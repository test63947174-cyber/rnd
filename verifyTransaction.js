// ============================================================
// 🔒 VERIFY TRANSACTION + DEPOSIT ENGINE — RND STAKING
// ============================================================

import { ethers } from "https://cdnjs.cloudflare.com/ajax/libs/ethers/6.7.0/ethers.min.js";
import { WALLET_CONFIG, normalizeTxHash, isValidTxHash } from "./wallet.js";
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

// ============================================================
// 🔖 ERROR CODES
// ============================================================
export const ERROR_CODES = Object.freeze({
    INVALID_INPUT: "INVALID_INPUT",
    INVALID_HASH: "INVALID_HASH",
    DUPLICATE: "DUPLICATE",
    IN_PROGRESS: "IN_PROGRESS",
    SUPERSEDED: "SUPERSEDED",
    NOT_FOUND: "NOT_FOUND",
    TX_FAILED: "TX_FAILED",
    NO_USDT_TRANSFER: "NO_USDT_TRANSFER",
    WRONG_TOKEN: "WRONG_TOKEN",
    WRONG_RECEIVER: "WRONG_RECEIVER",
    AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
    BELOW_MIN: "BELOW_MIN",
    SENDER_MISMATCH: "SENDER_MISMATCH",
    WALLET_NOT_LINKED: "WALLET_NOT_LINKED",
    TX_TOO_OLD: "TX_TOO_OLD",
    NETWORK: "NETWORK",
    TIMEOUT: "TIMEOUT",
    BANNED: "BANNED",
    USER_NOT_FOUND: "USER_NOT_FOUND",
    CREDIT_FAILED: "CREDIT_FAILED",
    PENDING: "PENDING"
});
const C = ERROR_CODES;

// ============================================================
// 🧰 SMALL HELPERS
// ============================================================
const TRANSFER_IFACE = new ethers.Interface([
    "event Transfer(address indexed from, address indexed to, uint256 value)"
]);
const TRANSFER_TOPIC = TRANSFER_IFACE.getEvent("Transfer").topicHash.toLowerCase();

const VERIFY_GUARD_MS = 60000;
const VERIFY_TOTAL_TIMEOUT = 60000;

const activeVerifications = new Map();
const activeDeposits = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message || "Timeout")), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function roundTo(value, precision) {
    const f = Math.pow(10, precision);
    return Math.round(value * f) / f;
}

const fail = (code, error, extra = {}) => ({ success: false, code, error, ...extra });

function codedError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

const addrEq = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();

function randomToken() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ============================================================
// 💰 AMOUNT TOLERANCE
// ============================================================
export function amountsMatch(userAmount, chainAmount) {
    const a = Number(userAmount);
    const b = Number(chainAmount);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (a <= 0 || b <= 0) return false;

    const diff = Math.abs(a - b);
    const tolerance = Math.max(b * WALLET_CONFIG.RELATIVE_TOLERANCE, WALLET_CONFIG.ABSOLUTE_TOLERANCE);
    return diff <= tolerance;
}

// ============================================================
// 🌐 RPC PROVIDER
// ============================================================
let providerCache = { provider: null, index: -1 };

function buildProvider(url) {
    const request = new ethers.FetchRequest(url);
    request.timeout = WALLET_CONFIG.RPC_TIMEOUT;
    return new ethers.JsonRpcProvider(request, WALLET_CONFIG.CHAIN_ID, { staticNetwork: true });
}

function destroyProvider(provider) {
    try { if (provider) provider.destroy(); } catch (_) { /* ignore */ }
}

async function connectProvider(startIndex) {
    const endpoints = WALLET_CONFIG.RPC_ENDPOINTS;
    let lastError = null;

    for (let i = 0; i < endpoints.length; i++) {
        const index = (startIndex + i) % endpoints.length;
        const provider = buildProvider(endpoints[index]);
        try {
            await withTimeout(provider.getBlockNumber(), WALLET_CONFIG.RPC_TIMEOUT, "RPC timeout");
            providerCache = { provider, index };
            return provider;
        } catch (error) {
            lastError = error;
            console.warn(`RPC ${endpoints[index]} failed:`, error.message);
            destroyProvider(provider);
        }
    }
    throw new Error(`All RPC endpoints failed. Last error: ${lastError ? lastError.message : "unknown"}`);
}

async function getProvider(forceNext = false) {
    const total = WALLET_CONFIG.RPC_ENDPOINTS.length;
    if (providerCache.provider && !forceNext) return providerCache.provider;

    let start;
    if (providerCache.provider) {
        start = (providerCache.index + 1) % total;
        destroyProvider(providerCache.provider);
        providerCache = { provider: null, index: -1 };
    } else {
        start = Math.floor(Math.random() * total);
    }
    return connectProvider(start);
}

async function rpc(fn) {
    const attempts = Math.min(3, WALLET_CONFIG.RPC_ENDPOINTS.length);
    let lastError = null;

    for (let i = 0; i < attempts; i++) {
        try {
            const provider = await getProvider(i > 0);
            return await withTimeout(fn(provider), WALLET_CONFIG.RPC_TIMEOUT * 2, "RPC timeout");
        } catch (error) {
            lastError = error;
            console.warn(`RPC attempt ${i + 1} failed:`, error.message);
        }
    }
    throw lastError || new Error("RPC failed");
}

async function fetchChainData(txHash, needBlockTime) {
    const read = async (provider) => {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt) {
            const tx = await provider.getTransaction(txHash);
            return { receipt: null, tx };
        }
        const currentBlock = await provider.getBlockNumber();
        let blockTimestamp = null;
        if (needBlockTime) {
            const block = await provider.getBlock(receipt.blockNumber);
            blockTimestamp = block ? block.timestamp : null;
        }
        return { receipt, tx: null, currentBlock, blockTimestamp };
    };

    let data = await rpc(read);

    if (!data.receipt && !data.tx) {
        await getProvider(true);
        data = await rpc(read);
    }
    return data;
}

// ============================================================
// 🔍 PARSE USDT TRANSFERS
// ============================================================
function analyzeTransfers(receipt) {
    const usdt = WALLET_CONFIG.USDT_CONTRACT.toLowerCase();
    const deposit = WALLET_CONFIG.DEPOSIT_WALLET.toLowerCase();

    const usdtTransfers = [];
    let otherTokenContract = null;

    for (const log of receipt.logs) {
        const address = String(log.address || "").toLowerCase();

        if (address === usdt) {
            try {
                const parsed = TRANSFER_IFACE.parseLog({ topics: [...log.topics], data: log.data });
                if (parsed && parsed.name === "Transfer") {
                    usdtTransfers.push({
                        from: parsed.args.from,
                        to: parsed.args.to,
                        value: parsed.args.value
                    });
                }
            } catch (_) { /* ignore */ }
        } else if (
            log.topics && log.topics.length === 3 &&
            String(log.topics[0]).toLowerCase() === TRANSFER_TOPIC
        ) {
            const to = "0x" + String(log.topics[2]).slice(26).toLowerCase();
            if (to === deposit && !otherTokenContract) otherTokenContract = log.address;
        }
    }

    const toDeposit = usdtTransfers.filter((t) => addrEq(t.to, deposit));

    if (toDeposit.length === 0) {
        if (otherTokenContract) {
            return {
                error: fail(
                    C.WRONG_TOKEN,
                    `Invalid token. Expected USDT (${WALLET_CONFIG.USDT_CONTRACT}) but got ${otherTokenContract}.`,
                    { tokenContract: otherTokenContract }
                )
            };
        }
        if (usdtTransfers.length === 0) {
            return {
                error: fail(C.NO_USDT_TRANSFER, "No USDT transfer found in this transaction. Please verify the transaction hash.")
            };
        }
        return {
            error: fail(
                C.WRONG_RECEIVER,
                `Wrong receiver wallet. Expected ${WALLET_CONFIG.DEPOSIT_WALLET} but got ${usdtTransfers[0].to}.`,
                { receiver: usdtTransfers[0].to }
            )
        };
    }

    const total = toDeposit.reduce((sum, t) => sum + t.value, 0n);
    const amountText = ethers.formatUnits(total, WALLET_CONFIG.USDT_DECIMALS).replace(/\.0$/, "");

    return {
        from: toDeposit[0].from,
        to: WALLET_CONFIG.DEPOSIT_WALLET,
        amount: Number(amountText),
        amountText,
        amountRaw: total.toString()
    };
}

// ============================================================
// 🔒 VERIFY TRANSACTION ON BLOCKCHAIN
// ============================================================
async function runVerification(hash, expectedAmount, options) {
    const required = WALLET_CONFIG.MIN_CONFIRMATIONS;
    const maxAgeHours = options.maxAgeHours != null ? Number(options.maxAgeHours) : WALLET_CONFIG.MAX_TX_AGE_HOURS;

    const data = await fetchChainData(hash, maxAgeHours > 0);

    if (!data.receipt) {
        if (data.tx) {
            return fail(C.PENDING, "Transaction is waiting to be mined...", {
                pending: true,
                phase: "mining",
                confirmations: 0,
                requiredConfirmations: required,
                currentBlock: null,
                blockNumber: null
            });
        }
        return fail(C.NOT_FOUND, "Transaction not found. Please check the hash and try again.");
    }

    const { receipt, currentBlock, blockTimestamp } = data;

    if (receipt.status !== 1) {
        return fail(C.TX_FAILED, "Transaction failed on blockchain. Please check the transaction.");
    }

    const analysis = analyzeTransfers(receipt);
    if (analysis.error) return analysis.error;

    const actualAmount = analysis.amount;

    if (!(actualAmount > 0)) {
        return fail(C.NO_USDT_TRANSFER, "No USDT transfer found in this transaction.");
    }

    if (actualAmount < WALLET_CONFIG.MIN_DEPOSIT_USDT) {
        return fail(C.BELOW_MIN, `Minimum deposit is ${WALLET_CONFIG.MIN_DEPOSIT_USDT} USDT.`, {
            blockchainAmount: actualAmount,
            minDeposit: WALLET_CONFIG.MIN_DEPOSIT_USDT
        });
    }

    const expected = Number(expectedAmount);
    if (Number.isFinite(expected) && expected > 0 && !amountsMatch(expected, actualAmount)) {
        return fail(
            C.AMOUNT_MISMATCH,
            `Amount mismatch. You entered ${expected} USDT but blockchain shows ${analysis.amountText} USDT.`,
            {
                amountMismatch: true,
                blockchainAmount: actualAmount,
                blockchainAmountText: analysis.amountText,
                userAmount: expected,
                tolerance: Math.max(actualAmount * WALLET_CONFIG.RELATIVE_TOLERANCE, WALLET_CONFIG.ABSOLUTE_TOLERANCE)
            }
        );
    }

    if (options.expectedSender) {
        const okSender = addrEq(analysis.from, options.expectedSender) || addrEq(receipt.from, options.expectedSender);
        if (!okSender) {
            return fail(C.SENDER_MISMATCH, "This transaction was not sent from your linked wallet address.", {
                sender: analysis.from
            });
        }
    }

    if (maxAgeHours > 0 && blockTimestamp) {
        const ageMs = Date.now() - blockTimestamp * 1000;
        if (ageMs > maxAgeHours * 3600 * 1000) {
            return fail(C.TX_TOO_OLD, `This transaction is older than ${maxAgeHours} hours.`);
        }
    }

    const confirmations = Math.max(0, currentBlock - receipt.blockNumber + 1);

    if (confirmations < required) {
        return fail(C.PENDING, `Waiting for confirmations... (${confirmations}/${required})`, {
            pending: true,
            phase: "confirming",
            confirmations,
            requiredConfirmations: required,
            currentBlock,
            blockNumber: receipt.blockNumber,
            blockchainAmount: actualAmount
        });
    }

    return {
        success: true,
        verified: true,
        receipt: {
            blockNumber: receipt.blockNumber,
            confirmations,
            from: analysis.from,
            to: analysis.to,
            amount: actualAmount,
            amountRaw: analysis.amountRaw,
            tokenContract: WALLET_CONFIG.USDT_CONTRACT,
            txHash: hash,
            blockHash: receipt.blockHash,
            gasUsed: receipt.gasUsed.toString(),
            status: receipt.status
        }
    };
}

export async function verifyTransaction(txHash, expectedAmount, options = {}) {
    const hash = normalizeTxHash(txHash);
    if (!isValidTxHash(hash)) {
        return fail(C.INVALID_HASH, "Invalid transaction hash. It must start with 0x and be 66 characters long.");
    }

    // 🔥 FIX: गार्ड केवल तभी लागू हो जब वास्तव में कोई verification चल रही हो
    const startedAt = activeVerifications.get(hash);
    if (startedAt && Date.now() - startedAt < VERIFY_GUARD_MS) {
        // अगर पिछली verification 60 सेकंड से पुरानी है, तो उसे मृत मानकर हटा दें
        // (यह अब तुरंत दोबारा try करने देगा)
        return fail(C.IN_PROGRESS, "This transaction is already being verified. Please wait.");
    }
    activeVerifications.set(hash, Date.now());

    try {
        return await withTimeout(
            runVerification(hash, expectedAmount, options),
            VERIFY_TOTAL_TIMEOUT,
            "Verification timed out"
        );
    } catch (error) {
        console.error("Verification error:", error);
        return fail(C.NETWORK, `Network problem while verifying: ${error.message}`);
    } finally {
        // 🔥 FIX: हमेशा हटाएं, चाहे सफल हो या विफल — ताकि अगली बार तुरंत try हो सके
        activeVerifications.delete(hash);
    }
}

// ============================================================
// 🔒 PROCESSING LOCK
// ============================================================
const lockRef = (txHash) => ref(db, `processingTransactions/${txHash}`);

async function acquireProcessingLock(txHash, uid, amount) {
    const token = randomToken();
    let reason = null;

    try {
        const result = await runTransaction(lockRef(txHash), (current) => {
            reason = null;
            const now = Date.now();

            if (current === null) {
                return { uid, token, amount, status: "processing", timestamp: now, startedAt: now, heartbeat: now };
            }

            const lastBeat = current.heartbeat || current.timestamp || 0;

            if (current.uid === uid) {
                return {
                    ...current,
                    token,
                    amount: amount > 0 ? amount : current.amount,
                    status: "processing",
                    heartbeat: now
                };
            }

            if (now - lastBeat > WALLET_CONFIG.LOCK_HEARTBEAT_TIMEOUT) {
                return { uid, token, amount, status: "processing", timestamp: now, startedAt: now, heartbeat: now };
            }

            reason = C.IN_PROGRESS;
            return undefined;
        });

        return { acquired: result.committed, token, reason: result.committed ? null : (reason || C.IN_PROGRESS) };
    } catch (error) {
        console.error("Error acquiring processing lock:", error);
        return { acquired: false, token, reason: C.NETWORK };
    }
}

async function releaseProcessingLock(txHash, token) {
    try {
        await runTransaction(lockRef(txHash), (current) => {
            if (current === null) return current;
            if (token && current.token && current.token !== token) return undefined;
            return null;
        });
        return true;
    } catch (error) {
        console.error("Error releasing processing lock:", error);
        return false;
    }
}

function startHeartbeat(txHash, token) {
    const state = { lost: false, timer: null, stop() { clearInterval(this.timer); } };

    const beat = async () => {
        try {
            const result = await runTransaction(lockRef(txHash), (current) => {
                if (current === null) return current;
                if (current.token !== token) return undefined;
                current.heartbeat = Date.now();
                return current;
            });
            const value = result.snapshot.exists() ? result.snapshot.val() : null;
            if (!result.committed || !value || value.token !== token) state.lost = true;
        } catch (_) { /* temporary network issue */ }
    };

    state.timer = setInterval(beat, WALLET_CONFIG.LOCK_HEARTBEAT_INTERVAL);
    return state;
}

// ============================================================
// 🔒 DUPLICATE CHECK
// ============================================================
export async function checkDuplicateTransaction(txHash, uid = null) {
    try {
        const hash = normalizeTxHash(txHash);
        const snap = await get(ref(db, `usedTransactions/${hash}`));
        if (!snap.exists()) return { isDuplicate: false };

        const data = snap.val() || {};
        const resumable = !!uid && data.uid === uid && data.status === "crediting";
        return { isDuplicate: !resumable, resumable, data };
    } catch (error) {
        console.error("Error checking duplicate:", error);
        return { isDuplicate: false, checkFailed: true };
    }
}

// ============================================================
// 🔒 ATOMIC CLAIM OF TXID
// ============================================================
async function claimTransaction(txHash, uid, amount) {
    let reason = null;

    const result = await runTransaction(ref(db, `usedTransactions/${txHash}`), (current) => {
        reason = null;
        const now = Date.now();

        if (current === null) {
            return { uid, amount, status: "crediting", timestamp: now, claimedAt: now };
        }
        if (current.uid === uid && current.status === "crediting") return current;

        reason = C.DUPLICATE;
        return undefined;
    });

    return { ok: result.committed, reason: result.committed ? null : (reason || C.DUPLICATE) };
}

// ============================================================
// 🔒 PROCESS DEPOSIT
// ============================================================
export async function processDeposit(uid, txHash, amount, receipt) {
    const hash = normalizeTxHash(txHash);

    if (!uid || !isValidTxHash(hash) || !receipt) {
        throw codedError(C.INVALID_INPUT, "Invalid deposit data.");
    }

    const finalAmount = roundTo(Number(receipt.amount), 8);
    if (!(finalAmount > 0)) {
        throw codedError(C.INVALID_INPUT, "Invalid deposit amount.");
    }

    const claim = await claimTransaction(hash, uid, finalAmount);
    if (!claim.ok) {
        throw codedError(C.DUPLICATE, "This transaction hash has already been used. Duplicate deposits are not allowed.");
    }

    const txKey = "dep_" + hash;
    let outcome = null;

    const result = await runTransaction(ref(db, `users/${uid}`), (data) => {
        outcome = null;
        if (data === null) return data;

        if (data.banned === true) {
            outcome = "banned";
            return undefined;
        }

        const transactions = data.transactions || {};

        let alreadyCredited = !!transactions[txKey];
        if (!alreadyCredited) {
            for (const key in transactions) {
                const t = transactions[key];
                if (t && t.type === "deposit" && t.status === "success" && normalizeTxHash(t.txHash) === hash) {
                    alreadyCredited = true;
                    break;
                }
            }
        }
        if (alreadyCredited) {
            outcome = "already";
            return undefined;
        }

        const currentBalance = Number(data.depositWallet) || 0;
        data.depositWallet = roundTo(currentBalance + finalAmount, 8);

        transactions[txKey] = {
            type: "deposit",
            status: "success",
            amount: finalAmount,
            currency: "USDT",
            network: "BSC",
            txHash: hash,
            txId: txKey,
            blockNumber: receipt.blockNumber,
            from: receipt.from,
            to: receipt.to,
            tokenContract: receipt.tokenContract,
            confirmations: receipt.confirmations,
            timestamp: Date.now(),
            date: new Date().toDateString(),
            description: `Deposit of ${finalAmount.toFixed(6)} USDT verified on blockchain`
        };
        data.transactions = transactions;

        outcome = "credited";
        return data;
    });

    if (outcome === "banned") {
        throw codedError(C.BANNED, "Your account has been banned.");
    }
    if (outcome !== "credited" && outcome !== "already") {
        if (!result.committed) throw codedError(C.CREDIT_FAILED, "Could not credit your balance. Please try again.");
    }

    const snapshot = result.snapshot;
    if (!snapshot || !snapshot.exists()) {
        throw codedError(C.USER_NOT_FOUND, "User account not found.");
    }
    const newBalance = Number(snapshot.val().depositWallet) || 0;

    try {
        await update(ref(db, `usedTransactions/${hash}`), {
            status: "completed",
            amount: finalAmount,
            blockNumber: receipt.blockNumber,
            completedAt: Date.now()
        });
    } catch (error) {
        console.warn("Could not mark transaction completed (credit is safe):", error);
    }

    if (outcome === "credited") {
        try {
            const historyRef = push(ref(db, "depositHistory"));
            await set(historyRef, {
                uid,
                txHash: hash,
                amount: finalAmount,
                blockNumber: receipt.blockNumber,
                from: receipt.from,
                to: receipt.to,
                timestamp: Date.now(),
                status: "success"
            });
        } catch (error) {
            console.warn("Could not save deposit history:", error);
        }
    }

    return {
        success: true,
        newBalance,
        amountCredited: finalAmount,
        blockNumber: receipt.blockNumber,
        txHash: hash,
        alreadyCredited: outcome === "already"
    };
}

// ============================================================
// 🔒 COMPLETE DEPOSIT FLOW
// ============================================================
export async function completeDeposit(uid, txHash, amount, onPending, onSuccess, onError, options = {}) {
    const safeCall = (fn, ...args) => {
        try { if (typeof fn === "function") fn(...args); } catch (e) { console.error("Callback error:", e); }
    };
    const finish = (result) => {
        if (!result.success) safeCall(onError, result.error, result);
        return result;
    };
    const phase = (name) => safeCall(options.onPhase, name);

    const hash = normalizeTxHash(txHash);

    if (!uid) return finish(fail(C.INVALID_INPUT, "Please login again."));
    if (!isValidTxHash(hash)) {
        return finish(fail(C.INVALID_HASH, "Invalid transaction hash. It must start with 0x and be 66 characters long."));
    }

    const userAmount = Number(amount) > 0 ? Number(amount) : 0;

    if (activeDeposits.has(hash)) {
        return finish(fail(C.IN_PROGRESS, "This transaction is already being processed. Please wait."));
    }
    activeDeposits.add(hash);

    let lock = null;
    let heartbeat = null;

    try {
        const bannedSnap = await get(ref(db, `users/${uid}/banned`));
        if (bannedSnap.exists() && bannedSnap.val() === true) {
            return finish(fail(C.BANNED, "Your account has been banned."));
        }

        const duplicate = await checkDuplicateTransaction(hash, uid);
        if (duplicate.isDuplicate) {
            return finish(fail(C.DUPLICATE, "This transaction hash has already been used. Duplicate deposits are not allowed."));
        }

        let expectedSender = null;
        if (WALLET_CONFIG.REQUIRE_SENDER_MATCH) {
            const walletSnap = await get(ref(db, `users/${uid}/${WALLET_CONFIG.USER_WALLET_FIELD}`));
            const saved = walletSnap.exists() ? String(walletSnap.val() || "").trim() : "";
            if (!/^0x[0-9a-fA-F]{40}$/.test(saved)) {
                return finish(fail(C.WALLET_NOT_LINKED, "Please save your wallet address in your profile before depositing."));
            }
            expectedSender = saved;
        }

        lock = await acquireProcessingLock(hash, uid, userAmount);
        if (!lock.acquired) {
            return finish(fail(
                lock.reason === C.NETWORK ? C.NETWORK : C.IN_PROGRESS,
                lock.reason === C.NETWORK
                    ? "Network problem. Please try again."
                    : "This transaction is already being processed. Please wait."
            ));
        }
        heartbeat = startHeartbeat(hash, lock.token);

        let effectiveAmount = userAmount;
        if (!(effectiveAmount > 0)) {
            try {
                const lockSnap = await get(lockRef(hash));
                const lockAmount = lockSnap.exists() ? Number(lockSnap.val().amount) : 0;
                if (lockAmount > 0) effectiveAmount = lockAmount;
            } catch (_) { /* ignore */ }
        }

        phase("verifying");
        let attempts = 0;
        let networkErrors = 0;
        let lastPending = null;
        let verification = null;

        while (true) {
            if (heartbeat.lost) {
                return finish(fail(C.SUPERSEDED, "This verification is now running in another tab/window."));
            }

            const result = await verifyTransaction(hash, effectiveAmount, { expectedSender });

            if (result.success) {
                verification = result;
                break;
            }

            if (result.pending) {
                networkErrors = 0;
                lastPending = result;
                phase(result.phase);
                safeCall(onPending, result.confirmations, result.currentBlock, result.blockNumber, result);
            } else if (result.code === C.NETWORK && networkErrors < WALLET_CONFIG.MAX_NETWORK_RETRIES) {
                networkErrors++;
                phase("network_retry");
            } else {
                return finish(result);
            }

            attempts++;
            if (attempts >= WALLET_CONFIG.MAX_POLLING_ATTEMPTS) {
                return finish(fail(
                    C.TIMEOUT,
                    "Still waiting for confirmations. Please try again later with the same transaction hash.",
                    { pending: true, confirmations: lastPending ? lastPending.confirmations : 0 }
                ));
            }
            await sleep(WALLET_CONFIG.POLLING_INTERVAL);
        }

        if (heartbeat.lost) {
            return finish(fail(C.SUPERSEDED, "This verification is now running in another tab/window."));
        }

        phase("crediting");
        try {
            const credited = await processDeposit(uid, hash, effectiveAmount, verification.receipt);
            safeCall(onSuccess, credited.newBalance, credited.amountCredited, credited.blockNumber);
            return credited;
        } catch (error) {
            console.error("processDeposit error:", error);
            return finish(fail(error.code || C.CREDIT_FAILED, error.message || "Failed to process deposit"));
        }

    } catch (error) {
        console.error("Complete deposit error:", error);
        return finish(fail(C.NETWORK, error.message || "Failed to complete deposit"));
    } finally {
        if (heartbeat) heartbeat.stop();
        if (lock && lock.acquired) await releaseProcessingLock(hash, lock.token);
        activeDeposits.delete(hash);
    }
}

// ============================================================
// 🧹 CLEANUP STALE LOCKS
// ============================================================
export async function cleanupStaleLocks() {
    try {
        const locksSnap = await get(ref(db, "processingTransactions"));
        if (!locksSnap.exists()) return;

        const now = Date.now();
        for (const [txHash, lockData] of Object.entries(locksSnap.val())) {
            const lastBeat = (lockData && (lockData.heartbeat || lockData.timestamp)) || 0;
            if (now - lastBeat > WALLET_CONFIG.STALE_LOCK_TIMEOUT) {
                try {
                    await remove(ref(db, `processingTransactions/${txHash}`));
                    console.log(`🧹 Cleaned up stale lock for ${txHash}`);
                } catch (err) {
                    console.warn(`Could not remove stale lock ${txHash}:`, err.message);
                }
            }
        }
    } catch (error) {
        console.error("Error cleaning up stale locks:", error);
    }
}

// ============================================================
// 🔁 CHECK PENDING VERIFICATIONS
// ============================================================
export async function checkPendingVerifications(uid) {
    try {
        const locksSnap = await get(ref(db, "processingTransactions"));
        if (!locksSnap.exists()) return [];

        const pendingTxs = [];

        for (const [txHash, lockData] of Object.entries(locksSnap.val())) {
            if (!lockData || lockData.uid !== uid) continue;

            const usedSnap = await get(ref(db, `usedTransactions/${txHash}`));
            if (usedSnap.exists() && usedSnap.val().status === "completed") {
                try { await remove(ref(db, `processingTransactions/${txHash}`)); } catch (_) { /* ignore */ }
                continue;
            }

            pendingTxs.push({ txHash, lockData });
        }

        return pendingTxs;
    } catch (error) {
        console.error("Error checking pending verifications:", error);
        return [];
    }
}
