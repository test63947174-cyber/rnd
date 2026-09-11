// ============================================================
// TRANSFER.JS — v4 (Password + Names)
// ============================================================
// ✅ requestId localStorage persist — duplicate click पर same
// ✅ Server idempotency — same requestId दोबारा effect नहीं
// ✅ Button पहली लाइन पर lock
// ✅ Transfer password setup + verification (SHA-256 hash)
// ✅ History में recipient का नाम भी दिखे
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

const WALLET_CURRENCY = {
    depositWallet: 'USDT',
    referralWallet: 'USDT',
    rndWallet: 'RND'
};

const WALLET_PRECISION = {
    depositWallet: 2,
    referralWallet: 2,
    rndWallet: 8
};

// ============================================================
// State
// ============================================================
let currentUserData = null;
let currentUserId = null;
let transferLock = false;
let balanceListenerOff = null;
let currentBalances = {
    depositWallet: 0,
    referralWallet: 0,
    rndWallet: 0
};

// 🔑 Pending transfer details (जब password verify हो रहा हो)
let pendingTransfer = null;

// ============================================================
// 🔐 Password Hashing (SHA-256)
// ============================================================
async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
}

// ============================================================
// 🔑 Idempotency Key
// ============================================================
function getOrCreateRequestId() {
    let existing = localStorage.getItem('activeTransferRequestId');
    if (existing) return existing;
    let newId;
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        newId = crypto.randomUUID();
    } else {
        newId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
    }
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

function roundToPrecision(value, precision) {
    const factor = Math.pow(10, precision);
    return Math.round(value * factor) / factor;
}

function validateAmount(amount, walletType) {
    if (typeof amount !== 'number' || !isFinite(amount) || Number.isNaN(amount)) {
        return { valid: false, error: 'Invalid amount' };
    }
    if (amount <= 0) return { valid: false, error: 'Amount must be > 0' };
    const precision = WALLET_PRECISION[walletType] || 8;
    const rounded = roundToPrecision(amount, precision);
    if (Math.abs(rounded - amount) > 1e-10) {
        return { valid: false, error: `Max ${precision} decimal places` };
    }
    return { valid: true, value: rounded };
}

function getTodayDate() {
    return new Date().toISOString().split('T')[0];
}

// ============================================================
// Recipient Lookup
// ============================================================
async function getUserByIdentifier(identifier) {
    try {
        if (!identifier) return null;
        const uidSnap = await get(ref(db, 'users/' + identifier));
        if (uidSnap.exists()) {
            return { uid: identifier, data: uidSnap.val(), source: 'uid' };
        }
        const usersSnap = await get(ref(db, 'users'));
        if (usersSnap.exists()) {
            const users = usersSnap.val();
            for (const uid in users) {
                const u = users[uid];
                if (u.username === identifier || u.referralCode === identifier) {
                    return { uid: uid, data: u, source: 'match' };
                }
            }
        }
        return null;
    } catch (error) {
        console.error('Error finding user:', error);
        return null;
    }
}

// ============================================================
// 👤 Get display name for user
// ============================================================
function getUserDisplayName(userData, fallbackUid) {
    if (!userData) return fallbackUid ? fallbackUid.slice(0, 8) : 'Unknown';
    return userData.name 
        || userData.username 
        || userData.referralCode 
        || (fallbackUid ? fallbackUid.slice(0, 8) : 'Unknown');
}

// ============================================================
// 🔐 Password Management
// ============================================================
async function hasTransferPassword(uid) {
    try {
        const snap = await get(ref(db, `users/${uid}/transferPasswordHash`));
        return snap.exists() && snap.val();
    } catch (err) {
        console.error('Password check error:', err);
        return false;
    }
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
        const storedHash = snap.val();
        const inputHash = await hashPassword(password);
        return storedHash === inputHash;
    } catch (err) {
        console.error('Verify error:', err);
        return false;
    }
}

// ============================================================
// ✅ ATOMIC TRANSFER
// ============================================================
async function atomicTransfer(senderUid, recipientUid, amount, walletType, currency, requestId, senderDisplayName, recipientDisplayName) {
    if (!senderUid || !recipientUid) return { status: 'failed', error: 'Missing user IDs' };
    if (senderUid === recipientUid) return { status: 'failed', error: 'Cannot send to yourself' };
    if (!WALLET_CURRENCY[walletType]) return { status: 'failed', error: 'Invalid wallet type' };
    
    const amountCheck = validateAmount(amount, walletType);
    if (!amountCheck.valid) return { status: 'failed', error: amountCheck.error };
    const safeAmount = amountCheck.value;
    const precision = WALLET_PRECISION[walletType];

    const requestRef = ref(db, `transferRequests/${requestId}`);
    const txId = 'TX_' + requestId.replace(/-/g, '').slice(0, 20);
    const now = Date.now();

    // ---- Sender side ----
    const senderRef = ref(db, `users/${senderUid}`);
    let senderBalanceBefore = 0;
    let alreadyProcessedInSender = false;

    try {
        const senderResult = await runTransaction(senderRef, (currentData) => {
            if (!currentData) return currentData;

            const history = currentData.transferHistory || {};
            if (history[txId]) {
                alreadyProcessedInSender = true;
                return;
            }

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
                type: 'sent',
                to: recipientDisplayName,         // ✅ नाम
                toUid: recipientUid,
                toUsername: recipientDisplayName, // ✅ यूज़रनेम भी
                amount: safeAmount,
                currency: currency,
                walletType: walletType,
                from: senderDisplayName,
                fromUid: senderUid,
                fromUsername: senderDisplayName,
                timestamp: now,
                txId: txId,
                requestId: requestId,
                status: 'completed'
            };

            if (!currentData.transactions) currentData.transactions = {};
            currentData.transactions[txId] = {
                type: 'transfer_sent',
                amount: safeAmount,
                currency: currency,
                walletType: walletType,
                to: recipientDisplayName,
                toUid: recipientUid,
                toUsername: recipientDisplayName,
                from: senderDisplayName,
                fromUid: senderUid,
                timestamp: now,
                date: getTodayDate(),
                txId: txId,
                requestId: requestId,
                status: 'completed'
            };

            return currentData;
        });

        if (alreadyProcessedInSender) {
            return { status: 'success', txId, recipientName: recipientDisplayName, duplicate: true };
        }

        if (!senderResult.committed) {
            return { status: 'failed', error: `Insufficient balance. Available: ${senderBalanceBefore} ${currency}` };
        }

    } catch (err) {
        console.error('Sender transaction error:', err);
        return { status: 'unknown', error: 'Network error on sender side' };
    }

    // ---- Recipient side ----
    const recipientRef = ref(db, `users/${recipientUid}`);
    let alreadyProcessedInRecipient = false;

    try {
        const recipientResult = await runTransaction(recipientRef, (currentData) => {
            if (!currentData) return currentData;

            const history = currentData.transferHistory || {};
            if (history[txId]) {
                alreadyProcessedInRecipient = true;
                return;
            }

            const balance = roundToPrecision(currentData[walletType] || 0, precision);
            currentData[walletType] = roundToPrecision(balance + safeAmount, precision);

            if (!currentData.transferHistory || Array.isArray(currentData.transferHistory)) {
                const arr = currentData.transferHistory || [];
                const obj = {};
                arr.forEach((item, i) => { obj[item.txId || `legacy_${i}`] = item; });
                currentData.transferHistory = obj;
            }
            currentData.transferHistory[txId] = {
                type: 'received',
                from: senderDisplayName,        // ✅ नाम
                fromUid: senderUid,
                fromUsername: senderDisplayName,
                to: recipientDisplayName,
                toUid: recipientUid,
                toUsername: recipientDisplayName,
                amount: safeAmount,
                currency: currency,
                walletType: walletType,
                timestamp: now,
                txId: txId,
                requestId: requestId,
                status: 'completed'
            };

            if (!currentData.transactions) currentData.transactions = {};
            currentData.transactions[txId] = {
                type: 'transfer_received',
                amount: safeAmount,
                currency: currency,
                walletType: walletType,
                from: senderDisplayName,
                fromUid: senderUid,
                to: recipientDisplayName,
                toUid: recipientUid,
                timestamp: now,
                date: getTodayDate(),
                txId: txId,
                requestId: requestId,
                status: 'completed'
            };

            return currentData;
        });

        if (alreadyProcessedInRecipient) {
            // दोनों तरफ हो गया — success
        } else if (!recipientResult.committed) {
            console.warn('⚠️ Recipient update failed — running compensation');
            await runTransaction(senderRef, (currentData) => {
                if (!currentData) return currentData;
                const hist = currentData.transferHistory || {};
                if (hist[txId] && hist[txId].status === 'reversed') return;
                currentData[walletType] = roundToPrecision(
                    (currentData[walletType] || 0) + safeAmount, precision
                );
                if (currentData.transferHistory && currentData.transferHistory[txId]) {
                    currentData.transferHistory[txId].status = 'reversed';
                }
                if (currentData.transactions && currentData.transactions[txId]) {
                    currentData.transactions[txId].status = 'reversed';
                }
                return currentData;
            });
            return { status: 'failed', error: 'Recipient update failed — amount returned' };
        }

    } catch (err) {
        console.error('Recipient transaction error:', err);
        try {
            await set(requestRef, {
                requestId, txId, senderUid, recipientUid,
                amount: safeAmount, currency, walletType,
                status: 'unknown',
                createdAt: now,
                error: 'Network ambiguity'
            });
        } catch (_) {}
        return { status: 'unknown', txId: txId, error: 'Transfer status could not be confirmed.' };
    }

    // ---- Success record ----
    try {
        await set(requestRef, {
            requestId, txId, senderUid, recipientUid,
            amount: safeAmount, currency, walletType,
            status: 'success',
            createdAt: now, completedAt: Date.now()
        });
    } catch (err) {
        console.warn('Request record write failed:', err);
    }

    return { status: 'success', txId: txId, recipientName: recipientDisplayName };
}

// ============================================================
// 🎭 MODAL CONTROLS
// ============================================================
function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('active');
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('active');
}

// ============================================================
// Password Setup Modal
// ============================================================
function openPasswordSetup() {
    document.getElementById('setupPassword').value = '';
    document.getElementById('setupPasswordConfirm').value = '';
    document.getElementById('setupError').classList.remove('show');
    openModal('setupModal');
    setTimeout(() => document.getElementById('setupPassword').focus(), 200);
}

async function handlePasswordSetup() {
    const pwd = document.getElementById('setupPassword').value;
    const pwdConfirm = document.getElementById('setupPasswordConfirm').value;
    const errorEl = document.getElementById('setupError');
    const btn = document.getElementById('setupBtn');

    errorEl.classList.remove('show');

    if (!pwd || pwd.length < 6) {
        errorEl.textContent = 'Password कम से कम 6 characters का होना चाहिए';
        errorEl.classList.add('show');
        return;
    }
    if (pwd !== pwdConfirm) {
        errorEl.textContent = 'दोनों passwords match नहीं कर रहे';
        errorEl.classList.add('show');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner me-2"></span>Setting...';

    try {
        await saveTransferPassword(currentUserId, pwd);
        showToast('✅ Transfer password set successfully!', 'success');
        closeModal('setupModal');
    } catch (err) {
        console.error('Save password error:', err);
        errorEl.textContent = 'Password save नहीं हो पाया। दोबारा try करें।';
        errorEl.classList.add('show');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-check-circle me-2"></i>Set Password';
    }
}

// ============================================================
// Password Verification Modal
// ============================================================
function openPasswordVerify(details) {
    document.getElementById('verifyPassword').value = '';
    document.getElementById('verifyError').classList.remove('show');
    
    // Details दिखाओ
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

        // ✅ Password सही — अब transfer execute करो
        closeModal('verifyModal');
        
        const details = pendingTransfer;
        if (!details) {
            showToast('❌ Transfer details missing', 'error');
            btn.disabled = false;
            btn.innerHTML = '<i class="bi bi-shield-check me-2"></i>Verify & Send';
            return;
        }

        // Execute transfer
        await executeTransfer(details);
        
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-shield-check me-2"></i>Verify & Send';

    } catch (err) {
        console.error('Verify error:', err);
        errorEl.textContent = 'Error आया। दोबारा try करें।';
        errorEl.classList.add('show');
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-shield-check me-2"></i>Verify & Send';
    }
}

// ============================================================
// 🚀 EXECUTE TRANSFER (password verify होने के बाद)
// ============================================================
async function executeTransfer(details) {
    const user = auth.currentUser;
    if (!user) return;

    const { recipient, amount, walletType, requestId } = details;
    const currency = WALLET_CURRENCY[walletType];
    const btn = document.getElementById('sendBtn');

    if (btn) {
        btn.disabled = true;
        btn.className = 'btn-send sending';
        btn.innerHTML = '<span class="loading-spinner me-2"></span>Sending...';
    }

    try {
        const result = await atomicTransfer(
            user.uid,
            recipient.uid,
            amount,
            walletType,
            currency,
            requestId,
            details.senderName,
            details.recipientName
        );

        if (result.status === 'success') {
            if (result.duplicate) {
                showToast(`✅ Transfer already completed (duplicate ignored)`, 'success');
            } else {
                showToast(`✅ ${amount} ${currency} sent to ${details.recipientName}!`, 'success');
            }

            document.getElementById('recipientInput').value = '';
            document.getElementById('amountInput').value = '';
            clearActiveRequestId();
            setTimeout(() => loadUserData(user.uid), 500);
            resetButton();

        } else if (result.status === 'unknown') {
            showToast(
                '⚠️ Transfer status could not be confirmed. Please DO NOT submit again. Checking...',
                'error'
            );
            if (btn) {
                btn.className = 'btn-send verifying';
                btn.innerHTML = '<i class="bi bi-hourglass-split me-2"></i>Verifying...';
            }
            startReconciliationLoop(requestId, user.uid);
            return;

        } else {
            showToast('❌ ' + (result.error || 'Transfer failed'), 'error');
            clearActiveRequestId();
            resetButton();
        }

    } catch (err) {
        console.error('Execute transfer error:', err);
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
// Form Submit → पहले password चेक करो
// ============================================================
async function handleTransferSubmit(e) {
    e.preventDefault();

    if (transferLock) {
        showToast('⏳ Transfer already in progress...', 'error');
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
            showToast('❌ Please enter recipient', 'error');
            resetButton();
            return;
        }
        const amount = parseFloat(amountRaw);
        if (!isFinite(amount) || Number.isNaN(amount) || amount <= 0) {
            showToast('❌ Please enter a valid amount', 'error');
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
            showToast('❌ Please login first', 'error');
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

        // 🔑 Pending request check
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
                    showToast('⚠️ Previous transfer still verifying. Please wait.', 'error');
                    resetButton();
                    return;
                } else if (pData.status === 'failed') {
                    clearActiveRequestId();
                }
            } else {
                showToast('⚠️ A previous transfer is pending. Please refresh.', 'error');
                resetButton();
                return;
            }
        }

        // 🔑 Get or create requestId
        const requestId = getOrCreateRequestId();

        // 👤 Names निकालो
        const senderName = getUserDisplayName(currentUserData, user.uid);
        const recipientName = getUserDisplayName(recipient.data, recipient.uid);

        // 🔐 Password check — set है या नहीं?
        const hasPwd = await hasTransferPassword(user.uid);

        // Pending details save करो
        pendingTransfer = {
            recipient,
            recipientName,
            senderName,
            amount: amountCheck.value,
            walletType,
            requestId,
            currency: WALLET_CURRENCY[walletType],
            walletLabel: getWalletLabel(walletType)
        };

        if (!hasPwd) {
            // पहली बार — setup modal खोलो
            resetButton();  // button unlock
            openPasswordSetup();
            return;
        }

        // Password है — verification modal खोलो
        resetButton();  // button unlock (modal खुलेगा)
        openPasswordVerify({
            amount: amountCheck.value,
            currency: WALLET_CURRENCY[walletType],
            recipientName: recipientName,
            walletLabel: getWalletLabel(walletType)
        });

    } catch (err) {
        console.error('Transfer error:', err);
        showToast('❌ Unexpected error.', 'error');
        resetButton();
    }
}

function getWalletLabel(walletType) {
    if (walletType === 'depositWallet') return '💰 Deposit Wallet';
    if (walletType === 'referralWallet') return '💳 Referral Wallet';
    if (walletType === 'rndWallet') return '📊 RND Wallet';
    return walletType;
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
                showToast('⚠️ Still verifying. Please refresh later.', 'error');
                return;
            }
            setTimeout(check, 10000);
        } catch (err) {
            console.warn('Reconcile error:', err);
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
    } catch (err) {
        console.warn('Reconcile error:', err);
    }
}

// ============================================================
// Balance
// ============================================================
function setupBalanceListener(uid) {
    if (balanceListenerOff) {
        balanceListenerOff();
        balanceListenerOff = null;
    }
    balanceListenerOff = onValue(ref(db, 'users/' + uid), (snapshot) => {
        if (!snapshot.exists()) return;
        const u = snapshot.val();
        currentUserData = u;
        currentBalances.depositWallet = u.depositWallet || 0;
        currentBalances.referralWallet = u.referralWallet || 0;
        currentBalances.rndWallet = u.rndWallet || 0;
        updateBalanceUI();
    }, (error) => console.error('Balance listener error:', error));
}

function updateBalanceUI() {
    const dep = document.getElementById('balanceDeposit');
    const ref = document.getElementById('balanceReferral');
    const rnd = document.getElementById('balanceRND');
    if (dep) dep.textContent = '$' + (currentBalances.depositWallet || 0).toFixed(2);
    if (ref) ref.textContent = '$' + (currentBalances.referralWallet || 0).toFixed(2);
    if (rnd) rnd.textContent = (currentBalances.rndWallet || 0).toFixed(4) + ' RND';
    updateAvailableText();
}

function updateAvailableText() {
    const select = document.getElementById('walletSelect');
    if (!select) return;
    const walletType = select.value;
    const balance = currentBalances[walletType] || 0;
    const currency = WALLET_CURRENCY[walletType];
    const precision = WALLET_PRECISION[walletType];
    const availText = document.getElementById('availableText');
    if (availText) availText.textContent = balance.toFixed(precision) + ' ' + currency;
}

window.setMaxAmount = function() {
    const walletType = document.getElementById('walletSelect').value;
    const balance = currentBalances[walletType] || 0;
    const precision = WALLET_PRECISION[walletType];
    document.getElementById('amountInput').value = balance.toFixed(precision);
};

// ============================================================
// Recent transfers — अब नाम के साथ
// ============================================================
function renderRecentTransfers(u) {
    const container = document.getElementById('recentTransfers');
    if (!container) return;

    let rawHistory = u.transferHistory || [];
    let historyArr = Array.isArray(rawHistory) 
        ? rawHistory 
        : Object.values(rawHistory).filter(Boolean);

    historyArr.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const recent = historyArr.slice(0, 5);

    if (recent.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; color: #64748b; padding: 20px; font-size: 0.85rem;">
                <i class="bi bi-clock"></i> No transfers yet
            </div>
        `;
        return;
    }

    container.innerHTML = recent.map(t => {
        const isSent = t.type === 'sent';
        // ✅ नाम prioritize करो
        const counterpartyName = isSent 
            ? (t.to || t.toUsername || 'Unknown')
            : (t.from || t.fromUsername || 'Unknown');
        const counterpartyUid = isSent 
            ? (t.toUid || '')
            : (t.fromUid || '');
        const sign = isSent ? '-' : '+';
        const cls = isSent ? 'transfer-sent' : 'transfer-received';
        const date = t.timestamp ? new Date(t.timestamp).toLocaleString('hi-IN') : '';
        
        return `
            <div class="transfer-item">
                <div>
                    <div class="${cls}" style="font-size: 0.85rem;">
                        <i class="bi bi-arrow-${isSent ? 'up-right' : 'down-left'}"></i>
                        ${isSent ? 'Sent to' : 'Received from'} 
                        <span class="transfer-name">${counterpartyName}</span>
                    </div>
                    ${counterpartyUid ? `<div style="font-size: 0.7rem; color: #64748b; margin-top: 2px;">ID: ${counterpartyUid.slice(0, 12)}...</div>` : ''}
                    <div class="transfer-date">${date}</div>
                </div>
                <div class="transfer-amount ${cls}">
                    ${sign}${t.amount} ${t.currency || 'RND'}
                </div>
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
        if (!snap.exists()) {
            showToast('❌ User data not found', 'error');
            return;
        }
        const u = snap.val();
        currentUserData = u;
        currentBalances.depositWallet = u.depositWallet || 0;
        currentBalances.referralWallet = u.referralWallet || 0;
        currentBalances.rndWallet = u.rndWallet || 0;
        updateBalanceUI();
        renderRecentTransfers(u);
    } catch (err) {
        console.error('Load user data error:', err);
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

    await reconcilePending();
    await loadUserData(user.uid);
    setupBalanceListener(user.uid);

    // Form submit
    const form = document.getElementById('transferForm');
    if (form) form.addEventListener('submit', handleTransferSubmit);

    // Password setup
    document.getElementById('setupBtn').addEventListener('click', handlePasswordSetup);
    document.getElementById('setupPasswordConfirm').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handlePasswordSetup();
    });

    // Password verify
    document.getElementById('verifyBtn').addEventListener('click', handlePasswordVerify);
    document.getElementById('verifyPassword').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handlePasswordVerify();
    });
    document.getElementById('verifyCancelBtn').addEventListener('click', () => {
        closeModal('verifyModal');
        pendingTransfer = null;
        resetButton();
    });

    // Wallet select
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
    if (balanceListenerOff) {
        balanceListenerOff();
        balanceListenerOff = null;
    }
});
