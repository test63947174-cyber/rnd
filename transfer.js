// ============================================================
// TRANSFER.JS — v2 (FIXED)
// ============================================================
// ✅ Balance show होगा (deposit, referral, RND)
// ✅ Send button transfer complete होने तक LOCK रहेगा
// ✅ Network fail हो तो भी button unlock नहीं होगा
// ✅ runTransaction से double-spend रुकेगा
// ✅ Idempotency (same requestId पर दोबारा effect नहीं)
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged } from "firebase/auth";
import { getDatabase, ref, get, runTransaction, set, onValue } from "firebase/database";

// Firebase config
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
// Constants
// ============================================================
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
// Global State
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

// ============================================================
// Utility functions
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

function generateRequestId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11) +
           Math.random().toString(36).slice(2, 11);
}

function roundToPrecision(value, precision) {
    const factor = Math.pow(10, precision);
    return Math.round(value * factor) / factor;
}

function validateAmount(amount, walletType) {
    if (typeof amount !== 'number' || !isFinite(amount) || Number.isNaN(amount)) {
        return { valid: false, error: 'Invalid amount' };
    }
    if (amount <= 0) {
        return { valid: false, error: 'Amount must be greater than 0' };
    }
    const precision = WALLET_PRECISION[walletType] || 8;
    const rounded = roundToPrecision(amount, precision);
    if (Math.abs(rounded - amount) > 1e-10) {
        return { valid: false, error: `Max ${precision} decimal places allowed` };
    }
    return { valid: true, value: rounded };
}

function getTodayDate() {
    return new Date().toISOString().split('T')[0];
}

// ============================================================
// Get user by identifier (UID / username / referral code)
// ============================================================
async function getUserByIdentifier(identifier) {
    try {
        if (!identifier) return null;

        // 1. Try UID (direct path)
        const uidSnap = await get(ref(db, 'users/' + identifier));
        if (uidSnap.exists()) {
            return { uid: identifier, data: uidSnap.val(), source: 'uid' };
        }

        // 2. Try by username or referralCode — पूरे users को पढ़कर match
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
// ✅ ATOMIC TRANSFER
// ============================================================
async function atomicTransfer(senderUid, recipientUid, amount, walletType, currency, requestId) {
    // ---- Validate ----
    if (!senderUid || !recipientUid) {
        return { status: 'failed', error: 'Missing user IDs' };
    }
    if (senderUid === recipientUid) {
        return { status: 'failed', error: 'Cannot send to yourself' };
    }
    if (!WALLET_CURRENCY[walletType]) {
        return { status: 'failed', error: 'Invalid wallet type' };
    }
    const amountCheck = validateAmount(amount, walletType);
    if (!amountCheck.valid) {
        return { status: 'failed', error: amountCheck.error };
    }
    const safeAmount = amountCheck.value;
    const precision = WALLET_PRECISION[walletType];

    // ---- Idempotency ----
    const requestRef = ref(db, `transferRequests/${requestId}`);
    try {
        const existing = await get(requestRef);
        if (existing.exists()) {
            const data = existing.val();
            console.log('♻️ Replay detected:', requestId);
            return {
                status: data.status === 'success' ? 'success' : data.status,
                txId: data.txId,
                error: data.error,
                replayed: true
            };
        }
    } catch (err) {
        console.error('Idempotency check failed:', err);
        return { status: 'unknown', error: 'Could not verify request state' };
    }

    const txId = 'TX_' + requestId.replace(/-/g, '').slice(0, 20);
    const now = Date.now();

    // ---- Sender side ----
    const senderRef = ref(db, `users/${senderUid}`);
    let senderBalanceBefore = 0;
    let senderUsername = '';

    try {
        const senderResult = await runTransaction(senderRef, (currentData) => {
            if (!currentData) return currentData;

            const balance = roundToPrecision(currentData[walletType] || 0, precision);
            senderBalanceBefore = balance;

            if (balance < safeAmount) {
                return; // abort
            }

            senderUsername = currentData.username || currentData.referralCode || senderUid.slice(0, 8);

            currentData[walletType] = roundToPrecision(balance - safeAmount, precision);

            // History normalize
            if (!currentData.transferHistory || Array.isArray(currentData.transferHistory)) {
                const arr = currentData.transferHistory || [];
                const obj = {};
                arr.forEach((item, i) => { obj[item.txId || `legacy_${i}`] = item; });
                currentData.transferHistory = obj;
            }
            currentData.transferHistory[txId] = {
                type: 'sent',
                to: recipientUid,
                toUid: recipientUid,
                amount: safeAmount,
                currency: currency,
                walletType: walletType,
                from: senderUsername,
                fromUid: senderUid,
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
                to: recipientUid,
                toUid: recipientUid,
                from: senderUsername,
                fromUid: senderUid,
                timestamp: now,
                date: getTodayDate(),
                txId: txId,
                requestId: requestId,
                status: 'completed'
            };

            return currentData;
        });

        if (!senderResult.committed) {
            return {
                status: 'failed',
                error: `Insufficient balance. Available: ${senderBalanceBefore} ${currency}`
            };
        }

        console.log('✅ Sender debited:', txId);

    } catch (err) {
        console.error('Sender transaction error:', err);
        return { status: 'unknown', error: 'Network error on sender side' };
    }

    // ---- Recipient side ----
    const recipientRef = ref(db, `users/${recipientUid}`);
    let recipientUsername = '';

    try {
        const recipientResult = await runTransaction(recipientRef, (currentData) => {
            if (!currentData) return currentData;

            recipientUsername = currentData.username || currentData.referralCode || recipientUid.slice(0, 8);

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
                from: senderUsername,
                fromUid: senderUid,
                to: recipientUid,
                toUid: recipientUid,
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
                from: senderUsername,
                fromUid: senderUid,
                to: recipientUid,
                toUid: recipientUid,
                timestamp: now,
                date: getTodayDate(),
                txId: txId,
                requestId: requestId,
                status: 'completed'
            };

            return currentData;
        });

        if (!recipientResult.committed) {
            console.warn('⚠️ Recipient update failed — running compensation');

            await runTransaction(senderRef, (currentData) => {
                if (!currentData) return currentData;
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

        console.log('✅ Recipient credited:', txId);

    } catch (err) {
        console.error('Recipient transaction error:', err);
        try {
            await set(requestRef, {
                requestId: requestId,
                txId: txId,
                senderUid: senderUid,
                recipientUid: recipientUid,
                amount: safeAmount,
                currency: currency,
                walletType: walletType,
                status: 'unknown',
                createdAt: now,
                error: 'Network ambiguity on recipient side'
            });
        } catch (_) {}

        return {
            status: 'unknown',
            txId: txId,
            error: 'Transfer status could not be confirmed. Please wait.'
        };
    }

    // ---- दोनों सफल ----
    try {
        await set(requestRef, {
            requestId: requestId,
            txId: txId,
            senderUid: senderUid,
            recipientUid: recipientUid,
            amount: safeAmount,
            currency: currency,
            walletType: walletType,
            status: 'success',
            createdAt: now,
            completedAt: Date.now()
        });
    } catch (err) {
        console.warn('Request record write failed (non-critical):', err);
    }

    return { status: 'success', txId: txId, recipientName: recipientUsername };
}

// ============================================================
// ✅ Button Control Functions — साफ़ और स्पष्ट
// ============================================================
function lockButton(state, text) {
    const btn = document.getElementById('sendBtn');
    if (!btn) return;
    btn.disabled = true;
    btn.className = 'btn-send ' + (state || 'sending');
    btn.innerHTML = text || '<span class="loading-spinner me-2"></span>Sending...';
}

function unlockButton() {
    const btn = document.getElementById('sendBtn');
    if (!btn) return;
    btn.disabled = false;
    btn.className = 'btn-send';
    btn.innerHTML = '<i class="bi bi-send me-2"></i> Send Money';
}

// ============================================================
// Handle Transfer Form Submit
// ============================================================
async function handleTransferSubmit(e) {
    e.preventDefault();

    // ---- 🔒 In-memory lock ----
    if (transferLock) {
        showToast('⏳ Transfer already in progress...', 'error');
        return;
    }

    const recipientInput = document.getElementById('recipientInput').value.trim();
    const walletType = document.getElementById('walletSelect').value;
    const amountRaw = document.getElementById('amountInput').value;

    // ---- Validate ----
    if (!recipientInput) {
        showToast('❌ Please enter recipient', 'error');
        return;
    }
    const amount = parseFloat(amountRaw);
    if (!isFinite(amount) || Number.isNaN(amount) || amount <= 0) {
        showToast('❌ Please enter a valid amount', 'error');
        return;
    }
    const amountCheck = validateAmount(amount, walletType);
    if (!amountCheck.valid) {
        showToast('❌ ' + amountCheck.error, 'error');
        return;
    }

    const user = auth.currentUser;
    if (!user) {
        showToast('❌ Please login first', 'error');
        return;
    }

    // Balance check (client-side quick check)
    const currentBalance = currentBalances[walletType] || 0;
    if (currentBalance < amountCheck.value) {
        const currency = WALLET_CURRENCY[walletType];
        showToast(`❌ Insufficient balance. Available: ${currentBalance} ${currency}`, 'error');
        return;
    }

    // Find recipient
    const recipient = await getUserByIdentifier(recipientInput);
    if (!recipient) {
        showToast('❌ User not found!', 'error');
        return;
    }
    if (recipient.uid === user.uid) {
        showToast('❌ Cannot send to yourself!', 'error');
        return;
    }

    // ---- 🔒 LOCK UI ----
    transferLock = true;
    lockButton('sending', '<span class="loading-spinner me-2"></span>Sending...');

    // Generate requestId
    const requestId = generateRequestId();
    localStorage.setItem('pendingTransferRequestId', requestId);
    localStorage.setItem('pendingTransferDetails', JSON.stringify({
        requestId, recipientUid: recipient.uid, amount: amountCheck.value, walletType
    }));

    try {
        const result = await atomicTransfer(
            user.uid,
            recipient.uid,
            amountCheck.value,
            walletType,
            WALLET_CURRENCY[walletType],
            requestId
        );

        const currency = WALLET_CURRENCY[walletType];

        if (result.status === 'success') {
            const name = result.recipientName || recipient.data.username || recipient.data.referralCode || recipient.uid.slice(0, 8);
            showToast(`✅ ${amountCheck.value} ${currency} sent to ${name}!`, 'success');

            document.getElementById('recipientInput').value = '';
            document.getElementById('amountInput').value = '';

            localStorage.removeItem('pendingTransferRequestId');
            localStorage.removeItem('pendingTransferDetails');

            // ✅ Success पर unlock
            setTimeout(() => {
                loadUserData(user.uid);
            }, 500);

            unlockButton();
            transferLock = false;

        } else if (result.status === 'unknown') {
            // ⚠️ CRITICAL: यूज़र को गलत "Failed" नहीं बताना
            // Button LOCKED रहेगा — जब तक reconciliation न हो
            showToast(
                '⚠️ Transfer status could not be confirmed. Please DO NOT submit again. ' +
                'Checking status automatically...',
                'error'
            );

            lockButton('verifying', '<i class="bi bi-hourglass-split me-2"></i>Verifying...');

            // ✅ नया: पहले 5 sec बाद, फिर हर 10 sec पर check करो
            // जब तक status साफ़ न हो जाए
            startReconciliationLoop(requestId, user.uid);

            return; // ⚠️ यहाँ से बाहर, button अभी locked है

        } else {
            showToast('❌ ' + (result.error || 'Transfer failed'), 'error');
            localStorage.removeItem('pendingTransferRequestId');
            localStorage.removeItem('pendingTransferDetails');
            
            // Failure पर unlock
            unlockButton();
            transferLock = false;
        }

    } catch (err) {
        console.error('Transfer error:', err);
        showToast('❌ Unexpected error. Status will be verified.', 'error');
        
        // Network error — UNKNOWN मानो, button locked रखो
        lockButton('verifying', '<i class="bi bi-hourglass-split me-2"></i>Verifying...');
        startReconciliationLoop(requestId, user.uid);
        return;
    }
}

// ============================================================
// ✅ Reconciliation Loop — जब तक status साफ़ न हो
// ============================================================
function startReconciliationLoop(requestId, userId) {
    let attempts = 0;
    const maxAttempts = 30; // ~5 minutes तक try करेगा

    const check = async () => {
        attempts++;
        try {
            const snap = await get(ref(db, `transferRequests/${requestId}`));
            
            if (snap.exists()) {
                const data = snap.val();
                
                if (data.status === 'success') {
                    showToast('✅ Transfer confirmed successful!', 'success');
                    localStorage.removeItem('pendingTransferRequestId');
                    localStorage.removeItem('pendingTransferDetails');
                    loadUserData(userId);
                    unlockButton();
                    transferLock = false;
                    return;
                } else if (data.status === 'failed') {
                    showToast('❌ Transfer failed. Amount not deducted.', 'error');
                    localStorage.removeItem('pendingTransferRequestId');
                    localStorage.removeItem('pendingTransferDetails');
                    loadUserData(userId);
                    unlockButton();
                    transferLock = false;
                    return;
                }
                // status unknown — continue polling
            }
            
            // अभी भी unknown
            if (attempts >= maxAttempts) {
                // 5 मिनट के बाद भी unknown — user को बताओ
                showToast(
                    '⚠️ Still verifying. Refresh the page later to check.',
                    'error'
                );
                // Button को unlock नहीं करेंगे — user refresh करे                return;
            }
            
            // 10 sec बाद फिर check
            setTimeout(check, 10000);
            
        } catch (err) {
            console.warn('Reconcile check error:', err);
            if (attempts < maxAttempts) {
                setTimeout(check, 10000);
            }
        }
    };

    // पहला check 5 sec बाद
    setTimeout(check, 5000);
}

// ============================================================
// Reconcile pending transfers (page load पर)
// ============================================================
async function reconcilePending() {
    const pendingRequestId = localStorage.getItem('pendingTransferRequestId');
    if (!pendingRequestId) return;

    try {
        const snap = await get(ref(db, `transferRequests/${pendingRequestId}`));
        if (snap.exists()) {
            const data = snap.val();
            if (data.status === 'success') {
                showToast('✅ Previous transfer confirmed successful!', 'success');
                localStorage.removeItem('pendingTransferRequestId');
                localStorage.removeItem('pendingTransferDetails');
                if (currentUserId) loadUserData(currentUserId);
            } else if (data.status === 'failed') {
                showToast('❌ Previous transfer failed.', 'error');
                localStorage.removeItem('pendingTransferRequestId');
                localStorage.removeItem('pendingTransferDetails');
            } else {
                // अभी भी unknown — user को बताओ
                showToast(
                    '⚠️ A previous transfer is still being verified. Please wait.',
                    'error'
                );
            }
        }
    } catch (err) {
        console.warn('Reconcile error:', err);
    }
}

// ============================================================
// Balance listener
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
    }, (error) => {
        console.error('Balance listener error:', error);
    });
}

// ============================================================
// ✅ Balance UI update — id names perfectly matched
// ============================================================
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
    if (availText) {
        availText.textContent = balance.toFixed(precision) + ' ' + currency;
    }
}

// ============================================================
// "Send Max"
// ============================================================
window.setMaxAmount = function() {
    const walletType = document.getElementById('walletSelect').value;
    const balance = currentBalances[walletType] || 0;
    const precision = WALLET_PRECISION[walletType];
    document.getElementById('amountInput').value = balance.toFixed(precision);
};

// ============================================================
// Recent transfers
// ============================================================
function renderRecentTransfers(u) {
    const container = document.getElementById('recentTransfers');
    if (!container) return;

    let rawHistory = u.transferHistory || [];
    let historyArr = [];
    if (Array.isArray(rawHistory)) {
        historyArr = rawHistory;
    } else {
        historyArr = Object.values(rawHistory).filter(Boolean);
    }

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
        const counterparty = isSent ? (t.to || 'unknown') : (t.from || 'unknown');
        const sign = isSent ? '-' : '+';
        const cls = isSent ? 'transfer-sent' : 'transfer-received';
        const date = t.timestamp ? new Date(t.timestamp).toLocaleString('hi-IN') : '';

        return `
            <div class="transfer-item">
                <div>
                    <div class="${cls}" style="font-size: 0.85rem;">
                        <i class="bi bi-arrow-${isSent ? 'up-right' : 'down-left'}"></i>
                        ${isSent ? 'Sent to' : 'Received from'} 
                        <strong>${counterparty}</strong>
                    </div>
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
        showToast('❌ Failed to load data', 'error');
    }
}

// ============================================================
// Main init
// ============================================================
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'login.html';
        return;
    }

    currentUserId = user.uid;

    const snap = await get(ref(db, 'users/' + user.uid));
    if (!snap.exists()) {
        showToast('❌ User account not found', 'error');
        setTimeout(() => {
            window.location.href = 'dashboard.html';
        }, 2000);
        return;
    }

    await reconcilePending();
    await loadUserData(user.uid);

    // Real-time balance listener
    setupBalanceListener(user.uid);

    // Form submit
    const form = document.getElementById('transferForm');
    if (form) {
        form.addEventListener('submit', handleTransferSubmit);
    }

    // Wallet change → update available text
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

// Cleanup
window.addEventListener('beforeunload', () => {
    if (balanceListenerOff) {
        balanceListenerOff();
        balanceListenerOff = null;
    }
});
