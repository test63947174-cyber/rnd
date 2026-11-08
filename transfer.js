// ============================================================
// TRANSFER.JS — v7.2 Final (Client-Side Only, No Cloud Function)
// Complete safety: stale pending, unknown recovery, rollback retry,
// background checker, multi-request tracking
// ============================================================

import { initializeApp } from "firebase/app";
import {
    getAuth,
    onAuthStateChanged,
    EmailAuthProvider,
    reauthenticateWithCredential
} from "firebase/auth";
import { getDatabase, ref, get, runTransaction, set, onValue } from "firebase/database";

const firebaseConfig = {
    apiKey: "AIzaSyDsuqsmiwIG3Ey57MR19tr_8wJQRQ3_W64",
    authDomain: "rwebsite-e031b.firebaseapp.com",
    databaseURL: "https://rwebsite-e031b-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "rwebsite-e031b",
    storageBucket: "rwebsite-e031b.firebasestorage.app",
    messagingSenderId: "376966041558",
    appId: "1:376966041558:web:02bc9062ec182590275e77",
    measurementId: "G-0T1FREXHD3"
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// ============================================================
// Config
// ============================================================
const WALLET_CURRENCY = { depositWallet: 'USDT', referralWallet: 'USDT', rndWallet: 'RND' };
const WALLET_PRECISION = { depositWallet: 2, referralWallet: 2, rndWallet: 8 };

const ACTIVE_REQUESTS_KEY = 'activeTransferRequestIds';
const STALE_PENDING_MS = 90 * 1000;          // 90 sec
const STALE_RECHECK_INTERVAL_MS = 60 * 1000;  // 1 min
const FALLBACK_USER_SCAN = true;              // Keep legacy username/referral-code lookup working

// ============================================================
// State
// ============================================================
let currentUserData = null;
let currentUserId = null;
let transferLock = false;
let balanceListenerOff = null;
let currentBalances = { depositWallet: 0, referralWallet: 0, rndWallet: 0 };
let pendingTransfer = null;
let modalOpen = false;
let reconciliationTimer = null;
let staleCheckTimer = null;

// ============================================================
// 👁️ Eye toggle
// ============================================================
window.togglePassword = function (inputId, btn) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const icon = btn.querySelector('i');
    if (input.type === 'password') {
        input.type = 'text';
        icon.className = 'bi bi-eye-slash';
    } else {
        input.type = 'password';
        icon.className = 'bi bi-eye';
    }
};

// ============================================================
// 🔐 Hash
// ============================================================
async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ============================================================
// 🔑 Multi-Request Tracking
// ============================================================
function getActiveRequestIds() {
    try {
        const raw = localStorage.getItem(ACTIVE_REQUESTS_KEY);
        if (!raw) {
            // Legacy migration
            const legacy = localStorage.getItem('activeTransferRequestId');
            if (legacy) {
                const arr = [legacy];
                localStorage.setItem(ACTIVE_REQUESTS_KEY, JSON.stringify(arr));
                return arr;
            }
            return [];
        }
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}

function addActiveRequestId(id) {
    const arr = getActiveRequestIds();
    if (!arr.includes(id)) arr.push(id);
    localStorage.setItem(ACTIVE_REQUESTS_KEY, JSON.stringify(arr));
}

function removeActiveRequestId(id) {
    const arr = getActiveRequestIds().filter(x => x !== id);
    localStorage.setItem(ACTIVE_REQUESTS_KEY, JSON.stringify(arr));
}

function getOrCreateRequestId() {
    const arr = getActiveRequestIds();
    if (arr.length > 0) return arr[arr.length - 1];
    const newId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
    addActiveRequestId(newId);
    return newId;
}

function clearActiveRequestId(specificId = null) {
    if (specificId) {
        removeActiveRequestId(specificId);
    } else {
        localStorage.removeItem(ACTIVE_REQUESTS_KEY);
        localStorage.removeItem('activeTransferRequestId');
    }
    localStorage.removeItem('activeTransferDetails');
}

// ============================================================
// 🕐 Stale pending detector
// ============================================================
function isStalePending(requestData) {
    if (!requestData || requestData.status !== 'pending') return false;
    const createdAt = requestData.createdAt || 0;
    return (Date.now() - createdAt) > STALE_PENDING_MS;
}

// ============================================================
// Toast
// ============================================================
function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) {
        console.log(`[Toast ${type}]`, message);
        return;
    }
    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;
    const icon = type === 'success'
        ? 'bi-check-circle-fill text-success'
        : 'bi-exclamation-triangle-fill text-danger';
    toast.innerHTML = `<i class="bi ${icon}"></i><span class="toast-msg">${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

// ============================================================
// Precision helpers
// ============================================================
function roundToPrecision(v, p) {
    const f = Math.pow(10, p);
    return Math.round((v + Number.EPSILON) * f) / f;
}

function validateAmount(amount, walletType) {
    if (typeof amount !== 'number' || !isFinite(amount) || Number.isNaN(amount))
        return { valid: false, error: 'Invalid amount' };
    if (amount <= 0) return { valid: false, error: 'Amount must be > 0' };
    const precision = WALLET_PRECISION[walletType] || 8;
    const rounded = roundToPrecision(amount, precision);
    if (Math.abs(rounded - amount) > 1e-10)
        return { valid: false, error: `Max ${precision} decimal places` };
    return { valid: true, value: rounded };
}

function getTodayDate() {
    return new Date().toISOString().split('T')[0];
}

// ============================================================
// Lookup
// ============================================================
async function getUserByIdentifier(identifier) {
    const raw = String(identifier ?? '').trim();
    if (!raw) return null;

    // Firebase keys cannot contain these characters. Avoid building an invalid path.
    const safeKey = !/[.#$\[\]\/]/.test(raw);

    // 1. Direct Firebase Auth UID lookup.
    if (safeKey) {
        try {
            const uidSnap = await get(ref(db, `users/${raw}`));
            if (uidSnap.exists() && uidSnap.val() && typeof uidSnap.val() === 'object') {
                return { uid: raw, data: uidSnap.val(), source: 'uid' };
            }
        } catch (error) {
            console.warn('Direct recipient UID lookup failed; trying legacy lookup:', error);
        }
    }

    // 2. Use lookup indexes when they exist. An absent/unreadable index must not
    //    stop the legacy users scan below (older accounts may not have indexes).
    if (safeKey) {
        try {
            const [unameSnap, refSnap] = await Promise.all([
                get(ref(db, `lookup/username/${raw}`)),
                get(ref(db, `lookup/referralCode/${raw}`))
            ]);
            const indexedUid = unameSnap.exists() ? unameSnap.val()
                : (refSnap.exists() ? refSnap.val() : null);
            if (indexedUid && typeof indexedUid === 'string') {
                const indexedUserSnap = await get(ref(db, `users/${indexedUid}`));
                if (indexedUserSnap.exists() && indexedUserSnap.val() && typeof indexedUserSnap.val() === 'object') {
                    return { uid: indexedUid, data: indexedUserSnap.val(), source: 'index' };
                }
            }
        } catch (error) {
            console.warn('Recipient lookup index unavailable; trying legacy users scan:', error);
        }
    }

    // 3. Legacy-compatible lookup. The previous working version searched users
    //    directly; newer accounts may not have lookup/username or lookup/referralCode.
    //    This is a read-only lookup: it does not modify user records or balances.
    if (!FALLBACK_USER_SCAN) return null;
    try {
        const usersSnap = await get(ref(db, 'users'));
        if (!usersSnap.exists()) return null;

        const users = usersSnap.val() || {};
        const wanted = raw.toLowerCase();
        let caseInsensitiveMatch = null;

        for (const [uid, userData] of Object.entries(users)) {
            if (!userData || typeof userData !== 'object') continue;

            // Preserve the old exact username/referralCode behavior and also
            // recognize common user-ID field names used by existing records.
            const candidates = [
                userData.username,
                userData.referralCode,
                userData.userId,
                userData.userID,
                userData.user_id,
                userData.memberId,
                userData.memberID,
                userData.uid,
                userData.id
            ].filter(value => value !== undefined && value !== null)
             .map(value => String(value).trim());

            if (candidates.some(value => value === raw)) {
                return { uid, data: userData, source: 'legacy-scan' };
            }

            if (!caseInsensitiveMatch && candidates.some(value => value.toLowerCase() === wanted)) {
                caseInsensitiveMatch = { uid, data: userData, source: 'legacy-scan-insensitive' };
            }
        }

        return caseInsensitiveMatch;
    } catch (error) {
        console.error('Recipient lookup failed:', error);
        return null;
    }
}

function getUserDisplayName(userData, fallbackUid) {
    if (!userData) return fallbackUid ? fallbackUid.slice(0, 8) : 'Unknown';
    return userData.name || userData.username || userData.referralCode
        || (fallbackUid ? fallbackUid.slice(0, 8) : 'Unknown');
}

// ============================================================
// 🔐 Password management
// ============================================================
async function hasTransferPassword(uid) {
    try {
        const snap = await get(ref(db, `users/${uid}/transferPasswordHash`));
        return snap.exists() && !!snap.val();
    } catch (err) { return false; }
}

async function saveTransferPassword(uid, password) {
    const hash = await hashPassword(password);
    await set(ref(db, `users/${uid}/transferPasswordHash`), hash);
    await set(ref(db, `users/${uid}/transferPasswordSetAt`), Date.now());
}

async function verifyTransferPassword(uid, password) {
    try {
        const snap = await get(ref(db, `users/${uid}/transferPasswordHash`));
        if (!snap.exists()) return false;
        return snap.val() === await hashPassword(password);
    } catch (err) { return false; }
}

// ============================================================
// History normalizer (array → object)
// ============================================================
function normalizeTransferHistory(currentData) {
    if (!currentData.transferHistory || Array.isArray(currentData.transferHistory)) {
        const arr = currentData.transferHistory || [];
        const obj = {};
        arr.forEach((item, i) => {
            obj[item.txId || `legacy_${i}`] = item;
        });
        currentData.transferHistory = obj;
    }
    return currentData.transferHistory;
}

// ============================================================
// Safe request patch
// ============================================================
async function patchRequest(requestRef, patch) {
    try {
        await runTransaction(requestRef, (currentData) => {
            if (!currentData) return;
            const currentStatus = currentData.status;
            const incomingStatus = patch && patch.status;
            // Terminal states must never be downgraded by a delayed checker/request.
            if ((currentStatus === 'success' || currentStatus === 'failed') &&
                incomingStatus && incomingStatus !== currentStatus) {
                return;
            }
            Object.assign(currentData, patch, { updatedAt: Date.now() });
            return currentData;
        });
    } catch (err) {
        console.warn('patchRequest failed:', err);
    }
}

// ============================================================
// Recipient credit: idempotent write + server-confirmed read-back
// ============================================================
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isMatchingRecipientCredit(entry, txId, requestId, senderUid, recipientUid, walletType, amount) {
    if (!entry) return false;
    return entry.txId === txId &&
        entry.requestId === requestId &&
        entry.fromUid === senderUid &&
        entry.toUid === recipientUid &&
        entry.walletType === walletType &&
        Number(entry.amount) === Number(amount) &&
        entry.status === 'completed';
}

async function creditRecipientExactlyOnce({ recipientUid, senderUid, amount, walletType, currency, txId, requestId, senderName, recipientName, timestamp }) {
    const recipientRef = ref(db, `users/${recipientUid}`);
    const precision = WALLET_PRECISION[walletType] || 8;
    let lastError = null;

    // Retry only the same idempotent request. A committed credit is detected by txId.
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await runTransaction(recipientRef, (currentData) => {
                if (!currentData) return;
                normalizeTransferHistory(currentData);
                const history = currentData.transferHistory || {};
                const existing = history[txId];

                // Never credit a second time. Existing record must match this exact transfer.
                if (existing) return;

                const balance = Number(currentData[walletType] || 0);
                if (!Number.isFinite(balance) || balance < 0) return;

                currentData[walletType] = roundToPrecision(balance + amount, precision);
                currentData.transferHistory[txId] = {
                    type: 'received',
                    from: senderName, fromUid: senderUid, fromUsername: senderName,
                    to: recipientName, toUid: recipientUid, toUsername: recipientName,
                    amount, currency, walletType,
                    timestamp, txId, requestId, status: 'completed'
                };
                if (!currentData.transactions || typeof currentData.transactions !== 'object') {
                    currentData.transactions = {};
                }
                currentData.transactions[txId] = {
                    type: 'transfer_received', amount, currency, walletType,
                    from: senderName, fromUid: senderUid,
                    to: recipientName, toUid: recipientUid,
                    timestamp, date: getTodayDate(), txId, requestId, status: 'completed'
                };
                return currentData;
            }, { applyLocally: false });

            // Do not trust only the transaction response: read the recipient record back.
            const verifySnap = await get(recipientRef);
            if (verifySnap.exists()) {
                const recipientData = verifySnap.val() || {};
                const historyEntry = recipientData.transferHistory && recipientData.transferHistory[txId];
                const transactionEntry = recipientData.transactions && recipientData.transactions[txId];
                const historyMatches = isMatchingRecipientCredit(
                    historyEntry, txId, requestId, senderUid, recipientUid, walletType, amount
                );
                const transactionMatches = !!transactionEntry &&
                    transactionEntry.txId === txId &&
                    transactionEntry.requestId === requestId &&
                    transactionEntry.type === 'transfer_received' &&
                    transactionEntry.fromUid === senderUid &&
                    transactionEntry.toUid === recipientUid &&
                    transactionEntry.walletType === walletType &&
                    Number(transactionEntry.amount) === Number(amount) &&
                    transactionEntry.status === 'completed';

                if (historyMatches && transactionMatches) {
                    return { confirmed: true, alreadyCredited: attempt > 1 };
                }

                // A txId already used for different details is a conflict; do not add balance.
                if (historyEntry || transactionEntry) {
                    return { confirmed: false, conflict: true, error: 'Recipient TXID record does not match this transfer.' };
                }
            }
        } catch (err) {
            lastError = err;
            console.warn(`Recipient credit attempt ${attempt} failed:`, err);
        }

        if (attempt < 3) await sleep(700 * attempt);
    }

    return { confirmed: false, error: lastError ? lastError.message : 'Recipient credit could not be confirmed.' };
}

// ============================================================
// 🔧 resolveUnknownTransfer — 4 case resolver
// ============================================================
async function resolveUnknownTransfer(requestId, txId, senderUid, recipientUid, walletType, amount) {
    try {
        if (!requestId || !txId || !senderUid || !recipientUid || !WALLET_CURRENCY[walletType]) {
            return { status: 'unknown', error: 'Invalid recovery details' };
        }

        const safeAmount = validateAmount(Number(amount), walletType);
        if (!safeAmount.valid) return { status: 'unknown', error: 'Invalid recovery amount' };
        const transferAmount = safeAmount.value;
        const precision = WALLET_PRECISION[walletType] || 8;
        const requestRef = ref(db, `transferRequests/${requestId}`);
        const senderRef = ref(db, `users/${senderUid}`);
        const recipientRef = ref(db, `users/${recipientUid}`);

        const [senderSnap, recipientSnap, recipientUserSnap] = await Promise.all([
            get(ref(db, `users/${senderUid}/transferHistory/${txId}`)),
            get(ref(db, `users/${recipientUid}/transferHistory/${txId}`)),
            get(recipientRef)
        ]);

        const senderEntry = senderSnap.exists() ? senderSnap.val() : null;
        const recipientEntry = recipientSnap.exists() ? recipientSnap.val() : null;
        const senderReversed = !!senderEntry && senderEntry.status === 'reversed';
        const senderCompleted = !!senderEntry && senderEntry.status === 'completed';

        // Recipient record is proof of credit only when the sender debit is also present.
        if (senderCompleted && recipientEntry) {
            await patchRequest(requestRef, {
                status: 'success', completedAt: Date.now(), resolvedBy: 'reconciliation'
            });
            return { status: 'success' };
        }

        // A previously refunded transfer must never be sent/credited again under this request ID.
        if (senderReversed && !recipientEntry) {
            await patchRequest(requestRef, {
                status: 'failed', failedAt: Date.now(),
                reason: 'Already refunded to sender', resolvedBy: 'reconciliation'
            });
            return { status: 'failed', error: 'Already refunded to sender' };
        }

        // Conflicting records require review; never silently create or remove funds.
        if ((senderReversed && recipientEntry) || (!senderEntry && recipientEntry)) {
            await patchRequest(requestRef, {
                status: 'unknown', needsManualReview: true,
                lastCheckedAt: Date.now(), lastError: 'Conflicting sender/recipient ledger records'
            });
            return { status: 'unknown', error: 'Manual review needed' };
        }

        // Sender was debited, but recipient is not credited yet: retry recipient credit idempotently.
        if (senderCompleted && !recipientEntry) {
            if (recipientUserSnap.exists()) {
                const creditResult = await creditRecipientExactlyOnce({
                    recipientUid, senderUid, amount: transferAmount, walletType,
                    currency: WALLET_CURRENCY[walletType], txId, requestId,
                    senderName: senderEntry.from || senderUid,
                    recipientName: senderEntry.to || recipientUid,
                    timestamp: senderEntry.timestamp || Date.now()
                });

                if (creditResult.confirmed) {
                    await patchRequest(requestRef, {
                        status: 'success', completedAt: Date.now(), resolvedBy: 'recipient_credit_retry'
                    });
                    return { status: 'success' };
                }
                if (creditResult.conflict) {
                    await patchRequest(requestRef, {
                        status: 'unknown', needsManualReview: true,
                        lastCheckedAt: Date.now(), lastError: creditResult.error || 'Recipient TXID conflict'
                    });
                    return { status: 'unknown', error: 'Recipient ledger conflict; manual review required.' };
                }

                // Recipient credit is not confirmed: keep the request recoverable.
                // Do NOT refund while the recipient account exists; it may have committed despite a timeout.
                await patchRequest(requestRef, {
                    status: 'unknown', lastCheckedAt: Date.now(),
                    lastError: 'Recipient credit not confirmed; retry required'
                });
                return { status: 'unknown' };
            }

            // Refund only when the recipient account is confirmed missing.
            let refundAlreadyDone = false;
            const refundResult = await runTransaction(senderRef, (currentData) => {
                if (!currentData) return;
                normalizeTransferHistory(currentData);
                const entry = currentData.transferHistory && currentData.transferHistory[txId];
                if (!entry) return;
                if (entry.status === 'reversed') { refundAlreadyDone = true; return; }
                if (entry.status !== 'completed') return;

                currentData[walletType] = roundToPrecision(
                    (Number(currentData[walletType]) || 0) + transferAmount, precision
                );
                entry.status = 'reversed';
                entry.reversedAt = Date.now();
                entry.reversedReason = 'recipient_account_missing';
                if (currentData.transactions && currentData.transactions[txId]) {
                    currentData.transactions[txId].status = 'reversed';
                    currentData.transactions[txId].reversedAt = Date.now();
                }
                return currentData;
            });

            if (refundAlreadyDone || refundResult.committed) {
                await patchRequest(requestRef, {
                    status: 'failed', failedAt: Date.now(),
                    reason: 'Recipient account missing; amount returned', resolvedBy: 'reconciliation'
                });
                return { status: 'failed', error: 'Recipient missing; amount refunded' };
            }

            await patchRequest(requestRef, {
                status: 'unknown', lastCheckedAt: Date.now(),
                lastError: 'Refund not confirmed; manual review required', needsManualReview: true
            });
            return { status: 'unknown' };
        }

        if (!senderEntry && !recipientEntry) {
            // A previous client/network error can hide a committed sender write temporarily.
            // Keep the request recoverable; never tell the user it failed while the debit
            // outcome is uncertain. The next reconciliation pass checks the ledger again.
            await patchRequest(requestRef, {
                status: 'unknown', lastCheckedAt: Date.now(),
                lastError: 'No ledger entry visible yet; waiting for a confirmed read'
            });
            return { status: 'unknown', error: 'Transfer outcome is still being confirmed' };
        }

        return { status: 'unknown' };
    } catch (err) {
        console.error('Resolve unknown error:', err);
        return { status: 'unknown', error: err.message };
    }
}

// ============================================================
// ATOMIC TRANSFER — v7.2
// ============================================================
async function atomicTransfer(senderUid, recipientUid, amount, walletType, currency, requestId, senderName, recipientName) {
    if (!senderUid || !recipientUid) return { status: 'failed', error: 'Missing IDs' };
    if (senderUid === recipientUid) return { status: 'failed', error: 'Cannot send to yourself' };
    if (!WALLET_CURRENCY[walletType]) return { status: 'failed', error: 'Invalid wallet' };
    if (!requestId || typeof requestId !== 'string') return { status: 'failed', error: 'Invalid request ID' };

    const amountCheck = validateAmount(amount, walletType);
    if (!amountCheck.valid) return { status: 'failed', error: amountCheck.error };
    const safeAmount = amountCheck.value;
    const precision = WALLET_PRECISION[walletType];
    const requestRef = ref(db, `transferRequests/${requestId}`);
    const txId = 'TX_' + requestId.replace(/-/g, '').slice(0, 20);
    const now = Date.now();

    // STEP 1: One durable request per requestId. Never reopen a terminal request.
    let alreadyCompleted = false;
    let alreadyPending = false;
    let alreadyFailed = false;
    try {
        const requestResult = await runTransaction(requestRef, (currentData) => {
            if (currentData) {
                if (currentData.status === 'success') { alreadyCompleted = true; return; }
                if (currentData.status === 'pending' || currentData.status === 'unknown') {
                    alreadyPending = true;
                    return;
                }
                if (currentData.status === 'failed') { alreadyFailed = true; return; }
            }
            return {
                requestId, txId, senderUid, recipientUid,
                amount: safeAmount, currency, walletType,
                status: 'pending', createdAt: currentData?.createdAt || now,
                retryCount: Number(currentData?.retryCount || 0),
                senderName, recipientName, updatedAt: now
            };
        });

        if (alreadyCompleted) return { status: 'success', txId, recipientName, duplicate: true };
        if (alreadyPending) return { status: 'unknown', txId, error: 'Transfer already processing; recovery is running.' };
        if (alreadyFailed) return { status: 'failed', txId, error: 'This transfer request is already closed. Start a new transfer.' };
        if (!requestResult.committed) return { status: 'failed', error: 'Unable to create transfer request.' };
    } catch (err) {
        console.error('Request create error:', err);
        return { status: 'failed', error: 'Unable to create transfer request.' };
    }

    // STEP 2: Debit sender exactly once. If already debited, continue to recipient credit.
    const senderRef = ref(db, `users/${senderUid}`);
    let senderBalanceBefore = 0;
    let alreadyDebited = false;
    let alreadyReversed = false;
    try {
        const senderResult = await runTransaction(senderRef, (currentData) => {
            if (!currentData) return;
            normalizeTransferHistory(currentData);
            const history = currentData.transferHistory || {};
            const prior = history[txId];
            if (prior) {
                if (prior.status === 'reversed') alreadyReversed = true;
                else if (prior.status === 'completed') alreadyDebited = true;
                return;
            }

            const balance = roundToPrecision(Number(currentData[walletType]) || 0, precision);
            senderBalanceBefore = balance;
            if (balance < safeAmount) return;

            currentData[walletType] = roundToPrecision(balance - safeAmount, precision);
            currentData.transferHistory[txId] = {
                type: 'sent', to: recipientName, toUid: recipientUid, toUsername: recipientName,
                amount: safeAmount, currency, walletType,
                from: senderName, fromUid: senderUid, fromUsername: senderName,
                timestamp: now, txId, requestId, status: 'completed'
            };
            if (!currentData.transactions) currentData.transactions = {};
            currentData.transactions[txId] = {
                type: 'transfer_sent', amount: safeAmount, currency, walletType,
                to: recipientName, toUid: recipientUid, toUsername: recipientName,
                from: senderName, fromUid: senderUid,
                timestamp: now, date: getTodayDate(), txId, requestId, status: 'completed'
            };
            return currentData;
        });

        if (alreadyReversed) {
            await patchRequest(requestRef, { status: 'failed', failedAt: Date.now(), reason: 'This request was already refunded' });
            return { status: 'failed', txId, error: 'This transfer was already refunded. Please create a new transfer.' };
        }
        if (!alreadyDebited && !senderResult.committed) {
            await patchRequest(requestRef, { status: 'failed', failedAt: Date.now(), reason: 'Insufficient balance or sender write not committed' });
            return { status: 'failed', error: `Insufficient balance or unable to debit. Available: ${senderBalanceBefore} ${currency}` };
        }
    } catch (err) {
        // A client/network error does not prove the debit failed; let reconciliation inspect ledger.
        console.error('Sender transaction uncertain:', err);
        await patchRequest(requestRef, { status: 'unknown', unknownAt: Date.now(), lastError: 'sender_write_uncertain' });
        return { status: 'unknown', txId, error: 'Transfer status is being checked. Do not submit again yet.' };
    }

    // STEP 3: Credit recipient exactly once. If the write is uncertain, do not refund immediately.
    const recipientRef = ref(db, `users/${recipientUid}`);
    try {
        const creditResult = await creditRecipientExactlyOnce({
            recipientUid, senderUid, amount: safeAmount, walletType, currency,
            txId, requestId, senderName, recipientName, timestamp: now
        });

        if (!creditResult.confirmed) {
            await patchRequest(requestRef, {
                status: 'unknown', unknownAt: Date.now(),
                lastError: creditResult.error || 'recipient_credit_not_confirmed',
                needsManualReview: !!creditResult.conflict
            });
            return {
                status: 'unknown', txId,
                error: creditResult.conflict
                    ? 'Recipient transfer record needs review. No duplicate credit was made.'
                    : 'Recipient credit is not confirmed yet. Safe recovery will retry.'
            };
        }
    } catch (err) {
        console.error('Recipient credit verification error:', err);
        await patchRequest(requestRef, {
            status: 'unknown', unknownAt: Date.now(), lastError: 'recipient_write_uncertain'
        });
        return { status: 'unknown', txId, error: 'Recipient credit status is being checked. Do not submit again yet.' };
    }

    // STEP 4: Mark success only after recipient record is confirmed.
    await patchRequest(requestRef, { status: 'success', completedAt: Date.now() });
    return { status: 'success', txId, recipientName };
}

// ============================================================
// Modal Controls
// ============================================================
function openModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.add('active');
    modalOpen = true;
}

function closeModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.remove('active');
    modalOpen = false;

    if (id === 'setupModal') {
        ['setupPassword', 'setupPasswordConfirm'].forEach(eid => {
            const el = document.getElementById(eid);
            if (el) { el.value = ''; el.type = 'password'; }
        });
        document.querySelectorAll('#setupModal .password-eye i').forEach(i => i.className = 'bi bi-eye');
        document.getElementById('setupError')?.classList.remove('show');
    }
    if (id === 'verifyModal') {
        const el = document.getElementById('verifyPassword');
        if (el) { el.value = ''; el.type = 'password'; }
        document.querySelectorAll('#verifyModal .password-eye i').forEach(i => i.className = 'bi bi-eye');
        document.getElementById('verifyError')?.classList.remove('show');
    }
    if (id === 'forgotModal') {
        ['forgotAccountPassword', 'forgotNewPassword', 'forgotNewPasswordConfirm'].forEach(eid => {
            const el = document.getElementById(eid);
            if (el) { el.value = ''; el.type = 'password'; }
        });
        document.querySelectorAll('#forgotModal .password-eye i').forEach(i => i.className = 'bi bi-eye');
        document.getElementById('forgotError1')?.classList.remove('show');
        document.getElementById('forgotError2')?.classList.remove('show');
        document.getElementById('forgotStep1')?.classList.add('active');
        document.getElementById('forgotStep2')?.classList.remove('active');
    }
}

// ============================================================
// Password Setup
// ============================================================
function openPasswordSetup() {
    openModal('setupModal');
    setTimeout(() => document.getElementById('setupPassword')?.focus(), 200);
}

async function handlePasswordSetup() {
    const pwd = document.getElementById('setupPassword').value;
    const confirm = document.getElementById('setupPasswordConfirm').value;
    const errorEl = document.getElementById('setupError');
    const btn = document.getElementById('setupBtn');
    errorEl.classList.remove('show');

    if (!pwd || pwd.length < 6) {
        errorEl.textContent = 'Password कम से कम 6 characters का हो';
        errorEl.classList.add('show');
        return;
    }
    if (pwd !== confirm) {
        errorEl.textContent = 'दोनों passwords match नहीं कर रहे';
        errorEl.classList.add('show');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner me-2"></span>Setting...';

    try {
        await saveTransferPassword(currentUserId, pwd);
        showToast('✅ Password set! अब फिर Send दबाओ।', 'success');
        closeModal('setupModal');
        pendingTransfer = null;
    } catch (err) {
        console.error('Save error:', err);
        errorEl.textContent = 'Password save नहीं हुआ।';
        errorEl.classList.add('show');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-check-circle me-2"></i>Set Password';
    }
}

// ============================================================
// Password Verify
// ============================================================
function openPasswordVerify(details) {
    pendingTransfer = details;
    const detailsEl = document.getElementById('verifyDetails');

    let walletClass = 'deposit';
    let walletIcon = 'bi-wallet2';
    if (details.walletType === 'referralWallet') { walletClass = 'referral'; walletIcon = 'bi-coin'; }
    if (details.walletType === 'rndWallet') { walletClass = 'rnd'; walletIcon = 'bi-database'; }

    detailsEl.innerHTML = `
        <div class="verify-row">
            <span class="label"><i class="bi bi-person-fill"></i> From:</span>
            <span class="value name">${details.senderName || 'You'}</span>
        </div>
        <div class="verify-row">
            <span class="label"><i class="bi bi-wallet2"></i> From Wallet:</span>
            <span class="verify-wallet-badge ${walletClass}">
                <i class="bi ${walletIcon}"></i> ${details.walletLabel}
            </span>
        </div>
        <div class="verify-row">
            <span class="label"><i class="bi bi-person-check-fill"></i> To:</span>
            <span class="value name">${details.recipientName}</span>
        </div>
        <div class="verify-row">
            <span class="label"><i class="bi bi-wallet2"></i> To Wallet:</span>
            <span class="verify-wallet-badge ${walletClass}">
                <i class="bi ${walletIcon}"></i> ${details.walletLabel}
            </span>
        </div>
        <div class="verify-row">
            <span class="label"><i class="bi bi-currency-dollar"></i> Amount:</span>
            <span class="value amount">${details.amount} ${details.currency}</span>
        </div>
    `;
    openModal('verifyModal');
    setTimeout(() => document.getElementById('verifyPassword')?.focus(), 200);
}

async function handlePasswordVerify() {
    const password = document.getElementById('verifyPassword').value;
    const errorEl = document.getElementById('verifyError');
    const btn = document.getElementById('verifyBtn');
    errorEl.classList.remove('show');

    if (!password) {
        errorEl.textContent = 'Password डालें';
        errorEl.classList.add('show');
        return;
    }
    if (!pendingTransfer) {
        errorEl.textContent = 'Transfer details missing. दोबारा Send दबाओ।';
        errorEl.classList.add('show');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner me-2"></span>Verifying...';

    try {
        const isValid = await verifyTransferPassword(currentUserId, password);
        if (!isValid) {
            errorEl.textContent = '❌ Password गलत है';
            errorEl.classList.add('show');
            btn.disabled = false;
            btn.innerHTML = '<i class="bi bi-shield-check me-2"></i>Verify & Send';
            return;
        }

        const details = pendingTransfer;
        closeModal('verifyModal');

        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-shield-check me-2"></i>Verify & Send';

        await executeTransfer(details);
    } catch (err) {
        console.error('Verify error:', err);
        errorEl.textContent = 'Error आया।';
        errorEl.classList.add('show');
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-shield-check me-2"></i>Verify & Send';
    }
}

// ============================================================
// 🚀 EXECUTE TRANSFER
// ============================================================
async function executeTransfer(details) {
    const user = auth.currentUser;
    if (!user) return;

    transferLock = true;
    const btn = document.getElementById('sendBtn');
    if (btn) {
        btn.disabled = true;
        btn.className = 'btn-send sending';
        btn.innerHTML = '<span class="loading-spinner me-2"></span>Sending...';
    }

    try {
        const result = await atomicTransfer(
            user.uid, details.recipient.uid, details.amount,
            details.walletType, details.currency, details.requestId,
            details.senderName, details.recipientName
        );

        if (result.status === 'success') {
            if (result.duplicate) {
                showToast('✅ Transfer already completed (duplicate ignored)', 'success');
            } else {
                showToast(`✅ ${details.amount} ${details.currency} sent to ${details.recipientName}!`, 'success');
            }
            document.getElementById('recipientInput').value = '';
            document.getElementById('amountInput').value = '';
            clearActiveRequestId(details.requestId);
            setTimeout(() => loadUserData(user.uid), 500);
            resetButton();
        } else if (result.status === 'unknown') {
            showToast('⚠️ Status could not be confirmed. Auto-recovery शुरू...', 'error');
            if (btn) {
                btn.className = 'btn-send verifying';
                btn.innerHTML = '<i class="bi bi-hourglass-split me-2"></i>Verifying...';
            }

            // Immediate resolve attempt
            const snap = await get(ref(db, `transferRequests/${details.requestId}`));
            if (snap.exists()) {
                const d = snap.val();
                const resolved = await resolveUnknownTransfer(
                    details.requestId, d.txId, d.senderUid, d.recipientUid,
                    d.walletType, d.amount
                );
                if (resolved.status === 'success') {
                    showToast('✅ Transfer confirmed (recovered)!', 'success');
                    clearActiveRequestId(details.requestId);
                    loadUserData(user.uid);
                    resetButton();
                    return;
                }
                if (resolved.status === 'failed') {
                    showToast('❌ Transfer failed — amount refunded.', 'error');
                    clearActiveRequestId(details.requestId);
                    loadUserData(user.uid);
                    resetButton();
                    return;
                }
            }

            startReconciliationLoop(details.requestId, user.uid);
            return;
        } else {
            showToast('❌ ' + (result.error || 'Transfer failed'), 'error');
            clearActiveRequestId(details.requestId);
            resetButton();
        }
    } catch (err) {
        console.error('Execute error:', err);
        showToast('❌ Unexpected error.', 'error');
        resetButton();
    }
}

function resetButton() {
    const btn = document.getElementById('sendBtn');
    if (btn) {
        btn.disabled = false;
        btn.className = 'btn-send';
        btn.innerHTML = '<i class="bi bi-send me-2"></i> Send Money';
    }
    transferLock = false;
    pendingTransfer = null;
}

// ============================================================
// FORGOT PASSWORD — Step 1
// ============================================================
async function handleForgotVerify() {
    const password = document.getElementById('forgotAccountPassword').value;
    const errorEl = document.getElementById('forgotError1');
    const btn = document.getElementById('forgotVerifyBtn');
    errorEl.classList.remove('show');

    if (!password) {
        errorEl.textContent = 'Account password डालें';
        errorEl.classList.add('show');
        return;
    }

    const user = auth.currentUser;
    if (!user || !user.email) {
        errorEl.textContent = 'User email नहीं मिला। Support से संपर्क करें।';
        errorEl.classList.add('show');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner me-2"></span>Verifying...';

    try {
        const credential = EmailAuthProvider.credential(user.email, password);
        await reauthenticateWithCredential(user, credential);

        document.getElementById('forgotStep1').classList.remove('active');
        document.getElementById('forgotStep2').classList.add('active');
        document.getElementById('forgotAccountPassword').value = '';
        setTimeout(() => document.getElementById('forgotNewPassword')?.focus(), 200);
    } catch (err) {
        console.error('Forgot verify error:', err);
        let msg = '❌ Account password गलत है';
        if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
            msg = '❌ Account password गलत है';
        } else if (err.code === 'auth/too-many-requests') {
            msg = 'बहुत बार try किया। थोड़ी देर बाद try करें।';
        } else if (err.code === 'auth/network-request-failed') {
            msg = 'Network error। Internet check करें।';
        }
        errorEl.textContent = msg;
        errorEl.classList.add('show');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-shield-check me-2"></i>Verify';
    }
}

// ============================================================
// FORGOT PASSWORD — Step 2
// ============================================================
async function handleForgotReset() {
    const pwd = document.getElementById('forgotNewPassword').value;
    const confirm = document.getElementById('forgotNewPasswordConfirm').value;
    const errorEl = document.getElementById('forgotError2');
    const btn = document.getElementById('forgotResetBtn');
    errorEl.classList.remove('show');

    if (!pwd || pwd.length < 6) {
        errorEl.textContent = 'Password कम से कम 6 characters का हो';
        errorEl.classList.add('show');
        return;
    }
    if (pwd !== confirm) {
        errorEl.textContent = 'दोनों passwords match नहीं कर रहे';
        errorEl.classList.add('show');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner me-2"></span>Saving...';

    try {
        await saveTransferPassword(currentUserId, pwd);
        showToast('✅ Transfer password reset successfully!', 'success');
        closeModal('forgotModal');
        pendingTransfer = null;
    } catch (err) {
        console.error('Reset error:', err);
        errorEl.textContent = 'Password save नहीं हुआ।';
        errorEl.classList.add('show');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-check-circle me-2"></i>Set New Password';
    }
}

// ============================================================
// Form Submit
// ============================================================
async function handleTransferSubmit(e) {
    e.preventDefault();
    if (modalOpen) return;
    if (transferLock) {
        showToast('⏳ Transfer in progress...', 'error');
        return;
    }
    transferLock = true;

    const btn = document.getElementById('sendBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="loading-spinner me-2"></span>Checking...';
    }

    try {
        const recipientInput = document.getElementById('recipientInput').value.trim();
        const walletType = document.getElementById('walletSelect').value;
        const amountRaw = document.getElementById('amountInput').value;

        if (!recipientInput) { showToast('❌ Enter recipient', 'error'); resetButton(); return; }

        const amount = parseFloat(amountRaw);
        if (!isFinite(amount) || Number.isNaN(amount) || amount <= 0) {
            showToast('❌ Valid amount डालें', 'error'); resetButton(); return;
        }
        const amountCheck = validateAmount(amount, walletType);
        if (!amountCheck.valid) { showToast('❌ ' + amountCheck.error, 'error'); resetButton(); return; }

        const user = auth.currentUser;
        if (!user) { showToast('❌ Please login', 'error'); resetButton(); return; }

        const currentBalance = currentBalances[walletType] || 0;
        if (currentBalance < amountCheck.value) {
            showToast(`❌ Insufficient balance. Available: ${currentBalance} ${WALLET_CURRENCY[walletType]}`, 'error');
            resetButton(); return;
        }

        const recipient = await getUserByIdentifier(recipientInput);
        if (!recipient) { showToast('❌ User not found!', 'error'); resetButton(); return; }
        if (recipient.uid === user.uid) { showToast('❌ Cannot send to yourself!', 'error'); resetButton(); return; }

        // ============================================================
        // Check existing active requests
        // ============================================================
        const activeIds = getActiveRequestIds();
        for (const existingRequestId of activeIds) {
            try {
                const pendingSnap = await get(ref(db, `transferRequests/${existingRequestId}`));
                if (!pendingSnap.exists()) { removeActiveRequestId(existingRequestId); continue; }

                const pData = pendingSnap.val();

                if (pData.status === 'success') {
                    removeActiveRequestId(existingRequestId);
                    continue;
                }

                if (pData.status === 'failed') {
                    removeActiveRequestId(existingRequestId);
                    continue;
                }

                // Stale pending → promote
                if (isStalePending(pData)) {
                    await patchRequest(ref(db, `transferRequests/${existingRequestId}`), {
                        status: 'unknown',
                        unknownAt: Date.now(),
                        promotedFrom: 'submit_precheck'
                    });
                    pData.status = 'unknown';
                }

                if (pData.status === 'unknown' || pData.status === 'pending') {
                    const resolved = await resolveUnknownTransfer(
                        existingRequestId, pData.txId, pData.senderUid,
                        pData.recipientUid, pData.walletType, pData.amount
                    );
                    if (resolved.status === 'success') {
                        showToast('✅ Previous transfer confirmed!', 'success');
                        removeActiveRequestId(existingRequestId);
                        loadUserData(user.uid);
                        resetButton(); return;
                    }
                    if (resolved.status === 'failed') {
                        showToast('❌ Previous failed & refunded.', 'error');
                        removeActiveRequestId(existingRequestId);
                        loadUserData(user.uid);
                        resetButton(); return;
                    }
                    showToast('⚠️ Previous transfer still verifying. Wait.', 'error');
                    resetButton(); return;
                }
            } catch (err) {
                console.warn('Precheck error:', err);
            }
        }

        // ============================================================
        // Create new request
        // ============================================================
        const requestId = getOrCreateRequestId();
        const senderName = getUserDisplayName(currentUserData, user.uid);
        const recipientName = getUserDisplayName(recipient.data, recipient.uid);

        const details = {
            recipient, recipientName, senderName,
            amount: amountCheck.value, walletType, requestId,
            currency: WALLET_CURRENCY[walletType],
            walletLabel: getWalletLabel(walletType)
        };

        const hasPwd = await hasTransferPassword(user.uid);

        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="bi bi-send me-2"></i> Send Money';
        }

        transferLock = false;

        if (!hasPwd) {
            openPasswordSetup();
            return;
        }
        openPasswordVerify(details);

    } catch (err) {
        console.error('Submit error:', err);
        showToast('❌ Unexpected error', 'error');
        resetButton();
    }
}

function getWalletLabel(w) {
    if (w === 'depositWallet') return '💰 Deposit Wallet';
    if (w === 'referralWallet') return '💳 Referral Wallet';
    if (w === 'rndWallet') return '📊 RND Wallet';
    return w;
}

// ============================================================
// Reconciliation Loop (10 min max)
// ============================================================
function startReconciliationLoop(requestId, userId) {
    if (reconciliationTimer) clearTimeout(reconciliationTimer);

    let attempts = 0;
    const maxAttempts = 60;

    const check = async () => {
        attempts++;
        try {
            const snap = await get(ref(db, `transferRequests/${requestId}`));
            if (!snap.exists()) {
                if (attempts < maxAttempts) {
                    reconciliationTimer = setTimeout(check, 10000);
                }
                return;
            }

            const data = snap.val();

            if (data.status === 'success') {
                showToast('✅ Transfer confirmed!', 'success');
                clearActiveRequestId(requestId);
                loadUserData(userId);
                resetButton();
                startStaleChecker();
                return;
            }

            if (data.status === 'failed') {
                showToast('❌ Transfer failed & refunded.', 'error');
                clearActiveRequestId(requestId);
                loadUserData(userId);
                resetButton();
                startStaleChecker();
                return;
            }

            // Stale pending → promote
            if (isStalePending(data)) {
                await patchRequest(ref(db, `transferRequests/${requestId}`), {
                    status: 'unknown',
                    unknownAt: Date.now(),
                    promotedFrom: 'reconciliation_loop'
                });
                data.status = 'unknown';
            }

            if (data.status === 'unknown') {
                const resolved = await resolveUnknownTransfer(
                    requestId, data.txId, data.senderUid,
                    data.recipientUid, data.walletType, data.amount
                );
                if (resolved.status === 'success') {
                    showToast('✅ Transfer confirmed (recovered)!', 'success');
                    clearActiveRequestId(requestId);
                    loadUserData(userId);
                    resetButton();
                    startStaleChecker();
                    return;
                }
                if (resolved.status === 'failed') {
                    showToast('❌ Transfer failed — amount refunded.', 'error');
                    clearActiveRequestId(requestId);
                    loadUserData(userId);
                    resetButton();
                    startStaleChecker();
                    return;
                }
            }

            if (attempts >= maxAttempts) {
                showToast('⚠️ Verifying... Background में जारी रहेगा।', 'error');
                try {
                    await update(ref(db, `transferRequests/${requestId}`), {
                        stuckAt: Date.now(),
                        stuckCheckpoint: attempts
                    });
                } catch (_) {}
                resetButton();
                startStaleChecker();
                return;
            }

            reconciliationTimer = setTimeout(check, 10000);
        } catch (err) {
            if (attempts < maxAttempts) {
                reconciliationTimer = setTimeout(check, 10000);
            } else {
                resetButton();
                startStaleChecker();
            }
        }
    };

    reconciliationTimer = setTimeout(check, 3000);
}

// ============================================================
// Background Stale Checker (हर 1 मिनट)
// ============================================================
function startStaleChecker() {
    if (staleCheckTimer) clearInterval(staleCheckTimer);
    staleCheckTimer = setInterval(async () => {
        const ids = getActiveRequestIds();
        if (ids.length === 0) {
            clearInterval(staleCheckTimer);
            staleCheckTimer = null;
            return;
        }
        for (const requestId of ids) {
            try {
                const snap = await get(ref(db, `transferRequests/${requestId}`));
                if (!snap.exists()) { removeActiveRequestId(requestId); continue; }
                const data = snap.val();

                if (data.status === 'success' || data.status === 'failed') {
                    removeActiveRequestId(requestId);
                    if (currentUserId) loadUserData(currentUserId);
                    continue;
                }

                if (isStalePending(data)) {
                    await patchRequest(ref(db, `transferRequests/${requestId}`), {
                        status: 'unknown',
                        unknownAt: Date.now(),
                        promotedFrom: 'stale_checker'
                    });
                    data.status = 'unknown';
                }

                if (data.status === 'unknown') {
                    const resolved = await resolveUnknownTransfer(
                        requestId, data.txId, data.senderUid,
                        data.recipientUid, data.walletType, data.amount
                    );
                    if (resolved.status === 'success' || resolved.status === 'failed') {
                        removeActiveRequestId(requestId);
                        if (currentUserId) loadUserData(currentUserId);
                    }
                }
            } catch (_) { /* silent */ }
        }
    }, STALE_RECHECK_INTERVAL_MS);
}

// ============================================================
// On-Load Verification (all active requests)
// ============================================================
async function verifyPendingTransfersOnLoad() {
    const ids = getActiveRequestIds();
    if (ids.length === 0) return;

    let anyBlocking = false;

    for (const requestId of ids) {
        try {
            const snap = await get(ref(db, `transferRequests/${requestId}`));
            if (!snap.exists()) {
                removeActiveRequestId(requestId);
                continue;
            }

            const data = snap.val();

            if (data.status === 'success') {
                showToast('✅ Previous transfer confirmed!', 'success');
                removeActiveRequestId(requestId);
                if (currentUserId) loadUserData(currentUserId);
                continue;
            }

            if (data.status === 'failed') {
                showToast('❌ Previous transfer failed.', 'error');
                removeActiveRequestId(requestId);
                if (currentUserId) loadUserData(currentUserId);
                continue;
            }

            // Stale pending → promote
            if (isStalePending(data)) {
                await patchRequest(ref(db, `transferRequests/${requestId}`), {
                    status: 'unknown',
                    unknownAt: Date.now(),
                    promotedFrom: 'stale_pending'
                });
                data.status = 'unknown';
            }

            if (data.status === 'unknown') {
                const resolved = await resolveUnknownTransfer(
                    requestId, data.txId, data.senderUid,
                    data.recipientUid, data.walletType, data.amount
                );

                if (resolved.status === 'success') {
                    showToast('✅ Transfer confirmed!', 'success');
                    removeActiveRequestId(requestId);
                    if (currentUserId) loadUserData(currentUserId);
                    continue;
                }
                if (resolved.status === 'failed') {
                    showToast('❌ Transfer failed & refunded.', 'error');
                    removeActiveRequestId(requestId);
                    if (currentUserId) loadUserData(currentUserId);
                    continue;
                }

                anyBlocking = true;
                const btn = document.getElementById('sendBtn');
                if (btn) {
                    btn.disabled = true;
                    btn.className = 'btn-send verifying';
                    btn.innerHTML = '<i class="bi bi-hourglass-split me-2"></i>Verifying...';
                }
                transferLock = true;
                startReconciliationLoop(requestId, currentUserId);
            } else if (data.status === 'pending') {
                anyBlocking = true;
                const btn = document.getElementById('sendBtn');
                if (btn) {
                    btn.disabled = true;
                    btn.className = 'btn-send verifying';
                    btn.innerHTML = '<i class="bi bi-hourglass-split me-2"></i>Verifying...';
                }
                transferLock = true;
                startReconciliationLoop(requestId, currentUserId);
            }
        } catch (err) {
            console.warn(`Reconcile error for ${requestId}:`, err);
        }
    }

    startStaleChecker();
    return anyBlocking;
}

// ============================================================
// Balance
// ============================================================
function setupBalanceListener(uid) {
    if (balanceListenerOff) { balanceListenerOff(); balanceListenerOff = null; }
    balanceListenerOff = onValue(ref(db, 'users/' + uid), (snapshot) => {
        if (!snapshot.exists()) return;
        const u = snapshot.val();
        currentUserData = u;
        currentBalances.depositWallet = u.depositWallet || 0;
        currentBalances.referralWallet = u.referralWallet || 0;
        currentBalances.rndWallet = u.rndWallet || 0;
        updateBalanceUI();
    }, (error) => console.error('Balance error:', error));
}

function updateBalanceUI() {
    const dep = document.getElementById('balanceDeposit');
    const refEl = document.getElementById('balanceReferral');
    const rnd = document.getElementById('balanceRND');
    if (dep) dep.textContent = '$' + (currentBalances.depositWallet || 0).toFixed(2);
    if (refEl) refEl.textContent = '$' + (currentBalances.referralWallet || 0).toFixed(2);
    if (rnd) rnd.textContent = (currentBalances.rndWallet || 0).toFixed(4) + ' RND';
    updateAvailableText();
}

function updateAvailableText() {
    const select = document.getElementById('walletSelect');
    if (!select) return;
    const walletType = select.value;
    const balance = currentBalances[walletType] || 0;
    const availText = document.getElementById('availableText');
    if (availText)
        availText.textContent = balance.toFixed(WALLET_PRECISION[walletType]) + ' ' + WALLET_CURRENCY[walletType];
}

window.setMaxAmount = function () {
    const walletType = document.getElementById('walletSelect').value;
    const balance = currentBalances[walletType] || 0;
    document.getElementById('amountInput').value = balance.toFixed(WALLET_PRECISION[walletType]);
};

// ============================================================
// Recent transfers
// ============================================================
function renderRecentTransfers(u) {
    const container = document.getElementById('recentTransfers');
    if (!container) return;

    let rawHistory = u.transferHistory || [];
    let arr = Array.isArray(rawHistory) ? rawHistory : Object.values(rawHistory).filter(Boolean);
    arr.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const recent = arr.slice(0, 5);

    if (recent.length === 0) {
        container.innerHTML = `<div style="text-align: center; color: #64748b; padding: 20px; font-size: 0.85rem;"><i class="bi bi-clock"></i> No transfers yet</div>`;
        return;
    }

    container.innerHTML = recent.map(t => {
        const isSent = t.type === 'sent';
        const name = isSent ? (t.to || t.toUsername || 'Unknown') : (t.from || t.fromUsername || 'Unknown');
        const uid = isSent ? (t.toUid || '') : (t.fromUid || '');
        const sign = isSent ? '-' : '+';
        const cls = isSent ? 'transfer-sent' : 'transfer-received';
        const date = t.timestamp ? new Date(t.timestamp).toLocaleString('hi-IN') : '';
        const statusBadge = t.status === 'reversed'
            ? ' <span style="color:#f59e0b;font-size:0.7rem;">(reversed)</span>'
            : '';
        return `
            <div class="transfer-item">
                <div>
                    <div class="${cls}" style="font-size: 0.85rem;">
                        <i class="bi bi-arrow-${isSent ? 'up-right' : 'down-left'}"></i>
                        ${isSent ? 'Sent to' : 'Received from'}
                        <span class="transfer-name">${name}</span>${statusBadge}
                    </div>
                    ${uid ? `<div style="font-size: 0.7rem; color: #64748b; margin-top: 2px;">ID: ${uid.slice(0, 12)}...</div>` : ''}
                    <div class="transfer-date">${date}</div>
                </div>
                <div class="transfer-amount ${cls}">${sign}${t.amount} ${t.currency || 'RND'}</div>
            </div>
        `;
    }).join('');
}

// ============================================================
// Load user data
// ============================================================
async function loadUserData(uid) {
    try {
        const snap = await get(ref(db, 'users/' + uid));
        if (!snap.exists()) { showToast('❌ User not found', 'error'); return; }
        const u = snap.val();
        currentUserData = u;
        currentBalances.depositWallet = u.depositWallet || 0;
        currentBalances.referralWallet = u.referralWallet || 0;
        currentBalances.rndWallet = u.rndWallet || 0;
        updateBalanceUI();
        renderRecentTransfers(u);
    } catch (err) {
        console.error('Load error:', err);
    }
}

// ============================================================
// Init
// ============================================================
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'login.html';
        return;
    }
    currentUserId = user.uid;

    const snap = await get(ref(db, 'users/' + user.uid));
    if (!snap.exists()) {
        showToast('❌ User not found', 'error');
        setTimeout(() => window.location.href = 'dashboard.html', 2000);
        return;
    }

    await verifyPendingTransfersOnLoad();
    await loadUserData(user.uid);
    setupBalanceListener(user.uid);

    if (typeof window.__hideTransferLoader === 'function') {
        window.__hideTransferLoader();
    }

    const form = document.getElementById('transferForm');
    if (form) form.addEventListener('submit', handleTransferSubmit);

    // Setup
    document.getElementById('setupBtn')?.addEventListener('click', handlePasswordSetup);
    document.getElementById('setupPasswordConfirm')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handlePasswordSetup();
    });

    // Verify
    document.getElementById('verifyBtn')?.addEventListener('click', handlePasswordVerify);
    document.getElementById('verifyPassword')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handlePasswordVerify();
    });
    document.getElementById('verifyCancelBtn')?.addEventListener('click', () => {
        closeModal('verifyModal');
        pendingTransfer = null;
        resetButton();
    });

    // Forgot Password
    document.getElementById('forgotPasswordBtn')?.addEventListener('click', () => {
        closeModal('verifyModal');
        openModal('forgotModal');
        setTimeout(() => document.getElementById('forgotAccountPassword')?.focus(), 200);
    });
    document.getElementById('forgotVerifyBtn')?.addEventListener('click', handleForgotVerify);
    document.getElementById('forgotAccountPassword')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleForgotVerify();
    });
    document.getElementById('forgotResetBtn')?.addEventListener('click', handleForgotReset);
    document.getElementById('forgotNewPasswordConfirm')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleForgotReset();
    });
    document.getElementById('forgotCancelBtn1')?.addEventListener('click', () => {
        closeModal('forgotModal');
        pendingTransfer = null;
        resetButton();
    });

    // Wallet change
    const select = document.getElementById('walletSelect');
    if (select) {
        select.addEventListener('change', () => {
            updateAvailableText();
            const walletType = select.value;
            const amountInput = document.getElementById('amountInput');
            if (walletType === 'rndWallet') {
                amountInput.step = '0.00000001';
                amountInput.min = '0.00000001';
            } else {
                amountInput.step = '0.01';
                amountInput.min = '0.01';
            }
        });
    }

    // 🔥 Background recheck on visibility change
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && getActiveRequestIds().length > 0) {
            verifyPendingTransfersOnLoad();
        }
    });

    // 🔥 Background recheck on network online
    window.addEventListener('online', () => {
        if (getActiveRequestIds().length > 0) {
            verifyPendingTransfersOnLoad();
        }
    });
});

// ============================================================
// Cleanup
// ============================================================
window.addEventListener('beforeunload', () => {
    if (balanceListenerOff) { balanceListenerOff(); balanceListenerOff = null; }
    if (reconciliationTimer) { clearTimeout(reconciliationTimer); reconciliationTimer = null; }
    if (staleCheckTimer) { clearInterval(staleCheckTimer); staleCheckTimer = null; }
});

// ============================================================
// 🔥 UI Logic (Loader & Sidebar) — Added for HTML fix
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    // Hide loader after 1.5 seconds (fallback)
    setTimeout(() => {
        const loader = document.getElementById('pageLoader');
        if (loader) {
            loader.style.opacity = '0';
            setTimeout(() => loader.style.display = 'none', 400);
            document.body.classList.remove('loading');
        }
    }, 1500);

    // Sidebar toggle
    const sidebarPanel = document.getElementById('sidebarPanel');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    const sidebarToggle = document.getElementById('sidebarToggle');
    const sidebarClose = document.getElementById('sidebarClose');

    if (sidebarToggle) {
        sidebarToggle.addEventListener('click', () => {
            sidebarPanel.classList.add('open');
            sidebarOverlay.classList.add('active');
            document.body.style.overflow = 'hidden';
        });
    }
    if (sidebarClose) {
        sidebarClose.addEventListener('click', () => {
            sidebarPanel.classList.remove('open');
            sidebarOverlay.classList.remove('active');
            document.body.style.overflow = '';
        });
    }
    if (sidebarOverlay) {
        sidebarOverlay.addEventListener('click', () => {
            sidebarPanel.classList.remove('open');
            sidebarOverlay.classList.remove('active');
            document.body.style.overflow = '';
        });
    }

    // Logout
    const logoutBtn = document.getElementById('logoutBtnSidebar');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            try {
                // signOut function needs to be imported or accessed. 
                // Since it's not imported at the top, we import it dynamically here.
                const { signOut } = await import("firebase/auth");
                await signOut(auth);
                window.location.href = 'login.html';
            } catch (err) {
                console.error('Logout error:', err);
                window.location.href = 'login.html';
            }
        });
    }
});
