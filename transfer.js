// ============================================================
// TRANSFER.JS — v7 (bug-fixed, low Firebase usage)
// ============================================================

import { initializeApp } from "firebase/app";
import {
    getAuth,
    onAuthStateChanged,
    EmailAuthProvider,
    reauthenticateWithCredential
} from "firebase/auth";
import {
    getDatabase, ref, get, runTransaction, set, update, onValue,
    query, orderByChild, equalTo, limitToFirst
} from "firebase/database";

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

const ACTIVE_KEY = 'activeTransferV2';
const MAX_PW_FAILS = 5;
const PW_LOCK_MS = 5 * 60 * 1000;
const MAX_AUTO_RETRIES = 8;
const RETRY_MS = 10000;

let currentUserData = null;
let currentUserId = null;
let transferLock = false;
let balanceListenerOff = null;
let currentBalances = { depositWallet: 0, referralWallet: 0, rndWallet: 0 };
let pendingTransfer = null;
let modalOpen = false;
let initDone = false;
let firstSnapshotDone = false;

const $ = id => document.getElementById(id);
const on = (id, evt, fn) => { const e = $(id); if (e) e.addEventListener(evt, fn); };

// ============================================================
// 🛡️ Escape (XSS से बचाव — user के नाम HTML में जाते हैं)
// ============================================================
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ============================================================
// 👁️ Eye toggle
// ============================================================
window.togglePassword = function (inputId, btn) {
    const input = $(inputId);
    if (!input) return;
    const icon = btn.querySelector('i');
    if (input.type === 'password') {
        input.type = 'text';
        if (icon) icon.className = 'bi bi-eye-slash';
    } else {
        input.type = 'password';
        if (icon) icon.className = 'bi bi-eye';
    }
};

// ============================================================
// 🔐 Password hashing
//  v2  = PBKDF2 (salted with uid)   |  पुराना = plain SHA-256 (अब भी चलेगा, सही password पर अपने-आप v2 बन जाएगा)
// ============================================================
const toHex = buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

async function hashLegacy(password) {
    const data = new TextEncoder().encode(password);
    return toHex(await crypto.subtle.digest('SHA-256', data));
}

async function hashV2(password, uid) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: enc.encode('rnd-transfer:' + uid), iterations: 150000, hash: 'SHA-256' },
        key, 256
    );
    return 'v2:' + toHex(bits);
}

// ---- wrong-password lockout (इसी device पर) ----
function pwState(uid) {
    try {
        const s = JSON.parse(localStorage.getItem('tpf_' + uid) || '{}');
        return { count: s.count || 0, until: s.until || 0 };
    } catch { return { count: 0, until: 0 }; }
}
function pwFail(uid) {
    const s = pwState(uid);
    s.count += 1;
    if (s.count >= MAX_PW_FAILS) { s.until = Date.now() + PW_LOCK_MS; s.count = 0; }
    try { localStorage.setItem('tpf_' + uid, JSON.stringify(s)); } catch { }
}
function pwClear(uid) { try { localStorage.removeItem('tpf_' + uid); } catch { } }

// ============================================================
// 📦 Active transfer (अधूरे transfer को दोबारा पूरा करने के लिए)
// ============================================================
function newRequestId() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
}
function saveActive(d) { try { localStorage.setItem(ACTIVE_KEY, JSON.stringify(d)); } catch { } }
function loadActive() {
    try { return JSON.parse(localStorage.getItem(ACTIVE_KEY) || 'null'); } catch { return null; }
}
function clearActive() {
    localStorage.removeItem(ACTIVE_KEY);
    localStorage.removeItem('activeTransferRequestId');   // पुरानी keys
    localStorage.removeItem('activeTransferDetails');
}

// ============================================================
// Toast (innerHTML नहीं — XSS safe)
// ============================================================
function showToast(message, type = 'success') {
    const container = $('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;
    const i = document.createElement('i');
    i.className = 'bi ' + (type === 'success'
        ? 'bi-check-circle-fill text-success'
        : 'bi-exclamation-triangle-fill text-danger');
    const span = document.createElement('span');
    span.className = 'toast-msg';
    span.textContent = message;
    toast.append(i, span);
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

function getTodayDate() { return new Date().toLocaleDateString('en-CA'); } // YYYY-MM-DD (local)

function getWalletLabel(w) {
    if (w === 'depositWallet') return '💰 Deposit Wallet';
    if (w === 'referralWallet') return '💳 Referral Wallet';
    if (w === 'rndWallet') return '📊 RND Wallet';
    return w;
}

// ============================================================
// 🔎 Recipient lookup — पूरा users डाउनलोड नहीं, सिर्फ query
// ============================================================
async function getUserByIdentifier(identifier) {
    try {
        if (!identifier) return null;

        // UID जैसा दिखे तभी सीधे UID से (. # $ [ ] वाले नाम पर Firebase error देता है)
        if (/^[A-Za-z0-9_-]{20,40}$/.test(identifier)) {
            const uidSnap = await get(ref(db, 'users/' + identifier));
            if (uidSnap.exists()) return { uid: identifier, data: uidSnap.val(), source: 'uid' };
        }
        for (const field of ['username', 'referralCode']) {
            const s = await get(query(ref(db, 'users'), orderByChild(field), equalTo(identifier), limitToFirst(1)));
            if (s.exists()) {
                const [uid, data] = Object.entries(s.val())[0];
                return { uid, data, source: 'match' };
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
// 🔐 Transfer password (listener के local डेटा से — अलग read नहीं)
// ============================================================
function hasTransferPassword() {
    return !!(currentUserData && currentUserData.transferPasswordHash);
}

async function saveTransferPassword(uid, password) {
    const hash = await hashV2(password, uid);
    await update(ref(db, `users/${uid}`), { transferPasswordHash: hash, transferPasswordSetAt: Date.now() });
}

// returns true/false
async function verifyTransferPassword(uid, password) {
    const stored = currentUserData && currentUserData.transferPasswordHash;
    if (!stored) return false;

    if (String(stored).startsWith('v2:')) {
        return stored === await hashV2(password, uid);
    }
    // पुराना SHA-256 hash
    if (stored === await hashLegacy(password)) {
        try { await update(ref(db, `users/${uid}`), { transferPasswordHash: await hashV2(password, uid) }); } catch { }
        return true;
    }
    return false;
}

// ============================================================
// ⚛️ ATOMIC TRANSFER (दोनों तरफ idempotent — दोबारा चलाना सुरक्षित है)
// ============================================================
function ensureHistoryObject(currentData) {
    if (!currentData.transferHistory || Array.isArray(currentData.transferHistory)) {
        const arr = currentData.transferHistory || [];
        const obj = {};
        arr.forEach((item, i) => { if (item) obj[item.txId || `legacy_${i}`] = item; });
        currentData.transferHistory = obj;
    }
    if (!currentData.transactions) currentData.transactions = {};
}

async function atomicTransfer(d) {
    const { senderUid, recipientUid, amount, walletType, currency, requestId, senderName, recipientName } = d;

    if (!senderUid || !recipientUid) return { status: 'failed', error: 'Missing IDs' };
    if (senderUid === recipientUid) return { status: 'failed', error: 'Cannot send to yourself' };
    if (!WALLET_CURRENCY[walletType]) return { status: 'failed', error: 'Invalid wallet' };

    const amountCheck = validateAmount(amount, walletType);
    if (!amountCheck.valid) return { status: 'failed', error: amountCheck.error };
    const safeAmount = amountCheck.value;
    const precision = WALLET_PRECISION[walletType];

    const requestRef = ref(db, `transferRequests/${requestId}`);
    const txId = 'TX_' + requestId.replace(/-/g, '').slice(0, 20);
    const now = d.startedAt || Date.now();
    const today = d.date || getTodayDate();

    // ---------- 1. Sender debit ----------
    const senderRef = ref(db, `users/${senderUid}`);
    const sf = { already: false, reversed: false, balance: 0 };

    try {
        const r = await runTransaction(senderRef, (cur) => {
            sf.already = false; sf.reversed = false;
            if (!cur) return cur;                       // cache खाली → server से दोबारा बुलाएगा

            const hist = cur.transferHistory;
            const existing = (hist && !Array.isArray(hist)) ? hist[txId] : null;
            if (existing) {
                if (existing.status === 'reversed') sf.reversed = true; else sf.already = true;
                return;                                  // abort (दोबारा debit नहीं)
            }

            const balance = roundToPrecision(Number(cur[walletType]) || 0, precision);
            sf.balance = balance;
            if (balance < safeAmount) return;            // abort: balance कम

            cur[walletType] = roundToPrecision(balance - safeAmount, precision);
            ensureHistoryObject(cur);
            cur.transferHistory[txId] = {
                type: 'sent', to: recipientName, toUid: recipientUid, toUsername: recipientName,
                amount: safeAmount, currency, walletType,
                from: senderName, fromUid: senderUid, fromUsername: senderName,
                timestamp: now, txId, requestId, status: 'completed'
            };
            cur.transactions[txId] = {
                type: 'transfer_sent', amount: safeAmount, currency, walletType,
                to: recipientName, toUid: recipientUid, toUsername: recipientName,
                from: senderName, fromUid: senderUid,
                timestamp: now, date: today, txId, requestId, status: 'completed'
            };
            return cur;
        });

        if (sf.reversed) return { status: 'failed', error: 'This transfer was reversed earlier' };
        if (!sf.already) {
            if (!r.committed) {
                return { status: 'failed', error: `Insufficient balance. Available: ${sf.balance} ${currency}` };
            }
            if (!r.snapshot.exists()) return { status: 'failed', error: 'Sender account not found' };
        }
        // sf.already == true → debit पहले हो चुका, सीधे recipient step पर जाओ (पुराने code का बग: यहीं success लौटा देता था)
    } catch (err) {
        console.error('Sender error:', err);
        return { status: 'unknown', txId, error: 'Network error' };
    }

    // ---------- 2. Recipient credit ----------
    const recipientRef = ref(db, `users/${recipientUid}`);
    let alreadyInRecipient = false;

    try {
        const rr = await runTransaction(recipientRef, (cur) => {
            alreadyInRecipient = false;
            if (!cur) return cur;

            const hist = cur.transferHistory;
            if (hist && !Array.isArray(hist) && hist[txId]) { alreadyInRecipient = true; return; }

            const balance = roundToPrecision(Number(cur[walletType]) || 0, precision);
            cur[walletType] = roundToPrecision(balance + safeAmount, precision);
            ensureHistoryObject(cur);
            cur.transferHistory[txId] = {
                type: 'received', from: senderName, fromUid: senderUid, fromUsername: senderName,
                to: recipientName, toUid: recipientUid, toUsername: recipientName,
                amount: safeAmount, currency, walletType,
                timestamp: now, txId, requestId, status: 'completed'
            };
            cur.transactions[txId] = {
                type: 'transfer_received', amount: safeAmount, currency, walletType,
                from: senderName, fromUid: senderUid,
                to: recipientName, toUid: recipientUid,
                timestamp: now, date: today, txId, requestId, status: 'completed'
            };
            return cur;
        });

        const credited = alreadyInRecipient || (rr.committed && rr.snapshot.exists());
        if (!credited) {
            // recipient में नहीं पहुँचा → sender को पैसे वापस
            await runTransaction(senderRef, (cur) => {
                if (!cur) return cur;
                const h = cur.transferHistory;
                if (h && !Array.isArray(h) && h[txId] && h[txId].status === 'reversed') return;
                cur[walletType] = roundToPrecision((Number(cur[walletType]) || 0) + safeAmount, precision);
                if (h && !Array.isArray(h) && h[txId]) h[txId].status = 'reversed';
                if (cur.transactions && cur.transactions[txId]) cur.transactions[txId].status = 'reversed';
                return cur;
            });
            update(requestRef, { status: 'failed', error: 'Recipient failed — returned', completedAt: Date.now() }).catch(() => { });
            return { status: 'failed', error: 'Recipient failed — amount returned' };
        }
    } catch (err) {
        console.error('Recipient error:', err);
        update(requestRef, { status: 'unknown', error: 'Network ambiguity' }).catch(() => { });
        return { status: 'unknown', txId, error: 'Status could not be confirmed.' };
    }

    update(requestRef, { status: 'success', completedAt: Date.now() }).catch(err => console.warn('Record write failed:', err));
    return { status: 'success', txId, recipientName };
}

// ============================================================
// Modal Controls
// ============================================================
function openModal(id) {
    const m = $(id);
    if (m) m.classList.add('active');
    modalOpen = true;
}

function resetPwInputs(ids, modalSel) {
    ids.forEach(i => { const el = $(i); if (el) { el.value = ''; el.type = 'password'; } });
    document.querySelectorAll(`${modalSel} .password-eye i`).forEach(i => i.className = 'bi bi-eye');
}

function closeModal(id) {
    const m = $(id);
    if (m) m.classList.remove('active');
    modalOpen = false;
    if (id === 'setupModal') {
        resetPwInputs(['setupPassword', 'setupPasswordConfirm'], '#setupModal');
        $('setupError')?.classList.remove('show');
    }
    if (id === 'verifyModal') {
        resetPwInputs(['verifyPassword'], '#verifyModal');
        $('verifyError')?.classList.remove('show');
    }
    if (id === 'forgotModal') {
        resetPwInputs(['forgotAccountPassword', 'forgotNewPassword', 'forgotNewPasswordConfirm'], '#forgotModal');
        $('forgotError1')?.classList.remove('show');
        $('forgotError2')?.classList.remove('show');
        $('forgotStep1')?.classList.add('active');
        $('forgotStep2')?.classList.remove('active');
    }
}

function showErr(id, msg) {
    const e = $(id);
    if (!e) return;
    e.textContent = msg;
    e.classList.add('show');
}

// ============================================================
// Password Setup
// ============================================================
function openPasswordSetup() {
    openModal('setupModal');
    setTimeout(() => $('setupPassword')?.focus(), 200);
}

async function handlePasswordSetup() {
    const pwd = $('setupPassword').value;
    const confirm = $('setupPasswordConfirm').value;
    const btn = $('setupBtn');
    $('setupError')?.classList.remove('show');

    if (!pwd || pwd.length < 6) return showErr('setupError', 'Password कम से कम 6 characters का हो');
    if (pwd !== confirm) return showErr('setupError', 'दोनों passwords match नहीं कर रहे');

    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner me-2"></span>Setting...';
    try {
        await saveTransferPassword(currentUserId, pwd);
        pwClear(currentUserId);
        showToast('✅ Password set! अब फिर Send दबाओ।', 'success');
        closeModal('setupModal');
        pendingTransfer = null;
    } catch (err) {
        console.error('Save error:', err);
        showErr('setupError', 'Password save नहीं हुआ।');
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
    const row = (label, value, style = '') =>
        `<div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span>${label}</span><strong style="${style}">${esc(value)}</strong></div>`;
    $('verifyDetails').innerHTML =
        row('Amount:', `${details.amount} ${details.currency}`, 'color:#2ecc71;') +
        row('To:', details.recipientName, 'color:#60a5fa;') +
        row('Wallet:', details.walletLabel);
    openModal('verifyModal');
    setTimeout(() => $('verifyPassword')?.focus(), 200);
}

async function handlePasswordVerify() {
    const password = $('verifyPassword').value;
    const btn = $('verifyBtn');
    const resetBtn = () => { btn.disabled = false; btn.innerHTML = '<i class="bi bi-shield-check me-2"></i>Verify & Send'; };
    $('verifyError')?.classList.remove('show');

    if (!password) return showErr('verifyError', 'Password डालें');
    if (!pendingTransfer) return showErr('verifyError', 'Transfer details missing. दोबारा Send दबाओ।');

    const st = pwState(currentUserId);
    if (st.until > Date.now()) {
        const mins = Math.ceil((st.until - Date.now()) / 60000);
        return showErr('verifyError', `बहुत ज़्यादा गलत प्रयास। ${mins} मिनट बाद try करें।`);
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner me-2"></span>Verifying...';

    try {
        const ok = await verifyTransferPassword(currentUserId, password);
        if (!ok) {
            pwFail(currentUserId);
            showErr('verifyError', '❌ Password गलत है');
            resetBtn();
            return;
        }
        pwClear(currentUserId);

        const details = pendingTransfer;
        transferLock = true;            // modal बंद होने से पहले ही lock
        closeModal('verifyModal');
        resetBtn();
        await executeTransfer(details, false);
    } catch (err) {
        console.error('Verify error:', err);
        showErr('verifyError', 'Error आया।');
        resetBtn();
    }
}

// ============================================================
// 🚀 EXECUTE TRANSFER
// ============================================================
function setSendButton(state) {
    const btn = $('sendBtn');
    if (!btn) return;
    if (state === 'sending') {
        btn.disabled = true; btn.className = 'btn-send sending';
        btn.innerHTML = '<span class="loading-spinner me-2"></span>Sending...';
    } else if (state === 'verifying') {
        btn.disabled = true; btn.className = 'btn-send verifying';
        btn.innerHTML = '<i class="bi bi-hourglass-split me-2"></i>Completing...';
    } else {
        btn.disabled = false; btn.className = 'btn-send';
        btn.innerHTML = '<i class="bi bi-send me-2"></i> Send Money';
    }
}

function resetButton() {
    setSendButton('idle');
    transferLock = false;
    pendingTransfer = null;
}

async function executeTransfer(details, resume, attempt = 0) {
    const user = auth.currentUser;
    if (!user) { resetButton(); return; }

    transferLock = true;
    setSendButton('sending');

    try {
        if (!resume) {
            details.requestId = newRequestId();
            details.startedAt = Date.now();
            details.date = getTodayDate();
            details.senderUid = user.uid;
            saveActive(details);
            // पहले record बनाओ — बाद में network टूटे तो भी transfer दोबारा पूरा हो सकेगा
            try {
                await set(ref(db, `transferRequests/${details.requestId}`), {
                    requestId: details.requestId, senderUid: user.uid, recipientUid: details.recipientUid,
                    amount: details.amount, currency: details.currency, walletType: details.walletType,
                    status: 'processing', createdAt: details.startedAt
                });
            } catch (e) {
                console.error('Request create failed:', e);
                clearActive();
                showToast('❌ Network error. पैसा नहीं कटा, दोबारा try करें।', 'error');
                resetButton();
                return;
            }
        }

        const result = await atomicTransfer(details);

        if (result.status === 'success') {
            showToast(resume
                ? `✅ Transfer to ${details.recipientName} पूरा हो गया!`
                : `✅ ${details.amount} ${details.currency} sent to ${details.recipientName}!`, 'success');
            if (!resume) {
                const r = $('recipientInput'); if (r) r.value = '';
                const a = $('amountInput'); if (a) a.value = '';
            }
            clearActive();
            resetButton();
        } else if (result.status === 'unknown') {
            if (attempt === 0) showToast('⚠️ Network issue — transfer अपने-आप पूरा किया जा रहा है...', 'error');
            setSendButton('verifying');
            if (attempt < MAX_AUTO_RETRIES) {
                setTimeout(() => executeTransfer(details, true, attempt + 1), RETRY_MS);
            } else {
                showToast('⚠️ अभी पूरा नहीं हुआ। Page दोबारा खोलने पर अपने-आप पूरा होगा।', 'error');
            }
            return;
        } else {
            showToast('❌ ' + (result.error || 'Transfer failed'), 'error');
            update(ref(db, `transferRequests/${details.requestId}`),
                { status: 'failed', error: result.error || 'failed', completedAt: Date.now() }).catch(() => { });
            clearActive();
            resetButton();
        }
    } catch (err) {
        console.error('Execute error:', err);
        showToast('❌ Unexpected error.', 'error');
        resetButton();
    }
}

// ============================================================
// 🔑 FORGOT PASSWORD
// ============================================================
async function handleForgotVerify() {
    const password = $('forgotAccountPassword').value;
    const btn = $('forgotVerifyBtn');
    $('forgotError1')?.classList.remove('show');

    if (!password) return showErr('forgotError1', 'Account password डालें');

    const user = auth.currentUser;
    if (!user || !user.email) return showErr('forgotError1', 'User email नहीं मिला। Support से संपर्क करें।');

    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner me-2"></span>Verifying...';

    try {
        await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
        $('forgotStep1').classList.remove('active');
        $('forgotStep2').classList.add('active');
        $('forgotAccountPassword').value = '';
        setTimeout(() => $('forgotNewPassword')?.focus(), 200);
    } catch (err) {
        console.error('Forgot verify error:', err);
        let msg = '❌ Account password गलत है';
        if (err.code === 'auth/too-many-requests') msg = 'बहुत बार try किया। थोड़ी देर बाद try करें।';
        else if (err.code === 'auth/network-request-failed') msg = 'Network error। Internet check करें।';
        showErr('forgotError1', msg);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-shield-check me-2"></i>Verify';
    }
}

async function handleForgotReset() {
    const pwd = $('forgotNewPassword').value;
    const confirm = $('forgotNewPasswordConfirm').value;
    const btn = $('forgotResetBtn');
    $('forgotError2')?.classList.remove('show');

    if (!pwd || pwd.length < 6) return showErr('forgotError2', 'Password कम से कम 6 characters का हो');
    if (pwd !== confirm) return showErr('forgotError2', 'दोनों passwords match नहीं कर रहे');

    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner me-2"></span>Saving...';
    try {
        await saveTransferPassword(currentUserId, pwd);
        pwClear(currentUserId);
        showToast('✅ Transfer password reset successfully!', 'success');
        closeModal('forgotModal');
        resetButton();
    } catch (err) {
        console.error('Reset error:', err);
        showErr('forgotError2', 'Password save नहीं हुआ।');
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
    if (transferLock) { showToast('⏳ Transfer in progress...', 'error'); return; }
    transferLock = true;
    setSendButton('sending');
    $('sendBtn') && ($('sendBtn').innerHTML = '<span class="loading-spinner me-2"></span>Checking...');

    try {
        const recipientInput = $('recipientInput').value.trim();
        const walletType = $('walletSelect').value;
        const amountRaw = $('amountInput').value;

        if (!recipientInput) { showToast('❌ Enter recipient', 'error'); resetButton(); return; }
        const amount = parseFloat(amountRaw);
        if (!isFinite(amount) || Number.isNaN(amount) || amount <= 0) {
            showToast('❌ Valid amount डालें', 'error'); resetButton(); return;
        }
        const amountCheck = validateAmount(amount, walletType);
        if (!amountCheck.valid) { showToast('❌ ' + amountCheck.error, 'error'); resetButton(); return; }

        const user = auth.currentUser;
        if (!user) { showToast('❌ Please login', 'error'); resetButton(); return; }

        // पिछला अधूरा transfer हो तो नया शुरू नहीं होगा
        const active = loadActive();
        if (active && active.senderUid === user.uid) {
            showToast('⚠️ पिछला transfer पूरा हो रहा है। थोड़ा रुकें।', 'error');
            resetButton();
            setSendButton('verifying');
            transferLock = true;
            return;
        }

        const currentBalance = currentBalances[walletType] || 0;
        if (currentBalance < amountCheck.value) {
            showToast(`❌ Insufficient balance. Available: ${currentBalance} ${WALLET_CURRENCY[walletType]}`, 'error');
            resetButton(); return;
        }

        const recipient = await getUserByIdentifier(recipientInput);
        if (!recipient) { showToast('❌ User not found!', 'error'); resetButton(); return; }
        if (recipient.uid === user.uid) { showToast('❌ Cannot send to yourself!', 'error'); resetButton(); return; }

        const details = {
            recipientUid: recipient.uid,
            recipientName: getUserDisplayName(recipient.data, recipient.uid),
            senderName: getUserDisplayName(currentUserData, user.uid),
            senderUid: user.uid,
            amount: amountCheck.value, walletType,
            currency: WALLET_CURRENCY[walletType],
            walletLabel: getWalletLabel(walletType)
        };

        const hasPwd = hasTransferPassword();
        transferLock = false;
        setSendButton('idle');

        if (!hasPwd) { openPasswordSetup(); return; }
        openPasswordVerify(details);
    } catch (err) {
        console.error('Submit error:', err);
        showToast('❌ Unexpected error', 'error');
        resetButton();
    }
}

// ============================================================
// अधूरा transfer फिर से पूरा करना (page खुलते समय, सिर्फ 1 read)
// ============================================================
async function reconcilePending() {
    // पुरानी version की keys हटाओ
    localStorage.removeItem('activeTransferRequestId');
    localStorage.removeItem('activeTransferDetails');

    const d = loadActive();
    if (!d || d.senderUid !== currentUserId) return;
    try {
        const snap = await get(ref(db, `transferRequests/${d.requestId}`));
        if (!snap.exists()) { clearActive(); return; }
        const st = snap.val().status;
        if (st === 'success') { showToast('✅ पिछला transfer पूरा हो चुका है।', 'success'); clearActive(); return; }
        if (st === 'failed') { showToast('❌ पिछला transfer fail हुआ था।', 'error'); clearActive(); return; }
        showToast('⏳ पिछला transfer पूरा किया जा रहा है...', 'error');
        executeTransfer(d, true);
    } catch (err) { console.warn('Reconcile error:', err); }
}

// ============================================================
// Balance + Recent transfers — एक ही listener (पहले 3 बार डाउनलोड होता था)
// ============================================================
function setupBalanceListener(uid) {
    if (balanceListenerOff) { balanceListenerOff(); balanceListenerOff = null; }
    balanceListenerOff = onValue(ref(db, 'users/' + uid), (snapshot) => {
        if (!snapshot.exists()) {
            if (!firstSnapshotDone) {
                showToast('❌ User not found', 'error');
                setTimeout(() => window.location.href = 'dashboard.html', 2000);
            }
            return;
        }
        const u = snapshot.val();
        currentUserData = u;
        currentBalances.depositWallet = Number(u.depositWallet) || 0;
        currentBalances.referralWallet = Number(u.referralWallet) || 0;
        currentBalances.rndWallet = Number(u.rndWallet) || 0;
        updateBalanceUI();
        renderRecentTransfers(u);

        if (!firstSnapshotDone) {
            firstSnapshotDone = true;
            reconcilePending();
        }
    }, (error) => console.error('Balance error:', error));
}

function updateBalanceUI() {
    const dep = $('balanceDeposit'), refEl = $('balanceReferral'), rnd = $('balanceRND');
    if (dep) dep.textContent = '$' + currentBalances.depositWallet.toFixed(2);
    if (refEl) refEl.textContent = '$' + currentBalances.referralWallet.toFixed(2);
    if (rnd) rnd.textContent = currentBalances.rndWallet.toFixed(4) + ' RND';
    updateAvailableText();
}

function updateAvailableText() {
    const select = $('walletSelect');
    if (!select) return;
    const walletType = select.value;
    const balance = currentBalances[walletType] || 0;
    const availText = $('availableText');
    if (availText)
        availText.textContent = balance.toFixed(WALLET_PRECISION[walletType]) + ' ' + WALLET_CURRENCY[walletType];
}

window.setMaxAmount = function () {
    const walletType = $('walletSelect').value;
    const balance = currentBalances[walletType] || 0;
    $('amountInput').value = balance.toFixed(WALLET_PRECISION[walletType]);
};

function renderRecentTransfers(u) {
    const container = $('recentTransfers');
    if (!container) return;
    const rawHistory = u.transferHistory || [];
    const arr = Array.isArray(rawHistory) ? rawHistory.filter(Boolean) : Object.values(rawHistory).filter(Boolean);
    arr.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const recent = arr.slice(0, 5);

    if (recent.length === 0) {
        container.innerHTML = `<div style="text-align:center;color:#64748b;padding:20px;font-size:0.85rem;"><i class="bi bi-clock"></i> No transfers yet</div>`;
        return;
    }
    container.innerHTML = recent.map(t => {
        const isSent = t.type === 'sent';
        const name = isSent ? (t.to || t.toUsername || 'Unknown') : (t.from || t.fromUsername || 'Unknown');
        const uid = isSent ? (t.toUid || '') : (t.fromUid || '');
        const sign = isSent ? '-' : '+';
        const cls = isSent ? 'transfer-sent' : 'transfer-received';
        const date = t.timestamp ? new Date(t.timestamp).toLocaleString('hi-IN') : '';
        const reversed = t.status === 'reversed' ? ' <small style="color:#f59e0b;">(returned)</small>' : '';
        return `
            <div class="transfer-item">
                <div>
                    <div class="${cls}" style="font-size:0.85rem;">
                        <i class="bi bi-arrow-${isSent ? 'up-right' : 'down-left'}"></i>
                        ${isSent ? 'Sent to' : 'Received from'}
                        <span class="transfer-name">${esc(name)}</span>${reversed}
                    </div>
                    ${uid ? `<div style="font-size:0.7rem;color:#64748b;margin-top:2px;">ID: ${esc(uid.slice(0, 12))}...</div>` : ''}
                    <div class="transfer-date">${esc(date)}</div>
                </div>
                <div class="transfer-amount ${cls}">${sign}${esc(t.amount)} ${esc(t.currency || 'RND')}</div>
            </div>`;
    }).join('');
}

// ============================================================
// Init
// ============================================================
function bindUI() {
    on('transferForm', 'submit', handleTransferSubmit);

    on('setupBtn', 'click', handlePasswordSetup);
    on('setupPasswordConfirm', 'keypress', e => { if (e.key === 'Enter') handlePasswordSetup(); });

    on('verifyBtn', 'click', handlePasswordVerify);
    on('verifyPassword', 'keypress', e => { if (e.key === 'Enter') handlePasswordVerify(); });
    on('verifyCancelBtn', 'click', () => { closeModal('verifyModal'); resetButton(); });

    on('forgotPasswordBtn', 'click', () => {
        closeModal('verifyModal');
        openModal('forgotModal');
        setTimeout(() => $('forgotAccountPassword')?.focus(), 200);
    });
    on('forgotVerifyBtn', 'click', handleForgotVerify);
    on('forgotAccountPassword', 'keypress', e => { if (e.key === 'Enter') handleForgotVerify(); });
    on('forgotResetBtn', 'click', handleForgotReset);
    on('forgotNewPasswordConfirm', 'keypress', e => { if (e.key === 'Enter') handleForgotReset(); });
    on('forgotCancelBtn1', 'click', () => { closeModal('forgotModal'); resetButton(); });
    on('forgotCancelBtn2', 'click', () => { closeModal('forgotModal'); resetButton(); });

    const select = $('walletSelect');
    if (select) {
        const applyStep = () => {
            updateAvailableText();
            const a = $('amountInput');
            if (!a) return;
            if (select.value === 'rndWallet') { a.step = '0.00000001'; a.min = '0.00000001'; }
            else { a.step = '0.01'; a.min = '0.01'; }
        };
        select.addEventListener('change', applyStep);
        applyStep();
    }
}

onAuthStateChanged(auth, (user) => {
    if (!user) { window.location.href = 'login.html'; return; }
    currentUserId = user.uid;
    if (initDone) return;          // listeners दुगने न हों
    initDone = true;
    bindUI();
    setupBalanceListener(user.uid);
});

window.addEventListener('beforeunload', () => {
    if (balanceListenerOff) { balanceListenerOff(); balanceListenerOff = null; }
});
