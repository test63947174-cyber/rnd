import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getDatabase, ref, get, runTransaction } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

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
const SWAP_MARKUP = 0.05; 
const WALLET_LABELS = {
    depositWallet: 'Deposit Wallet',
    referralWallet: 'Referral Wallet'
};
const DEST_CURRENCY = 'USDT';

let currentUserId = null;
let liveRate = 1.00;
let swapInProgress = false;

// ============================================================
// UTILITIES
// ============================================================
function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;
    const icon = type === 'success' ? 'bi-check-circle-fill text-success' : 'bi-exclamation-triangle-fill text-danger';
    toast.innerHTML = `<i class="bi ${icon}"></i><span>${message}</span>`;
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
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function generateTxId() {
    return 'swap_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
}

function roundTo(value, precision) {
    const f = Math.pow(10, precision);
    return Math.round(value * f) / f;
}

// ============================================================
// FETCH LIVE RATE
// ============================================================
async function fetchLiveRate() {
    try {
        const snap = await get(ref(db, 'settings/rate'));
        liveRate = snap.exists() ? Number(snap.val()) : 1.00;
        if (!isFinite(liveRate) || liveRate <= 0) liveRate = 1.00;
    } catch (err) {
        console.warn('Rate fetch failed, using default:', err);
        liveRate = 1.00;
    }
    return liveRate;
}

// ============================================================
// UPDATE RATE PREVIEW
// ============================================================
function updateRatePreview() {
    const swapRate = roundTo(liveRate + SWAP_MARKUP, 4);
    const amount = parseFloat(document.getElementById('swapAmount').value) || 0;
    const youReceive = roundTo(amount * swapRate, 2);

    document.getElementById('liveRate').textContent = '$' + liveRate.toFixed(4);
    document.getElementById('swapRate').textContent = '$' + swapRate.toFixed(4);
    document.getElementById('youReceive').textContent = youReceive.toFixed(2) + ' ' + DEST_CURRENCY;
}

// ============================================================
// LOAD RND WALLET
// ============================================================
async function loadRndWallet() {
    try {
        const snap = await get(ref(db, 'users/' + currentUserId));
        if (!snap.exists()) {
            showToast('User data not found', 'error');
            return;
        }
        const data = snap.val();
        const rnd = Number(data.rndWallet || 0);
        document.getElementById('rndWalletValue').textContent = rnd.toFixed(4) + ' RND';
    } catch (err) {
        console.error('Load wallet error:', err);
        showToast('Failed to load wallet', 'error');
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

    const amountRaw = document.getElementById('swapAmount').value;
    const amount = parseFloat(amountRaw);
    const toWallet = document.getElementById('toWallet').value;
    const btn = document.getElementById('swapBtn');

    // Validation
    if (!WALLET_LABELS[toWallet]) {
        showToast('❌ Invalid destination wallet', 'error');
        return;
    }
    if (!isFinite(amount) || Number.isNaN(amount) || amount <= 0) {
        showToast('❌ Enter a valid amount', 'error');
        return;
    }
    if (Math.abs(roundTo(amount, 4) - amount) > 1e-9) {
        showToast('❌ Amount can have max 4 decimals', 'error');
        return;
    }

    const swapRate = roundTo(liveRate + SWAP_MARKUP, 4);
    const usdtReceived = roundTo(amount * swapRate, 2);

    if (usdtReceived <= 0) {
        showToast('❌ Amount too small', 'error');
        return;
    }

    swapInProgress = true;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Swapping...';

    const userRef = ref(db, 'users/' + currentUserId);
    const txId = generateTxId();
    const today = getTodayDate();
    const now = Date.now();

    try {
        const result = await runTransaction(userRef, (data) => {
            if (!data) return data;

            const rndBalance = roundTo(Number(data.rndWallet) || 0, 8);

            // ✅ Balance check INSIDE transaction (atomic)
            if (rndBalance < amount) {
                return undefined; // Aborts transaction
            }

            const currentDest = roundTo(Number(data[toWallet]) || 0, 2);

            data.rndWallet = roundTo(rndBalance - amount, 8);
            data[toWallet] = roundTo(currentDest + usdtReceived, 2);

            // ✅ FIX: Correct transaction fields for transactions.html
            const transactions = data.transactions || {};
            transactions[txId] = {
                type: 'swap',
                from: 'rndWallet',
                to: toWallet,
                amount: usdtReceived,           // <-- Fixed so UI shows correct amount
                amountIn: amount,               // 2 RND
                currencyIn: 'RND',
                amountOut: usdtReceived,        // 1.96 USDT
                currencyOut: DEST_CURRENCY,     // USDT
                liveRate: liveRate,
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
            showToast('❌ Insufficient RND balance or swap cancelled', 'error');
            swapInProgress = false;
            btn.disabled = false;
            btn.innerHTML = '<i class="bi bi-arrow-left-right me-2"></i>Swap Now';
            return;
        }

        const finalData = result.snapshot.val();
        const newRnd = Number(finalData.rndWallet || 0);

        showToast(`✅ Swapped ${amount.toFixed(4)} RND → ${usdtReceived.toFixed(2)} USDT`, 'success');

        // Update UI immediately
        document.getElementById('rndWalletValue').textContent = newRnd.toFixed(4) + ' RND';
        document.getElementById('swapAmount').value = '';
        updateRatePreview();

    } catch (err) {
        console.error('Swap error:', err);
        showToast('❌ Swap failed. Please try again.', 'error');
    } finally {
        swapInProgress = false;
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-arrow-left-right me-2"></i>Swap Now';
    }
}

// Expose for inline onclick (if added later)
window.handleSwap = handleSwap;

// ============================================================
// AUTH GUARD + INIT
// ============================================================
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'login.html';
        return;
    }
    currentUserId = user.uid;

    // Ban check
    try {
        const snap = await get(ref(db, 'users/' + user.uid));
        if (snap.exists() && snap.val().banned === true) {
            alert('Your account has been banned.');
            window.location.href = 'login.html';
            return;
        }
    } catch (_) {}

    await fetchLiveRate();
    await loadRndWallet();

    document.getElementById('loadingState').classList.add('hidden');
    document.getElementById('swapFormCard').classList.remove('hidden');

    updateRatePreview();
    document.getElementById('swapAmount').addEventListener('input', updateRatePreview);
    document.getElementById('toWallet').addEventListener('change', updateRatePreview);
    document.getElementById('swapBtn').addEventListener('click', handleSwap);
});