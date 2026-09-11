// ============================================================
// TRANSFER.JS — v3 (CRITICAL FIX)
// ============================================================
// ✅ requestId localStorage में persist — duplicate click पर same requestId
// ✅ Server idempotency — same requestId दोबारा effect नहीं करेगा
// ✅ Button पहली लाइन पर lock — कोई race नहीं
// ✅ Balance check server-side (runTransaction अंदर)
// ✅ Network ambiguity पर UNKNOWN, button locked रहे
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

// ============================================================
// 🔑 Idempotency Key Management
// ============================================================
// अगर localStorage में pending requestId है → उसे ही use करो
// नहीं तो नया बनाओ
function getOrCreateRequestId() {
    let existing = localStorage.getItem('activeTransferRequestId');
    if (existing) {
        console.log('♻️ Reusing existing requestId:', existing);
        return existing;
    }
    let newId;
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        newId = crypto.randomUUID();
    } else {
        newId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11) +
                Math.random().toString(36).slice(2, 11);
    }
    localStorage.setItem('activeTransferRequestId', newId);
    console.log('🆕 New requestId generated:', newId);
    return newId;
}

function clearActiveRequestId() {
    localStorage.removeItem('activeTransferRequestId');
    localStorage.removeItem('activeTransferDetails');
}

function saveActiveRequestDetails(details) {
    localStorage.setItem('activeTransferDetails', JSON.stringify(details));
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
// ✅ ATOMIC TRANSFER (v3) — पूरी तरह fixed
// ============================================================
async function atomicTransfer(senderUid, recipientUid, amount, walletType, currency, requestId) {
    // ---- Validate ----
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

    // ============================================================
    // 🔑 CRITICAL: Idempotency check को runTransaction के अंदर करो
    // ताकि race condition न हो
    // ============================================================

    // ---- Sender side: एक ही transaction में idempotency + debit ----
    const senderRef = ref(db, `users/${senderUid}`);
    let senderBalanceBefore = 0;
    let senderUsername = '';
    let alreadyProcessedInSender = false;

    try {
        const senderResult = await runTransaction(senderRef, (currentData) => {
            if (!currentData) return currentData;

            // 🔑 Sender की history में यह txId पहले से है क्या?
            const history = currentData.transferHistory || {};
            if (history[txId]) {
                alreadyProcessedInSender = true;
                return; // abort — पहले ही process हो चुका
            }

            const balance = roundToPrecision(currentData[walletType] || 0, precision);
            senderBalanceBefore = balance;

            if (balance < safeAmount) {
                return; // abort — insufficient
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

        // 🔑 अगर sender पर पहले से process हो चुका है → यह duplicate है
        if (alreadyProcessedInSender) {
            console.log('⚠️ Duplicate detected — sender already has this txId');
            return {
                status: 'success',
                txId: txId,
                recipientName: '',
                duplicate: true
            };
        }

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
    let alreadyProcessedInRecipient = false;

    try {
        const recipientResult = await runTransaction(recipientRef, (currentData) => {
            if (!currentData) return currentData;

            // 🔑 Recipient की history में यह txId पहले से है क्या?
            const history = currentData.transferHistory || {};
            if (history[txId]) {
                alreadyProcessedInRecipient = true;
                return; // abort — पहले ही मिल चुका
            }

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

        if (alreadyProcessedInRecipient) {
            console.log('✅ Recipient already had this txId — idempotent');
            // दोनों तरफ हो गया — success मानो
        } else if (!recipientResult.committed) {
            console.warn('⚠️ Recipient update failed — running compensation');
            // Sender से कट गया, recipient को नहीं मिला → sender को वापस दो
            await runTransaction(senderRef, (currentData) => {
                if (!currentData) return currentData;
                // अगर वापस नहीं किया तो वापस करो
                const hist = currentData.transferHistory || {};
                if (hist[txId] && hist[txId].status === 'reversed') {
                    return; // पहले ही reverse हो चुका
                }
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
        // Network ambiguity — request record में UNKNOWN लिखो
        try {
            await set(requestRef, {
                requestId, txId, senderUid, recipientUid,
                amount: safeAmount, currency, walletType,
                status: 'unknown',
                createdAt: now,
                error: 'Network ambiguity'
            });
        } catch (_) {}
        return {
            status: 'unknown',
            txId: txId,
            error: 'Transfer status could not be confirmed.'
        };
    }

    // ---- दोनों सफल — request record लिखो (idempotency के लिए) ----
    try {
        await set(requestRef, {
            requestId, txId, senderUid, recipientUid,
            amount: safeAmount, currency, walletType,
            status: 'success',
            createdAt: now, completedAt: Date.now()
        });
    } catch (err) {
        console.warn('Request record write failed (non-critical):', err);
    }

    return { status: 'success', txId: txId, recipientName: recipientUsername };
}

// ============================================================
// Form Submit
// ============================================================
async function handleTransferSubmit(e) {
    e.preventDefault();

    // 🔒 1. पहली लाइन पर ही lock करो — कोई race नहीं
    if (transferLock) {
        showToast('⏳ Transfer already in progress...', 'error');
        return;
    }
    transferLock = true;

    const btn = document.getElementById('sendBtn');
    // 🔒 Button तुरंत disable करो — किसी भी await से पहले
    if (btn) {
        btn.disabled = true;
        btn.className = 'btn-send sending';
        btn.innerHTML = '<span class="loading-spinner me-2"></span>Sending...';
    }

    try {
        const recipientInput = document.getElementById('recipientInput').value.trim();
        const walletType = document.getElementById('walletSelect').value;
        const amountRaw = document.getElementById('amountInput').value;

        // ---- Validate ----
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

        // Balance check (client-side quick UX)
        const currentBalance = currentBalances[walletType] || 0;
        if (currentBalance < amountCheck.value) {
            showToast(`❌ Insufficient balance. Available: ${currentBalance} ${WALLET_CURRENCY[walletType]}`, 'error');
            resetButton();
            return;
        }

        // Find recipient
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

        // ============================================================
        // 🔑 CRITICAL: अगर localStorage में पहले से active requestId है,
        // तो वो पिछला pending transfer है — उसे पहले resolve करो
        // ============================================================
        const existingRequestId = localStorage.getItem('activeTransferRequestId');
        if (existingRequestId) {
            // पिछला request अभी भी pending है — user को मना करो
            const pendingSnap = await get(ref(db, `transferRequests/${existingRequestId}`));
            if (pendingSnap.exists()) {
                const pData = pendingSnap.val();
                if (pData.status === 'success') {
                    showToast('✅ Previous transfer already completed. Please refresh.', 'success');
                    clearActiveRequestId();
                    resetButton();
                    loadUserData(user.uid);
                    return;
                } else if (pData.status === 'unknown') {
                    showToast('⚠️ Previous transfer is still being verified. Please wait.', 'error');
                    resetButton();
                    return;
                } else if (pData.status === 'failed') {
                    // Failed था — अब clear करके नया करने दो
                    clearActiveRequestId();
                }
            } else {
                // Record नहीं मिला — पिछला transfer शायद शुरू ही नहीं हुआ
                // पर safe रहने के लिए मना करो
                showToast('⚠️ A previous transfer is pending. Please refresh page first.', 'error');
                resetButton();
                return;
            }
        }

        // ============================================================
        // 🔑 CRITICAL: अब नया या existing requestId लो
        // (localStorage में persist है — duplicate click पर same रहेगा)
        // ============================================================
        const requestId = getOrCreateRequestId();
        saveActiveRequestDetails({
            requestId,
            recipientUid: recipient.uid,
            amount: amountCheck.value,
            walletType,
            createdAt: Date.now()
        });

        // ---- Transfer execute ----
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
            if (result.duplicate) {
                showToast(`✅ Transfer already completed (duplicate ignored)`, 'success');
            } else {
                showToast(`✅ ${amountCheck.value} ${currency} sent to ${name}!`, 'success');
            }

            document.getElementById('recipientInput').value = '';
            document.getElementById('amountInput').value = '';

            // 🔑 Clear localStorage
            clearActiveRequestId();

            setTimeout(() => loadUserData(user.uid), 500);

            resetButton();

        } else if (result.status === 'unknown') {
            // ⚠️ Button LOCKED रहेगा — reconciliation होने तक
            showToast(
                '⚠️ Transfer status could not be confirmed. Please DO NOT submit again. ' +
                'Checking automatically...',
                'error'
            );
            if (btn) {
                btn.className = 'btn-send verifying';
                btn.innerHTML = '<i class="bi bi-hourglass-split me-2"></i>Verifying...';
                // ⚠️ Button disabled ही रहेगा
            }
            // 🔑 requestId localStorage में रहे — ताकि user दोबारा click न कर सके
            startReconciliationLoop(requestId, user.uid);
            return; // transferLock true रहेगा जब तक reconciliation पूरा न हो

        } else {
            showToast('❌ ' + (result.error || 'Transfer failed'), 'error');
            clearActiveRequestId();
            resetButton();
        }

    } catch (err) {
        console.error('Transfer error:', err);
        showToast('❌ Unexpected error. Please refresh and try again.', 'error');
        // Error पर भी requestId clear मत करो — पहले reconcile करो
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
}

// ============================================================
// Reconciliation Loop — जब तक status साफ़ न हो
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
                // unknown → keep polling
            }
            
            // अभी भी unknown — पर हमें पता है कि sender की history में txId है या नहीं
            // यही असली सबूत है कि transfer हुआ
            const userSnap = await get(ref(db, `users/${userId}/transferHistory/${data?.txId || 'TX_' + requestId.replace(/-/g, '').slice(0, 20)}`));
            if (userSnap.exists()) {
                // Sender की history में entry है → transfer हो गया
                showToast('✅ Transfer confirmed (from history)!', 'success');
                clearActiveRequestId();
                loadUserData(userId);
                resetButton();
                return;
            }
            
            if (attempts >= maxAttempts) {
                showToast('⚠️ Still verifying. Please refresh later.', 'error');
                return;
            }
            
            setTimeout(check, 10000);
            
        } catch (err) {
            console.warn('Reconcile check error:', err);
            if (attempts < maxAttempts) {
                setTimeout(check, 10000);
            }
        }
    };

    setTimeout(check, 3000);
}

// ============================================================
// On page load — reconcile
// ============================================================
async function reconcilePending() {
    const requestId = localStorage.getItem('activeTransferRequestId');
    if (!requestId) return;

    console.log('🔍 Reconciling pending request:', requestId);

    try {
        const snap = await get(ref(db, `transferRequests/${requestId}`));
        if (snap.exists()) {
            const data = snap.val();
            if (data.status === 'success') {
                showToast('✅ Previous transfer confirmed successful!', 'success');
                clearActiveRequestId();
                if (currentUserId) loadUserData(currentUserId);
            } else if (data.status === 'failed') {
                showToast('❌ Previous transfer failed.', 'error');
                clearActiveRequestId();
            } else {
                // अभी भी unknown — user को बताओ
                showToast('⚠️ Previous transfer still being verified. Please wait.', 'error');
                // Button भी locked रखो
                const btn = document.getElementById('sendBtn');
                if (btn) {
                    btn.disabled = true;
                    btn.className = 'btn-send verifying';
                    btn.innerHTML = '<i class="bi bi-hourglass-split me-2"></i>Verifying...';
                }
                transferLock = true;
                // Reconciliation चालू रखो
                startReconciliationLoop(requestId, currentUserId);
            }
        } else {
            // Record नहीं मिला — safe side पर clear कर दो
            // (क्योंकि transfer शायद हुआ ही नहीं)
            console.log('No request record found — clearing pending');
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
    if (availText) {
        availText.textContent = balance.toFixed(precision) + ' ' + currency;
    }
}

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

    const form = document.getElementById('transferForm');
    if (form) form.addEventListener('submit', handleTransferSubmit);

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
