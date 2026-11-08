// ============================================================
// 🔥 DEPOSIT PAGE LOGIC — RND STAKING
// ============================================================
// Verify dabate hi form chhup jata hai aur live progress dikhta hai:
//   Checking  ->  Confirmations  ->  Crediting  ->  Success / Error
// Double-click, refresh, 2 tab — kisi se bhi duplicate deposit nahi hota.
// ============================================================

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getDatabase, ref, get, onValue } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

import {
    completeDeposit,
    cleanupStaleLocks,
    checkPendingVerifications,
    ERROR_CODES as C
} from "./verifyTransaction.js";

import {
    WALLET_CONFIG,
    normalizeTxHash,
    isValidTxHash,
    shortHash,
    getExplorerTxUrl
} from "./wallet.js";

// ============================================================
// 🔥 FIREBASE
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

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// ============================================================
// 🔧 UTILITIES
// ============================================================
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
}

const state = {
    uid: null,
    busy: false,          // verification chal rahi hai
    formBound: false
};

let progress = null;      // live progress data

// ============================================================
// 🔔 TOAST
// ============================================================
function showToast(message, type = "success", duration = null) {
    const container = $("toastContainer");
    if (!container) return;

    const icons = {
        success: "bi-check-circle-fill",
        error: "bi-x-octagon-fill",
        warning: "bi-exclamation-triangle-fill",
        info: "bi-info-circle-fill"
    };
    const colors = { success: "#2ecc71", error: "#f87171", warning: "#fbbf24", info: "#60a5fa" };
    const showFor = duration || (type === "error" ? 8000 : type === "warning" ? 7000 : 5000);

    const toast = document.createElement("div");
    toast.className = `toast-custom ${type}`;

    const icon = document.createElement("i");
    icon.className = `bi ${icons[type] || icons.info}`;
    icon.style.color = colors[type] || colors.info;

    const text = document.createElement("span");
    text.className = "toast-msg";
    text.textContent = message;

    toast.append(icon, text);
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateX(100%)";
        toast.style.transition = "all 0.3s";
        setTimeout(() => toast.remove(), 300);
    }, showFor);
}

// ============================================================
// 📋 CLIPBOARD
// ============================================================
function fallbackCopy(text) {
    const input = document.createElement("input");
    input.value = text;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    try {
        document.execCommand("copy");
        showToast("✅ Address copied to clipboard!", "success");
    } catch (err) {
        showToast("❌ Copy nahi hua. Please manually copy karein.", "error");
    }
    document.body.removeChild(input);
}

function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text)
            .then(() => showToast("✅ Address copied to clipboard!", "success"))
            .catch(() => fallbackCopy(text));
    } else {
        fallbackCopy(text);
    }
}

// ============================================================
// 📱 SIDEBAR
// ============================================================
const sidebarPanel = $("sidebarPanel");
const sidebarOverlay = $("sidebarOverlay");

function openSidebar() {
    if (!sidebarPanel || !sidebarOverlay) return;
    sidebarPanel.classList.add("open");
    sidebarOverlay.classList.add("active");
    document.body.style.overflow = "hidden";
}

function closeSidebar() {
    if (!sidebarPanel || !sidebarOverlay) return;
    sidebarPanel.classList.remove("open");
    sidebarOverlay.classList.remove("active");
    document.body.style.overflow = "";
}

if ($("sidebarToggle")) $("sidebarToggle").addEventListener("click", openSidebar);
if ($("sidebarClose")) $("sidebarClose").addEventListener("click", closeSidebar);
if (sidebarOverlay) sidebarOverlay.addEventListener("click", closeSidebar);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSidebar(); });

const logoutBtn = $("logoutBtnSidebar");
if (logoutBtn) {
    logoutBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        try { await signOut(auth); } catch (err) { console.error("Logout error:", err); }
        window.location.href = "login.html";
    });
}

// ============================================================
// 🧩 ERROR → MESSAGE (code se, text parsing nahi)
// ============================================================
function describeResult(result, ctx = {}) {
    const code = result && result.code;
    const raw = (result && result.error) || "Kuch problem aa gayi. Please dobara try karein.";
    const entered = ctx.amount > 0 ? ctx.amount : "";
    const required = WALLET_CONFIG.MIN_CONFIRMATIONS;

    switch (code) {
        case C.DUPLICATE:
            return {
                type: "error", icon: "bi-x-octagon-fill", title: "Duplicate Transaction",
                text: "Yeh transaction hash pehle hi use ho chuka hai. Ek TXID sirf ek baar use ho sakta hai.",
                hint: "Naya deposit karne par naya TXID use karein."
            };
        case C.IN_PROGRESS:
            return {
                type: "info", icon: "bi-hourglass-split", title: "Already Processing",
                text: "Yeh transaction abhi verify ho rahi hai. Thoda wait karein.",
                hint: "Agar pehle se page khula hai to wahin progress dekhein."
            };
        case C.SUPERSEDED:
            return {
                type: "info", icon: "bi-window-stack", title: "Verification Dusre Tab Me Chal Rahi Hai",
                text: "Is transaction ki verification aapke dusre tab/window me chal rahi hai.",
                hint: "Wahin progress dekhein ya yeh page refresh karein."
            };
        case C.INVALID_HASH:
            return {
                type: "error", icon: "bi-x-octagon-fill", title: "Invalid Transaction Hash",
                text: "TXID galat hai. Yeh 0x se shuru hota hai aur total 66 characters ka hota hai.",
                hint: "Wallet ya BscScan se poora hash copy karke paste karein."
            };
        case C.NOT_FOUND:
            return {
                type: "error", icon: "bi-search", title: "Transaction Not Found",
                text: "Yeh TXID BSC blockchain par nahi mila.",
                hint: "Hash check karein ya 1-2 minute baad dobara try karein."
            };
        case C.TX_FAILED:
            return {
                type: "error", icon: "bi-x-octagon-fill", title: "Transaction Failed",
                text: "Yeh transaction blockchain par fail ho chuka hai.",
                hint: "Failed transaction se paisa credit nahi hota. Sahi TXID use karein."
            };
        case C.NO_USDT_TRANSFER:
            return {
                type: "error", icon: "bi-x-octagon-fill", title: "No USDT Transfer Found",
                text: "Is transaction me koi USDT transfer nahi mila.",
                hint: "Sirf USDT (BEP20) transfer wala TXID hi valid hai."
            };
        case C.WRONG_TOKEN:
            return {
                type: "error", icon: "bi-x-octagon-fill", title: "Wrong Token",
                text: "Aapne USDT ke bajay koi aur token bheja hai.",
                hint: `Sirf USDT (BEP20) accept hota hai. Token contract: ${shortHash(result.tokenContract || "", 10, 6)}`
            };
        case C.WRONG_RECEIVER:
            return {
                type: "error", icon: "bi-x-octagon-fill", title: "Wrong Receiver Wallet",
                text: "Yeh USDT hamare deposit address par nahi bheja gaya.",
                hint: "Hamesha upar diye gaye deposit address par hi bhejein."
            };
        case C.AMOUNT_MISMATCH: {
            const chain = result.blockchainAmountText || result.blockchainAmount;
            return {
                type: "warning", icon: "bi-exclamation-triangle-fill", title: "Amount Mismatch",
                text: `Aapne ${entered} USDT likha, lekin blockchain par ${chain} USDT hai.`,
                hint: "Neeche button se sahi amount bhar kar dobara Verify karein.",
                chainAmount: chain
            };
        }
        case C.BELOW_MIN:
            return {
                type: "error", icon: "bi-x-octagon-fill", title: "Amount Too Small",
                text: `Minimum deposit ${WALLET_CONFIG.MIN_DEPOSIT_USDT} USDT hai.`,
                hint: "Is transaction se balance credit nahi ho sakta."
            };
        case C.SENDER_MISMATCH:
            return {
                type: "error", icon: "bi-person-x-fill", title: "Wallet Match Nahi Hua",
                text: "Yeh transaction aapke saved wallet address se nahi bheji gayi.",
                hint: "Wahi wallet use karein jo aapne profile me save kiya hai."
            };
        case C.WALLET_NOT_LINKED:
            return {
                type: "error", icon: "bi-wallet2", title: "Wallet Address Save Nahi Hai",
                text: "Deposit se pehle apna wallet address profile me save karein.",
                hint: "Phir yahan wapas aakar Verify karein."
            };
        case C.TX_TOO_OLD:
            return {
                type: "error", icon: "bi-clock-history", title: "Transaction Bahut Purani Hai",
                text: raw,
                hint: "Sirf recent transactions accept hoti hain. Support se sampark karein."
            };
        case C.NETWORK:
            return {
                type: "error", icon: "bi-wifi-off", title: "Network Error",
                text: "Blockchain se connect nahi ho pa raha.",
                hint: "Internet check karein aur thodi der baad dobara try karein. Aapka paisa safe hai."
            };
        case C.TIMEOUT:
            return {
                type: "info", icon: "bi-hourglass-split", title: "Confirmations Abhi Pending Hain",
                text: `Abhi ${result.confirmations || 0}/${required} confirmations hue hain.`,
                hint: "Thodi der baad wahi TXID dobara Verify karein. Koi duplicate nahi hoga."
            };
        case C.BANNED:
            return {
                type: "error", icon: "bi-slash-circle-fill", title: "Account Banned",
                text: "Aapka account ban hai. Deposit credit nahi ho sakta.",
                hint: "Support se sampark karein."
            };
        case C.USER_NOT_FOUND:
            return {
                type: "error", icon: "bi-person-x-fill", title: "Account Nahi Mila",
                text: "Aapka user account nahi mila. Dobara login karein.",
                hint: ""
            };
        case C.CREDIT_FAILED:
            return {
                type: "error", icon: "bi-x-octagon-fill", title: "Credit Nahi Ho Paya",
                text: "Balance add karte samay problem aayi.",
                hint: "Wahi TXID dobara Verify karein — paisa safe hai aur double credit nahi hoga."
            };
        default:
            return {
                type: "error", icon: "bi-x-octagon-fill", title: "Verification Failed",
                text: raw,
                hint: "Dobara try karein. Problem bani rahe to support se sampark karein."
            };
    }
}

// ============================================================
// 🎨 STATUS PANELS (inline styles — CSS par depend nahi)
// ============================================================
function setStatus(type, html) {
    const el = $("verificationStatus");
    if (!el) return;
    el.className = `verification-status show ${type}`;
    el.innerHTML = html;
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function clearStatus() {
    const el = $("verificationStatus");
    if (!el) return;
    el.className = "verification-status";
    el.innerHTML = "";
}

function txLinkHTML(txHash) {
    if (!txHash) return "";
    return `<a href="${escapeHtml(getExplorerTxUrl(txHash))}" target="_blank" rel="noopener noreferrer"
               style="color:var(--blue,#60a5fa);font-family:monospace;font-size:.8rem;word-break:break-all;">
                ${escapeHtml(shortHash(txHash, 12, 8))} <i class="bi bi-box-arrow-up-right"></i></a>`;
}

function stepRow(status, label) {
    const icon = status === "done"
        ? '<i class="bi bi-check-circle-fill" style="color:var(--primary,#2ecc71);"></i>'
        : status === "active"
            ? '<span class="spinner-border spinner-border-sm" role="status" style="width:14px;height:14px;color:var(--primary,#2ecc71);"></span>'
            : '<i class="bi bi-circle" style="opacity:.35;"></i>';
    const color = status === "pending" ? "var(--text-muted,#7386a6)" : "var(--text-primary,#f0f4ff)";
    return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;font-size:.88rem;color:${color};">
                <span style="width:18px;display:inline-flex;justify-content:center;">${icon}</span>
                <span>${label}</span>
            </div>`;
}

function renderProgress() {
    if (!progress) return;

    const required = progress.required || WALLET_CONFIG.MIN_CONFIRMATIONS;
    const conf = Math.min(progress.confirmations || 0, required);
    const phase = progress.phase;

    let step = 0;
    if (phase === "confirming") step = 1;
    if (phase === "crediting") step = 2;

    const st = (index) => (index < step ? "done" : index === step ? "active" : "pending");

    const firstLabel = phase === "mining"
        ? "Transaction blockchain par confirm hone ka wait"
        : phase === "network_retry"
            ? "Network slow hai, dobara try ho raha hai..."
            : "Blockchain par transaction check ho rahi hai";

    const pct = step >= 2 ? 100 : Math.round((conf / required) * 100);

    const html = `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
            <span class="spinner-border spinner-border-sm" role="status"></span>
            <strong>Deposit verify ho raha hai</strong>
        </div>
        <div style="font-size:.8rem;color:var(--text-secondary,#a0b0cf);margin-bottom:10px;line-height:1.6;">
            ${progress.amount > 0 ? `Amount: <strong>${escapeHtml(progress.amount)} USDT</strong><br>` : ""}
            TXID: ${txLinkHTML(progress.txHash)}
        </div>
        ${stepRow(st(0), firstLabel)}
        ${stepRow(st(1), `Confirmations (${conf}/${required})`)}
        ${stepRow(st(2), "Aapke wallet me balance add ho raha hai")}
        <div style="height:6px;border-radius:6px;background:rgba(255,255,255,.08);overflow:hidden;margin-top:12px;">
            <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,var(--primary,#2ecc71),var(--primary-light,#4ade80));transition:width .4s ease;"></div>
        </div>
        <div style="font-size:.74rem;color:var(--text-muted,#7386a6);margin-top:12px;line-height:1.5;">
            <i class="bi bi-info-circle"></i>
            Kripya page band ya refresh na karein. Agar band ho gaya to wapas aane par verification apne aap resume hogi.
        </div>`;

    setStatus("polling", html);
}

function renderSuccess(result) {
    const html = `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
            <i class="bi bi-check-circle-fill" style="font-size:1.4rem;"></i>
            <strong>${result.alreadyCredited ? "Deposit Pehle Se Credit Ho Chuka Hai" : "Deposit Successfully Credited!"}</strong>
        </div>
        <div style="font-size:.86rem;line-height:1.8;">
            Credited Amount: <strong>$${Number(result.amountCredited).toFixed(4)} USDT</strong><br>
            New Balance: <strong>$${Number(result.newBalance).toFixed(2)} USDT</strong><br>
            Verified on BSC Block: <strong>${escapeHtml(result.blockNumber || "confirmed")}</strong><br>
            TXID: ${txLinkHTML(result.txHash)}
        </div>
        <button type="button" class="btn-refresh mt-3" data-action="new-deposit" style="max-width:260px;">
            <i class="bi bi-plus-circle"></i> New Deposit
        </button>`;
    setStatus("success", html);
}

function renderError(info, result, ctx) {
    const autofill = info.chainAmount
        ? `<button type="button" class="btn-refresh mt-2 me-2" data-action="autofill"
                   data-amount="${escapeHtml(info.chainAmount)}" style="max-width:300px;padding:8px 16px;font-size:.8rem;">
               <i class="bi bi-magic"></i> Auto-fill ${escapeHtml(info.chainAmount)} USDT
           </button>`
        : "";

    const retryLabel = result.code === C.TIMEOUT || result.code === C.IN_PROGRESS || result.code === C.SUPERSEDED
        ? "Back"
        : "Try Again";

    const html = `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
            <i class="bi ${info.icon}" style="font-size:1.3rem;"></i>
            <strong>${escapeHtml(info.title)}</strong>
        </div>
        <div style="font-size:.86rem;line-height:1.7;">${escapeHtml(info.text)}</div>
        ${info.hint ? `<div style="font-size:.8rem;opacity:.85;margin-top:6px;line-height:1.6;">💡 ${escapeHtml(info.hint)}</div>` : ""}
        ${ctx && ctx.txHash ? `<div style="font-size:.78rem;margin-top:8px;">TXID: ${txLinkHTML(ctx.txHash)}</div>` : ""}
        <div style="margin-top:6px;">
            ${autofill}
            <button type="button" class="btn-refresh mt-2" data-action="retry" style="max-width:200px;padding:8px 16px;font-size:.8rem;">
                <i class="bi bi-arrow-counterclockwise"></i> ${retryLabel}
            </button>
        </div>`;

    setStatus(info.type === "warning" ? "error" : info.type, html);
}

// ============================================================
// 🧾 FORM SHOW / HIDE
// ============================================================
function setFormVisible(visible) {
    const wrap = $("depositFormWrap");
    if (wrap) wrap.style.display = visible ? "" : "none";

    const verifyBtn = $("verifyBtn");
    if (verifyBtn) verifyBtn.disabled = !visible;

    ["depositAmount", "txHash"].forEach((id) => {
        const input = $(id);
        if (input) input.readOnly = !visible;
    });
}

function showFormAgain() {
    if (state.busy) return;
    clearStatus();
    setFormVisible(true);
    const hashInput = $("txHash");
    if (hashInput) hashInput.focus();
}

// ============================================================
// 🔢 BALANCE
// ============================================================
function updateBalance(newBalance) {
    const el = $("depositBalance");
    if (el) el.textContent = "$" + (Number(newBalance) || 0).toFixed(2);
}

// ============================================================
// 🚀 RUN DEPOSIT (submit + resume dono yahin se)
// ============================================================
async function runDeposit({ txHash, amount, isResume = false }) {
    if (state.busy) return null;

    // ---- Turant: busy lock + form hide + progress ----
    state.busy = true;
    progress = {
        phase: "verifying",
        confirmations: 0,
        required: WALLET_CONFIG.MIN_CONFIRMATIONS,
        txHash,
        amount: amount > 0 ? amount : 0
    };
    setFormVisible(false);
    renderProgress();
    if (isResume) showToast("⏳ Pending deposit ki verification resume ho rahi hai...", "info", 4500);

    let result;
    try {
        result = await completeDeposit(
            state.uid,
            txHash,
            amount,
            (confirmations, currentBlock, blockNumber, info) => {
                progress.confirmations = confirmations || 0;
                if (info && info.requiredConfirmations) progress.required = info.requiredConfirmations;
                renderProgress();
            },
            null,
            null,
            {
                onPhase: (phase) => {
                    if (phase) progress.phase = phase;
                    renderProgress();
                }
            }
        );
    } catch (err) {
        console.error("Unexpected deposit error:", err);
        result = { success: false, code: "UNKNOWN", error: (err && err.message) || "Unexpected error" };
    }

    state.busy = false;
    progress = null;
    handleResult(result, { txHash, amount });
    return result;
}

function handleResult(result, ctx) {
    if (result && result.success) {
        renderSuccess(result);
        updateBalance(result.newBalance);
        showToast(
            result.alreadyCredited
                ? "ℹ️ Yeh deposit pehle hi credit ho chuka hai."
                : `✅ Deposit success! $${Number(result.amountCredited).toFixed(4)} USDT aapke wallet me add ho gaya.`,
            result.alreadyCredited ? "info" : "success",
            6000
        );
        const amountInput = $("depositAmount");
        const hashInput = $("txHash");
        if (amountInput) amountInput.value = "";
        if (hashInput) hashInput.value = "";
        return;
    }

    const info = describeResult(result || {}, ctx);
    renderError(info, result || {}, ctx);
    showToast(`${info.title}: ${info.text}`, info.type === "warning" ? "warning" : info.type, 8000);
}

// ============================================================
// 🖱️ DELEGATED BUTTON ACTIONS
// ============================================================
document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;

    const action = btn.getAttribute("data-action");

    if (action === "retry") {
        showFormAgain();
    } else if (action === "new-deposit") {
        const amountInput = $("depositAmount");
        const hashInput = $("txHash");
        if (amountInput) amountInput.value = "";
        if (hashInput) hashInput.value = "";
        showFormAgain();
    } else if (action === "autofill") {
        const amount = btn.getAttribute("data-amount");
        showFormAgain();
        const amountInput = $("depositAmount");
        if (amountInput && amount) {
            amountInput.value = amount;
            showToast(`✅ ${amount} USDT bhar diya gaya. Ab "Verify" dabayein.`, "success");
        }
    }
});

// ============================================================
// 🖼️ RENDER DEPOSIT UI
// ============================================================
function renderDepositUI(depositWallet) {
    const container = $("depositContent");
    if (!container) return;

    const depositAddress = WALLET_CONFIG.DEPOSIT_WALLET || "";
    const usdtContract = WALLET_CONFIG.USDT_CONTRACT || "";
    const minConfirmations = WALLET_CONFIG.MIN_CONFIRMATIONS;

    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(depositAddress)}&color=2ecc71&bgcolor=080e1a`;

    container.innerHTML = `
        <div class="page-header">
            <div>
                <h4>
                    <span class="header-icon"><i class="bi bi-arrow-down-circle"></i></span>
                    Deposit USDT
                </h4>
                <p>Send USDT (BEP20) to your deposit address & verify on blockchain</p>
            </div>
        </div>

        <div class="row g-4">
            <div class="col-12 col-lg-6">
                <div class="card-glass">
                    <div class="card-title">
                        <i class="bi bi-wallet2"></i>
                        Deposit Wallet Balance
                    </div>
                    <div class="deposit-balance" id="depositBalance">$${(Number(depositWallet) || 0).toFixed(2)}</div>
                    <div class="deposit-balance-label">USDT Balance</div>
                    <div class="balance-badge">
                        <i class="bi bi-shield-check"></i>
                        Blockchain Verified
                    </div>
                </div>
            </div>

            <div class="col-12 col-lg-6">
                <div class="card-glass">
                    <div class="card-title">
                        <i class="bi bi-qr-code"></i>
                        Send USDT (BEP20)
                    </div>

                    <div class="qr-wrapper">
                        <img src="${qrUrl}" alt="Deposit QR Code" id="qrCodeImg" loading="lazy"
                             onerror="this.style.display='none'">
                    </div>

                    <div class="wallet-address-box">
                        <span class="address" id="depositAddress">${escapeHtml(depositAddress)}</span>
                        <button class="copy-btn" id="copyAddressBtn" type="button">
                            <i class="bi bi-copy"></i> Copy
                        </button>
                    </div>

                    <div class="address-note">
                        <i class="bi bi-info-circle"></i>
                        Only send <strong>USDT (BEP20)</strong> to this address.
                        <br>
                        Contract: <span class="contract">${escapeHtml(usdtContract)}</span>
                    </div>
                </div>
            </div>

            <div class="col-12">
                <div class="card-glass">
                    <div class="card-title">
                        <i class="bi bi-shield-check"></i>
                        Verify Deposit (Blockchain)
                    </div>

                    <div class="info-alert">
                        <i class="bi bi-info-circle"></i>
                        <strong>Blockchain Verification:</strong> Aapki transaction seedha BSC blockchain par check hoti hai.
                        <br>
                        Required confirmations: <strong>${minConfirmations}</strong> |
                        Minimum deposit: <strong>${WALLET_CONFIG.MIN_DEPOSIT_USDT} USDT</strong>
                        <br>
                        Ek TXID sirf ek baar use ho sakta hai.
                    </div>

                    <div id="depositFormWrap">
                        <form id="depositForm" novalidate autocomplete="off">
                            <div class="row g-3">
                                <div class="col-12 col-md-4">
                                    <label class="form-label" for="depositAmount">
                                        Amount You Sent (USDT) <span class="required">*</span>
                                    </label>
                                    <input type="number" id="depositAmount" class="form-control form-control-custom"
                                           placeholder="e.g. 5.012" min="${WALLET_CONFIG.MIN_DEPOSIT_USDT}" step="any"
                                           inputmode="decimal" autocomplete="off" required>
                                    <span class="form-hint">Exact amount you sent (decimals OK)</span>
                                </div>
                                <div class="col-12 col-md-5">
                                    <label class="form-label" for="txHash">
                                        Transaction Hash (TXID) <span class="required">*</span>
                                    </label>
                                    <input type="text" id="txHash" class="form-control form-control-custom"
                                           placeholder="0x..." maxlength="66" spellcheck="false"
                                           autocomplete="off" autocapitalize="off" required>
                                    <span class="form-hint">Real BSC transaction hash from your wallet</span>
                                </div>
                                <div class="col-12 col-md-3 d-flex align-items-start">
                                    <button type="submit" class="btn-primary-custom" id="verifyBtn" style="margin-top: 26px;">
                                        <i class="bi bi-check-circle"></i>
                                        <span>Verify</span>
                                    </button>
                                </div>
                            </div>
                        </form>
                    </div>

                    <div id="verificationStatus" class="verification-status" aria-live="polite"></div>
                </div>
            </div>

            <div class="col-12">
                <div class="card-glass">
                    <div class="card-title">
                        <i class="bi bi-clock-history"></i>
                        Recent Deposits
                    </div>
                    <div id="recentDeposits">
                        <div class="empty-state">
                            <i class="bi bi-inbox"></i>
                            <p>Loading deposits...</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    const copyBtn = $("copyAddressBtn");
    if (copyBtn) {
        copyBtn.addEventListener("click", function () {
            copyToClipboard(depositAddress);
            this.classList.add("copied");
            this.innerHTML = '<i class="bi bi-check"></i> Copied!';
            setTimeout(() => {
                this.classList.remove("copied");
                this.innerHTML = '<i class="bi bi-copy"></i> Copy';
            }, 2000);
        });
    }
}

// ============================================================
// 📝 FORM SUBMIT
// ============================================================
function attachFormHandler() {
    const form = $("depositForm");
    if (!form || state.formBound) return;
    state.formBound = true;

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (state.busy) return; // double-click / double-enter

        const amountInput = $("depositAmount");
        const hashInput = $("txHash");

        const amount = parseFloat(amountInput.value);
        const txHash = normalizeTxHash(hashInput.value);

        // ---- Validation (network call se pehle) ----
        if (!Number.isFinite(amount) || amount <= 0) {
            showToast("❌ Sahi amount enter karein (0 se zyada).", "error");
            amountInput.focus();
            return;
        }
        if (amount < WALLET_CONFIG.MIN_DEPOSIT_USDT) {
            showToast(`❌ Minimum deposit ${WALLET_CONFIG.MIN_DEPOSIT_USDT} USDT hai.`, "error");
            amountInput.focus();
            return;
        }
        if (!isValidTxHash(txHash)) {
            showToast("❌ Sahi transaction hash enter karein (0x se shuru, 66 characters).", "error");
            hashInput.focus();
            return;
        }

        hashInput.value = txHash; // normalized hash dikhao
        await runDeposit({ txHash, amount });
    });
}

// ============================================================
// 🔁 RESUME PENDING (background me — page ko block nahi karta)
// ============================================================
async function resumePendingVerifications(uid) {
    try {
        const pendingTxs = await checkPendingVerifications(uid);

        for (const pending of pendingTxs) {
            while (state.busy) await sleep(1000); // user ki koi aur verification chal rahi ho to wait
            const amount = Number(pending.lockData && pending.lockData.amount) || 0;
            await runDeposit({ txHash: pending.txHash, amount, isResume: true });
        }
    } catch (err) {
        console.error("Error in resumePendingVerifications:", err);
    }
}

// ============================================================
// 📜 RECENT DEPOSITS (real-time)
// ============================================================
function emptyDepositsHTML(message, isError = false) {
    return `
        <div class="empty-state">
            <i class="bi ${isError ? "bi-exclamation-triangle" : "bi-inbox"}" ${isError ? 'style="color:var(--red);opacity:.6;"' : ""}></i>
            <p ${isError ? 'style="color:var(--red);"' : ""}>${escapeHtml(message)}</p>
        </div>`;
}

function loadRecentDeposits(userId) {
    onValue(ref(db, `users/${userId}/transactions`), (snapshot) => {
        const container = $("recentDeposits");
        if (!container) return;

        if (!snapshot.exists()) {
            container.innerHTML = emptyDepositsHTML("No deposits yet. Send USDT to your deposit address.");
            return;
        }

        const deposits = Object.values(snapshot.val())
            .filter((tx) => tx && tx.type === "deposit" && tx.status === "success")
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
            .slice(0, 10);

        if (deposits.length === 0) {
            container.innerHTML = emptyDepositsHTML("No deposits yet. Send USDT to your deposit address.");
            return;
        }

        container.innerHTML = deposits.map((tx) => {
            const amount = Number(tx.amount || 0).toFixed(4);
            const dateStr = tx.timestamp ? new Date(tx.timestamp).toLocaleString("en-IN") : "N/A";
            const hash = tx.txHash ? shortHash(tx.txHash, 12, 6) : "";

            return `
                <div class="deposit-item">
                    <div>
                        <div class="amount">$${escapeHtml(amount)} USDT</div>
                        <div class="date">${escapeHtml(dateStr)}</div>
                    </div>
                    <div style="text-align:right;">
                        <span class="status-active">
                            <i class="bi bi-check-circle-fill"></i>
                            Verified (Blockchain)
                        </span>
                        <div class="badges">
                            ${tx.blockNumber ? `<span class="badge-mini badge-block">Block: ${escapeHtml(tx.blockNumber)}</span>` : ""}
                            ${tx.confirmations ? `<span class="badge-mini badge-confirm">${escapeHtml(tx.confirmations)} Confirmations</span>` : ""}
                            ${hash ? `<a class="badge-mini badge-hash" href="${escapeHtml(getExplorerTxUrl(tx.txHash))}" target="_blank" rel="noopener noreferrer">${escapeHtml(hash)}</a>` : ""}
                        </div>
                    </div>
                </div>`;
        }).join("");
    }, (error) => {
        console.error("Error loading deposits:", error);
        const container = $("recentDeposits");
        if (container) container.innerHTML = emptyDepositsHTML("Error loading deposits. Please refresh.", true);
    });
}

// ============================================================
// 💰 BALANCE LISTENER
// ============================================================
function listenToBalance(userId) {
    onValue(ref(db, `users/${userId}/depositWallet`), (snapshot) => {
        if (snapshot.exists()) updateBalance(snapshot.val());
    });
}

// ============================================================
// 🚪 LEAVE-PAGE WARNING (verification chal rahi ho tab)
// ============================================================
window.addEventListener("beforeunload", (e) => {
    if (state.busy) {
        e.preventDefault();
        e.returnValue = "";
    }
});

// ============================================================
// 🔐 MAIN AUTH FLOW
// ============================================================
let pageInitialized = false;

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = "login.html";
        return;
    }
    if (pageInitialized) return; // dobara fire hone par duplicate listeners na bane
    pageInitialized = true;

    try {
        // Purane dead locks background me saaf karo (page ko rokta nahi)
        cleanupStaleLocks().catch((err) => console.warn("cleanupStaleLocks warning:", err));

        const userSnap = await get(ref(db, "users/" + user.uid));
        if (!userSnap.exists()) {
            window.location.href = "dashboard.html";
            return;
        }

        const userData = userSnap.val();

        if (userData.banned === true) {
            alert("Your account has been banned.");
            try { await signOut(auth); } catch (_) { /* ignore */ }
            window.location.href = "login.html";
            return;
        }

        state.uid = user.uid;

        // ---- Sidebar info ----
        const name = userData.name || "User";
        const username = String(userData.username || userData.referralCode || "USER");
        if ($("sidebarName")) $("sidebarName").textContent = name;
        if ($("sidebarUserId")) {
            $("sidebarUserId").textContent = "ID: " + username.substring(0, 20) + (username.length > 20 ? "..." : "");
        }
        if ($("sidebarAvatar")) $("sidebarAvatar").textContent = name.charAt(0).toUpperCase();
        if ($("referralBadge")) $("referralBadge").textContent = userData.totalReferrals || 0;

        // ---- Page ----
        renderDepositUI(userData.depositWallet || 0);
        attachFormHandler();
        loadRecentDeposits(user.uid);
        listenToBalance(user.uid);

        // Adhoori verification (agar koi ho) background me resume
        resumePendingVerifications(user.uid);

    } catch (error) {
        console.error("Error loading deposit page:", error);
        pageInitialized = false;

        const container = $("depositContent");
        if (container) {
            container.innerHTML = `
                <div class="empty-state" style="padding: 60px 20px;">
                    <i class="bi bi-exclamation-triangle" style="color:var(--red);opacity:0.8;"></i>
                    <h4 style="color:#fff;margin-bottom:8px;">Error Loading Page</h4>
                    <p style="color:var(--text-muted);margin-bottom:20px;">
                        ${escapeHtml(error.message || "Please check your internet connection.")}
                    </p>
                    <button class="btn-refresh" onclick="location.reload()" style="max-width:200px;margin:0 auto;">
                        <i class="bi bi-arrow-clockwise"></i>
                        Refresh Page
                    </button>
                </div>`;
        }
    }
});
