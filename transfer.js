// ============================================================
// TRANSFER.JS — v5 (FINAL FIX)
// ============================================================
// ✅ Password eye button
// ✅ Save के बाद transfer flow साफ़ — कोई pending stuck नहीं
// ✅ transferLock properly manage — modal open/close पर भी
// ✅ Idempotency (requestId localStorage)
// ✅ नाम के साथ history
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged } from "firebase/auth";
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

const WALLET_CURRENCY = { depositWallet: 'USDT', referralWallet: 'USDT', rndWallet: 'RND' };
const WALLET_PRECISION = { depositWallet: 2, referralWallet: 2, rndWallet: 8 };

// ============================================================
// State
// ============================================================
let currentUserData = null;
let currentUserId = null;
let transferLock = false;
let balanceListenerOff = null;
let currentBalances = { depositWallet: 0, referralWallet: 0, rndWallet: 0 };

// 🔑 Pending transfer — जब modal खुला हो
let pendingTransfer = null;
// 🔑 Modal खुला है क्या?
let modalOpen = false;

// ============================================================
// 👁️ Password Eye Toggle
// ============================================================
window.togglePassword = function(inputId, btn) {
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
// 🔑 Idempotency
// ============================================================
function getOrCreateRequestId() {
    let existing = localStorage.getItem('activeTransferRequestId');
    if (existing) return existing;
    let newId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
    localStorage.setItem('activeTransferRequestId', newId);
    return newId;
}

function clearActiveRequestId() {
    localStorage.removeItem('activeTransferRequestId');
    localStorage.removeItem('activeTransferDetails');
}

// ============================================================
// UI Helpers
// ============================================================
function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
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

function roundToPrecision(v, p) {
    const f = Math.pow(10, p);
    return Math.round(v * f) / f;
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

function getTodayDate() { return new Date().toISOString().split('T')[0]; }

// ============================================================
// Lookup
// ============================================================
async function getUserByIdentifier(identifier) {
    try {
        if (!identifier) return null;
        const uidSnap = await get(ref(db, 'users/' + identifier));
        if (uidSnap.exists()) return { uid: identifier, data: uidSnap.val(), source: 'uid' };
        const usersSnap = await get(ref(db, 'users'));
        if (usersSnap.exists()) {
            const users = usersSnap.val();
            for (const uid in users) {
                const u = users[uid];
                if (u.username === identifier || u.referralCode === identifier)
                    return { uid: uid, data: u, source: 'match' };
            }
        }
        return null;
    } catch (error) {
        console.error('Lookup error:', error);
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
// ✅ ATOMIC TRANSFER
// ============================================================
async function atomicTransfer(senderUid, recipientUid, amount, walletType, currency, requestId, senderName, recipientName) {
    if (!senderUid || !recipientUid) return { status: 'failed', error: 'Missing IDs' };
    if (senderUid === recipientUid) return { status: 'failed', error: 'Cannot send to yourself' };
    if (!WALLET_CURRENCY[walletType]) return { status: 'failed', error: 'Invalid wallet' };
    
    const amountCheck = validateAmount(amount, walletType);
    if (!amountCheck.valid) return { status: 'failed', error: amountCheck.error };
    const safeAmount = amountCheck.value;
    const precision = WALLET_PRECISION[walletType];

    const requestRef = ref(db, `transferRequests/${requestId}`);
    const txId = 'TX_' + requestId.replace(/-/g, '').slice(0, 20);
    const now = Date.now();

    // Sender
    const senderRef = ref(db, `users/${senderUid}`);
    let senderBalanceBefore = 0;
    let alreadyInSender = false;

    try {
        const senderResult = await runTransaction(senderRef, (currentData) => {
            if (!currentData) return currentData;
            const history = currentData.transferHistory || {};
            if (history[txId]) { alreadyInSender = true; return; }
            const balance = roundToPrecision(currentData[walletType] || 0, precision);
            senderBalanceBefore = balance;
            if (balance < safeAmount) return;

            currentData[walletType] = roundToPrecision(balance - safeAmount, precision);

            if (!currentData.transferHistory || Array.isArray(currentData.transferHistory)) {
                const arr = currentData.transferHistory || [];
                const obj = {};
                arr.forEach((item, i) => { obj[item.txId || `legacy_${i}`] = item; });
                currentData.transferHistory = obj;
            }
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

        if (alreadyInSender) {
            return { status: 'success', txId, recipientName, duplicate: true };
        }
        if (!senderResult.committed) {
            return { status: 'failed', error: `Insufficient balance. Available: ${senderBalanceBefore} ${currency}` };
        }
    } catch (err) {
        console.error('Sender error:', err);
        return { status: 'unknown', error: 'Network error on sender' };
    }

    // Recipient
    const recipientRef = ref(db, `users/${recipientUid}`);
    let alreadyInRecipient = false;

    try {
        const recipientResult = await runTransaction(recipientRef, (currentData) => {
            if (!currentData) return currentData;
            const history = currentData.transferHistory || {};
            if (history[txId]) { alreadyInRecipient = true; return; }
            const balance = roundToPrecision(currentData[walletType] || 0, precision);
            currentData[walletType] = roundToPrecision(balance + safeAmount, precision);

            if (!currentData.transferHistory || Array.isArray(currentData.transferHistory)) {
                const arr = currentData.transferHistory || [];
                const obj = {};
                arr.forEach((item, i) => { obj[item.txId || `legacy_${i}`] = item; });
                currentData.transferHistory = obj;
            }
            currentData.transferHistory[txId] = {
                type: 'received', from: senderName, fromUid: senderUid, fromUsername: senderName,
                to: recipientName, toUid: recipientUid, toUsername: recipientName,
                amount: safeAmount, currency, walletType,
                timestamp: now, txId, requestId, status: 'completed'
            };
            if (!currentData.transactions) currentData.transactions = {};
            currentData.transactions[txId] = {
                type: 'transfer_received', amount: safeAmount, currency, walletType,
                from: senderName, fromUid: senderUid,
                to: recipientName, toUid: recipientUid,
                timestamp: now, date: getTodayDate(), txId, requestId, status: 'completed'
            };
            return currentData;
        });

        if (alreadyInRecipient) {
            // दोनों तरफ हो चुका
        } else if (!recipientResult.committed) {
            // Compensation
            await runTransaction(senderRef, (currentData) => {
                if (!currentData) return currentData;
                const hist = currentData.transferHistory || {};
                if (hist[txId] && hist[txId].status === 'reversed') return;
                currentData[walletType] = roundToPrecision((currentData[walletType] || 0) + safeAmount, precision);
                if (currentData.transferHistory && currentData.transferHistory[txId])
                    currentData.transferHistory[txId].status = 'reversed';
                if (currentData.transactions && currentData.transactions[txId])
                    currentData.transactions[txId].status = 'reversed';
                return currentData;
            });
            return { status: 'failed', error: 'Recipient failed — amount returned' };
        }
    } catch (err) {
        console.error('Recipient error:', err);
        try {
            await set(requestRef, {
                requestId, txId, senderUid, recipientUid,
                amount: safeAmount, currency, walletType,
                status: 'unknown', createdAt: now, error: 'Network ambiguity'
            });
        } catch (_) {}
        return { status: 'unknown', txId, error: 'Status could not be confirmed.' };
    }

    // Success record
    try {
        await set(requestRef, {
            requestId, txId, senderUid, recipientUid,
            amount: safeAmount, currency, walletType,
            status: 'success', createdAt: now, completedAt: Date.now()
        });
    } catch (err) { console.warn('Record write failed:', err); }

    return { status: 'success', txId, recipientName };
}

// ============================================================
// 🎭 Modal Controls
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
    // Password field reset
    if (id === 'setupModal') {
        document.getElementById('setupPassword').value = '';
        document.getElementById('setupPasswordConfirm').value = '';
        document.getElementById('setupPassword').type = 'password';
        document.getElementById('setupPasswordConfirm').type = 'password';
        document.querySelectorAll('#setupModal .password-eye i').forEach(i => i.className = 'bi bi-eye');
        document.getElementById('setupError').classList.remove('show');
    }
    if (id === 'verifyModal') {
        document.getElementById('verifyPassword').value = '';
        document.getElementById('verifyPassword').type = 'password';
        document.querySelectorAll('#verifyModal .password-eye i').forEach(i => i.className = 'bi bi-eye');
        document.getElementById('verifyError').classList.remove('show');
    }
}

// ============================================================
// Password Setup
// ============================================================
function openPasswordSetup() {
    openModal('setupModal');
    setTimeout(() => document.getElementById('setupPassword').focus(), 200);
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
        // अब user दोबारा Send दबाएगा → verify modal खुलेगा
    } catch (err) {
        console.error('Save error:', err);
        errorEl.textContent = 'Password save नहीं हुआ। दोबारा try करें।';
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
    // 🔑 pendingTransfer यहाँ set होता है — modal खुलने से पहले
    pendingTransfer = details;

    const detailsEl = document.getElementById('verifyDetails');
    detailsEl.innerHTML = `
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
            <span>Amount:</span>
            <strong style="color: #2ecc71;">${details.amount} ${details.currency}</strong>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
            <span>To:</span>
            <strong style="color: #60a5fa;">${details.recipientName}</strong>
        </div>
        <div style="display: flex; justify-content: space-between;">
            <span>Wallet:</span>
            <strong>${details.walletLabel}</strong>
        </div>
    `;

    openModal('verifyModal');
    setTimeout(() => document.getElementById('verifyPassword').focus(), 200);
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

    // 🔑 pendingTransfer होना चाहिए
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

        // ✅ Password सही
        const details = pendingTransfer;
        closeModal('verifyModal');

        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-shield-check me-2"></i>Verify & Send';

        // 🚀 अब transfer चलाओ
        await executeTransfer(details);

    } catch (err) {
        console.error('Verify error:', err);
        errorEl.textContent = 'Error आया। दोबारा try करें।';
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

    // 🔒 Lock दोबारा (modal के दौरान unlock हो गया था)
    transferLock = true;

    const btn = document.getElementById('sendBtn');
    if (btn) {
        btn.disabled = true;
        btn.className = 'btn-send sending';
        btn.innerHTML = '<span class="loading-spinner me-2"></span>Sending...';
    }

    try {
        const result = await atomicTransfer(
            user.uid,
            details.recipient.uid,
            details.amount,
            details.walletType,
            details.currency,
            details.requestId,
            details.senderName,
            details.recipientName
        );

        if (result.status === 'success') {
            if (result.duplicate) {
                showToast('✅ Transfer already completed (duplicate ignored)', 'success');
            } else {
                showToast(`✅ ${details.amount} ${details.currency} sent to ${details.recipientName}!`, 'success');
            }

            document.getElementById('recipientInput').value = '';
            document.getElementById('amountInput').value = '';
            clearActiveRequestId();
            setTimeout(() => loadUserData(user.uid), 500);
            resetButton();

        } else if (result.status === 'unknown') {
            showToast('⚠️ Status could not be confirmed. Please wait...', 'error');
            if (btn) {
                btn.className = 'btn-send verifying';
                btn.innerHTML = '<i class="bi bi-hourglass-split me-2"></i>Verifying...';
            }
            startReconciliationLoop(details.requestId, user.uid);
            return;

        } else {
            showToast('❌ ' + (result.error || 'Transfer failed'), 'error');
            clearActiveRequestId();
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
// Form Submit
// ============================================================
async function handleTransferSubmit(e) {
    e.preventDefault();

    // 🔒 Modal खुला है? तो कुछ मत करो
    if (modalOpen) return;

    // 🔒 Lock है? रोक दो
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

        if (!recipientInput) {
            showToast('❌ Enter recipient', 'error');
            resetButton();
            return;
        }
        const amount = parseFloat(amountRaw);
        if (!isFinite(amount) || Number.isNaN(amount) || amount <= 0) {
            showToast('❌ Valid amount डालें', 'error');
            resetButton();
            return;
        }
        const amountCheck = validateAmount(amount, walletType);
        if (!amountCheck.valid) {
            showToast('❌ ' + amountCheck.error, 'error');
            resetButton();
            return;
        }

        const user = auth.currentUser;
        if (!user) {
            showToast('❌ Please login', 'error');
            resetButton();
            return;
        }

        const currentBalance = currentBalances[walletType] || 0;
        if (currentBalance < amountCheck.value) {
            showToast(`❌ Insufficient balance. Available: ${currentBalance} ${WALLET_CURRENCY[walletType]}`, 'error');
            resetButton();
            return;
        }

        const recipient = await getUserByIdentifier(recipientInput);
        if (!recipient) {
            showToast('❌ User not found!', 'error');
            resetButton();
            return;
        }
        if (recipient.uid === user.uid) {
            showToast('❌ Cannot send to yourself!', 'error');
            resetButton();
            return;
        }

        // Pending check
        const existingRequestId = localStorage.getItem('activeTransferRequestId');
        if (existingRequestId) {
            const pendingSnap = await get(ref(db, `transferRequests/${existingRequestId}`));
            if (pendingSnap.exists()) {
                const pData = pendingSnap.val();
                if (pData.status === 'success') {
                    showToast('✅ Previous transfer completed. Refreshing...', 'success');
                    clearActiveRequestId();
                    setTimeout(() => loadUserData(user.uid), 500);
                    resetButton();
                    return;
                } else if (pData.status === 'unknown') {
                    showToast('⚠️ Previous transfer still verifying. Wait.', 'error');
                    resetButton();
                    return;
                } else if (pData.status === 'failed') {
                    clearActiveRequestId();
                }
            } else {
                // Record नहीं मिला — clear करके आगे बढ़ो
                clearActiveRequestId();
            }
        }

        const requestId = getOrCreateRequestId();

        const senderName = getUserDisplayName(currentUserData, user.uid);
        const recipientName = getUserDisplayName(recipient.data, recipient.uid);

        const details = {
            recipient,
            recipientName,
            senderName,
            amount: amountCheck.value,
            walletType,
            requestId,
            currency: WALLET_CURRENCY[walletType],
            walletLabel: getWalletLabel(walletType)
        };

        const hasPwd = await hasTransferPassword(user.uid);

        // 🔑 Unlock before opening modal
        transferLock = false;
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="bi bi-send me-2"></i> Send Money';
        }

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
// Reconciliation
// ============================================================
function startReconciliationLoop(requestId, userId) {
    let attempts = 0;
    const maxAttempts = 30;

    const check = async () => {
        attempts++;
        try {
            const snap = await get(ref(db, `transferRequests/${requestId}`));
            if (snap.exists()) {
                const data = snap.val();
                if (data.status === 'success') {
                    showToast('✅ Transfer confirmed!', 'success');
                    clearActiveRequestId();
                    loadUserData(userId);
                    resetButton();
                    return;
                } else if (data.status === 'failed') {
                    showToast('❌ Transfer failed.', 'error');
                    clearActiveRequestId();
                    loadUserData(userId);
                    resetButton();
                    return;
                }
            }
            if (attempts >= maxAttempts) {
                showToast('⚠️ Still verifying. Refresh later.', 'error');
                return;
            }
            setTimeout(check, 10000);
        } catch (err) {
            if (attempts < maxAttempts) setTimeout(check, 10000);
        }
    };
    setTimeout(check, 3000);
}

async function reconcilePending() {
    const requestId = localStorage.getItem('activeTransferRequestId');
    if (!requestId) return;
    try {
        const snap = await get(ref(db, `transferRequests/${requestId}`));
        if (snap.exists()) {
            const data = snap.val();
            if (data.status === 'success') {
                showToast('✅ Previous transfer confirmed!', 'success');
                clearActiveRequestId();
                if (currentUserId) loadUserData(currentUserId);
            } else if (data.status === 'failed') {
                showToast('❌ Previous transfer failed.', 'error');
                clearActiveRequestId();
            } else {
                showToast('⚠️ Previous transfer still verifying.', 'error');
                const btn = document.getElementById('sendBtn');
                if (btn) {
                    btn.disabled = true;
                    btn.className = 'btn-send verifying';
                    btn.innerHTML = '<i class="bi bi-hourglass-split me-2"></i>Verifying...';
                }
                transferLock = true;
                startReconciliationLoop(requestId, currentUserId);
            }
        } else {
            clearActiveRequestId();
        }
    } catch (err) { console.warn('Reconcile error:', err); }
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

window.setMaxAmount = function() {
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
        return `
            <div class="transfer-item">
                <div>
                    <div class="${cls}" style="font-size: 0.85rem;">
                        <i class="bi bi-arrow-${isSent ? 'up-right' : 'down-left'}"></i>
                        ${isSent ? 'Sent to' : 'Received from'} 
                        <span class="transfer-name">${name}</span>
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
    } catch (err) { console.error('Load error:', err); }
}

// ============================================================
// Init
// ============================================================
onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = 'login.html'; return; }
    currentUserId = user.uid;

    const snap = await get(ref(db, 'users/' + user.uid));
    if (!snap.exists()) {
        showToast('❌ User not found', 'error');
        setTimeout(() => window.location.href = 'dashboard.html', 2000);
        return;
    }

    await reconcilePending();
    await loadUserData(user.uid);
    setupBalanceListener(user.uid);

    // Form submit
    const form = document.getElementById('transferForm');
    if (form) form.addEventListener('submit', handleTransferSubmit);

    // Setup modal
    document.getElementById('setupBtn').addEventListener('click', handlePasswordSetup);
    document.getElementById('setupPasswordConfirm').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handlePasswordSetup();
    });

    // Verify modal
    document.getElementById('verifyBtn').addEventListener('click', handlePasswordVerify);
    document.getElementById('verifyPassword').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handlePasswordVerify();
    });
    document.getElementById('verifyCancelBtn').addEventListener('click', () => {
        closeModal('verifyModal');
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
});

window.addEventListener('beforeunload', () => {
    if (balanceListenerOff) { balanceListenerOff(); balanceListenerOff = null; }
});
