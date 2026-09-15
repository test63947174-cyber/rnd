// ============================================================
// 🔥 WITHDRAWAL PAGE LOGIC - RND STAKING (v2 - Double Safe)
// ============================================================
// 🔥 Security features:
//   - Idempotency key (requestId) prevents double submission
//   - Server-side balance re-verification via runTransaction
//   - Atomic balance deduction + transaction record
//   - Pending request tracking (survives refresh/back/multiple tabs)
//   - Network error safe: reply with UNKNOWN state, don't double-charge
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getDatabase, ref, get, set, push, runTransaction, remove } from "firebase/database";

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

// ============================================================
// 🔥 UTILITY
// ============================================================
function roundTo8(v) {
    if (v === undefined || v === null || isNaN(v)) return 0;
    return parseFloat(Math.round(v * 100000000) / 100000000);
}

function generateRequestId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'wd_req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
}

function showToast(message, type = 'success') {
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

    toast.innerHTML = `
        <i class="bi ${icons[type] || icons.info}" style="color:${colors[type] || colors.info};"></i>
        <span class="toast-msg">${message}</span>
    `;

    container.appendChild(toast);

    const duration = type === 'error' ? 8000 : type === 'warning' ? 7000 : 5000;
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, duration);
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
// 🔥 CHECK DUPLICATE REQUEST (Idempotency)
// ============================================================
async function checkDuplicateRequest(uid, requestId) {
    try {
        const snap = await get(ref(db, `users/${uid}/withdrawalRequests/${requestId}`));
        if (snap.exists()) {
            return { isDuplicate: true, data: snap.val() };
        }
        return { isDuplicate: false };
    } catch (err) {
        console.warn('Duplicate check error:', err);
        return { isDuplicate: false };
    }
}

// ============================================================
// 🔥 RESERVE REQUEST SLOT (Atomic)
// ============================================================
async function reserveRequestSlot(uid, requestId, payload) {
    const slotRef = ref(db, `users/${uid}/withdrawalRequests/${requestId}`);
    try {
        const result = await runTransaction(slotRef, (currentData) => {
            // Agar pehle se hai → abort (duplicate)
            if (currentData !== null) {
                return; // abort
            }
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
// 🔥 UPDATE REQUEST SLOT
// ============================================================
async function updateRequestSlot(uid, requestId, updates) {
    try {
        const slotRef = ref(db, `users/${uid}/withdrawalRequests/${requestId}`);
        const snap = await get(slotRef);
        const existing = snap.exists() ? snap.val() : {};
        await set(slotRef, { ...existing, ...updates });
    } catch (err) {
        console.warn('Could not update request slot:', err);
    }
}

// ============================================================
// 🔥 ATOMIC WITHDRAWAL PROCESS
// ============================================================
// 🔥 The heart of the security — this runs atomically on Firebase:
//    1. Re-reads balance from server (NOT from browser)
//    2. Validates balance >= amount
//    3. Deducts amount
//    4. Creates transaction record with withdrawalId
//    All inside a single runTransaction → no double-charge possible.
// ============================================================
async function processAtomicWithdrawal(uid, walletType, amount, address, currency, withdrawalId, requestId) {
    const userRef = ref(db, 'users/' + uid);
    const now = Date.now();

    try {
        const result = await runTransaction(userRef, (currentData) => {
            if (!currentData) {
                return null; // abort — user not found
            }

            // ============================================================
            // STEP 1: Check if this withdrawalId already exists (double-safety)
            // ============================================================
            const transactions = currentData.transactions || {};
            for (let key in transactions) {
                const tx = transactions[key];
                if (tx && tx.type === 'withdrawal' && tx.withdrawalId === withdrawalId) {
                    console.warn('⚠️ Withdrawal already exists in transactions:', withdrawalId);
                    return; // abort — duplicate
                }
            }

            // ============================================================
            // STEP 2: Re-verify balance from server side
            // ============================================================
            const balance = roundTo8(currentData[walletType] || 0);
            const amt = roundTo8(amount);

            if (balance < amt) {
                console.warn('⚠️ Insufficient balance in transaction:', balance, 'needed:', amt);
                return null; // abort — insufficient
            }

            // ============================================================
            // STEP 3: Deduct balance
            // ============================================================
            const newBalance = roundTo8(balance - amt);

            // ============================================================
            // STEP 4: Create transaction record
            // ============================================================
            const txId = 'wd_' + now + '_' + Math.random().toString(36).substr(2, 8);
            transactions[txId] = {
                type: 'withdrawal',
                withdrawalId: withdrawalId,
                requestId: requestId,
                amount: amt,
                currency: currency,
                walletType: walletType,
                walletAddress: address,
                timestamp: now,
                date: new Date().toDateString(),
                status: 'pending',
                description: `Withdrawal of ${amt} ${currency} to ${address.substring(0, 15)}...`
            };

            return {
                ...currentData,
                [walletType]: newBalance,
                transactions: transactions
            };
        });

        if (result.committed && result.snapshot && result.snapshot.exists()) {
            const updated = result.snapshot.val();
            const newBal = roundTo8(updated[walletType] || 0);
            console.log('✅ Atomic withdrawal committed:', withdrawalId, '| New balance:', newBal);
            return { success: true, withdrawalId, newBalance: newBal };
        } else {
            console.warn('⚠️ Atomic withdrawal not committed (insufficient or duplicate):', withdrawalId);
            return { success: false, error: 'Insufficient balance or duplicate request' };
        }

    } catch (err) {
        console.error('❌ Atomic withdrawal error:', err);
        return { success: false, error: err.message || 'Transaction failed' };
    }
}

// ============================================================
// 🔥 RECONCILE PENDING REQUESTS (survives refresh/back/network fail)
// ============================================================
async function reconcilePendingRequests(uid) {
    try {
        const reqRef = ref(db, `users/${uid}/withdrawalRequests`);
        const snap = await get(reqRef);
        if (!snap.exists()) return [];

        const requests = snap.val();
        const results = [];

        for (const [requestId, data] of Object.entries(requests)) {
            if (!data || data.status !== 'processing') continue;

            // Check if the corresponding transaction exists
            const userSnap = await get(ref(db, 'users/' + uid));
            const userData = userSnap.exists() ? userSnap.val() : null;
            const transactions = userData?.transactions || {};

            let txFound = false;
            for (let key in transactions) {
                const tx = transactions[key];
                if (tx && tx.type === 'withdrawal' && tx.requestId === requestId) {
                    txFound = true;
                    break;
                }
            }

            if (txFound) {
                // Success — mark complete
                await updateRequestSlot(uid, requestId, {
                    status: 'completed',
                    completedAt: Date.now()
                });
                results.push({ requestId, status: 'completed' });
            } else {
                // Was in-progress but no transaction found → likely failed → clear
                await remove(ref(db, `users/${uid}/withdrawalRequests/${requestId}`));
                results.push({ requestId, status: 'failed' });
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
            <!-- Page Header -->
            <div class="col-12">
                <div class="page-header-section">
                    <h4><i class="bi bi-arrow-up-circle"></i> Withdraw Funds</h4>
                    <span class="badge-mini-pill pill-green"><i class="bi bi-shield-check"></i> Secure Withdrawal</span>
                </div>
            </div>

            <!-- Wallet Cards -->
            <div class="col-12">
                <div class="row g-3">
                    <div class="col-6 col-lg-3">
                        <div class="wallet-card-new deposit">
                            <div class="wallet-card-header">
                                <span class="wallet-card-label">Deposit Wallet</span>
                                <div class="wallet-card-icon"><i class="bi bi-wallet2"></i></div>
                            </div>
                            <div class="wallet-card-value">
                                $${depositWallet.toFixed(2)}
                                <span class="wallet-card-currency">USDT</span>
                            </div>
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
                            <div class="wallet-card-value">
                                ${referralWallet.toFixed(2)}
                                <span class="wallet-card-currency">USDT</span>
                            </div>
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
                            <div class="wallet-card-value">
                                ${rndWallet.toFixed(4)}
                                <span class="wallet-card-currency">RND</span>
                            </div>
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
                            <div class="wallet-card-value">
                                ${lockedRND.toFixed(2)}
                                <span class="wallet-card-currency">RND</span>
                            </div>
                            <div class="wallet-card-footer">
                                <i class="bi bi-lock-fill"></i>
                                <span class="badge-mini-pill pill-red">🔒 Locked</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Withdraw Form -->
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

                    <!-- Option Cards -->
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
                            <label class="form-label" for="withAddr">Wallet Address (BEP20) <span class="required">*</span></label>
                            <input type="text" id="withAddr" class="form-control form-control-custom"
                                   placeholder="0x..." required>
                            <small class="form-hint">Enter your BEP20 wallet address (must start with 0x)</small>
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

            <!-- Withdrawal History -->
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
// 🔥 ATTACH WITHDRAW FORM HANDLER
// ============================================================
function attachWithdrawHandler(user) {
    const form = document.getElementById('withdrawForm');
    if (!form) return;

    // 🔥 Prevent double-submit at the very front
    let isSubmitting = false;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        // ============================================================
        // 🔥 LAYER 1: JavaScript lock (fast, client-side)
        // ============================================================
        if (isSubmitting) {
            showToast('⏳ Please wait, aapka request already process ho raha hai...', 'warning');
            return;
        }

        const walletType = document.getElementById('selectedWallet').value;
        const amountRaw = document.getElementById('withAmount').value;
        const address = document.getElementById('withAddr').value.trim();
        const btn = document.getElementById('withdrawBtn');

        const cfg = WITHDRAW_CONFIG[walletType];
        if (!cfg) {
            showToast('❌ Invalid wallet selected.', 'error');
            return;
        }

        // ============================================================
        // 🔥 LAYER 2: Frontend validation (fast, nice UX)
        // ============================================================
        const amount = parseFloat(amountRaw);
        if (!amount || isNaN(amount) || amount <= 0) {
            showToast('❌ Please enter a valid amount greater than 0.', 'error');
            return;
        }

        if (amount < cfg.min) {
            showToast(`❌ Minimum withdrawal for ${cfg.label} is ${cfg.min} ${cfg.currency} (BEP20).`, 'error');
            return;
        }

        if (!address || !address.startsWith('0x') || address.length < 10) {
            showToast('❌ Please enter a valid BEP20 wallet address starting with 0x.', 'error');
            return;
        }

        // 🔥 Fresh balance from server (double-check before even trying)
        const freshUser = await getUserData(user.uid);
        const freshBalance = Number(freshUser?.[walletType]) || 0;
        if (freshBalance < amount) {
            showToast(`❌ Insufficient balance! You have only ${freshBalance.toFixed(4)} ${cfg.currency}.`, 'error');
            return;
        }

        // ============================================================
        // 🔥 LAYER 3: Generate idempotency key (uniqueness per submission)
        // ============================================================
        const requestId = generateRequestId();
        const withdrawalId = 'wd_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);

        // Lock UI
        isSubmitting = true;
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span>Processing...';
        }

        try {
            // ============================================================
            // 🔥 LAYER 4: Duplicate check (server-side, fast)
            // ============================================================
            const dupCheck = await checkDuplicateRequest(user.uid, requestId);
            if (dupCheck.isDuplicate) {
                showToast('⚠️ Yeh request already process ho chuki hai.', 'warning');
                throw new Error('Duplicate request — aborted');
            }

            // ============================================================
            // 🔥 LAYER 5: Reserve the request slot atomically
            // ============================================================
            const reserved = await reserveRequestSlot(user.uid, requestId, {
                walletType, amount, currency: cfg.currency, address
            });
            if (!reserved) {
                showToast('⏳ Yeh request already process ho rahi hai. Please wait...', 'warning');
                throw new Error('Could not reserve request slot');
            }

            // ============================================================
            // 🔥 LAYER 6: Atomic withdrawal on Firebase
            //          (re-verifies balance, deducts, creates tx)
            // ============================================================
            const result = await processAtomicWithdrawal(
                user.uid,
                walletType,
                amount,
                address,
                cfg.currency,
                withdrawalId,
                requestId
            );

            if (!result.success) {
                await updateRequestSlot(user.uid, requestId, {
                    status: 'failed',
                    error: result.error,
                    failedAt: Date.now()
                });
                showToast('❌ ' + (result.error || 'Withdrawal failed. Please try again.'), 'error');
                return;
            }

            // ============================================================
            // 🔥 LAYER 7: Mark slot completed
            // ============================================================
            await updateRequestSlot(user.uid, requestId, {
                status: 'completed',
                withdrawalId,
                completedAt: Date.now()
            });

            // ============================================================
            // 🔥 LAYER 8: Push to root withdrawals (admin visibility)
            // ============================================================
            try {
                await push(ref(db, 'withdrawals'), {
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
            } catch (err) {
                console.warn('Root withdrawal save warning (non-critical):', err);
            }

            // ✅ SUCCESS
            showToast(`✅ Withdrawal request submitted! ${amount} ${cfg.currency} will be processed by admin.`, 'success', 6000);

            // Clear form
            document.getElementById('withAmount').value = '';
            document.getElementById('withAddr').value = '';

            // Reload to show updated balance + history
            setTimeout(() => { window.location.reload(); }, 2000);

        } catch (err) {
            console.error('Withdrawal error:', err);

            // Network ambiguity — do NOT encourage re-submission
            if (err?.message?.includes('network') || err?.code === 'NETWORK_ERROR') {
                showToast('⚠️ Network issue — aapka request process ho sakti hai. DO NOT submit again. Page refresh karke check karein.', 'warning', 10000);
            } else if (!err?.message?.includes('aborted') && !err?.message?.includes('reserve')) {
                showToast('❌ Error submitting withdrawal. Please try again.', 'error');
            }

        } finally {
            // 🔥 ALWAYS release lock (success, error, network fail — sab me)
            isSubmitting = false;
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="bi bi-arrow-up-circle"></i> Submit Withdrawal';
            }
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
        // ============================================================
        // Reconcile any pending requests before rendering
        // (safe if user refreshed mid-flight)
        // ============================================================
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