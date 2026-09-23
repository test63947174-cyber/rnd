// ============================================================
// 🔥 WITHDRAWAL PAGE LOGIC - RND STAKING (v10 - Production Hardened)
// ============================================================
// 🔥 Fixes over v9:
//   - Pending requestId is USER-SPECIFIC (per-uid sessionStorage key)
//   - Pending intent stores requestId + walletType + amount + currency + address
//     → requestId is reused ONLY if all details match; otherwise a new one is created
//   - `checking` state is NOT treated as duplicate-completed; it is re-reconciled
//   - Request state machine enforced (processing / checking / root_pending / completed / failed)
//   - Root withdrawal write failure → request status `root_pending` (retried on next load)
//   - Request marked `completed` ONLY AFTER root write succeeds
//   - Transactions object cloned inside transaction (no mutation)
//   - Local saved-address state only updated when Firebase save succeeds
// ============================================================

import { initializeApp } from "firebase/app";
import {
    getAuth,
    onAuthStateChanged,
    signOut,
    EmailAuthProvider,
    reauthenticateWithCredential
} from "firebase/auth";
import { getDatabase, ref, get, set, update, runTransaction, remove } from "firebase/database";

// ============================================================
// 🔥 FIREBASE CONFIG
// ============================================================
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

console.log('✅ Firebase initialized with NEW config (rwebsite-e031b)');

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// ============================================================
// 🔥 CONSTANTS
// ============================================================
const WITHDRAW_CONFIG = {
    referralWallet: { min: 20, currency: 'USDT', label: 'Referral Wallet' },
    rndWallet:      { min: 5,  currency: 'RND',  label: 'RND Wallet' }
};

const BEP20_REGEX = /^0x[a-fA-F0-9]{40}$/;
const PASSWORD_MIN_LEN = 6;
const AMOUNT_REGEX = /^\d+(?:\.\d{1,8})?$/;

// 🔥 Allowed state transitions for a withdrawal request
const ALLOWED_TRANSITIONS = {
    processing:   ['checking', 'root_pending', 'completed', 'failed'],
    checking:     ['processing', 'root_pending', 'completed', 'failed'],
    root_pending: ['completed', 'failed'],
    completed:    [],
    failed:       []
};

function isTransitionAllowed(from, to) {
    if (!from) return true; // first write
    const allowed = ALLOWED_TRANSITIONS[from];
    if (!allowed) return false;
    return allowed.includes(to);
}

// ============================================================
// 🔐 HASH (djb2-based, salted with uid)
// ============================================================
function hashWithdrawalPassword(uid, password) {
    const input = `rnd_${uid}_${password}_stake_v6`;
    let hash = 5381;
    for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) + hash) + input.charCodeAt(i);
        hash = hash & 0xffffffff;
    }
    let h2 = 52711;
    for (let i = input.length - 1; i >= 0; i--) {
        h2 = ((h2 << 5) + h2) ^ input.charCodeAt(i);
        h2 = h2 & 0xffffffff;
    }
    const part1 = (hash >>> 0).toString(16).padStart(8, '0');
    const part2 = (h2 >>> 0).toString(16).padStart(8, '0');
    return `wd_${part1}${part2}`;
}

// ============================================================
// 🔥 UTILITY
// ============================================================
function roundTo8(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.round((n + Number.EPSILON) * 100000000) / 100000000;
}

function generateRequestId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'wd_req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
}

// 🔥 Deterministic withdrawal ID derived from requestId
function deriveWithdrawalId(requestId) {
    const clean = String(requestId).replace(/[^a-zA-Z0-9_-]/g, '');
    return 'wd_' + clean.slice(0, 60);
}

// 🔥 XSS-safe toast (uses textContent)
function showToast(message, type = 'success', customDuration = null) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;

    const icons = {
        success: 'bi-check-circle-fill',
        error: 'bi-x-octagon-fill',
        info: 'bi-info-circle-fill',
        warning: 'bi-exclamation-triangle-fill'
    };
    const colors = {
        success: '#2ecc71',
        error: '#f87171',
        info: '#60a5fa',
        warning: '#fbbf24'
    };

    const icon = document.createElement('i');
    icon.className = `bi ${icons[type] || icons.info}`;
    icon.style.color = colors[type] || colors.info;

    const msg = document.createElement('span');
    msg.className = 'toast-msg';
    msg.textContent = String(message);

    toast.append(icon, msg);
    container.appendChild(toast);

    const duration = Number.isFinite(customDuration)
        ? customDuration
        : (type === 'error' ? 8000 : type === 'warning' ? 7000 : 5000);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// ============================================================
// 👁️ PASSWORD EYE TOGGLE
// ============================================================
function attachPasswordEyeToggles() {
    const pairs = [
        ['withdrawPasswordInput', 'toggleWdPwd1'],
        ['withdrawPasswordConfirm', 'toggleWdPwd2'],
        ['fpAccountPassword', 'toggleFpAcc'],
        ['fpNewPassword', 'toggleFpNew'],
        ['fpConfirmPassword', 'toggleFpConfirm']
    ];

    pairs.forEach(([inputId, btnId]) => {
        const input = document.getElementById(inputId);
        const btn = document.getElementById(btnId);
        if (!input || !btn) return;

        if (btn.dataset.eyeBound === '1') return;
        btn.dataset.eyeBound = '1';

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';

            const icon = btn.querySelector('i');
            if (icon) {
                icon.className = isPassword ? 'bi bi-eye-slash' : 'bi bi-eye';
            }
            btn.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
            input.focus();
        });
    });
}

// ============================================================
// 🔥 SIDEBAR
// ============================================================
const sidebarPanel = document.getElementById('sidebarPanel');
const sidebarOverlay = document.getElementById('sidebarOverlay');
const sidebarToggle = document.getElementById('sidebarToggle');
const sidebarClose = document.getElementById('sidebarClose');

function openSidebar() {
    if (!sidebarPanel || !sidebarOverlay) return;
    sidebarPanel.classList.add('open');
    sidebarOverlay.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeSidebar() {
    if (!sidebarPanel || !sidebarOverlay) return;
    sidebarPanel.classList.remove('open');
    sidebarOverlay.classList.remove('active');
    document.body.style.overflow = '';
}

if (sidebarToggle) sidebarToggle.addEventListener('click', openSidebar);
if (sidebarClose) sidebarClose.addEventListener('click', closeSidebar);
if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeSidebar);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidebar(); });

const logoutBtn = document.getElementById('logoutBtnSidebar');
if (logoutBtn) {
    logoutBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        try { await signOut(auth); } catch (err) { console.error('Logout error:', err); }
        window.location.href = 'login.html';
    });
}

// ============================================================
// 🔥 GET USER DATA
// ============================================================
async function getUserData(uid) {
    const snap = await get(ref(db, 'users/' + uid));
    return snap.exists() ? snap.val() : null;
}

// ============================================================
// 🔥 GET WITHDRAWAL HISTORY
// ============================================================
async function getWithdrawalHistory(uid) {
    const userSnap = await get(ref(db, 'users/' + uid));
    if (!userSnap.exists()) return [];

    const userData = userSnap.val();
    const transactions = userData.transactions || {};
    const withdrawals = [];

    for (let key in transactions) {
        const tx = transactions[key];
        if (tx && tx.type === 'withdrawal') {
            withdrawals.push({ id: key, ...tx });
        }
    }

    withdrawals.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return withdrawals;
}

// ============================================================
// 🔐 WITHDRAWAL SETTINGS
// ============================================================
async function getWithdrawalSettings(uid) {
    // Do not swallow network errors
    const snap = await get(ref(db, `users/${uid}/withdrawalSettings`));
    if (!snap.exists()) {
        return { savedAddress: '', addressUpdatedAt: 0, passwordHash: '', passwordUpdatedAt: 0 };
    }
    return snap.val() || {};
}

async function saveWithdrawalAddress(uid, address) {
    const cleanAddress = String(address || '').trim();
    if (!BEP20_REGEX.test(cleanAddress)) {
        throw new Error('Invalid BEP20 wallet address.');
    }
    const updates = {};
    updates[`users/${uid}/withdrawalSettings/savedAddress`] = cleanAddress;
    updates[`users/${uid}/withdrawalSettings/addressUpdatedAt`] = Date.now();
    await update(ref(db), updates);
    return true;
}

async function saveWithdrawalPasswordHash(uid, passwordHash) {
    const updates = {};
    updates[`users/${uid}/withdrawalSettings/passwordHash`] = passwordHash;
    updates[`users/${uid}/withdrawalSettings/passwordUpdatedAt`] = Date.now();
    await update(ref(db), updates);
    return true;
}

async function verifyWithdrawalPasswordFromDB(uid, password) {
    if (!password || String(password).length < PASSWORD_MIN_LEN) {
        return { ok: false, error: `Password must be at least ${PASSWORD_MIN_LEN} characters.` };
    }
    let settings;
    try {
        settings = await getWithdrawalSettings(uid);
    } catch (err) {
        return { ok: false, error: 'Could not verify password. Please try again.' };
    }
    const storedHash = String(settings.passwordHash || '').trim();

    if (!storedHash) {
        return { ok: false, error: 'NO_PASSWORD_SET' };
    }
    const inputHash = hashWithdrawalPassword(uid, String(password));
    if (inputHash !== storedHash) {
        return { ok: false, error: 'Incorrect withdrawal password.' };
    }
    return { ok: true };
}

// ============================================================
// 🔐 ACCOUNT PASSWORD RE-AUTHENTICATION
// ============================================================
async function verifyAccountPassword(user, password) {
    if (!user) throw new Error('Session expired. Please login again.');
    if (!user.email) throw new Error('Your account does not have an email address for verification.');
    if (!password) throw new Error('Please enter your account password.');

    const credential = EmailAuthProvider.credential(user.email, password);
    try {
        await reauthenticateWithCredential(user, credential);
        return true;
    } catch (err) {
        console.error('Account re-auth failed:', err);
        if (
            err.code === 'auth/wrong-password' ||
            err.code === 'auth/invalid-credential' ||
            err.code === 'auth/invalid-login-credentials'
        ) {
            throw new Error('Incorrect account password.');
        }
        if (err.code === 'auth/too-many-requests') {
            throw new Error('Too many failed attempts. Please try again later.');
        }
        throw new Error('Account verification failed. Please try again.');
    }
}

// ============================================================
// 🔥 PENDING REQUEST INTENT (per-user, per-details)
// ============================================================
function getPendingKey(uid) {
    return `rnd_pending_withdrawal_${uid}`;
}

function getPendingIntent(uid) {
    try {
        const raw = sessionStorage.getItem(getPendingKey(uid));
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || !obj.requestId) return null;
        return obj;
    } catch (e) {
        return null;
    }
}

function setPendingIntent(uid, intent) {
    try {
        if (intent) sessionStorage.setItem(getPendingKey(uid), JSON.stringify(intent));
        else sessionStorage.removeItem(getPendingKey(uid));
    } catch (e) { /* ignore */ }
}

function clearPendingIntent(uid) {
    try { sessionStorage.removeItem(getPendingKey(uid)); } catch (e) {}
}

function intentMatches(intent, details) {
    if (!intent) return false;
    return (
        intent.walletType === details.walletType &&
        roundTo8(intent.amount) === roundTo8(details.amount) &&
        intent.currency === details.currency &&
        String(intent.address || '').toLowerCase() === String(details.address || '').toLowerCase()
    );
}

// ============================================================
// 🔥 CHECK DUPLICATE REQUEST
// ============================================================
async function checkDuplicateRequest(uid, requestId) {
    try {
        const snap = await get(ref(db, `users/${uid}/withdrawalRequests/${requestId}`));
        if (snap.exists()) {
            return { isDuplicate: true, data: snap.val(), statusUnknown: false };
        }
        return { isDuplicate: false, statusUnknown: false };
    } catch (err) {
        console.warn('Duplicate check error:', err);
        return { isDuplicate: false, statusUnknown: true, error: err };
    }
}

// ============================================================
// 🔥 RESERVE REQUEST SLOT
// ============================================================
async function reserveRequestSlot(uid, requestId, payload) {
    const slotRef = ref(db, `users/${uid}/withdrawalRequests/${requestId}`);
    try {
        const result = await runTransaction(slotRef, (currentData) => {
            if (currentData !== null) return; // abort (undefined)
            return {
                requestId,
                uid,
                walletType: payload.walletType,
                amount: payload.amount,
                currency: payload.currency,
                address: payload.address,
                status: 'processing',
                createdAt: Date.now()
            };
        });
        return result.committed;
    } catch (err) {
        console.error('Reserve slot error:', err);
        return false;
    }
}

// ============================================================
// 🔥 UPDATE REQUEST SLOT (state-machine enforced)
// ============================================================
async function updateRequestSlot(uid, requestId, updates) {
    try {
        const slotRef = ref(db, `users/${uid}/withdrawalRequests/${requestId}`);
        await runTransaction(slotRef, (currentData) => {
            if (currentData === null) return; // abort
            const nextStatus = updates.status;
            if (nextStatus && currentData.status && nextStatus !== currentData.status) {
                if (!isTransitionAllowed(currentData.status, nextStatus)) {
                    console.warn('⚠️ Invalid state transition blocked:', currentData.status, '→', nextStatus);
                    return; // abort
                }
            }
            return { ...currentData, ...updates };
        });
    } catch (err) {
        console.warn('Could not update request slot:', err);
    }
}

// ============================================================
// 🔥 ATOMIC WITHDRAWAL PROCESS
// ============================================================
async function processAtomicWithdrawal(uid, walletType, amount, address, currency, withdrawalId, requestId) {
    const cfg = WITHDRAW_CONFIG[walletType];
    if (!cfg) return { success: false, error: 'Invalid wallet type.' };

    if (!BEP20_REGEX.test(String(address || ''))) {
        return { success: false, error: 'Invalid BEP20 address.' };
    }

    const amt = roundTo8(amount);
    if (!Number.isFinite(amt) || amt <= 0) return { success: false, error: 'Invalid amount.' };
    if (amt < cfg.min) return { success: false, error: `Minimum withdrawal is ${cfg.min} ${cfg.currency}.` };

    const userRef = ref(db, 'users/' + uid);
    const now = Date.now();

    try {
        const result = await runTransaction(userRef, (currentData) => {
            if (!currentData) return;

            // 🔥 Clone transactions (do not mutate original)
            const transactions = { ...(currentData.transactions || {}) };

            for (let key in transactions) {
                const tx = transactions[key];
                if (
                    tx &&
                    tx.type === 'withdrawal' &&
                    (tx.requestId === requestId || tx.withdrawalId === withdrawalId)
                ) {
                    console.warn('⚠️ Duplicate withdrawal detected:', requestId);
                    return;
                }
            }

            const balance = roundTo8(currentData[walletType] || 0);
            if (!Number.isFinite(balance) || balance < 0) return;
            if (balance < amt) return;

            const newBalance = roundTo8(balance - amt);
            if (newBalance < 0 || !Number.isFinite(newBalance)) return;

            const txId = 'tx_' + String(requestId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);

            transactions[txId] = {
                type: 'withdrawal',
                withdrawalId,
                requestId,
                amount: amt,
                currency,
                walletType,
                walletAddress: address,
                timestamp: now,
                date: new Date().toDateString(),
                status: 'pending',
                description: `Withdrawal of ${amt} ${currency} to ${address.substring(0, 15)}...`
            };

            return {
                ...currentData,
                [walletType]: newBalance,
                transactions
            };
        });

        if (result.committed && result.snapshot && result.snapshot.exists()) {
            const updated = result.snapshot.val();
            const newBal = roundTo8(updated[walletType] || 0);
            console.log('✅ Atomic withdrawal committed:', withdrawalId, '| New balance:', newBal);
            return { success: true, withdrawalId, newBalance: newBal };
        } else {
            console.warn('⚠️ Atomic withdrawal not committed:', withdrawalId);
            return { success: false, error: 'Insufficient balance or duplicate request' };
        }
    } catch (err) {
        console.error('❌ Atomic withdrawal error:', err);
        return { success: false, error: err.message || 'Transaction failed' };
    }
}

// ============================================================
// 🔥 ROOT WITHDRAWAL (deterministic, idempotent)
// ============================================================
async function writeRootWithdrawal(withdrawalId, payload) {
    await set(ref(db, 'withdrawals/' + withdrawalId), payload);
}

// ============================================================
// 🔥 RECONCILE PENDING REQUESTS
// ============================================================
async function reconcilePendingRequests(uid) {
    try {
        const reqRef = ref(db, `users/${uid}/withdrawalRequests`);
        const snap = await get(reqRef);
        if (!snap.exists()) return [];

        const requests = snap.val();
        const results = [];

        // Read user data once
        let userData = null;
        try {
            const userSnap = await get(ref(db, 'users/' + uid));
            userData = userSnap.exists() ? userSnap.val() : null;
        } catch (err) {
            console.warn('Reconcile: could not read user data:', err);
            return [];
        }

        const transactions = userData?.transactions || {};

        for (const [requestId, data] of Object.entries(requests)) {
            if (!data || !data.status) continue;
            if (data.status === 'completed' || data.status === 'failed') continue;

            // Look for matching transaction
            let txFound = null;
            for (let key in transactions) {
                const tx = transactions[key];
                if (tx && tx.type === 'withdrawal' && tx.requestId === requestId) {
                    txFound = tx;
                    break;
                }
            }

            const withdrawalId = data.withdrawalId || deriveWithdrawalId(requestId);

            if (txFound) {
                // Transaction exists → check root withdrawal
                let rootOk = false;
                try {
                    const rootSnap = await get(ref(db, 'withdrawals/' + withdrawalId));
                    rootOk = rootSnap.exists();
                } catch (err) {
                    console.warn('Reconcile: root read error:', err);
                }

                if (!rootOk) {
                    // Write root (idempotent since deterministic)
                    try {
                        await writeRootWithdrawal(withdrawalId, {
                            uid,
                            withdrawalId,
                            requestId,
                            amount: txFound.amount,
                            currency: txFound.currency,
                            walletType: txFound.walletType,
                            wallet: txFound.walletAddress,
                            status: 'pending',
                            timestamp: txFound.timestamp || Date.now()
                        });
                        rootOk = true;
                    } catch (err) {
                        console.warn('Reconcile: root write failed:', err);
                    }
                }

                if (rootOk) {
                    await updateRequestSlot(uid, requestId, {
                        status: 'completed',
                        withdrawalId,
                        completedAt: Date.now()
                    });
                    results.push({ requestId, status: 'completed' });
                } else {
                    await updateRequestSlot(uid, requestId, {
                        status: 'root_pending',
                        withdrawalId,
                        rootPendingAt: Date.now()
                    });
                    results.push({ requestId, status: 'root_pending' });
                }
            } else {
                // Transaction not found. Could be:
                //   - genuinely failed (never committed)
                //   - or read failed / still pending
                // Mark as `checking` and let the user retry after verifying.
                if (data.status !== 'checking') {
                    await updateRequestSlot(uid, requestId, {
                        status: 'checking',
                        checkedAt: Date.now()
                    });
                }
                results.push({ requestId, status: 'checking' });
            }
        }
        return results;
    } catch (err) {
        console.warn('Reconcile error:', err);
        return [];
    }
}

// ============================================================
// 🔥 RENDER WITHDRAWAL UI
// ============================================================
function renderWithdrawalUI(userData, withdrawals) {
    const container = document.getElementById('withdrawalContent');
    if (!container) return;

    const depositWallet  = Number(userData.depositWallet) || 0;
    const referralWallet = Number(userData.referralWallet) || 0;
    const rndWallet      = Number(userData.rndWallet) || 0;
    const lockedRND      = Number(userData.lockedRND) || 0;

    let historyHtml = '';
    if (withdrawals.length === 0) {
        historyHtml = `
            <div class="empty-state">
                <i class="bi bi-inbox"></i>
                <p>No withdrawal requests yet.</p>
            </div>
        `;
    } else {
        historyHtml = `<div class="withdrawal-history">` + withdrawals.map((w) => {
            let statusHtml = '';
            if (w.status === 'pending')        statusHtml = '<span class="status-pending"><i class="bi bi-clock"></i>Pending</span>';
            else if (w.status === 'approved')  statusHtml = '<span class="status-approved"><i class="bi bi-check-circle-fill"></i>Approved</span>';
            else if (w.status === 'rejected')  statusHtml = '<span class="status-rejected"><i class="bi bi-x-circle-fill"></i>Rejected</span>';
            else                                statusHtml = '<span class="status-pending">Pending</span>';

            const currency = w.currency || 'RND';
            const walletLabel = w.walletType === 'referralWallet' ? '💳 Referral Wallet' : '📊 RND Wallet';
            const dateStr = w.timestamp ? new Date(w.timestamp).toLocaleString('en-IN') : 'N/A';

            return `
                <div class="transaction-item">
                    <div>
                        <div class="amount">${Number(w.amount).toFixed(4)} ${currency}</div>
                        <div style="font-size:0.72rem;color:var(--text-secondary);margin-top:2px;">${walletLabel}</div>
                        <div class="date">${dateStr}</div>
                        ${w.walletAddress ? `<div style="font-size:0.62rem;color:var(--text-muted);font-family:'Courier New',monospace;margin-top:2px;">${w.walletAddress.substring(0, 24)}...</div>` : ''}
                    </div>
                    <div>${statusHtml}</div>
                </div>
            `;
        }).join('') + `</div>`;
    }

    container.innerHTML = `
        <div class="row g-4">
            <div class="col-12">
                <div class="page-header-section">
                    <h4><i class="bi bi-arrow-up-circle"></i> Withdraw Funds</h4>
                    <span class="badge-mini-pill pill-green"><i class="bi bi-shield-check"></i> Secure Withdrawal</span>
                </div>
            </div>

            <div class="col-12">
                <div class="row g-3">
                    <div class="col-6 col-lg-3">
                        <div class="wallet-card-new deposit">
                            <div class="wallet-card-header">
                                <span class="wallet-card-label">Deposit Wallet</span>
                                <div class="wallet-card-icon"><i class="bi bi-wallet2"></i></div>
                            </div>
                            <div class="wallet-card-value">$${depositWallet.toFixed(2)}<span class="wallet-card-currency">USDT</span></div>
                            <div class="wallet-card-footer">
                                <i class="bi bi-lock-fill"></i>
                                <span class="badge-mini-pill pill-red">🔒 Not for Withdrawal</span>
                            </div>
                        </div>
                    </div>

                    <div class="col-6 col-lg-3">
                        <div class="wallet-card-new referral">
                            <div class="wallet-card-header">
                                <span class="wallet-card-label">Referral Wallet</span>
                                <div class="wallet-card-icon"><i class="bi bi-people-fill"></i></div>
                            </div>
                            <div class="wallet-card-value">${referralWallet.toFixed(2)}<span class="wallet-card-currency">USDT</span></div>
                            <div class="wallet-card-footer">
                                <i class="bi bi-check-circle-fill"></i>
                                <span class="badge-mini-pill pill-green">✅ Min: 20 USDT</span>
                            </div>
                        </div>
                    </div>

                    <div class="col-6 col-lg-3">
                        <div class="wallet-card-new rnd">
                            <div class="wallet-card-header">
                                <span class="wallet-card-label">RND Wallet</span>
                                <div class="wallet-card-icon"><i class="bi bi-database"></i></div>
                            </div>
                            <div class="wallet-card-value">${rndWallet.toFixed(4)}<span class="wallet-card-currency">RND</span></div>
                            <div class="wallet-card-footer">
                                <i class="bi bi-check-circle-fill"></i>
                                <span class="badge-mini-pill pill-green">✅ Min: 5 RND</span>
                            </div>
                        </div>
                    </div>

                    <div class="col-6 col-lg-3">
                        <div class="wallet-card-new locked">
                            <div class="wallet-card-header">
                                <span class="wallet-card-label">Locked RND</span>
                                <div class="wallet-card-icon"><i class="bi bi-lock"></i></div>
                            </div>
                            <div class="wallet-card-value">${lockedRND.toFixed(2)}<span class="wallet-card-currency">RND</span></div>
                            <div class="wallet-card-footer">
                                <i class="bi bi-lock-fill"></i>
                                <span class="badge-mini-pill pill-red">🔒 Locked</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="col-lg-7 mx-auto">
                <div class="card-glass">
                    <div class="card-title"><i class="bi bi-arrow-up-circle"></i> Request Withdrawal</div>

                    <div class="info-alert">
                        <i class="bi bi-info-circle"></i>
                        <strong>Withdrawal Limits:</strong>
                        <br>💳 <strong>Referral Wallet:</strong> Min <strong>20 USDT</strong> (BEP20)
                        <br>📊 <strong>RND Wallet:</strong> Min <strong>5 RND</strong> (BEP20)
                        <br>🔒 Deposit & Locked wallets cannot be withdrawn.
                    </div>

                    <div class="row g-2 mb-3">
                        <div class="col-6">
                            <div class="withdraw-option-card selected" id="optionReferral" data-wallet="referralWallet">
                                <div class="option-icon">💳</div>
                                <div class="option-label">Referral Wallet</div>
                                <div class="option-balance">${referralWallet.toFixed(2)} USDT</div>
                                <div class="min-label referral-min">Min: 20 USDT (BEP20)</div>
                            </div>
                        </div>
                        <div class="col-6">
                            <div class="withdraw-option-card" id="optionRND" data-wallet="rndWallet">
                                <div class="option-icon">📊</div>
                                <div class="option-label">RND Wallet</div>
                                <div class="option-balance">${rndWallet.toFixed(4)} RND</div>
                                <div class="min-label rnd-min">Min: 5 RND (BEP20)</div>
                            </div>
                        </div>
                    </div>

                    <form id="withdrawForm" autocomplete="off">
                        <div class="mb-3">
                            <label class="form-label" for="selectedWalletDisplay">Selected Wallet <span class="required">*</span></label>
                            <input type="text" id="selectedWalletDisplay" class="form-control form-control-custom" value="Referral Wallet (USDT - BEP20)" readonly>
                            <input type="hidden" id="selectedWallet" value="referralWallet">
                        </div>
                        <div class="mb-3">
                            <label class="form-label" for="withAmount">Amount <span class="required">*</span></label>
                            <input type="number" id="withAmount" class="form-control form-control-custom"
                                   placeholder="Enter amount" min="0.00000001" step="any" required>
                            <small class="form-hint" id="minAmountHint">Minimum: 20 USDT (BEP20) for Referral Wallet</small>
                        </div>

                        <div class="mb-3">
                            <label class="form-label">Wallet Address (BEP20) <span class="required">*</span></label>

                            <div id="savedAddressBox"></div>

                            <div id="addressInputBox" style="display:none;">
                                <input type="text" id="withAddr" class="form-control form-control-custom"
                                       placeholder="0x..." autocomplete="off">
                                <small class="form-hint">Enter your BEP20 wallet address (must start with 0x)</small>

                                <div id="saveAddressOption" style="display:none; margin-top:10px; padding:10px 12px;
                                     border-radius:10px; background:rgba(96,165,250,.06);
                                     border:1px solid rgba(96,165,250,.18);">
                                    <label style="display:flex; align-items:flex-start; gap:9px;
                                                  cursor:pointer; font-size:.82rem; margin:0;">
                                        <input type="checkbox" id="saveWithdrawalAddress" style="margin-top:3px;">
                                        <span>
                                            <strong style="color:var(--text-primary);">Save this wallet address</strong><br>
                                            <small style="color:var(--text-secondary);">
                                                You won't need to enter it again next time.
                                            </small>
                                        </span>
                                    </label>
                                </div>
                            </div>
                        </div>

                        <button type="submit" class="btn-primary-custom" id="withdrawBtn">
                            <i class="bi bi-arrow-up-circle"></i>
                            <span>Submit Withdrawal</span>
                        </button>
                    </form>

                    <div class="mt-3">
                        <a href="dashboard.html" class="btn-outline-custom">
                            <i class="bi bi-arrow-left"></i> Back to Dashboard
                        </a>
                    </div>
                </div>
            </div>

            <div class="col-lg-7 mx-auto">
                <div class="card-glass">
                    <div class="card-title"><i class="bi bi-clock-history"></i> Withdrawal History</div>
                    ${historyHtml}
                </div>
            </div>
        </div>
    `;
}

// ============================================================
// 🔥 WITHDRAW OPTION SWITCHER
// ============================================================
function attachOptionHandlers() {
    const optionReferral = document.getElementById('optionReferral');
    const optionRND = document.getElementById('optionRND');

    function selectOption(walletType) {
        document.querySelectorAll('.withdraw-option-card').forEach(el => el.classList.remove('selected'));

        if (walletType === 'referralWallet') {
            optionReferral.classList.add('selected');
            document.getElementById('selectedWalletDisplay').value = 'Referral Wallet (USDT - BEP20)';
            document.getElementById('selectedWallet').value = 'referralWallet';
            const hint = document.getElementById('minAmountHint');
            hint.textContent = 'Minimum: 20 USDT (BEP20) for Referral Wallet';
            hint.style.color = '#fbbf24';
        } else {
            optionRND.classList.add('selected');
            document.getElementById('selectedWalletDisplay').value = 'RND Wallet (RND - BEP20)';
            document.getElementById('selectedWallet').value = 'rndWallet';
            const hint = document.getElementById('minAmountHint');
            hint.textContent = 'Minimum: 5 RND (BEP20) for RND Wallet';
            hint.style.color = '#60a5fa';
        }
    }

    if (optionReferral) optionReferral.addEventListener('click', () => selectOption('referralWallet'));
    if (optionRND) optionRND.addEventListener('click', () => selectOption('rndWallet'));
}

// ============================================================
// 🔐 WITHDRAWAL PASSWORD MODAL
// ============================================================
function openWithdrawPasswordModal(uid, { mode, onSuccess }) {
    const modalEl = document.getElementById('withdrawPasswordModal');
    if (!modalEl) {
        showToast('Password UI unavailable.', 'error');
        return;
    }

    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    const titleEl = document.getElementById('wdPwdModalTitle');
    const infoEl = document.getElementById('wdPwdInfo');
    const inputEl = document.getElementById('withdrawPasswordInput');
    const confirmWrap = document.getElementById('wdPwdConfirmWrap');
    const confirmEl = document.getElementById('withdrawPasswordConfirm');
    const errEl = document.getElementById('withdrawPasswordError');
    const confirmBtn = document.getElementById('confirmWithdrawPasswordBtn');
    const btnText = document.getElementById('wdPwdBtnText');
    const forgotBtn = document.getElementById('forgotWithdrawPasswordBtn');

    inputEl.value = '';
    confirmEl.value = '';
    errEl.style.display = 'none';
    errEl.textContent = '';

    [inputEl, confirmEl].forEach((el) => { if (el) el.type = 'password'; });
    document.querySelectorAll('#withdrawPasswordModal .pwd-eye-btn i').forEach((ic) => {
        ic.className = 'bi bi-eye';
    });

    if (mode === 'set') {
        titleEl.innerHTML = `<i class="bi bi-shield-lock-fill" style="color:var(--primary);"></i> Set Withdrawal Password`;
        infoEl.innerHTML = `Set a <strong style="color:#2ecc71;">strong withdrawal password</strong> (min 6 characters). You will need it for every withdrawal and to change your saved address.`;
        btnText.textContent = 'Set Password';
        forgotBtn.style.display = 'none';
        confirmWrap.style.display = 'block';
    } else {
        titleEl.innerHTML = `<i class="bi bi-shield-lock-fill" style="color:var(--primary);"></i> Withdrawal Password`;
        infoEl.innerHTML = `Enter your <strong style="color:#2ecc71;">withdrawal password</strong> to continue.`;
        btnText.textContent = 'Verify';
        forgotBtn.style.display = 'inline-block';
        confirmWrap.style.display = 'none';
    }

    confirmBtn.onclick = async () => {
        const pwd = String(inputEl.value || '');
        const confirmPwd = String(confirmEl.value || '');

        if (!pwd || pwd.length < PASSWORD_MIN_LEN) {
            errEl.textContent = `Password must be at least ${PASSWORD_MIN_LEN} characters.`;
            errEl.style.display = 'block';
            return;
        }
        if (mode === 'set' && pwd !== confirmPwd) {
            errEl.textContent = 'Password and confirm password do not match.';
            errEl.style.display = 'block';
            return;
        }

        confirmBtn.disabled = true;
        const origHTML = confirmBtn.innerHTML;
        confirmBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>Please wait...`;
        errEl.style.display = 'none';

        try {
            if (mode === 'set') {
                const hash = hashWithdrawalPassword(uid, pwd);
                await saveWithdrawalPasswordHash(uid, hash);
                showToast('✅ Withdrawal password set successfully. Now click "Submit Withdrawal" again to proceed.', 'success', 7000);
                modal.hide();
                return;
            }

            const check = await verifyWithdrawalPasswordFromDB(uid, pwd);
            if (!check.ok) {
                if (check.error === 'NO_PASSWORD_SET') {
                    errEl.textContent = 'No withdrawal password set yet. Please set one now.';
                    errEl.style.display = 'block';
                    setTimeout(() => {
                        modal.hide();
                        openWithdrawPasswordModal(uid, { mode: 'set', onSuccess });
                    }, 900);
                    return;
                }
                errEl.textContent = check.error || 'Incorrect password.';
                errEl.style.display = 'block';
                return;
            }

            modal.hide();
            await onSuccess();
        } catch (err) {
            console.error('Withdrawal password error:', err);
            errEl.textContent = err.message || 'Something went wrong. Please try again.';
            errEl.style.display = 'block';
        } finally {
            confirmBtn.disabled = false;
            confirmBtn.innerHTML = origHTML;
        }
    };

    forgotBtn.onclick = () => {
        modal.hide();
        setTimeout(() => openForgotPasswordModal(uid, onSuccess), 350);
    };

    modal.show();
    setTimeout(() => inputEl.focus(), 300);
}

// ============================================================
// 🔐 FORGOT PASSWORD MODAL
// ============================================================
function openForgotPasswordModal(uid, onSuccess) {
    const modalEl = document.getElementById('forgotPasswordModal');
    if (!modalEl) {
        showToast('Forgot-password UI unavailable.', 'error');
        return;
    }

    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    const accEl = document.getElementById('fpAccountPassword');
    const newEl = document.getElementById('fpNewPassword');
    const confEl = document.getElementById('fpConfirmPassword');
    const errEl = document.getElementById('fpError');
    const btn = document.getElementById('confirmForgotPasswordBtn');

    accEl.value = '';
    newEl.value = '';
    confEl.value = '';
    errEl.style.display = 'none';
    errEl.textContent = '';

    [accEl, newEl, confEl].forEach((el) => { if (el) el.type = 'password'; });
    document.querySelectorAll('#forgotPasswordModal .pwd-eye-btn i').forEach((ic) => {
        ic.className = 'bi bi-eye';
    });

    btn.onclick = async () => {
        const accountPwd = String(accEl.value || '');
        const newPwd = String(newEl.value || '');
        const confPwd = String(confEl.value || '');

        if (!accountPwd) {
            errEl.textContent = 'Please enter your account password.';
            errEl.style.display = 'block';
            return;
        }
        if (!newPwd || newPwd.length < PASSWORD_MIN_LEN) {
            errEl.textContent = `New withdrawal password must be at least ${PASSWORD_MIN_LEN} characters.`;
            errEl.style.display = 'block';
            return;
        }
        if (newPwd !== confPwd) {
            errEl.textContent = 'New password and confirm password do not match.';
            errEl.style.display = 'block';
            return;
        }
        if (newPwd === accountPwd) {
            errEl.textContent = 'Withdrawal password should be different from your account password.';
            errEl.style.display = 'block';
            return;
        }

        btn.disabled = true;
        const origHTML = btn.innerHTML;
        btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>Please wait...`;
        errEl.style.display = 'none';

        try {
            const currentUser = auth.currentUser;
            await verifyAccountPassword(currentUser, accountPwd);

            const newHash = hashWithdrawalPassword(uid, newPwd);
            await saveWithdrawalPasswordHash(uid, newHash);

            showToast('✅ Withdrawal password reset successfully.', 'success');
            modal.hide();

            if (typeof onSuccess === 'function') {
                setTimeout(() => onSuccess(), 400);
            }
        } catch (err) {
            console.error('Forgot password error:', err);
            errEl.textContent = err.message || 'Something went wrong. Please try again.';
            errEl.style.display = 'block';
        } finally {
            btn.disabled = false;
            btn.innerHTML = origHTML;
        }
    };

    modal.show();
    setTimeout(() => accEl.focus(), 300);
}

// ============================================================
// 💳 SAVED ADDRESS UI
// ============================================================
async function initializeWithdrawalAddressUI(uid) {
    window.__currentUid = uid;

    const savedAddressBox = document.getElementById('savedAddressBox');
    const addressInputBox = document.getElementById('addressInputBox');
    if (!savedAddressBox || !addressInputBox) return;

    let settings;
    try {
        settings = await getWithdrawalSettings(uid);
    } catch (err) {
        console.warn('Could not load withdrawal settings:', err);
        settings = { savedAddress: '', passwordHash: '' };
    }
    const savedAddress = String(settings.savedAddress || '').trim();

    window.addressChangeMode = false;

    const existingRow = document.getElementById('changeAddressActionRow');
    if (existingRow) existingRow.remove();

    if (!savedAddress) {
        savedAddressBox.style.display = 'block';
        savedAddressBox.innerHTML = `
            <div style="border:1px dashed rgba(96,165,250,.35);
                        background:rgba(96,165,250,.04);
                        border-radius:12px; padding:14px;">
                <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
                    <i class="bi bi-wallet2" style="font-size:1.2rem;color:#60a5fa;"></i>
                    <strong style="color:#fff; font-size:.88rem;">Add your BEP20 wallet address</strong>
                </div>
                <div style="font-size:.78rem; color:var(--text-secondary); margin-bottom:12px;">
                    You can save this address for future withdrawals.
                </div>
                <button type="button" class="btn-outline-custom" id="enterAddressBtn"
                        style="width:auto; padding:10px 18px; font-size:.82rem;">
                    <i class="bi bi-plus-circle"></i> Add Wallet Address
                </button>
            </div>
        `;

        addressInputBox.style.display = 'none';
        window.currentSavedWithdrawalAddress = '';

        document.getElementById('enterAddressBtn')?.addEventListener('click', () => {
            addressInputBox.style.display = 'block';
            savedAddressBox.style.display = 'none';
            const saveOpt = document.getElementById('saveAddressOption');
            if (saveOpt) saveOpt.style.display = 'block';
            document.getElementById('withAddr')?.focus();
        });

        return;
    }

    const shortAddress = `${savedAddress.substring(0, 10)}...${savedAddress.slice(-8)}`;

    savedAddressBox.style.display = 'block';
    savedAddressBox.innerHTML = `
        <div style="border:1px solid rgba(46,204,113,.30);
                    background:rgba(46,204,113,.06);
                    border-radius:12px; padding:14px;">
            <div style="display:flex; justify-content:space-between;
                        align-items:center; gap:10px; flex-wrap:wrap;">
                <div style="min-width:0; flex:1;">
                    <div style="color:#2ecc71; font-size:.78rem;
                                font-weight:700; margin-bottom:5px;">
                        <i class="bi bi-shield-check"></i> SAVED BEP20 ADDRESS
                    </div>
                    <div style="font-family:'Courier New',monospace;
                                font-size:.82rem; color:#e2e8f0;
                                word-break:break-all;">
                        ${shortAddress}
                    </div>
                </div>
                <button type="button" class="btn-outline-custom"
                        id="changeAddressBtn"
                        style="width:auto; padding:8px 14px; font-size:.78rem; white-space:nowrap;">
                    <i class="bi bi-pencil"></i> Change
                </button>
            </div>
        </div>
    `;

    addressInputBox.style.display = 'none';
    window.currentSavedWithdrawalAddress = savedAddress;

    document.getElementById('changeAddressBtn')?.addEventListener('click', async () => {
        let currentSettings;
        try {
            currentSettings = await getWithdrawalSettings(uid);
        } catch (err) {
            showToast('❌ Could not load settings. Please try again.', 'error');
            return;
        }
        const hasPassword = !!(currentSettings.passwordHash && String(currentSettings.passwordHash).trim());

        if (!hasPassword) {
            showToast('Please set a withdrawal password first.', 'warning');
            openWithdrawPasswordModal(uid, {
                mode: 'set',
                onSuccess: () => {
                    showChangeAddressUI(savedAddress);
                }
            });
            return;
        }

        openWithdrawPasswordModal(uid, {
            mode: 'verify',
            onSuccess: () => {
                showChangeAddressUI(savedAddress);
            }
        });
    });
}

// ============================================================
// 🔄 CHANGE SAVED ADDRESS UI
// ============================================================
function showChangeAddressUI(oldAddress) {
    const savedAddressBox = document.getElementById('savedAddressBox');
    const addressInputBox = document.getElementById('addressInputBox');
    const addressInput = document.getElementById('withAddr');
    const saveOpt = document.getElementById('saveAddressOption');

    if (!savedAddressBox || !addressInputBox || !addressInput) return;

    savedAddressBox.style.display = 'block';
    savedAddressBox.innerHTML = `
        <div style="border:1px solid rgba(251,191,36,.30);
                    background:rgba(251,191,36,.06);
                    border-radius:12px; padding:14px;">
            <div style="color:#fbbf24; font-weight:700; font-size:.85rem; margin-bottom:6px;">
                <i class="bi bi-exclamation-triangle"></i> Change Wallet Address
            </div>
            <div style="font-size:.78rem; color:var(--text-secondary);">
                Enter your new BEP20 address below and click <strong>Save Address</strong>.
            </div>
        </div>
    `;

    addressInputBox.style.display = 'block';
    addressInput.value = '';
    addressInput.focus();

    if (saveOpt) saveOpt.style.display = 'none';

    let actionRow = document.getElementById('changeAddressActionRow');
    if (!actionRow) {
        actionRow = document.createElement('div');
        actionRow.id = 'changeAddressActionRow';
        actionRow.style.display = 'flex';
        actionRow.style.gap = '8px';
        actionRow.style.marginTop = '10px';
        actionRow.innerHTML = `
            <button type="button" class="btn-primary-custom" id="saveNewAddressBtn"
                    style="flex:1; padding:10px 16px; font-size:.85rem;">
                <i class="bi bi-check-circle"></i> Save Address
            </button>
            <button type="button" class="btn-outline-custom" id="cancelChangeAddressBtn"
                    style="flex:1; padding:10px 16px; font-size:.85rem;">
                <i class="bi bi-x-circle"></i> Cancel
            </button>
        `;
        addressInputBox.appendChild(actionRow);
    } else {
        actionRow.style.display = 'flex';
    }

    document.getElementById('cancelChangeAddressBtn').onclick = async () => {
        actionRow.style.display = 'none';
        addressInput.value = '';
        window.addressChangeMode = false;
        await initializeWithdrawalAddressUI(window.__currentUid);
    };

    document.getElementById('saveNewAddressBtn').onclick = async () => {
        const newAddr = String(addressInput.value || '').trim();

        if (!BEP20_REGEX.test(newAddr)) {
            showToast('❌ Please enter a valid BEP20 wallet address (0x + 40 hex chars).', 'error');
            return;
        }

        if (newAddr.toLowerCase() === String(oldAddress || '').toLowerCase()) {
            showToast('⚠️ This is already your saved address.', 'warning');
            return;
        }

        const btn = document.getElementById('saveNewAddressBtn');
        btn.disabled = true;
        const orig = btn.innerHTML;
        btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>Saving...`;

        try {
            const uid = window.__currentUid;
            if (!uid) throw new Error('Session issue. Please refresh the page.');

            await saveWithdrawalAddress(uid, newAddr);

            window.currentSavedWithdrawalAddress = newAddr;
            window.addressChangeMode = false;

            showToast('✅ Wallet address updated successfully.', 'success');
            actionRow.style.display = 'none';

            await initializeWithdrawalAddressUI(uid);
        } catch (err) {
            console.error('Save address error:', err);
            showToast('❌ ' + (err.message || 'Could not save address. Please try again.'), 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = orig;
        }
    };

    window.addressChangeMode = true;
    window.previousWithdrawalAddress = oldAddress;
}

// ============================================================
// 🔥 ATTACH WITHDRAW FORM HANDLER (v10)
// ============================================================
function attachWithdrawHandler(user) {
    const form = document.getElementById('withdrawForm');
    if (!form) return;

    let isSubmitting = false;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (isSubmitting) {
            showToast('⏳ Please wait, aapka request already process ho raha hai...', 'warning');
            return;
        }

        const walletType = document.getElementById('selectedWallet').value;
        const amountRaw = String(document.getElementById('withAmount').value || '').trim();
        const btn = document.getElementById('withdrawBtn');

        const cfg = WITHDRAW_CONFIG[walletType];
        if (!cfg) { showToast('❌ Invalid wallet selected.', 'error'); return; }

        if (!AMOUNT_REGEX.test(amountRaw)) {
            showToast('❌ Invalid amount format (max 8 decimals).', 'error');
            return;
        }

        const amount = roundTo8(Number(amountRaw));
        if (!Number.isFinite(amount) || amount <= 0) {
            showToast('❌ Please enter a valid amount greater than 0.', 'error');
            return;
        }
        if (amount < cfg.min) {
            showToast(`❌ Minimum withdrawal for ${cfg.label} is ${cfg.min} ${cfg.currency} (BEP20).`, 'error');
            return;
        }

        let address = '';
        const savedAddress = String(window.currentSavedWithdrawalAddress || '').trim();
        if (savedAddress && !window.addressChangeMode) {
            address = savedAddress;
        } else {
            const inputEl = document.getElementById('withAddr');
            address = inputEl ? inputEl.value.trim() : '';
        }

        if (!BEP20_REGEX.test(address)) {
            showToast('❌ Please enter a valid BEP20 wallet address.', 'error');
            return;
        }

        // LOCK
        isSubmitting = true;
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span>Processing...';
        }

        const releaseLock = () => {
            isSubmitting = false;
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="bi bi-arrow-up-circle"></i> Submit Withdrawal';
            }
        };

        try {
            // Fresh balance check
            const freshUser = await getUserData(user.uid);
            if (!freshUser) { showToast('❌ Unable to verify your balance. Please try again.', 'error'); releaseLock(); return; }

            const freshBalance = Number(freshUser[walletType]);
            if (!Number.isFinite(freshBalance) || freshBalance < 0) {
                showToast('❌ Unable to verify your balance. Please try again.', 'error'); releaseLock(); return;
            }
            if (freshBalance < amount) {
                showToast(`❌ Insufficient balance! You have only ${freshBalance.toFixed(4)} ${cfg.currency}.`, 'error');
                releaseLock(); return;
            }

            // Password settings
            let settings;
            try {
                settings = await getWithdrawalSettings(user.uid);
            } catch (err) {
                showToast('❌ Could not load settings. Please try again.', 'error');
                releaseLock(); return;
            }
            const hasPassword = !!(settings.passwordHash && String(settings.passwordHash).trim());
            const pwdMode = hasPassword ? 'verify' : 'set';

            // Pre-verify pending intent state BEFORE password modal
            const currentIntent = getPendingIntent(user.uid);
            const thisIntent = { walletType, amount, currency: cfg.currency, address };

            // If a previous pending intent exists for the SAME details, warn the user
            if (currentIntent && intentMatches(currentIntent, thisIntent)) {
                showToast('⚠️ A previous attempt with the same details is still pending. Verifying...', 'warning', 5000);
            } else if (currentIntent) {
                // Different details → drop the stale intent safely
                clearPendingIntent(user.uid);
            }

            const modalEl = document.getElementById('withdrawPasswordModal');
            let hiddenHandler = null;
            if (modalEl) {
                hiddenHandler = () => {
                    setTimeout(() => { if (isSubmitting) releaseLock(); }, 500);
                    modalEl.removeEventListener('hidden.bs.modal', hiddenHandler);
                };
                modalEl.addEventListener('hidden.bs.modal', hiddenHandler);
            }

            openWithdrawPasswordModal(user.uid, {
                mode: pwdMode,
                onSuccess: async () => {
                    try {
                        // 🔥 Resolve requestId from pending intent if details match
                        let requestId = '';
                        let existingIntent = getPendingIntent(user.uid);

                        if (existingIntent && intentMatches(existingIntent, thisIntent)) {
                            requestId = existingIntent.requestId;
                        } else {
                            requestId = generateRequestId();
                            setPendingIntent(user.uid, {
                                requestId,
                                walletType,
                                amount,
                                currency: cfg.currency,
                                address,
                                createdAt: Date.now()
                            });
                        }

                        const withdrawalId = deriveWithdrawalId(requestId);

                        // Duplicate check
                        const dupCheck = await checkDuplicateRequest(user.uid, requestId);

                        if (dupCheck.statusUnknown) {
                            showToast('⚠️ Request status could not be verified. Please try again.', 'warning', 8000);
                            releaseLock();
                            return;
                        }

                        if (dupCheck.isDuplicate) {
                            const reqStatus = String(dupCheck.data?.status || '');

                            if (reqStatus === 'completed') {
                                showToast('⚠️ Yeh withdrawal already complete ho chuki hai.', 'warning');
                                clearPendingIntent(user.uid);
                                setTimeout(() => window.location.reload(), 1500);
                                releaseLock();
                                return;
                            }

                            if (reqStatus === 'failed') {
                                // Failed state → allow fresh attempt with new requestId
                                clearPendingIntent(user.uid);
                                showToast('⚠️ Previous attempt failed. Please submit again.', 'warning', 6000);
                                releaseLock();
                                return;
                            }

                            if (reqStatus === 'processing' || reqStatus === 'checking' || reqStatus === 'root_pending') {
                                // Previous attempt is uncertain. Trigger reconciliation and ask user to wait.
                                showToast('⏳ A previous withdrawal is being verified. Please wait while we check...', 'warning', 8000);
                                try {
                                    await reconcilePendingRequests(user.uid);
                                } catch (e) {}
                                setTimeout(() => window.location.reload(), 2500);
                                releaseLock();
                                return;
                            }

                            // Unknown state → treat as pending, force reconcile
                            showToast('⏳ Previous request status is being verified. Please wait...', 'warning', 8000);
                            try { await reconcilePendingRequests(user.uid); } catch (e) {}
                            setTimeout(() => window.location.reload(), 2500);
                            releaseLock();
                            return;
                        }

                        // Reserve slot
                        const reserved = await reserveRequestSlot(user.uid, requestId, {
                            walletType, amount, currency: cfg.currency, address
                        });
                        if (!reserved) {
                            showToast('⏳ Yeh request already process ho rahi hai. Please wait...', 'warning');
                            try { await reconcilePendingRequests(user.uid); } catch (e) {}
                            releaseLock();
                            return;
                        }

                        // Atomic withdrawal
                        const result = await processAtomicWithdrawal(
                            user.uid, walletType, amount, address, cfg.currency, withdrawalId, requestId
                        );

                        if (!result.success) {
                            await updateRequestSlot(user.uid, requestId, {
                                status: 'failed',
                                error: result.error,
                                failedAt: Date.now()
                            });
                            clearPendingIntent(user.uid);
                            showToast('❌ ' + (result.error || 'Withdrawal failed. Please try again.'), 'error');
                            releaseLock();
                            return;
                        }

                        // 🔥 ROOT WRITE FIRST, then mark completed
                        let rootOk = false;
                        try {
                            await writeRootWithdrawal(withdrawalId, {
                                uid: user.uid,
                                withdrawalId,
                                requestId,
                                amount,
                                currency: cfg.currency,
                                walletType,
                                wallet: address,
                                status: 'pending',
                                timestamp: Date.now()
                            });
                            rootOk = true;
                        } catch (err) {
                            console.warn('Root withdrawal write failed:', err);
                        }

                        if (rootOk) {
                            await updateRequestSlot(user.uid, requestId, {
                                status: 'completed',
                                withdrawalId,
                                completedAt: Date.now()
                            });
                        } else {
                            await updateRequestSlot(user.uid, requestId, {
                                status: 'root_pending',
                                withdrawalId,
                                rootPendingAt: Date.now()
                            });
                        }

                        // Save address on success
                        const shouldSave = window.addressChangeMode ||
                                          document.getElementById('saveWithdrawalAddress')?.checked;

                        let addressSaved = false;
                        if (shouldSave) {
                            try {
                                await saveWithdrawalAddress(user.uid, address);
                                addressSaved = true;
                            } catch (err) {
                                console.warn('Address save failed:', err);
                            }
                        }

                        clearPendingIntent(user.uid);

                        if (rootOk) {
                            showToast(`✅ Withdrawal request submitted! ${amount} ${cfg.currency} will be processed by admin.`, 'success', 6000);
                        } else {
                            showToast(`⚠️ Withdrawal created but admin record pending. It will sync automatically.`, 'warning', 8000);
                        }

                        document.getElementById('withAmount').value = '';
                        window.addressChangeMode = false;

                        if (addressSaved) {
                            window.currentSavedWithdrawalAddress = address;
                        }

                        setTimeout(() => { window.location.reload(); }, 2500);

                    } catch (err) {
                        console.error('Withdrawal error:', err);

                        if (err?.message?.includes('network') || err?.code === 'NETWORK_ERROR') {
                            showToast('⚠️ Network issue — aapka request process ho sakti hai. DO NOT submit again. Page refresh karke check karein.', 'warning', 10000);
                        } else if (!err?.message?.includes('aborted') && !err?.message?.includes('reserve')) {
                            showToast('❌ Error submitting withdrawal. Please try again.', 'error');
                        }
                    } finally {
                        releaseLock();
                        if (modalEl && hiddenHandler) {
                            modalEl.removeEventListener('hidden.bs.modal', hiddenHandler);
                        }
                    }
                }
            });

        } catch (err) {
            console.error('Pre-withdrawal error:', err);
            showToast('❌ Something went wrong. Please try again.', 'error');
            releaseLock();
        }
    });
}

// ============================================================
// 🔥 MAIN
// ============================================================
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'login.html';
        return;
    }

    try {
        try {
            await reconcilePendingRequests(user.uid);
        } catch (err) {
            console.warn('Reconcile skipped:', err);
        }

        const userData = await getUserData(user.uid);
        if (!userData) {
            window.location.href = 'dashboard.html';
            return;
        }

        const username = userData.username || userData.referralCode || 'USER';
        const name = userData.name || 'User';
        const sidebarName = document.getElementById('sidebarName');
        const sidebarUserId = document.getElementById('sidebarUserId');
        const sidebarAvatar = document.getElementById('sidebarAvatar');
        const referralBadge = document.getElementById('referralBadge');

        if (sidebarName) sidebarName.textContent = name;
        if (sidebarUserId) sidebarUserId.textContent = 'ID: ' + username.substring(0, 20) + (username.length > 20 ? '...' : '');
        if (sidebarAvatar) sidebarAvatar.textContent = name.charAt(0).toUpperCase();
        if (referralBadge) referralBadge.textContent = userData.totalReferrals || 0;

        const withdrawals = await getWithdrawalHistory(user.uid);

        renderWithdrawalUI(userData, withdrawals);
        attachOptionHandlers();
        attachPasswordEyeToggles();

        await initializeWithdrawalAddressUI(user.uid);
        attachWithdrawHandler(user);

    } catch (error) {
        console.error('Error loading withdrawal page:', error);
        const container = document.getElementById('withdrawalContent');
        if (container) {
            container.innerHTML = `
                <div class="empty-state" style="padding: 60px 20px;">
                    <i class="bi bi-exclamation-triangle" style="color:var(--red);opacity:0.8;"></i>
                    <h4 style="color:#fff;margin-bottom:8px;">Error Loading Page</h4>
                    <p style="color:var(--text-muted);margin-bottom:20px;">
                        ${error.message || 'Please check your internet connection.'}
                    </p>
                    <button class="btn-primary-custom" onclick="location.reload()" style="max-width:200px;margin:0 auto;">
                        <i class="bi bi-arrow-clockwise"></i> Refresh Page
                    </button>
                </div>
            `;
        }
    }
});
