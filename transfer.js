// ============================================================
// TRANSFER.JS — अलग Transfer Page का JavaScript
// ============================================================
// ✅ रनTransaction से double-spend रुकेगा
// ✅ Idempotency (same requestId पर दोबारा effect नहीं)
// ✅ Network timeout पर UNKNOWN status, गलत FAILED नहीं
// ✅ Balance negative नहीं होगा
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged } from "firebase/auth";
import { getDatabase, ref, get, runTransaction, set, onValue } from "firebase/database";

// Firebase config (same as dashboard)
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
let transferLock = false;         // in-memory lock (double-click prevention)
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
    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;
    const icon = type === 'success' ? 'bi-check-circle-fill text-success' : 'bi-exclamation-triangle-fill text-danger';
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

        // 1. Try UID
        const uidSnap = await get(ref(db, 'users/' + identifier));
        if (uidSnap.exists()) {
            return { uid: identifier, data: uidSnap.val(), source: 'uid' };
        }

        // 2. Try by fetching all users (match username/referralCode)
        // (Firebase के orderByChild को index चाहिए, इसलिए simple read)
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
// ✅ ATOMIC TRANSFER — दिल का हिस्सा
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

    // ---- Idempotency: पहले से processed है क्या? ----
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

    // ---- Deterministic txId ----
    const txId = 'TX_' + requestId.replace(/-/g, '').slice(0, 20);
    const now = Date.now();

    // ---- ✅ SENDER side: runTransaction (atomic) ----
    // यह सर्वर पर execute होता है, इसलिए double-spend नहीं होगा
    const senderRef = ref(db, `users/${senderUid}`);
    let senderBalanceBefore = 0;
    let senderUsername = '';
    let senderUpdated = false;

    try {
        const senderResult = await runTransaction(senderRef, (currentData) => {
            if (!currentData) return currentData; // abort

            const balance = roundToPrecision(currentData[walletType] || 0, precision);

            // ❌ Balance कम है → abort (transaction fail हो जाएगा)
            if (balance < safeAmount) {
                senderBalanceBefore = balance;
                return; // undefined return = abort
            }

            senderBalanceBefore = balance;
            senderUsername = currentData.username || currentData.referralCode || senderUid.slice(0, 8);

            // ✅ Balance काटो
            currentData[walletType] = roundToPrecision(balance - safeAmount, precision);

            // ✅ Sender history add करो
            if (!currentData.transferHistory || Array.isArray(currentData.transferHistory)) {
                // Array → object में convert
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

            // ✅ Transactions add करो
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
            // Sender side fail — balance insufficient
            return {
                status: 'failed',
                error: `Insufficient balance. Available: ${senderBalanceBefore} ${currency}`
            };
        }

        senderUpdated = true;
        console.log('✅ Sender debited atomically:', txId);

    } catch (err) {
        console.error('Sender transaction error:', err);
        return { status: 'unknown', error: 'Network error on sender side' };
    }

    // ---- ✅ RECIPIENT side: runTransaction ----
    const recipientRef = ref(db, `users/${recipientUid}`);
    let recipientUsername = '';

    try {
        const recipientResult = await runTransaction(recipientRef, (currentData) => {
            if (!currentData) return currentData;

            recipientUsername = currentData.username || currentData.referralCode || recipientUid.slice(0, 8);

            // ✅ Balance जोड़ो
            const balance = roundToPrecision(currentData[walletType] || 0, precision);
            currentData[walletType] = roundToPrecision(balance + safeAmount, precision);

            // ✅ Recipient history
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

            // ✅ Recipient transactions
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
            // ⚠️ Recipient fail — सर्वर पर कुछ नहीं बदला, लेकिन sender से पैसे कट गए
            // अब हम एक "compensation" transaction लिखते हैं जो sender को वापस देगी
            // (यह client-side rollback नहीं है, यह एक अलग transaction है जो 
            //  balance को संतुलित करती है)
            console.warn('⚠️ Recipient update failed — running compensation');

            await runTransaction(senderRef, (currentData) => {
                if (!currentData) return currentData;
                // वापस जोड़ो
                currentData[walletType] = roundToPrecision(
                    (currentData[walletType] || 0) + safeAmount, precision
                );
                // Sender history में "reversed" mark करो
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

        console.log('✅ Recipient credited atomically:', txId);

    } catch (err) {
        console.error('Recipient transaction error:', err);
        // Network ambiguity — sender से कट गया, recipient को मिला या नहीं पता नहीं
        // हम request record में UNKNOWN लिखते हैं
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

    // ---- ✅ दोनों सफल — request record लिखो ----
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
        // Record लिखने में fail — लेकिन transfer हो गया है
        // यह non-critical है, हम success ही return करेंगे
        console.warn('Request record write failed (non-critical):', err);
    }

    return { status: 'success', txId: txId, recipientName: recipientUsername };
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
    const btn = document.getElementById('sendBtn');

    // ---- Validate inputs ----
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

    // ---- Balance check (client-side, quick UX check) ----
    const currentBalance = currentBalances[walletType] || 0;
    if (currentBalance < amountCheck.value) {
        const currency = WALLET_CURRENCY[walletType];
        showToast(`❌ Insufficient balance. Available: ${currentBalance} ${currency}`, 'error');
        return;
    }

    // ---- Find recipient ----
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
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner me-2"></span>Sending...';

    // ---- Generate requestId ----
    const requestId = generateRequestId();
    // localStorage में सेव करो — refresh पर recovery के लिए
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
            
            // Clear form
            document.getElementById('recipientInput').value = '';
            document.getElementById('amountInput').value = '';
            
            // Clear pending
            localStorage.removeItem('pendingTransferRequestId');
            localStorage.removeItem('pendingTransferDetails');
            
            // Refresh data
            setTimeout(() => {
                loadUserData(user.uid);
            }, 500);

        } else if (result.status === 'unknown') {
            // ⚠️ CRITICAL: यूज़र को "Failed" नहीं बोलना
            showToast(
                '⚠️ Transfer status could not be confirmed. Please DO NOT submit again. ' +
                'We will verify on next load.',
                'error'
            );
            
            // Button बंद रहेगा — 30 seconds तक
            // ताकि यूज़र दोबारा न दबा सके
            btn.innerHTML = '<i class="bi bi-hourglass-split me-2"></i>Verifying...';
            
            setTimeout(async () => {
                // Reconciliation try करो
                await reconcilePending();
                
                btn.disabled = false;
                btn.innerHTML = '<i class="bi bi-send me-2"></i> Send Money';
                transferLock = false;
            }, 30000); // 30 seconds
            return; // ⚠️ यहाँ से बाहर निकलो, नीचे unlock न हो

        } else {
            showToast('❌ ' + (result.error || 'Transfer failed'), 'error');
            localStorage.removeItem('pendingTransferRequestId');
            localStorage.removeItem('pendingTransferDetails');
        }

    } catch (err) {
        console.error('Transfer error:', err);
        showToast('❌ Unexpected error. Please check again.', 'error');
        localStorage.removeItem('pendingTransferRequestId');
        localStorage.removeItem('pendingTransferDetails');
    }

    // ---- Unlock UI ----
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-send me-2"></i> Send Money';
    transferLock = false;
}

// ============================================================
// Reconcile pending transfers (on page load)
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
            }
            // 'unknown' → पेंडिंग रहने दो
        } else {
            // Record नहीं मिला — अभी पक्का नहीं कि fail हुआ
            // इसे पेंडिंग रहने दो, अगली बार फिर try करेंगे
            console.log('Pending record not found — keeping for retry');
        }
    } catch (err) {
        console.warn('Reconcile error:', err);
    }
}

// ============================================================
// Balance listener (real-time balance update)
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
    });
}

function updateBalanceUI() {
    document.getElementById('balanceDeposit').textContent = '$' + (currentBalances.depositWallet || 0).toFixed(2);
    document.getElementById('balanceReferral').textContent = '$' + (currentBalances.referralWallet || 0).toFixed(2);
    document.getElementById('balanceRND').textContent = (currentBalances.rndWallet || 0).toFixed(4) + ' RND';
    
    updateAvailableText();
}

function updateAvailableText() {
    const walletType = document.getElementById('walletSelect').value;
    const balance = currentBalances[walletType] || 0;
    const currency = WALLET_CURRENCY[walletType];
    const precision = WALLET_PRECISION[walletType];
    document.getElementById('availableText').textContent = 
        balance.toFixed(precision) + ' ' + currency;
}

// ============================================================
// "Send Max" button
// ============================================================
window.setMaxAmount = function() {
    const walletType = document.getElementById('walletSelect').value;
    const balance = currentBalances[walletType] || 0;
    const precision = WALLET_PRECISION[walletType];
    document.getElementById('amountInput').value = balance.toFixed(precision);
};

// ============================================================
// Recent transfers render
// ============================================================
function renderRecentTransfers(u) {
    const container = document.getElementById('recentTransfers');
    
    let rawHistory = u.transferHistory || [];
    // Array → object normalization
    let historyArr = [];
    if (Array.isArray(rawHistory)) {
        historyArr = rawHistory;
    } else {
        historyArr = Object.values(rawHistory).filter(Boolean);
    }
    
    // Sort by timestamp desc, top 5
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
        
        // Update balances
        currentBalances.depositWallet = u.depositWallet || 0;
        currentBalances.referralWallet = u.referralWallet || 0;
        currentBalances.rndWallet = u.rndWallet || 0;
        updateBalanceUI();
        
        // Render recent transfers
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
        // Not logged in → redirect to login
        window.location.href = 'login.html';
        return;
    }
    
    currentUserId = user.uid;
    
    // Check user exists
    const snap = await get(ref(db, 'users/' + user.uid));
    if (!snap.exists()) {
        showToast('❌ User account not found', 'error');
        setTimeout(() => {
            window.location.href = 'dashboard.html';
        }, 2000);
        return;
    }
    
    // Reconcile any pending transfers first
    await reconcilePending();
    
    // Load user data
    await loadUserData(user.uid);
    
    // Setup real-time balance listener
    setupBalanceListener(user.uid);
    
    // Setup form submit
    document.getElementById('transferForm').addEventListener('submit', handleTransferSubmit);
    
    // Wallet change → update available text
    document.getElementById('walletSelect').addEventListener('change', () => {
        updateAvailableText();
        // RND wallet के precision के हिसाब से step बदलो
        const walletType = document.getElementById('walletSelect').value;
        const amountInput = document.getElementById('amountInput');
        if (walletType === 'rndWallet') {
            amountInput.step = '0.00000001';
            amountInput.min = '0.00000001';
        } else {
            amountInput.step = '0.01';
            amountInput.min = '0.01';
        }
    });
});

// Cleanup on unload
window.addEventListener('beforeunload', () => {
    if (balanceListenerOff) {
        balanceListenerOff();
        balanceListenerOff = null;
    }
});