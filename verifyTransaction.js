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
// 🔥 AMOUNT TOLERANCE CONFIG
// ============================================================
const RELATIVE_TOLERANCE = 0.005;  // 0.5%
const ABSOLUTE_TOLERANCE = 0.01;   // 0.01 USDT minimum floor

export function amountsMatch(userAmount, chainAmount) {
    const a = Number(userAmount);
    const b = Number(chainAmount);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (a <= 0 || b <= 0) return false;

    const diff = Math.abs(a - b);
    const tolerance = Math.max(b * RELATIVE_TOLERANCE, ABSOLUTE_TOLERANCE);
    return diff <= tolerance;
}

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
            if (currentData !== null) {
                const now = Date.now();
                const lockTime = currentData.timestamp || 0;
                
                if (now - lockTime > WALLET_CONFIG.STALE_LOCK_TIMEOUT) {
                    return {
                        uid: uid,
                        timestamp: now,
                        status: 'processing',
                        amount: amount
                    };
                }
                return;
            }
            
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
        
        if (!transferEvent) {
            return {
                success: false,
                error: "No USDT transfer found in this transaction. Please verify the contract address."
            };
        }
        
        if (tokenContract?.toLowerCase() !== WALLET_CONFIG.USDT_CONTRACT.toLowerCase()) {
            return {
                success: false,
                error: `Invalid token. Expected USDT (${WALLET_CONFIG.USDT_CONTRACT}) but got ${tokenContract || 'unknown'}.`
            };
        }
        
        if (toAddress?.toLowerCase() !== WALLET_CONFIG.DEPOSIT_WALLET.toLowerCase()) {
            return {
                success: false,
                error: `Wrong receiver wallet. Expected ${WALLET_CONFIG.DEPOSIT_WALLET} but got ${toAddress}.`
            };
        }
        
        // GET ACTUAL AMOUNT FROM BLOCKCHAIN
        const actualAmount = parseFloat(ethers.formatUnits(transferAmount, 18));
        
        // AMOUNT VALIDATION WITH SMART TOLERANCE
        if (expectedAmount && Number(expectedAmount) > 0) {
            if (!amountsMatch(expectedAmount, actualAmount)) {
                const tolerance = Math.max(actualAmount * RELATIVE_TOLERANCE, ABSOLUTE_TOLERANCE);
                return {
                    success: false,
                    error: `Amount mismatch. You entered ${Number(expectedAmount)} USDT but blockchain shows ${actualAmount} USDT. ` +
                           `Difference: ${Math.abs(Number(expectedAmount) - actualAmount).toFixed(6)} USDT (tolerance: ±${tolerance.toFixed(4)}). ` +
                           `Please enter the exact amount including decimals (e.g. ${actualAmount}).`,
                    blockchainAmount: actualAmount,
                    userAmount: Number(expectedAmount),
                    tolerance: tolerance
                };
            }
        }
        
        // ALL VALIDATIONS PASSED
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
        // Use the verified blockchain amount if available
        const finalAmount = (receipt && receipt.amount) ? Number(receipt.amount) : Number(amount);
        
        const userRef = ref(db, `users/${uid}`);
        
        const result = await runTransaction(userRef, (currentData) => {
            if (!currentData) {
                return { ...currentData };
            }
            
            // STEP 1: Check duplicate
            const transactions = currentData.transactions || {};
            for (let key in transactions) {
                const tx = transactions[key];
                if (tx.type === 'deposit' && tx.txHash === txHash && tx.status === 'success') {
                    return { ...currentData };
                }
            }
            
            // STEP 2: Update balance
            const currentBalance = Number(currentData.depositWallet) || 0;
            const newBalance = currentBalance + finalAmount;
            
            // STEP 3: Create transaction record
            const txId = 'tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
            const transactionRecord = {
                type: 'deposit',
                status: 'success',
                amount: finalAmount,
                txHash: txHash,
                blockNumber: receipt.blockNumber,
                from: receipt.from,
                to: receipt.to,
                tokenContract: receipt.tokenContract,
                confirmations: receipt.confirmations,
                timestamp: Date.now(),
                date: new Date().toDateString(),
                description: `Deposit of ${finalAmount.toFixed(6)} USDT verified on blockchain`
            };
            
            transactions[txId] = transactionRecord;
            
            return {
                ...currentData,
                depositWallet: newBalance,
                transactions: transactions
            };
        });
        
        if (!result.committed) {
            throw new Error("Transaction failed - duplicate or insufficient balance");
        }
        
        // STEP 5: Mark as used
        try {
            await set(ref(db, `usedTransactions/${txHash}`), {
                uid: uid,
                amount: finalAmount,
                timestamp: Date.now(),
                blockNumber: receipt.blockNumber,
                status: 'completed'
            });
        } catch (err) {
            console.warn('Warning: Could not mark transaction as used:', err);
        }
        
        // STEP 6: Save to deposit history
        try {
            const historyRef = ref(db, `depositHistory`);
            const newHistoryRef = push(historyRef);
            await set(newHistoryRef, {
                uid: uid,
                txHash: txHash,
                amount: finalAmount,
                blockNumber: receipt.blockNumber,
                from: receipt.from,
                to: receipt.to,
                timestamp: Date.now(),
                status: 'success'
            });
        } catch (err) {
            console.warn('Warning: Could not save deposit history:', err);
        }
        
        return {
            success: true,
            newBalance: result.snapshot.val().depositWallet,
            amountCredited: finalAmount,
            blockNumber: receipt.blockNumber
        };
        
    } catch (error) {
        console.error("Error processing deposit:", error);
        throw error;
    }
}

// ============================================================
// 🔒 COMPLETE DEPOSIT FLOW (FIXED)
// ============================================================
export async function completeDeposit(uid, txHash, amount, onPending, onSuccess, onError) {
    console.log('🔒 Starting secure deposit flow...');
    
    try {
        // STEP 1: Check duplicate
        const duplicateCheck = await checkDuplicateTransaction(txHash);
        if (duplicateCheck.isDuplicate) {
            return {
                success: false,
                error: "❌ This transaction hash has already been used. Duplicate deposits are not allowed."
            };
        }
        
        // STEP 2: Acquire processing lock
        const lockAcquired = await acquireProcessingLock(txHash, uid, amount);
        if (!lockAcquired) {
            return {
                success: false,
                error: "⏳ This transaction is already being processed. Please wait."
            };
        }
        
        try {
            // STEP 3: Verify on blockchain
            const verification = await verifyTransaction(txHash, amount);
            console.log('Verification result:', verification);
            
            // STEP 4: Handle pending
            if (verification.pending) {
                if (onPending) {
                    onPending(verification.confirmations, verification.currentBlock, verification.blockNumber);
                }
                
                const pollingResult = await startAutoPolling(uid, txHash, amount, onPending, onSuccess, onError);
                await releaseProcessingLock(txHash);
                return pollingResult;
            }
            
            // STEP 5: Handle failure
            if (!verification.success) {
                await releaseProcessingLock(txHash);
                return verification;
            }
            
            // STEP 6: Process deposit
            try {
                const result = await processDeposit(uid, txHash, amount, verification.receipt);
                await releaseProcessingLock(txHash);
                
                // 🔥 Call onSuccess with THREE parameters
                if (onSuccess) {
                    onSuccess(
                        result.newBalance,
                        result.amountCredited,
                        result.blockNumber
                    );
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
// 🔒 AUTO-POLLING FOR PENDING TRANSACTIONS (FIXED)
// ============================================================
async function startAutoPolling(uid, txHash, amount, onPending, onSuccess, onError) {
    let attempts = 0;
    
    return new Promise((resolve) => {
        const pollInterval = setInterval(async () => {
            attempts++;
            
            try {
                const lockSnap = await get(ref(db, `processingTransactions/${txHash}`));
                if (!lockSnap.exists()) {
                    clearInterval(pollInterval);
                    resolve({
                        success: false,
                        error: "Processing was interrupted. Please try again."
                    });
                    return;
                }
                
                const verification = await verifyTransaction(txHash, amount);
                
                if (verification.pending) {
                    if (onPending) {
                        onPending(verification.confirmations, verification.currentBlock, verification.blockNumber);
                    }
                    
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
                
                clearInterval(pollInterval);
                
                if (!verification.success) {
                    resolve(verification);
                    return;
                }
                
                try {
                    const result = await processDeposit(uid, txHash, amount, verification.receipt);
                    
                    // 🔥 Call onSuccess with THREE parameters
                    if (onSuccess) {
                        onSuccess(
                            result.newBalance,
                            result.amountCredited,
                            result.blockNumber
                        );
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
