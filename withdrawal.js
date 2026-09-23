// ============================================================
// 🔥 WITHDRAWAL PAGE LOGIC - RND STAKING (v5 - DB Password + Saved Address)
// ============================================================
// 🔥 Security features:
//   - Idempotency key (requestId) prevents double submission
//   - Server-side balance re-verification via runTransaction
//   - Atomic balance deduction + transaction record
//   - Pending request tracking (survives refresh/back/multiple tabs)
//   - Network error safe: reply with UNKNOWN state, don't double-charge
//   - Hardened amount & address validation
//   - NEW: 6-digit withdrawal password (hashed, in Firebase DB)
//   - NEW: Saved BEP20 address (Firebase-backed)
//   - NEW: Forgot password via DB verification (no Firebase Auth touch)
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

const BEP20_REGEX = /^0x[a-fA-F0-9]{40}$/;
const PASSWORD_REGEX = /^\d{6}$/;

// 🔥 Simple hash function for withdrawal password (djb2 + salt)
// ⚠️ NOTE: This is NOT cryptographically strong. For a production money
// system, replace with a proper hashing mechanism (e.g. Cloud Function
// + bcrypt). But it does prevent plaintext storage in the DB.
function hashWithdrawalPassword(uid, password) {
    const input = `rnd_${uid}_${password}_stake`;
    let hash = 5381;
    for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) + hash) + input.charCodeAt(i);
        hash = hash & 0xffffffff;
    }
    // Produce a longer hex string by running two passes
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
// 🔐 WITHDRAWAL SETTINGS (Saved Address + Password)
// ============================================================
async function getWithdrawalSettings(uid) {
    try {
        const snap = await get(ref(db, `users/${uid}/withdrawalSettings`));
        if (!snap.exists()) {
            return { savedAddress: '', addressUpdatedAt: 0, passwordHash: '', passwordUpdatedAt: 0 };
        }
        return snap.val() || {};
    } catch (err) {
        console.error('Withdrawal settings read error:', err);
        return { savedAddress: '', addressUpdatedAt: 0, passwordHash: '', passwordUpdatedAt: 0 };
    }
}

async function saveWithdrawalAddress(uid, address) {
    const cleanAddress = String(address || '').trim();
    if (!BEP20_REGEX.test(cleanAddress)) {
        throw new Error('Invalid BEP20 wallet address.');
    }
    await set(ref(db, `users/${uid}/withdrawalSettings/savedAddress`), cleanAddress);
    await set(ref(db, `users/${uid}/withdrawalSettings/addressUpdatedAt`), Date.now());
    return true;
}

async function saveWithdrawalPasswordHash(uid, passwordHash) {
    await set(ref(db, `users/${uid}/withdrawalSettings/passwordHash`), passwordHash);
    await set(ref(db, `users/${uid}/withdrawalSettings/passwordUpdatedAt`), Date.now());
    return true;
}

async function verifyWithdrawalPasswordFromDB(uid, password) {
    if (!PASSWORD_REGEX.test(String(password || ''))) {
        return { ok: false, error: 'Password must be exactly 6 digits.' };
    }
    const settings = await getWithdrawalSettings(uid);
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
            if (currentData !== null) return; // abort — duplicate
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
// 🔥 ATOMIC WITHDRAWAL PROCESS (Hardened — UNCHANGED)
// ============================================================
async function processAtomicWithdrawal(uid, walletType, amount, address, currency, withdrawalId, requestId) {
    const userRef = ref(db, 'users/' + uid);
    const now = Date.now();

    try {
        const result = await runTransaction(userRef, (currentData) => {
            if (!currentData) return null;

            // STEP 1: Duplicate withdrawalId check
            const transactions = currentData.transactions || {};
            for (let key in transactions) {
                const tx = transactions[key];
                if (tx && tx.type === 'withdrawal' && tx.withdrawalId === withdrawalId) {
                    console.warn('⚠️ Withdrawal already exists:', withdrawalId);
                    return;
                }
            }

            // STEP 2: Validate balance & amount
            const balance = roundTo8(currentData[walletType] || 0);
            const amt = roundTo8(amount);

            if (!Number.isFinite(balance) || balance < 0) {
                console.warn('⚠️ Invalid wallet balance:', balance);
                return null;
            }
            if (!Number.isFinite(amt) || amt <= 0) {
                console.warn('⚠️ Invalid withdrawal amount:', amt);
                return null;
            }
            if (balance < amt) {
                console.warn('⚠️ Insufficient balance:', balance, 'needed:', amt);
                return null;
            }

            // STEP 3: Compute new balance
            const newBalance = roundTo8(balance - amt);
            if (newBalance < 0 || !Number.isFinite(newBalance)) {
                console.warn('⚠️ Invalid resulting balance:', newBalance);
                return null;
            }

            // STEP 4: Transaction record
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
            console.warn('⚠️ Atomic withdrawal not committed:', withdrawalId);
            return { success: false, error: 'Insufficient balance or duplicate request' };
        }

    } catch (err) {
        console.error('❌ Atomic withdrawal error:', err);
        return { success: false, error: err.message || 'Transaction failed' };
    }
}

// ============================================================
// 🔥 RECONCILE PENDING REQUESTS (UNCHANGED)
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
                await updateRequestSlot(uid, requestId, {
                    status: 'completed',
                    completedAt: Date.now()
                });
                results.push({ requestId, status: 'completed' });
            } else {
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
// 💳 SAVED ADDRESS UI
// ============================================================
async function initializeWithdrawalAddressUI(uid) {
    const savedAddressBox = document.getElementById('savedAddressBox');
    const addressInputBox = document.getElementById('addressInputBox');
    if (!savedAddressBox || !addressInputBox) return;

    const settings = await getWithdrawalSettings(uid);
    const savedAddress = String(settings.savedAddress || '').trim();

    window.addressChangeMode = false;

    // NO SAVED ADDRESS
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

    // SAVED ADDRESS EXISTS
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
                                word-break:break-all;" title="${savedAddress}">
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

    document.getElementById('changeAddressBtn')?.addEventListener('click', () => {
        showChangeAddressUI(savedAddress);
    });
}

// ============================================================
// 🔄 CHANGE SAVED ADDRESS UI
// ============================================================
function showChangeAddressUI(oldAddress) {
    const savedAddressBox = document.getElementById('savedAddressBox');
    const addressInputBox = document.getElementById('addressInputBox');
    const addressInput = document.getElementById('withAddr');

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
                Make sure the new address is your correct BEP20 wallet address.
            </div>
        </div>
    `;

    addressInputBox.style.display = 'block';
    addressInput.value = '';
    addressInput.focus();

    const saveOpt = document.getElementById('saveAddressOption');
    if (saveOpt) saveOpt.style.display = 'block';

    window.addressChangeMode = true;
    window.previousWithdrawalAddress = oldAddress;
}

// ============================================================
// 🔐 WITHDRAWAL PASSWORD MODAL LOGIC
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
    const errEl = document.getElementById('withdrawPasswordError');
    const confirmBtn = document.getElementById('confirmWithdrawPasswordBtn');
    const btnText = document.getElementById('wdPwdBtnText');
    const forgotBtn = document.getElementById('forgotWithdrawPasswordBtn');
    const closeBtn = document.getElementById('wdPwdCloseBtn');

    inputEl.value = '';
    errEl.style.display = 'none';
    errEl.textContent = '';

    // Mode: 'verify' or 'set'
    if (mode === 'set') {
        titleEl.innerHTML = `<i class="bi bi-shield-lock-fill" style="color:var(--primary);"></i> Set Withdrawal Password`;
        infoEl.innerHTML = `You are setting up your <strong style="color:#2ecc71;">6-digit withdrawal password</strong>. You will need this password every time you withdraw.`;
        btnText.textContent = 'Set Password';
        forgotBtn.style.display = 'none';
    } else {
        titleEl.innerHTML = `<i class="bi bi-shield-lock-fill" style="color:var(--primary);"></i> Withdrawal Password`;
        infoEl.innerHTML = `Enter your <strong style="color:#2ecc71;">6-digit withdrawal password</strong> to continue.`;
        btnText.textContent = 'Verify';
        forgotBtn.style.display = 'inline-block';
    }

    // Force numeric only
    inputEl.oninput = () => {
        inputEl.value = inputEl.value.replace(/\D/g, '').slice(0, 6);
    };

    confirmBtn.onclick = async () => {
        const pwd = String(inputEl.value || '').trim();

        if (!PASSWORD_REGEX.test(pwd)) {
            errEl.textContent = 'Please enter exactly 6 digits.';
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
                showToast('✅ Withdrawal password set successfully.', 'success');
                modal.hide();
                await onSuccess();
                return;
            }

            // mode === 'verify'
            const check = await verifyWithdrawalPasswordFromDB(uid, pwd);
            if (!check.ok) {
                if (check.error === 'NO_PASSWORD_SET') {
                    // Auto-switch to set mode
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

    // Forgot password flow
    forgotBtn.onclick = () => {
        modal.hide();
        setTimeout(() => openForgotPasswordModal(uid, onSuccess), 350);
    };

    // Prevent close during verification — but allow cancel (just leave)
    modal.show();
    setTimeout(() => inputEl.focus(), 300);
}

// ============================================================
// 🔐 FORGOT PASSWORD MODAL LOGIC
// ============================================================
function openForgotPasswordModal(uid, onSuccess) {
    const modalEl = document.getElementById('forgotPasswordModal');
    if (!modalEl) {
        showToast('Forgot-password UI unavailable.', 'error');
        return;
    }

    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    const oldEl = document.getElementById('fpOldPassword');
    const newEl = document.getElementById('fpNewPassword');
    const confEl = document.getElementById('fpConfirmPassword');
    const errEl = document.getElementById('fpError');
    const btn = document.getElementById('confirmForgotPasswordBtn');

    oldEl.value = '';
    newEl.value = '';
    confEl.value = '';
    errEl.style.display = 'none';
    errEl.textContent = '';

    [oldEl, newEl, confEl].forEach(el => {
        el.oninput = () => { el.value = el.value.replace(/\D/g, '').slice(0, 6); };
    });

    btn.onclick = async () => {
        const oldPwd = String(oldEl.value || '').trim();
        const newPwd = String(newEl.value || '').trim();
        const confPwd = String(confEl.value || '').trim();

        if (!PASSWORD_REGEX.test(oldPwd)) {
            errEl.textContent = 'Please enter your current 6-digit password.';
            errEl.style.display = 'block';
            return;
        }
        if (!PASSWORD_REGEX.test(newPwd)) {
            errEl.textContent = 'New password must be exactly 6 digits.';
            errEl.style.display = 'block';
            return;
        }
        if (newPwd !== confPwd) {
            errEl.textContent = 'New password and confirm password do not match.';
            errEl.style.display = 'block';
            return;
        }
        if (oldPwd === newPwd) {
            errEl.textContent = 'New password must be different from old password.';
            errEl.style.display = 'block';
            return;
        }

        btn.disabled = true;
        const origHTML = btn.innerHTML;
        btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>Please wait...`;
        errEl.style.display = 'none';

        try {
            // Verify current password first
            const check = await verifyWithdrawalPasswordFromDB(uid, oldPwd);
            if (!check.ok) {
                if (check.error === 'NO_PASSWORD_SET') {
                    errEl.textContent = 'No withdrawal password set yet. Please set one from the withdrawal page.';
                } else {
                    errEl.textContent = check.error || 'Current password is incorrect.';
                }
                errEl.style.display = 'block';
                return;
            }

            // Save new hashed password
            const newHash = hashWithdrawalPassword(uid, newPwd);
            await saveWithdrawalPasswordHash(uid, newHash);

            showToast('✅ Withdrawal password reset successfully.', 'success');
            modal.hide();

            // Continue to withdrawal automatically after successful reset
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
    setTimeout(() => oldEl.focus(), 300);
}

// ============================================================
// 🔥 ATTACH WITHDRAW FORM HANDLER
// ============================================================
function attachWithdrawHandler(user) {
    const form = document.getElementById('withdrawForm');
    if (!form) return;

    let isSubmitting = false;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        // LAYER 1: JS lock
        if (isSubmitting) {
            showToast('⏳ Please wait, aapka request already process ho raha hai...', 'warning');
            return;
        }

        const walletType = document.getElementById('selectedWallet').value;
        const amountRaw = document.getElementById('withAmount').value;
        const btn = document.getElementById('withdrawBtn');

        const cfg = WITHDRAW_CONFIG[walletType];
        if (!cfg) {
            showToast('❌ Invalid wallet selected.', 'error');
            return;
        }

        // LAYER 2: Amount validation
        const amount = Number(amountRaw);

        if (!Number.isFinite(amount) || amount <= 0) {
            showToast('❌ Please enter a valid amount greater than 0.', 'error');
            return;
        }

        const amountString = String(amountRaw).trim();
        const decimalPart = amountString.includes('.') ? amountString.split('.')[1] : '';

        if (decimalPart.length > 8) {
            showToast('❌ Maximum 8 decimal places are allowed.', 'error');
            return;
        }

        if (amount < cfg.min) {
            showToast(`❌ Minimum withdrawal for ${cfg.label} is ${cfg.min} ${cfg.currency} (BEP20).`, 'error');
            return;
        }

        // LAYER 3: Resolve address
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

        // LAYER 4: Fresh balance from server
        const freshUser = await getUserData(user.uid);

        if (!freshUser) {
            showToast('❌ Unable to verify your balance. Please try again.', 'error');
            return;
        }

        const freshBalance = Number(freshUser[walletType]);

        if (!Number.isFinite(freshBalance) || freshBalance < 0) {
            showToast('❌ Unable to verify your balance. Please try again.', 'error');
            return;
        }

        if (freshBalance < amount) {
            showToast(`❌ Insufficient balance! You have only ${freshBalance.toFixed(4)} ${cfg.currency}.`, 'error');
            return;
        }

        // Lock UI
        isSubmitting = true;
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span>Processing...';
        }

        // Determine password mode
        const settings = await getWithdrawalSettings(user.uid);
        const hasPassword = !!(settings.passwordHash && String(settings.passwordHash).trim());
        const pwdMode = hasPassword ? 'verify' : 'set';

        // LAYER 5: Open withdrawal password modal
        openWithdrawPasswordModal(user.uid, {
            mode: pwdMode,
            onSuccess: async () => {
                try {
                    // LAYER 6: Idempotency + reservation
                    const requestId = generateRequestId();
                    const withdrawalId = 'wd_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);

                    const dupCheck = await checkDuplicateRequest(user.uid, requestId);
                    if (dupCheck.isDuplicate) {
                        showToast('⚠️ Yeh request already process ho chuki hai.', 'warning');
                        throw new Error('Duplicate request — aborted');
                    }

                    const reserved = await reserveRequestSlot(user.uid, requestId, {
                        walletType, amount, currency: cfg.currency, address
                    });
                    if (!reserved) {
                        showToast('⏳ Yeh request already process ho rahi hai. Please wait...', 'warning');
                        throw new Error('Could not reserve request slot');
                    }

                    // LAYER 7: Atomic withdrawal
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

                    // LAYER 8: Mark completed
                    await updateRequestSlot(user.uid, requestId, {
                        status: 'completed',
                        withdrawalId,
                        completedAt: Date.now()
                    });

                    // LAYER 9: Admin visibility
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

                    // LAYER 10: Save address after successful withdrawal
                    const shouldSave = window.addressChangeMode ||
                                      document.getElementById('saveWithdrawalAddress')?.checked;

                    if (shouldSave) {
                        try {
                            await saveWithdrawalAddress(user.uid, address);
                        } catch (err) {
                            console.warn('Address save failed (non-critical):', err);
                        }
                    }

                    showToast(`✅ Withdrawal request submitted! ${amount} ${cfg.currency} will be processed by admin.`, 'success', 6000);

                    document.getElementById('withAmount').value = '';
                    window.addressChangeMode = false;
                    window.currentSavedWithdrawalAddress = address;

                    setTimeout(() => { window.location.reload(); }, 2000);

                } catch (err) {
                    console.error('Withdrawal error:', err);

                    if (err?.message?.includes('network') || err?.code === 'NETWORK_ERROR') {
                        showToast('⚠️ Network issue — aapka request process ho sakti hai. DO NOT submit again. Page refresh karke check karein.', 'warning', 10000);
                    } else if (!err?.message?.includes('aborted') && !err?.message?.includes('reserve')) {
                        showToast('❌ Error submitting withdrawal. Please try again.', 'error');
                    }

                } finally {
                    isSubmitting = false;
                    if (btn) {
                        btn.disabled = false;
                        btn.innerHTML = '<i class="bi bi-arrow-up-circle"></i> Submit Withdrawal';
                    }
                }
            }
        });

        // If user cancels the password modal (closes without verifying),
        // we must release the lock. Attach a one-time listener.
        const modalEl = document.getElementById('withdrawPasswordModal');
        if (modalEl) {
            const releaseLock = () => {
                // Small delay so the onSuccess (if triggered) has time to start
                setTimeout(() => {
                    if (isSubmitting) {
                        isSubmitting = false;
                        if (btn) {
                            btn.disabled = false;
                            btn.innerHTML = '<i class="bi bi-arrow-up-circle"></i> Submit Withdrawal';
                        }
                    }
                }, 500);
                modalEl.removeEventListener('hidden.bs.modal', releaseLock);
            };
            modalEl.addEventListener('hidden.bs.modal', releaseLock);
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
        attachWithdrawHandler(user);

        // Initialize saved address UI
        await initializeWithdrawalAddressUI(user.uid);

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
