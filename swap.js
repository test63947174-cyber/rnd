import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getDatabase, ref, get, onValue, runTransaction } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

// ============================================================
// FIREBASE CONFIG
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

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// ============================================================
// CONSTANTS & STATE
// ============================================================
// Markup = user ko live rate se zyada milta hai (shopping incentive)
const SWAP_MARKUP = 0.05;
const WALLET_LABELS = {
    depositWallet: 'Deposit Wallet',
    referralWallet: 'Referral Wallet'
};
const DEST_CURRENCY = 'USDT';
const RATE_REFRESH_MS = 60000;
const MAX_AMOUNT_DECIMALS = 4;

let currentUserId = null;
let liveRate = 0;
let rateReady = false;
let walletReady = false;
let isConnected = true;
let rndBalance = 0;
let swapInProgress = false;
let uiInitialized = false;
let rateTimer = null;

// ============================================================
// DOM HELPERS (null-safe: koi element na ho to error nahi aayega)
// ============================================================
const $ = (id) => document.getElementById(id);

function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
}

// ============================================================
// UTILITIES
// ============================================================
function showToast(message, type = 'success') {
    const container = $('toastContainer');
    if (!container) {
        if (type !== 'success') alert(message);
        return;
    }

    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;

    const icon = document.createElement('i');
    icon.className = 'bi ' + (type === 'success'
        ? 'bi-check-circle-fill text-success'
        : 'bi-exclamation-triangle-fill text-danger');

    const text = document.createElement('span');
    text.textContent = message;

    toast.append(icon, text);
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        toast.style.transition = 'all 0.3s';
        setTimeout(() => toast.remove(), 300);
    }, 4500);
}

function getTodayDate() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function generateTxId() {
    const rand = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
        : Math.random().toString(36).slice(2, 10);
    return 'swap_' + Date.now() + '_' + rand;
}

function roundTo(value, precision) {
    const f = Math.pow(10, precision);
    return Math.round(value * f) / f;
}

function isAllowedWallet(name) {
    return Object.prototype.hasOwnProperty.call(WALLET_LABELS, name);
}

function getSwapRate() {
    return roundTo(liveRate + SWAP_MARKUP, 4);
}

function fmtRnd(n) {
    return Number(n || 0).toFixed(4) + ' RND';
}

function fmtUsdt(n) {
    return Number(n || 0).toFixed(2) + ' ' + DEST_CURRENCY;
}

// ============================================================
// VALIDATION (live hint aur swap, dono me same logic)
// ============================================================
function validateAmount(raw) {
    const amount = parseFloat(raw);

    if (raw === '' || raw === null || raw === undefined) {
        return { ok: false, amount: 0, error: null }; // khali = koi error nahi dikhana
    }
    if (!isFinite(amount) || amount <= 0) {
        return { ok: false, amount: 0, error: 'Enter a valid amount' };
    }
    if (Math.abs(roundTo(amount, MAX_AMOUNT_DECIMALS) - amount) > 1e-9) {
        return { ok: false, amount, error: `Maximum ${MAX_AMOUNT_DECIMALS} decimals allowed` };
    }
    if (rateReady && roundTo(amount * getSwapRate(), 2) <= 0) {
        return { ok: false, amount, error: 'Amount too small' };
    }
    if (walletReady && amount > rndBalance) {
        return { ok: false, amount, error: 'Insufficient RND balance' };
    }
    return { ok: true, amount, error: null };
}

// ============================================================
// UI RENDER
// ============================================================
function refreshButtonState() {
    const btn = $('swapBtn');
    if (!btn) return;

    if (swapInProgress) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Swapping...';
        return;
    }

    btn.disabled = !(rateReady && walletReady && isConnected);
    btn.innerHTML = '<i class="bi bi-arrow-left-right me-2"></i>Swap Now';
}

function updateRatePreview() {
    const amountInput = $('swapAmount');
    const raw = amountInput ? amountInput.value : '';
    const check = validateAmount(raw);

    if (rateReady) {
        const swapRate = getSwapRate();
        setText('liveRate', '$' + liveRate.toFixed(4));
        setText('swapRate', '$' + swapRate.toFixed(4));
        const receive = check.ok ? roundTo(check.amount * swapRate, 2) : 0;
        setText('youReceive', fmtUsdt(receive));
    } else {
        setText('liveRate', '--');
        setText('swapRate', '--');
        setText('youReceive', '--');
    }

    // Optional: agar HTML me id="swapError" wala element ho to inline error dikhega
    const errEl = $('swapError');
    if (errEl) {
        errEl.textContent = check.error || '';
        errEl.style.display = check.error ? 'block' : 'none';
    }
}

function renderWallets(data) {
    setText('rndWalletValue', fmtRnd(data.rndWallet));
    // Optional elements (agar HTML me hon to update honge)
    setText('depositWalletValue', fmtUsdt(data.depositWallet));
    setText('referralWalletValue', fmtUsdt(data.referralWallet));
}

// ============================================================
// FETCH LIVE RATE
// Rate sahi na mile to swap BLOCK hoga (galat rate par swap nahi hoga)
// ============================================================
async function fetchLiveRate() {
    try {
        const snap = await get(ref(db, 'settings/rate'));
        const val = snap.exists() ? Number(snap.val()) : NaN;
        if (!isFinite(val) || val <= 0) {
            throw new Error('Invalid or missing settings/rate');
        }
        liveRate = val;
        rateReady = true;
        return true;
    } catch (err) {
        console.warn('Rate fetch failed:', err);
        return false;
    }
}

// ============================================================
// LOAD WALLETS
// ============================================================
async function loadWallets() {
    try {
        const snap = await get(ref(db, 'users/' + currentUserId));
        if (!snap.exists()) {
            showToast('❌ User data not found', 'error');
            return false;
        }
        const data = snap.val();
        rndBalance = Number(data.rndWallet || 0);
        walletReady = true;
        renderWallets(data);
        return true;
    } catch (err) {
        console.error('Load wallet error:', err);
        showToast('❌ Failed to load wallet', 'error');
        return false;
    }
}

// ============================================================
// HANDLE SWAP
// ============================================================
async function handleSwap() {
    if (swapInProgress) {
        showToast('⏳ Swap already in progress...', 'error');
        return;
    }
    if (!currentUserId) {
        showToast('❌ Please login again', 'error');
        return;
    }
    if (!isConnected) {
        showToast('❌ No internet connection. Please try again.', 'error');
        return;
    }
    if (!rateReady || !walletReady) {
        showToast('❌ Data not loaded yet. Please refresh the page.', 'error');
        return;
    }

    const toWallet = $('toWallet') ? $('toWallet').value : '';
    const raw = $('swapAmount') ? $('swapAmount').value : '';

    if (!isAllowedWallet(toWallet)) {
        showToast('❌ Invalid destination wallet', 'error');
        return;
    }

    const check = validateAmount(raw);
    if (!check.ok) {
        showToast('❌ ' + (check.error || 'Enter a valid amount'), 'error');
        return;
    }
    const amount = check.amount;

    // Double-click se bachne ke liye turant lock
    swapInProgress = true;
    refreshButtonState();

    try {
        // ---------- Fresh rate (swap se theek pehle) ----------
        const shownRate = getSwapRate();
        const fetched = await fetchLiveRate();
        if (!fetched) {
            showToast('❌ Could not fetch current rate. Please try again.', 'error');
            return;
        }
        const swapRate = getSwapRate();

        if (swapRate !== shownRate) {
            updateRatePreview();
            showToast('⚠️ Rate has changed. Please check the new rate and swap again.', 'error');
            return;
        }

        const usdtReceived = roundTo(amount * swapRate, 2);
        if (usdtReceived <= 0) {
            showToast('❌ Amount too small', 'error');
            return;
        }

        const userRef = ref(db, 'users/' + currentUserId);
        const txId = generateTxId();
        const today = getTodayDate();
        const now = Date.now();
        const usedLiveRate = liveRate;
        let abortReason = null;

        // ---------- Atomic transaction ----------
        const result = await runTransaction(userRef, (data) => {
            abortReason = null;

            // Local cache khali ho to Firebase real data ke saath dobara chalata hai
            if (data === null) return data;

            if (data.banned === true) {
                abortReason = 'banned';
                return; // abort
            }

            const rndNow = roundTo(Number(data.rndWallet) || 0, 8);
            if (!isFinite(rndNow) || rndNow < amount) {
                abortReason = 'insufficient';
                return; // abort
            }

            const destNow = roundTo(Number(data[toWallet]) || 0, 2);

            data.rndWallet = roundTo(rndNow - amount, 8);
            data[toWallet] = roundTo(destNow + usdtReceived, 2);

            const transactions = data.transactions || {};
            transactions[txId] = {
                type: 'swap',
                from: 'rndWallet',
                to: toWallet,
                amount: usdtReceived,
                amountIn: amount,
                currencyIn: 'RND',
                amountOut: usdtReceived,
                currencyOut: DEST_CURRENCY,
                liveRate: usedLiveRate,
                swapRate: swapRate,
                markup: SWAP_MARKUP,
                timestamp: now,
                date: today,
                status: 'completed',
                txId: txId,
                description: `Swapped ${amount.toFixed(4)} RND → ${usdtReceived.toFixed(2)} USDT at $${swapRate}`
            };
            data.transactions = transactions;

            return data;
        });

        if (!result.committed) {
            if (abortReason === 'banned') {
                showToast('❌ Your account has been banned.', 'error');
                setTimeout(() => { window.location.href = 'login.html'; }, 1500);
            } else if (abortReason === 'insufficient') {
                showToast('❌ Insufficient RND balance', 'error');
                await loadWallets(); // balance refresh
                updateRatePreview();
            } else {
                showToast('❌ Swap cancelled. Please try again.', 'error');
            }
            return;
        }

        const finalData = result.snapshot.val();
        if (!finalData) {
            showToast('❌ User data not found', 'error');
            return;
        }

        rndBalance = Number(finalData.rndWallet || 0);
        renderWallets(finalData);

        showToast(
            `✅ Swapped ${amount.toFixed(4)} RND → ${usdtReceived.toFixed(2)} USDT (${WALLET_LABELS[toWallet]})`,
            'success'
        );

        if ($('swapAmount')) $('swapAmount').value = '';
        updateRatePreview();

    } catch (err) {
        console.error('Swap error:', err);
        showToast('❌ Swap failed. Please check your balance and try again.', 'error');
    } finally {
        swapInProgress = false;
        refreshButtonState();
    }
}

window.handleSwap = handleSwap;

// ============================================================
// UI INIT (sirf ek baar)
// ============================================================
function initUI() {
    if (uiInitialized) return;
    uiInitialized = true;

    const amountEl = $('swapAmount');
    const walletEl = $('toWallet');
    const btnEl = $('swapBtn');

    if (!amountEl || !walletEl || !btnEl) {
        console.error('Required elements missing: swapAmount / toWallet / swapBtn');
    }

    if (amountEl) amountEl.addEventListener('input', updateRatePreview);
    if (walletEl) walletEl.addEventListener('change', updateRatePreview);
    if (btnEl) btnEl.addEventListener('click', handleSwap);

    // Optional "Max" button (id="maxBtn")
    const maxBtn = $('maxBtn');
    if (maxBtn && amountEl) {
        maxBtn.addEventListener('click', () => {
            const maxVal = Math.floor(roundTo(rndBalance * 10000, 6)) / 10000;
            amountEl.value = maxVal > 0 ? maxVal.toFixed(MAX_AMOUNT_DECIMALS) : '';
            updateRatePreview();
        });
    }

    // Rate auto-refresh
    const refreshRate = async () => {
        if (swapInProgress) return;
        await fetchLiveRate();
        refreshButtonState();
        updateRatePreview();
    };
    rateTimer = setInterval(refreshRate, RATE_REFRESH_MS);

    // Tab wapas khulne par rate refresh
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshRate();
    });

    // Internet connection status
    onValue(ref(db, '.info/connected'), (snap) => {
        isConnected = snap.val() === true;
        refreshButtonState();
        // Optional: id="connectionStatus" element
        setText('connectionStatus', isConnected ? '' : 'Offline - reconnecting...');
    });
}

// ============================================================
// AUTH GUARD + INIT
// ============================================================
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'login.html';
        return;
    }
    currentUserId = user.uid;

    try {
        // Ban check (error aaye to bhi aage nahi jaane dena)
        const snap = await get(ref(db, 'users/' + user.uid));
        if (snap.exists() && snap.val().banned === true) {
            alert('Your account has been banned.');
            window.location.href = 'login.html';
            return;
        }

        const [rateOk, walletOk] = await Promise.all([fetchLiveRate(), loadWallets()]);

        if (!rateOk) {
            showToast('❌ Swap rate unavailable right now. Please try again later.', 'error');
        }
        if (!walletOk) {
            showToast('❌ Could not load your wallet. Please refresh.', 'error');
        }
    } catch (err) {
        console.error('Init error:', err);
        showToast('❌ Something went wrong. Please refresh the page.', 'error');
    }

    $('loadingState')?.classList.add('hidden');
    $('swapFormCard')?.classList.remove('hidden');

    initUI();
    updateRatePreview();
    refreshButtonState();
});
