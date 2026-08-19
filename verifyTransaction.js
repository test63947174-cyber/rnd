import { ethers } from "https://cdnjs.cloudflare.com/ajax/libs/ethers/6.7.0/ethers.min.js";
import { WALLET_CONFIG } from "./wallet.js";
import { 
    db, 
    ref, 
    get, 
    set, 
    push, 
    runTransaction, 
    remove,
    update
} from "./firebase.js";

// ERC20 ABI for USDT transfer events
const ERC20_ABI = [
    "event Transfer(address indexed from, address indexed to, uint256 value)"
];

// Browser memory cache for active verifications
const activeVerifications = new Map();

// ============================================================
// 🔒 GET RPC PROVIDER WITH FAILOVER
// ============================================================
async function getProvider() {
    let lastError = null;
    
    for (const rpcUrl of WALLET_CONFIG.RPC_ENDPOINTS) {
        try {
            const provider = new ethers.JsonRpcProvider(rpcUrl);
            provider.timeout = WALLET_CONFIG.RPC_TIMEOUT;
            
            await Promise.race([
                provider.getBlockNumber(),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('RPC timeout')), WALLET_CONFIG.RPC_TIMEOUT)
                )
            ]);
            
            return provider;
        } catch (error) {
            lastError = error;
            console.warn(`RPC ${rpcUrl} failed:`, error.message);
            continue;
        }
    }
    
    throw new Error(`All RPC endpoints failed. Last error: ${lastError?.message}`);
}

// ============================================================
// 🔒 ACQUIRE PROCESSING LOCK - ATOMIC
// ============================================================
async function acquireProcessingLock(txHash, uid, amount) {
    const lockRef = ref(db, `processingTransactions/${txHash}`);
    
    try {
        const result = await runTransaction(lockRef, (currentData) => {
            // If lock exists
            if (currentData !== null) {
                const now = Date.now();
                const lockTime = currentData.timestamp || 0;
                
                // Check if lock is stale (older than timeout)
                if (now - lockTime > WALLET_CONFIG.STALE_LOCK_TIMEOUT) {
                    // Override stale lock
                    return {
                        uid: uid,
                        timestamp: now,
                        status: 'processing',
                        amount: amount
                    };
                }
                // Lock is active - reject
                return;
            }
            
            // No lock exists - create new
            return {
                uid: uid,
                timestamp: Date.now(),
                status: 'processing',
                amount: amount
            };
        });
        
        return result.committed;
    } catch (error) {
        console.error('Error acquiring processing lock:', error);
        return false;
    }
}

// ============================================================
// 🔒 RELEASE PROCESSING LOCK
// ============================================================
async function releaseProcessingLock(txHash) {
    try {
        await remove(ref(db, `processingTransactions/${txHash}`));
        return true;
    } catch (error) {
        console.error('Error releasing processing lock:', error);
        return false;
    }
}

// ============================================================
// 🔒 CHECK DUPLICATE TRANSACTION
// ============================================================
export async function checkDuplicateTransaction(txHash) {
    try {
        const snap = await get(ref(db, `usedTransactions/${txHash}`));
        if (snap.exists()) {
            return {
                isDuplicate: true,
                data: snap.val()
            };
        }
        return { isDuplicate: false };
    } catch (error) {
        console.error("Error checking duplicate:", error);
        return { isDuplicate: false };
    }
}

// ============================================================
// 🔒 VERIFY TRANSACTION ON BLOCKCHAIN
// ============================================================
export async function verifyTransaction(txHash, expectedAmount) {
    // Check if already being verified
    if (activeVerifications.has(txHash)) {
        return {
            success: false,
            error: "This transaction is already being verified. Please wait."
        };
    }
    
    activeVerifications.set(txHash, Date.now());
    
    try {
        const provider = await getProvider();
        
        // Get transaction receipt with retry
        let receipt = null;
        let retries = 3;
        while (retries > 0 && !receipt) {
            try {
                receipt = await provider.getTransactionReceipt(txHash);
                if (!receipt) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    retries--;
                } else {
                    break;
                }
            } catch (e) {
                retries--;
                if (retries === 0) throw e;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        if (!receipt) {
            return {
                success: false,
                error: "Transaction not found. Please check the hash and try again."
            };
        }
        
        // Check transaction status
        if (receipt.status !== 1) {
            return {
                success: false,
                error: "Transaction failed on blockchain. Please check the transaction."
            };
        }
        
        // Check confirmations
        const currentBlock = await provider.getBlockNumber();
        const confirmations = currentBlock - receipt.blockNumber;
        
        if (confirmations < WALLET_CONFIG.MIN_CONFIRMATIONS) {
            return {
                success: false,
                error: `Waiting for confirmations... (${confirmations}/${WALLET_CONFIG.MIN_CONFIRMATIONS})`,
                pending: true,
                confirmations: confirmations,
                currentBlock: currentBlock,
                blockNumber: receipt.blockNumber
            };
        }
        
        // Parse USDT Transfer event
        const iface = new ethers.Interface(ERC20_ABI);
        let transferEvent = null;
        let fromAddress = null;
        let toAddress = null;
        let transferAmount = null;
        let tokenContract = null;
        
        for (const log of receipt.logs) {
            // Check if log is from USDT contract
            if (log.address.toLowerCase() !== WALLET_CONFIG.USDT_CONTRACT.toLowerCase()) {
                continue;
            }
            
            try {
                const parsedLog = iface.parseLog(log);
                if (parsedLog && parsedLog.name === 'Transfer') {
                    fromAddress = parsedLog.args.from;
                    toAddress = parsedLog.args.to;
                    transferAmount = parsedLog.args.value;
                    tokenContract = log.address;
                    transferEvent = parsedLog;
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        // No USDT transfer found
        if (!transferEvent) {
            return {
                success: false,
                error: "No USDT transfer found in this transaction. Please verify the contract address."
            };
        }
        
        // Validate token contract
        if (tokenContract?.toLowerCase() !== WALLET_CONFIG.USDT_CONTRACT.toLowerCase()) {
            return {
                success: false,
                error: `Invalid token. Expected USDT (${WALLET_CONFIG.USDT_CONTRACT}) but got ${tokenContract || 'unknown'}.`
            };
        }
        
        // Validate receiver wallet
        if (toAddress?.toLowerCase() !== WALLET_CONFIG.DEPOSIT_WALLET.toLowerCase()) {
            return {
                success: false,
                error: `Wrong receiver wallet. Expected ${WALLET_CONFIG.DEPOSIT_WALLET} but got ${toAddress}.`
            };
        }
        
        // Get actual amount from blockchain
        const actualAmount = parseFloat(ethers.formatUnits(transferAmount, 18));
        const expectedAmountNum = parseFloat(expectedAmount);
        
        // Validate amount with tolerance
        const tolerance = 0.001;
        if (Math.abs(actualAmount - expectedAmountNum) > tolerance) {
            return {
                success: false,
                error: `Amount mismatch. Expected ${expectedAmountNum} USDT but blockchain shows ${actualAmount.toFixed(2)} USDT.`
            };
        }
        
        // ============================================================
        // 🔒 ALL VALIDATIONS PASSED
        // ============================================================
        return {
            success: true,
            verified: true,
            receipt: {
                blockNumber: receipt.blockNumber,
                confirmations: confirmations,
                from: fromAddress,
                to: toAddress,
                amount: actualAmount,
                tokenContract: tokenContract,
                txHash: txHash,
                blockHash: receipt.blockHash,
                gasUsed: receipt.gasUsed.toString(),
                status: receipt.status
            }
        };
        
    } catch (error) {
        console.error("Verification error:", error);
        return {
            success: false,
            error: `Verification failed: ${error.message}`
        };
    } finally {
        activeVerifications.delete(txHash);
    }
}

// ============================================================
// 🔒 PROCESS DEPOSIT - ATOMIC
// ============================================================
export async function processDeposit(uid, txHash, amount, receipt) {
    try {
        const userRef = ref(db, `users/${uid}`);
        
        // 🔥 ALL OPERATIONS INSIDE runTransaction()
        const result = await runTransaction(userRef, (currentData) => {
            if (!currentData) {
                return { ...currentData };
            }
            
            // ============================================================
            // 🔒 STEP 1: Check for duplicate one more time inside transaction
            // ============================================================
            const transactions = currentData.transactions || {};
            for (let key in transactions) {
                const tx = transactions[key];
                if (tx.type === 'deposit' && tx.txHash === txHash && tx.status === 'success') {
                    // Already processed
                    return { ...currentData };
                }
            }
            
            // ============================================================
            // 🔒 STEP 2: Update balance
            // ============================================================
            const currentBalance = currentData.depositWallet || 0;
            const newBalance = currentBalance + amount;
            
            // ============================================================
            // 🔒 STEP 3: Create transaction record
            // ============================================================
            const txId = 'tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
            const transactionRecord = {
                type: 'deposit',
                status: 'success',
                amount: amount,
                txHash: txHash,
                blockNumber: receipt.blockNumber,
                from: receipt.from,
                to: receipt.to,
                tokenContract: receipt.tokenContract,
                confirmations: receipt.confirmations,
                timestamp: Date.now(),
                date: new Date().toDateString(),
                description: `Deposit of $${amount.toFixed(2)} USDT verified on blockchain`
            };
            
            // Add to transactions
            transactions[txId] = transactionRecord;
            
            // ============================================================
            // 🔒 STEP 4: Update user data
            // ============================================================
            return {
                ...currentData,
                depositWallet: newBalance,
                transactions: transactions
            };
        });
        
        if (!result.committed) {
            throw new Error("Transaction failed - duplicate or insufficient balance");
        }
        
        // ============================================================
        // 🔒 STEP 5: Mark as used (outside transaction - second layer)
        // ============================================================
        try {
            await set(ref(db, `usedTransactions/${txHash}`), {
                uid: uid,
                amount: amount,
                timestamp: Date.now(),
                blockNumber: receipt.blockNumber,
                status: 'completed'
            });
        } catch (err) {
            console.warn('Warning: Could not mark transaction as used:', err);
            // Non-critical - transaction already processed
        }
        
        // ============================================================
        // 🔒 STEP 6: Save to deposit history (for admin)
        // ============================================================
        try {
            const historyRef = ref(db, `depositHistory`);
            const newHistoryRef = push(historyRef);
            await set(newHistoryRef, {
                uid: uid,
                txHash: txHash,
                amount: amount,
                blockNumber: receipt.blockNumber,
                from: receipt.from,
                to: receipt.to,
                timestamp: Date.now(),
                status: 'success'
            });
        } catch (err) {
            console.warn('Warning: Could not save deposit history:', err);
            // Non-critical
        }
        
        return {
            success: true,
            newBalance: result.snapshot.val().depositWallet
        };
        
    } catch (error) {
        console.error("Error processing deposit:", error);
        throw error;
    }
}

// ============================================================
// 🔒 COMPLETE DEPOSIT FLOW
// ============================================================
export async function completeDeposit(uid, txHash, amount, onPending, onSuccess, onError) {
    console.log('🔒 Starting secure deposit flow...');
    
    try {
        // ============================================================
        // 🔒 STEP 1: Check duplicate first (fastest check)
        // ============================================================
        const duplicateCheck = await checkDuplicateTransaction(txHash);
        if (duplicateCheck.isDuplicate) {
            return {
                success: false,
                error: "❌ This transaction hash has already been used. Duplicate deposits are not allowed."
            };
        }
        
        // ============================================================
        // 🔒 STEP 2: Acquire processing lock
        // ============================================================
        const lockAcquired = await acquireProcessingLock(txHash, uid, amount);
        if (!lockAcquired) {
            return {
                success: false,
                error: "⏳ This transaction is already being processed. Please wait."
            };
        }
        
        try {
            // ============================================================
            // 🔒 STEP 3: Verify on blockchain
            // ============================================================
            const verification = await verifyTransaction(txHash, amount);
            console.log('Verification result:', verification);
            
            // ============================================================
            // 🔒 STEP 4: Handle pending (auto-polling)
            // ============================================================
            if (verification.pending) {
                if (onPending) {
                    onPending(verification.confirmations, verification.currentBlock, verification.blockNumber);
                }
                
                // Start auto-polling
                const pollingResult = await startAutoPolling(uid, txHash, amount, onPending, onSuccess, onError);
                await releaseProcessingLock(txHash);
                return pollingResult;
            }
            
            // ============================================================
            // 🔒 STEP 5: Handle verification failure
            // ============================================================
            if (!verification.success) {
                await releaseProcessingLock(txHash);
                return verification;
            }
            
            // ============================================================
            // 🔒 STEP 6: Process deposit atomically
            // ============================================================
            try {
                const result = await processDeposit(uid, txHash, amount, verification.receipt);
                await releaseProcessingLock(txHash);
                
                if (onSuccess) {
                    onSuccess(result.newBalance);
                }
                
                return {
                    success: true,
                    ...result
                };
            } catch (error) {
                await releaseProcessingLock(txHash);
                return {
                    success: false,
                    error: error.message || "Failed to process deposit"
                };
            }
            
        } catch (error) {
            await releaseProcessingLock(txHash);
            throw error;
        }
        
    } catch (error) {
        console.error('Complete deposit error:', error);
        return {
            success: false,
            error: error.message || "Failed to complete deposit"
        };
    }
}

// ============================================================
// 🔒 AUTO-POLLING FOR PENDING TRANSACTIONS
// ============================================================
async function startAutoPolling(uid, txHash, amount, onPending, onSuccess, onError) {
    let attempts = 0;
    
    return new Promise((resolve) => {
        const pollInterval = setInterval(async () => {
            attempts++;
            
            try {
                // Check if lock still exists
                const lockSnap = await get(ref(db, `processingTransactions/${txHash}`));
                if (!lockSnap.exists()) {
                    clearInterval(pollInterval);
                    resolve({
                        success: false,
                        error: "Processing was interrupted. Please try again."
                    });
                    return;
                }
                
                // Verify again
                const verification = await verifyTransaction(txHash, amount);
                
                // Still pending
                if (verification.pending) {
                    if (onPending) {
                        onPending(verification.confirmations, verification.currentBlock, verification.blockNumber);
                    }
                    
                    // Max attempts reached
                    if (attempts >= WALLET_CONFIG.MAX_POLLING_ATTEMPTS) {
                        clearInterval(pollInterval);
                        resolve({
                            success: false,
                            error: `Still waiting for confirmations. Please try again later.`,
                            pending: true,
                            confirmations: verification.confirmations
                        });
                    }
                    return;
                }
                
                // Verification done
                clearInterval(pollInterval);
                
                // Verification failed
                if (!verification.success) {
                    resolve(verification);
                    return;
                }
                
                // Process deposit
                try {
                    const result = await processDeposit(uid, txHash, amount, verification.receipt);
                    if (onSuccess) {
                        onSuccess(result.newBalance);
                    }
                    resolve({
                        success: true,
                        ...result
                    });
                } catch (error) {
                    resolve({
                        success: false,
                        error: error.message || "Failed to process deposit"
                    });
                }
                
            } catch (error) {
                clearInterval(pollInterval);
                resolve({
                    success: false,
                    error: error.message || "Polling failed"
                });
            }
        }, WALLET_CONFIG.POLLING_INTERVAL);
    });
}

// ============================================================
// 🔒 CLEANUP STALE LOCKS
// ============================================================
export async function cleanupStaleLocks() {
    try {
        const locksSnap = await get(ref(db, 'processingTransactions'));
        if (!locksSnap.exists()) return;
        
        const locks = locksSnap.val();
        const now = Date.now();
        
        for (const [txHash, lockData] of Object.entries(locks)) {
            if (now - lockData.timestamp > WALLET_CONFIG.STALE_LOCK_TIMEOUT) {
                await remove(ref(db, `processingTransactions/${txHash}`));
                console.log(`🧹 Cleaned up stale lock for ${txHash}`);
            }
        }
    } catch (error) {
        console.error('Error cleaning up stale locks:', error);
    }
}

// ============================================================
// 🔒 CHECK PENDING VERIFICATIONS
// ============================================================
export async function checkPendingVerifications(uid) {
    try {
        const locksSnap = await get(ref(db, 'processingTransactions'));
        if (!locksSnap.exists()) return [];
        
        const locks = locksSnap.val();
        const pendingTxs = [];
        
        for (const [txHash, lockData] of Object.entries(locks)) {
            if (lockData.uid === uid) {
                // Check if already used
                const usedSnap = await get(ref(db, `usedTransactions/${txHash}`));
                if (usedSnap.exists()) {
                    await remove(ref(db, `processingTransactions/${txHash}`));
                    continue;
                }
                
                pendingTxs.push({
                    txHash: txHash,
                    lockData: lockData
                });
            }
        }
        
        return pendingTxs;
    } catch (error) {
        console.error('Error checking pending verifications:', error);
        return [];
    }
}