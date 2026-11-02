import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getDatabase, ref, get, onValue, runTransaction } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.esm.min.js";

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
const DEST_CURRENCY = 'USDT';
const RATE_REFRESH_MS = 30000; 

// BSC नेटवर्क और कॉन्ट्रैक्ट्स
const BSC_RPC = "https://bsc-dataseed.binance.org/";
const QUOTER_V2 = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997"; 
const RND_TOKEN = "0xcF1FbF18bE9202865bcf88E6349B9D207F75942d";
const USDT_TOKEN = "0x55d398326f99059fF775485246999027B3197955"; 
const WBNB_TOKEN = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"; 

// फीस टियर्स जिन्हें हम चेक करेंगे
const FEE_TIERS = [100, 500, 2500, 10000]; 

let currentUserId = null;
let liveRate = 0;
let rateReady = false;
let walletReady = false;
let isConnected = true;
let rndBalance = 0;
let swapInProgress = false;
let uiInitialized = false;
let rateTimer = null;
let detectedFee = null; // सही फीस यहाँ सेव होगी

// ============================================================
// DOM HELPERS
// ============================================================
const $ = (id) => document.getElementById(id);
function setText(id, text) { const el = $(id); if (el) el.textContent = text; }

// ============================================================
// UTILITIES
// ============================================================
function showToast(message, type = 'success') {
    const container = $('toastContainer');
    if (!container) { if (type !== 'success') alert(message); return; }
    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;
    const icon = document.createElement('i');
    icon.className = 'bi ' + (type === 'success' ? 'bi-check-circle-fill text-success' : 'bi-exclamation-triangle-fill text-danger');
    const text = document.createElement('span');
    text.textContent = message;
    toast.append(icon, text);
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(100%)'; toast.style.transition = 'all 0.3s'; setTimeout(() => toast.remove(), 300); }, 4500);
}

function getTodayDate() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function generateTxId() { const rand = (window.crypto && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, '').slice(0, 12) : Math.random().toString(36).slice(2, 10); return 'swap_' + Date.now() + '_' + rand; }
function roundTo(value, precision) { const f = Math.pow(10, precision); return Math.round(value * f) / f; }
function getSwapRate() { return roundTo(liveRate + SWAP_MARKUP, 4); }
function fmtRnd(n) { return Number(n || 0).toFixed(4) + ' RND'; }
function fmtUsdt(n) { return Number(n || 0).toFixed(2) + ' ' + DEST_CURRENCY; }

// ============================================================
// VALIDATION
// ============================================================
function validateAmount(raw) {
    const amount = parseFloat(raw);
    if (raw === '' || raw === null || raw === undefined) return { ok: false, amount: 0, error: null };
    if (!isFinite(amount) || amount <= 0) return { ok: false, amount: 0, error: 'Enter a valid amount' };
    if (Math.abs(roundTo(amount, 4) - amount) > 1e-9) return { ok: false, amount, error: 'Maximum 4 decimals allowed' };
    if (rateReady && roundTo(amount * getSwapRate(), 2) <= 0) return { ok: false, amount, error: 'Amount too small' };
    if (walletReady && amount > rndBalance) return { ok: false, amount, error: 'Insufficient RND balance' };
    return { ok: true, amount, error: null };
}

// ============================================================
// UI RENDER
// ============================================================
function refreshButtonState() {
    const btn = $('swapBtn'); if (!btn) return;
    if (swapInProgress) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Swapping...'; return; }
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
        setText('liveRate', '--'); setText('swapRate', '--'); setText('youReceive', '--');
    }
    const errEl = $('swapError'); if (errEl) { errEl.textContent = check.error || ''; errEl.style.display = check.error ? 'block' : 'none'; }
}

function renderWallets(data) {
    setText('rndWalletValue', fmtRnd(data.rndWallet));
    setText('depositWalletValue', fmtUsdt(data.depositWallet));
    setText('referralWalletValue', fmtUsdt(data.referralWallet));
}

// ============================================================
// ✅ PancakeSwap V3 से लाइव रेट (ऑटो-फीस डिटेक्शन)
// ============================================================
async function fetchLiveRate() {
    try {
        const provider = new ethers.providers.JsonRpcProvider(BSC_RPC);
        const quoterAbi = [
            "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)"
        ];
        const quoter = new ethers.Contract(QUOTER_V2, quoterAbi, provider);
        const amountIn = ethers.utils.parseUnits("1", 18); 

        // 1. सबसे पहले सीधा RND -> USDT का रास्ता चेक करें
        for (const fee of FEE_TIERS) {
            try {
                const params = { tokenIn: RND_TOKEN, tokenOut: USDT_TOKEN, amountIn: amountIn, fee: fee, sqrtPriceLimitX96: 0 };
                const result = await quoter.callStatic.quoteExactInputSingle(params);
                if (result.amountOut > 0) {
                    liveRate = parseFloat(ethers.utils.formatUnits(result.amountOut, 18));
                    detectedFee = fee;
                    rateReady = true;
                    console.log(`✅ सीधा पूल मिला! Fee: ${fee}, Rate: $${liveRate.toFixed(4)}`);
                    return true;
                }
            } catch (e) { /* इस फीस पर पूल नहीं है, आगे चेक करें */ }
        }

        // 2. अगर सीधा USDT पूल नहीं मिला, तो RND -> WBNB -> USDT का रास्ता चेक करें
        for (const fee of FEE_TIERS) {
            try {
                // पहले 1 RND से कितना WBNB मिलेगा
                const params1 = { tokenIn: RND_TOKEN, tokenOut: WBNB_TOKEN, amountIn: amountIn, fee: fee, sqrtPriceLimitX96: 0 };
                const res1 = await quoter.callStatic.quoteExactInputSingle(params1);
                const wbnbOut = ethers.utils.formatUnits(res1.amountOut, 18);

                if (parseFloat(wbnbOut) > 0) {
                    // अब उतने WBNB से कितना USDT मिलेगा (WBNB/USDT का फीस आमतौर पर 500 या 2500 होता है)
                    const params2 = { tokenIn: WBNB_TOKEN, tokenOut: USDT_TOKEN, amountIn: ethers.utils.parseUnits(wbnbOut, 18), fee: 500, sqrtPriceLimitX96: 0 };
                    const res2 = await quoter.callStatic.quoteExactInputSingle(params2);
                    liveRate = parseFloat(ethers.utils.formatUnits(res2.amountOut, 18));
                    detectedFee = fee;
                    rateReady = true;
                    console.log(`✅ RND -> WBNB पूल मिला! Fee: ${fee}, Rate: $${liveRate.toFixed(4)}`);
                    return true;
                }
            } catch (e) { /* इस फीस पर WBNB पूल नहीं है */ }
        }

        throw new Error('कोई भी पूल नहीं मिला');
    } catch (err) {
        console.warn('Pancake rate fetch failed, using fallback:', err);
        // फॉलबैक: अगर ब्लॉकचेन से रेट न आए तो डेटाबेस का रेट (सिर्फ इस पेज पर)
        try {
            const snap = await get(ref(db, 'settings/rate'));
            const val = snap.exists() ? Number(snap.val()) : 0.95;
            liveRate = (isFinite(val) && val > 0) ? val : 0.95;
            rateReady = true;
            return true;
        } catch (fbErr) {
            liveRate = 0.95; rateReady = true; return true;
        }
    }
}

// ============================================================
// LOAD WALLETS
// ============================================================
async function loadWallets() {
    try {
        const snap = await get(ref(db, 'users/' + currentUserId));
        if (!snap.exists()) { showToast('❌ User data not found', 'error'); return false; }
        const data = snap.val();
        rndBalance = Number(data.rndWallet || 0);
        walletReady = true;
        renderWallets(data);
        return true;
    } catch (err) { console.error('Load wallet error:', err); showToast('❌ Failed to load wallet', 'error'); return false; }
}

// ============================================================
// HANDLE SWAP
// ============================================================
async function handleSwap() {
    if (swapInProgress) return showToast('⏳ Swap already in progress...', 'error');
    if (!currentUserId) return showToast('❌ Please login again', 'error');
    if (!isConnected) return showToast('❌ No internet connection.', 'error');
    if (!rateReady || !walletReady) return showToast('❌ Data not loaded yet.', 'error');

    const toWallet = $('toWallet') ? $('toWallet').value : '';
    const raw = $('swapAmount') ? $('swapAmount').value : '';
    if (toWallet !== 'depositWallet' && toWallet !== 'referralWallet') return showToast('❌ Invalid destination wallet', 'error');
    
    const check = validateAmount(raw);
    if (!check.ok) return showToast('❌ ' + (check.error || 'Enter a valid amount'), 'error');
    const amount = check.amount;

    swapInProgress = true;
    refreshButtonState();

    try {
        const shownRate = getSwapRate();
        const fetched = await fetchLiveRate();
        if (!fetched) return showToast('❌ Could not fetch current rate.', 'error');
        
        const swapRate = getSwapRate();
        if (swapRate !== shownRate) {
            updateRatePreview();
            return showToast('⚠️ Rate has changed. Please check and swap again.', 'error');
        }

        const usdtReceived = roundTo(amount * swapRate, 2);
        if (usdtReceived <= 0) return showToast('❌ Amount too small', 'error');

        const userRef = ref(db, 'users/' + currentUserId);
        const txId = generateTxId();
        const today = getTodayDate();
        const now = Date.now();
        let abortReason = null;

        const result = await runTransaction(userRef, (data) => {
            abortReason = null;
            if (data === null) return data;
            if (data.banned === true) { abortReason = 'banned'; return; }
            const rndNow = roundTo(Number(data.rndWallet) || 0, 8);
            if (!isFinite(rndNow) || rndNow < amount) { abortReason = 'insufficient'; return; }
            
            const destNow = roundTo(Number(data[toWallet]) || 0, 2);
            data.rndWallet = roundTo(rndNow - amount, 8);
            data[toWallet] = roundTo(destNow + usdtReceived, 2);

            const transactions = data.transactions || {};
            transactions[txId] = {
                type: 'swap', from: 'rndWallet', to: toWallet,
                amount: usdtReceived, amountIn: amount, currencyIn: 'RND',
                amountOut: usdtReceived, currencyOut: DEST_CURRENCY,
                liveRate: liveRate, swapRate: swapRate, markup: SWAP_MARKUP,
                timestamp: now, date: today, status: 'completed', txId: txId,
                description: `Swapped ${amount.toFixed(4)} RND → ${usdtReceived.toFixed(2)} USDT at $${swapRate}`
            };
            data.transactions = transactions;
            return data;
        });

        if (!result.committed) {
            if (abortReason === 'banned') { showToast('❌ Account banned.', 'error'); setTimeout(() => window.location.href = 'login.html', 1500); }
            else if (abortReason === 'insufficient') { showToast('❌ Insufficient RND balance', 'error'); await loadWallets(); updateRatePreview(); }
            else showToast('❌ Swap cancelled.', 'error');
            return;
        }

        const finalData = result.snapshot.val();
        rndBalance = Number(finalData.rndWallet || 0);
        renderWallets(finalData);
        showToast(`✅ Swapped ${amount.toFixed(4)} RND → ${usdtReceived.toFixed(2)} USDT`, 'success');
        
        if ($('swapAmount')) $('swapAmount').value = '';
        updateRatePreview();
    } catch (err) {
        console.error('Swap error:', err);
        showToast('❌ Swap failed. Please try again.', 'error');
    } finally {
        swapInProgress = false;
        refreshButtonState();
    }
}
window.handleSwap = handleSwap;

// ============================================================
// UI INIT
// ============================================================
function initUI() {
    if (uiInitialized) return;
    uiInitialized = true;
    const amountEl = $('swapAmount'), walletEl = $('toWallet'), btnEl = $('swapBtn');
    if (amountEl) amountEl.addEventListener('input', updateRatePreview);
    if (walletEl) walletEl.addEventListener('change', updateRatePreview);
    if (btnEl) btnEl.addEventListener('click', handleSwap);

    const refreshRate = async () => { if (swapInProgress) return; await fetchLiveRate(); refreshButtonState(); updateRatePreview(); };
    rateTimer = setInterval(refreshRate, RATE_REFRESH_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshRate(); });
    onValue(ref(db, '.info/connected'), (snap) => { isConnected = snap.val() === true; refreshButtonState(); });
}

// ============================================================
// AUTH GUARD + INIT
// ============================================================
onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = 'login.html'; return; }
    currentUserId = user.uid;
    try {
        const snap = await get(ref(db, 'users/' + user.uid));
        if (snap.exists() && snap.val().banned === true) { alert('Banned.'); window.location.href = 'login.html'; return; }
        const [rateOk, walletOk] = await Promise.all([fetchLiveRate(), loadWallets()]);
        if (!rateOk) showToast('❌ Swap rate unavailable.', 'error');
        if (!walletOk) showToast('❌ Could not load wallet.', 'error');
    } catch (err) { console.error('Init error:', err); showToast('❌ Error loading.', 'error'); }
    $('loadingState')?.classList.add('hidden');
    $('swapFormCard')?.classList.remove('hidden');
    initUI(); updateRatePreview(); refreshButtonState();
});
