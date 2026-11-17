// ============================================================
// direct-offer  (TESTING MODE - Withdrawal always open)
// File: direct-offer.js
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import {
  getDatabase, ref, get, update, runTransaction,
  query, orderByChild, equalTo, onValue
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

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getDatabase(app);

// ============================================================
// 🎯 CONFIG (टेस्टिंग के लिए विड्रॉल पूरी तरह खुला है)
// ============================================================
const CAMPAIGN = {
  id: "bumper_referral_offer_2026",
  name: "Bumper Referral Offer 2026",
  startDate: new Date("2026-11-16T00:00:00+05:30"),
  endDate:   new Date("2026-11-17T23:59:59+05:30"),
  tiers: [
    { min: 50,   max: 100,      reward: 10,  key: "50",   label: "$50 – $99"   },
    { min: 100,  max: 200,      reward: 20,  key: "100",  label: "$100 – $199" },
    { min: 200,  max: 500,      reward: 40,  key: "200",  label: "$200 – $499" },
    { min: 500,  max: 1000,     reward: 80,  key: "500",  label: "$500 – $999" },
    { min: 1000, max: Infinity, reward: 200, key: "1000", label: "$1,000+"     }
  ]
};

const REFERRER_FIELDS = ["referredBy"];

const MIN_WITHDRAW = 1;
const REWARD_SYNC_MS = 60 * 1000;

const P = CAMPAIGN.id;

function getTierForAmount(amount) {
  const amt = Number(amount || 0);
  if (!amt || amt < CAMPAIGN.tiers[0].min) return null;
  for (const t of CAMPAIGN.tiers) if (amt >= t.min && amt < t.max) return t;
  return null;
}

// ============================================================
// DOM REFS
// ============================================================
const $ = id => document.getElementById(id);
const el = {
  loadingOverlay: $("loadingOverlay"), toastContainer: $("toastContainer"),
  userAvatar: $("userAvatar"), userName: $("userName"), logoutBtn: $("logoutBtn"),
  campaignTitle: $("campaignTitle"), campaignDates: $("campaignDates"),
  campaignDuration: $("campaignDuration"), campaignStatusBadge: $("campaignStatusBadge"),
  countdownDays: $("countdownDays"), countdownHours: $("countdownHours"),
  countdownMinutes: $("countdownMinutes"), countdownSeconds: $("countdownSeconds"),
  countdownWrapper: $("countdownWrapper"), campaignEndedMessage: $("campaignEndedMessage"),
  walletAmount: $("walletAmount"), walletStatusText: $("walletStatusText"),
  finalBadge: $("finalBadge"),
  statEligibleIds: $("statEligibleIds"), statEligibleReward: $("statEligibleReward"),
  statRewardNote: $("statRewardNote"), statWithdrawable: $("statWithdrawable"),
  statWithdrawNote: $("statWithdrawNote"), statPaid: $("statPaid"),
  referralLinkDisplay: $("referralLinkDisplay"), referralCodeDisplay: $("referralCodeDisplay"),
  copyReferralBtn: $("copyReferralBtn"),
  withdrawAmount: $("withdrawAmount"), withdrawalInfoBox: $("withdrawalInfoBox"),
  withdrawalInfoText: $("withdrawalInfoText"), withdrawalDetails: $("withdrawalDetails"),
  detailAmount: $("detailAmount"), detailWallet: $("detailWallet"),
  detailPaidDate: $("detailPaidDate"), detailTxHash: $("detailTxHash"),
  walletFormGroup: $("walletFormGroup"), walletAddressInput: $("walletAddressInput"),
  walletValidationMsg: $("walletValidationMsg"), withdrawBtn: $("withdrawBtn"),
  withdrawalStatus: $("withdrawalStatus"),
  daysPopup: $("daysPopup"), popupCloseBtn: $("popupCloseBtn"),
  confirmationModal: $("confirmationModal"), confirmAmount: $("confirmAmount"),
  confirmWallet: $("confirmWallet"), confirmCancel: $("confirmCancel"),
  confirmSubmit: $("confirmSubmit"),
  rewardsTableBody: $("rewardsTableBody")
};

let currentUserId = null;
let currentUserData = null;
let calculatedRewards = emptyRewards();
let earnedState = { totalEarned: 0, counts: {}, breakdown: {} };
let withdrawalsData = {};
let countdownInterval = null;
let isProcessingWithdrawal = false;
let isSyncing = false;
let syncInterval = null;
let unsubWithdrawals = null;
let withdrawalAmountInput = null;
let lastStatus = null;
let booted = false;
let amountPrefilled = false;

function emptyRewards() {
  return {
    totalEarned: 0, paidAmount: 0, pendingAmount: 0, withdrawable: 0,
    counts: {}, breakdown: {}, currentStatus: "available", currentWithdrawal: null
  };
}

// ============================================================
// ⏱️ SERVER TIME
// ============================================================
let serverOffset = 0;
function getNow() { return new Date(Date.now() + serverOffset); }

function initServerTime() {
  return new Promise(resolve => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(); } }, 3000);
    onValue(ref(db, ".info/serverTimeOffset"), snap => {
      serverOffset = Number(snap.val() || 0);
      if (!done) { done = true; clearTimeout(t); resolve(); }
    });
  });
}

// 🔓 टेस्टिंग के लिए: स्टेटस हमेशा ACTIVE रहेगा (विड्रॉल बायपास के लिए)
function getCampaignStatus() {
  return "ACTIVE"; 
}

// ============================================================
// UTILS
// ============================================================
const round2 = n => Math.round(Number(n || 0) * 100) / 100;
function fmt(n) { return Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function validateBEP20Wallet(a) { return typeof a === "string" && /^0x[a-fA-F0-9]{40}$/.test(a.trim()); }

function toMillis(v) {
  if (v == null || v === "") return NaN;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "object" && typeof v.seconds === "number") return v.seconds * 1000;
  const n = Number(v);
  if (!isNaN(n)) return n < 1e12 ? n * 1000 : n;
  return Date.parse(v);
}

function showToast(message, type = "success") {
  const container = el.toastContainer;
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast-custom ${type}`;
  const iconMap = { success: "bi-check-circle-fill", error: "bi-exclamation-triangle-fill", warning: "bi-exclamation-triangle-fill", info: "bi-info-circle-fill" };
  const icon = document.createElement("i");
  icon.className = `bi ${iconMap[type] || iconMap.success}`;
  const span = document.createElement("span");
  span.className = "toast-msg";
  span.textContent = message;
  toast.append(icon, span);
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = "0"; toast.style.transform = "translateX(100%)"; setTimeout(() => toast.remove(), 300); }, 5000);
}

function generateId(prefix) {
  return prefix + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
}

// ============================================================
// ⏱️ COUNTDOWN (अभी टेस्टिंग के लिए डमी टाइमर)
// ============================================================
function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  const tick = () => {
    if (el.countdownWrapper) el.countdownWrapper.style.display = "none";
    if (el.campaignEndedMessage) el.campaignEndedMessage.style.display = "block";
    if (el.campaignEndedMessage) el.campaignEndedMessage.textContent = "🔓 TESTING MODE: Withdrawals Open";
  };
  tick();
}

// ============================================================
// 📋 REWARD TABLE
// ============================================================
function renderRewardsTable() {
  if (!el.rewardsTableBody) return;
  el.rewardsTableBody.innerHTML = CAMPAIGN.tiers.map((t, i) => {
    const isLast = i === CAMPAIGN.tiers.length - 1;
    return `
      <tr class="${isLast ? "highlight-row" : ""}">
        <td><strong>${t.label}</strong></td>
        <td><span class="gold-text ${isLast ? "big" : ""}">$${t.reward}</span>${isLast ? '<span class="star">★</span>' : ""}</td>
      </tr>`;
  }).join("");
}

// ============================================================
// 💵 WITHDRAWAL AMOUNT INPUT
// ============================================================
function injectWithdrawalInput() {
  if (document.getElementById("withdrawAmountInput")) return;
  const formGroup = el.walletFormGroup;
  if (!formGroup) return;
  const amountDiv = document.createElement("div");
  amountDiv.className = "form-group mt-3";
  amountDiv.innerHTML = `
    <label><i class="bi bi-cash me-1"></i> Withdrawal Amount (USDT)</label>
    <input type="number" id="withdrawAmountInput" class="form-control-custom" placeholder="Enter amount" min="${MIN_WITHDRAW}" step="0.01"/>
    <div id="amountValidationMsg" class="wallet-validation-msg"></div>`;
  formGroup.parentNode.insertBefore(amountDiv, formGroup);
  withdrawalAmountInput = document.getElementById("withdrawAmountInput");
}

// ============================================================
// 👤 PROFILE
// ============================================================
async function loadProfile(uid) {
  const snap = await get(ref(db, `users/${uid}`));
  if (!snap.exists()) return;
  currentUserData = snap.val();
  const name = currentUserData.name || currentUserData.username || "User";
  if (el.userName) el.userName.textContent = name;
  if (el.userAvatar) el.userAvatar.textContent = name.charAt(0).toUpperCase();
  const refCode = currentUserData.referralCode || uid.substring(0, 8);
  currentUserData._refCode = refCode;
  if (el.referralCodeDisplay) el.referralCodeDisplay.textContent = refCode;
  if (el.referralLinkDisplay) el.referralLinkDisplay.textContent = `https://staking.randigital.in/register.html?ref=${refCode}`;
}

// ============================================================
// 🔥 REWARD CALCULATION
// ============================================================
async function fetchReferredUsers(uid, refCode) {
  const values = [...new Set([refCode, uid].filter(Boolean))];
  const jobs = [];
  for (const f of REFERRER_FIELDS)
    for (const v of values)
      jobs.push(get(query(ref(db, "users"), orderByChild(f), equalTo(v))));
  const snaps = await Promise.all(jobs);
  const out = {};
  snaps.forEach(s => s.forEach(c => { if (c.key !== uid) out[c.key] = c.val(); }));
  return out;
}

function computeFromReferred(referred) {
  const counts = {}, breakdown = {};
  CAMPAIGN.tiers.forEach(t => { counts[t.key] = 0; breakdown[t.key] = 0; });
  const purchases = [];
  let totalEarned = 0;
  const start = CAMPAIGN.startDate.getTime();
  const end = CAMPAIGN.endDate.getTime();

  for (const [buyerUid, data] of Object.entries(referred)) {
    for (const [pkgId, pkg] of Object.entries(data.packages || {})) {
      if (pkg.status !== "active" && pkg.status !== "completed") continue;
      const amt = Number(pkg.usdtAmount || 0);
      const tier = getTierForAmount(amt);
      if (!tier) continue;
      const t = toMillis(pkg.purchaseDate || pkg.timestamp || pkg.createdAt);
      if (isNaN(t) || t < start || t > end) continue;

      counts[tier.key]++;
      breakdown[tier.key] += tier.reward;
      totalEarned += tier.reward;
      purchases.push({ purchaseId: `${buyerUid}_${pkgId}`, buyerUid, amt, tier, time: t });
    }
  }
  return { counts, breakdown, totalEarned, purchases };
}

async function syncRewards(uid) {
  if (isSyncing || !currentUserData) return;
  isSyncing = true;
  try {
    const refCode = currentUserData._refCode;
    const referred = await fetchReferredUsers(uid, refCode);
    const res = computeFromReferred(referred);
    earnedState = { totalEarned: res.totalEarned, counts: res.counts, breakdown: res.breakdown };

    try {
      const claimsSnap = await get(ref(db, `${P}/user_claims/${uid}`));
      const existing = claimsSnap.val() || {};
      const updates = {};
      for (const p of res.purchases) {
        if (existing[p.purchaseId]) continue;
        updates[`purchases/${p.purchaseId}`] = {
          purchaseId: p.purchaseId, buyerUid: p.buyerUid, directReferrerUid: uid,
          packageAmount: p.amt, tierKey: p.tier.key, rewardAmount: p.tier.reward,
          status: "completed", timestamp: p.time, campaignId: P
        };
        updates[`user_claims/${uid}/${p.purchaseId}`] = {
          purchaseId: p.purchaseId, amount: p.amt, tierKey: p.tier.key,
          reward: p.tier.reward, claimedAt: Date.now()
        };
      }
      if (Object.keys(updates).length) await update(ref(db, P), updates);
    } catch (e) { console.warn("Audit write skipped:", e.message); }

    recomputeBalances();
    updateUI();
  } catch (err) {
    console.error("Sync error:", err);
  } finally {
    isSyncing = false;
  }
}

// ============================================================
// 🏦 WITHDRAWALS
// ============================================================
function listenWithdrawals(uid) {
  if (unsubWithdrawals) unsubWithdrawals();
  unsubWithdrawals = onValue(ref(db, `${P}/user_withdrawals/${uid}`), snap => {
    withdrawalsData = snap.val() || {};
    recomputeBalances();
    updateUI();
  }, err => console.error("Withdrawal listener error:", err));
}

function recomputeBalances() {
  let paid = 0, pending = 0, hasPending = false, hasApproved = false;
  let latest = null;

  for (const w of Object.values(withdrawalsData)) {
    const amt = Number(w.amount || 0);
    if (w.status === "paid") paid += amt;
    else if (w.status === "pending") { pending += amt; hasPending = true; }
    else if (w.status === "approved") { pending += amt; hasApproved = true; }
    if (!latest || (w.requestedAt || 0) > (latest.requestedAt || 0)) latest = w;
  }

  const currentStatus = hasPending ? "pending" : hasApproved ? "approved" : (latest ? latest.status : "available");
  calculatedRewards = {
    totalEarned: earnedState.totalEarned,
    paidAmount: round2(paid),
    pendingAmount: round2(pending),
    withdrawable: Math.max(0, round2(earnedState.totalEarned - paid - pending)),
    counts: earnedState.counts, breakdown: earnedState.breakdown,
    currentStatus, currentWithdrawal: latest
  };
}

function startAutoSync(uid) {
  stopAutoSync();
  if (getCampaignStatus() !== "UPCOMING") syncRewards(uid);
  listenWithdrawals(uid);
  syncInterval = setInterval(() => {
    if (document.hidden) return;
    if (getCampaignStatus() !== "ACTIVE") return;
    syncRewards(uid);
  }, REWARD_SYNC_MS);
}

function stopAutoSync() {
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
  if (unsubWithdrawals) { unsubWithdrawals(); unsubWithdrawals = null; }
}

// ============================================================
// 🎨 UI RENDER
// ============================================================
function updateUI() {
  const status = getCampaignStatus();
  if (el.campaignDates) el.campaignDates.textContent = `17 Nov – 18 Nov (Testing)`;
  if (el.campaignDuration) el.campaignDuration.textContent = `Testing Mode`;
  if (el.campaignStatusBadge) el.campaignStatusBadge.innerHTML = `<span class="campaign-status-badge active">🔥 TESTING (WITHDRAW OPEN)</span>`;

  const { totalEarned, paidAmount, withdrawable, counts, breakdown } = calculatedRewards;
  const totalIds = Object.values(counts || {}).reduce((a, b) => a + Number(b || 0), 0);

  if (el.walletAmount) el.walletAmount.textContent = fmt(withdrawable);
  if (el.statEligibleIds) el.statEligibleIds.textContent = totalIds;
  if (el.statEligibleReward) el.statEligibleReward.textContent = `$${fmt(totalEarned)}`;
  if (el.statPaid) el.statPaid.textContent = `$${fmt(paidAmount)}`;
  if (el.statWithdrawable) el.statWithdrawable.textContent = `$${fmt(withdrawable)}`;
  if (el.statRewardNote) el.statRewardNote.textContent = `${totalIds} eligible purchase${totalIds === 1 ? "" : "s"}`;
  if (el.statWithdrawNote) el.statWithdrawNote.textContent = "Available to withdraw";

  CAMPAIGN.tiers.forEach(t => {
    const cEl = $(`bdCount${t.key}`), rEl = $(`bdReward${t.key}`);
    if (cEl) cEl.textContent = (counts || {})[t.key] || 0;
    if (rEl) rEl.textContent = ((breakdown || {})[t.key] || 0).toLocaleString();
  });

  updateWithdrawalUI(withdrawable, status);
}

function updateWithdrawalUI(withdrawable, status) {
  const ws = String(calculatedRewards.currentStatus || "available").toLowerCase();
  const cw = calculatedRewards.currentWithdrawal;
  const blocked = ws === "pending" || ws === "approved";
  const canWithdraw = withdrawable >= MIN_WITHDRAW && !blocked;

  injectWithdrawalInput();

  if (el.withdrawAmount) el.withdrawAmount.textContent = `$${fmt(withdrawable)} USDT`;
  if (el.withdrawalInfoBox) el.withdrawalInfoBox.classList.add("visible");

  if (el.withdrawalInfoText) {
    let txt;
    if (ws === "pending") txt = "⏳ Your withdrawal is pending approval.";
    else if (ws === "approved") txt = "✅ Your withdrawal is approved and being processed.";
    else if (canWithdraw) txt = "🔓 Withdrawals are open (Testing Mode).";
    else if (calculatedRewards.paidAmount > 0) txt = "✅ All your rewards have been paid.";
    else txt = "No reward available to withdraw.";
    el.withdrawalInfoText.textContent = txt;
  }

  if (el.withdrawalStatus) {
    const msgs = {
      pending:  "⏳ Your withdrawal request is pending admin approval.",
      approved: "✅ Your withdrawal has been approved and is being processed.",
      paid:     "✅ Payment has been sent to your wallet.",
      rejected: "❌ Your last withdrawal request was rejected." + (cw && cw.rejectReason ? ` Reason: ${cw.rejectReason}` : "")
    };
    if (msgs[ws]) {
      el.withdrawalStatus.className = `withdrawal-status visible ${ws}`;
      el.withdrawalStatus.textContent = msgs[ws];
    } else {
      el.withdrawalStatus.className = "withdrawal-status";
      el.withdrawalStatus.textContent = "";
    }
  }

  if (el.withdrawalDetails) {
    if (ws === "paid" && cw) {
      el.withdrawalDetails.classList.add("visible");
      if (el.detailAmount) el.detailAmount.textContent = `$${fmt(cw.amount)} USDT`;
      if (el.detailWallet) el.detailWallet.textContent = cw.walletAddress || "---";
      if (el.detailPaidDate) el.detailPaidDate.textContent = cw.paidAt ? new Date(cw.paidAt).toLocaleString() : "---";
      if (el.detailTxHash) el.detailTxHash.textContent = cw.txHash || "---";
    } else {
      el.withdrawalDetails.classList.remove("visible");
    }
  }

  if (el.withdrawBtn) {
    if (canWithdraw) {
      el.withdrawBtn.disabled = false;
      el.withdrawBtn.className = "btn-withdraw";
      el.withdrawBtn.innerHTML = calculatedRewards.paidAmount > 0
        ? `<i class="bi bi-arrow-up-right me-2"></i>Withdraw New Rewards`
        : `<i class="bi bi-arrow-up-right me-2"></i>Withdraw Offer Reward`;
    } else {
      el.withdrawBtn.disabled = true;
      el.withdrawBtn.className = "btn-withdraw withdrawal-locked";
      if (ws === "pending") el.withdrawBtn.innerHTML = `<i class="bi bi-clock me-2"></i>Pending Approval`;
      else if (ws === "approved") el.withdrawBtn.innerHTML = `<i class="bi bi-check-circle me-2"></i>Approved`;
      else if (calculatedRewards.paidAmount > 0) el.withdrawBtn.innerHTML = `<i class="bi bi-check-circle-fill me-2"></i>Paid ✓`;
      else el.withdrawBtn.innerHTML = `Nothing to Withdraw`;
    }
  }

  if (el.walletFormGroup) el.walletFormGroup.style.display = canWithdraw ? "block" : "none";
  if (withdrawalAmountInput) {
    const wrap = withdrawalAmountInput.closest(".form-group");
    if (wrap) wrap.style.display = canWithdraw ? "block" : "none";
    withdrawalAmountInput.max = withdrawable;
    if (canWithdraw && !amountPrefilled && !withdrawalAmountInput.value) {
      withdrawalAmountInput.value = withdrawable.toFixed(2);
      amountPrefilled = true;
    }
  }
}

// ============================================================
// 🏦 WITHDRAW FLOW
// ============================================================
function validateWallet() {
  const val = el.walletAddressInput?.value.trim() || "";
  const msg = el.walletValidationMsg;
  if (!msg) return false;
  if (!val) {
    el.walletAddressInput.className = "form-control-custom";
    msg.className = "wallet-validation-msg"; msg.textContent = "";
    return false;
  }
  if (validateBEP20Wallet(val)) {
    el.walletAddressInput.className = "form-control-custom valid";
    msg.className = "wallet-validation-msg valid"; msg.textContent = "✅ Valid BEP-20 wallet";
    return true;
  }
  el.walletAddressInput.className = "form-control-custom error";
  msg.className = "wallet-validation-msg error"; msg.textContent = "❌ Invalid BEP-20 wallet";
  return false;
}

function handleWithdrawClick() {
  const avail = calculatedRewards.withdrawable;
  if (avail < MIN_WITHDRAW) { showToast("Nothing to withdraw.", "warning"); return; }
  if (!validateWallet()) { showToast("Enter a valid BEP-20 wallet address.", "error"); return; }

  const amountVal = round2(parseFloat(withdrawalAmountInput?.value || 0));
  if (!amountVal || amountVal < MIN_WITHDRAW) { showToast(`Minimum withdrawal is $${MIN_WITHDRAW}.`, "error"); return; }
  if (amountVal > avail + 1e-9) { showToast("Amount exceeds available balance.", "error"); return; }

  if (el.confirmAmount) el.confirmAmount.textContent = `$${fmt(amountVal)} USDT`;
  if (el.confirmWallet) el.confirmWallet.textContent = el.walletAddressInput.value.trim();
  el.confirmationModal?.classList.add("visible");
}

async function submitWithdrawal() {
  if (isProcessingWithdrawal) return;
  isProcessingWithdrawal = true;
  const origHTML = '<i class="bi bi-check-circle me-1"></i>Confirm Withdrawal';
  if (el.confirmSubmit) { el.confirmSubmit.disabled = true; el.confirmSubmit.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>Processing...`; }

  let lockTaken = false;
  const lockRef = ref(db, `${P}/rewards/${currentUserId}`);

  try {
    const addr = el.walletAddressInput?.value.trim() || "";
    if (!validateBEP20Wallet(addr)) { showToast("Invalid wallet.", "error"); return; }

    const amountVal = round2(parseFloat(withdrawalAmountInput?.value || 0));
    const avail = calculatedRewards.withdrawable;
    if (!amountVal || amountVal < MIN_WITHDRAW || amountVal > avail + 1e-9) { showToast("Invalid amount.", "error"); return; }

    const withdrawalId = generateId("dw");
    const txId = generateId("tx");
    const timestamp = Date.now() + serverOffset;

    const lockResult = await runTransaction(lockRef, (current) => {
      if (current && (current.status === "pending" || current.status === "approved")) return;
      return {
        ...(current || {}),
        status: "pending", walletAddress: addr, withdrawalId, transactionId: txId,
        requestedAmount: amountVal, requestedAt: timestamp, updatedAt: timestamp
      };
    });
    if (!lockResult.committed) { showToast("A withdrawal is already pending.", "warning"); return; }
    lockTaken = true;

    const date = new Date(timestamp).toISOString().split("T")[0];
    const username = currentUserData?.username || currentUserData?.name || currentUserId;

    const adminData = {
      campaignName: CAMPAIGN.name, campaignId: P, type: "bumper_offer_withdrawal",
      asset: "USDT", network: "BEP-20 / BNB Smart Chain",
      amount: amountVal, status: "pending",
      userId: currentUserId, username,
      email: currentUserData?.email || null,
      referralCode: currentUserData?._refCode || null,
      walletAddress: addr, requestedAt: timestamp,
      withdrawalId, transactionId: txId,
      earnedAtRequest: calculatedRewards.totalEarned,
      paidBeforeRequest: calculatedRewards.paidAmount
    };
    const userWithdrawal = {
      withdrawalId, transactionId: txId, amount: amountVal, status: "pending",
      walletAddress: addr, requestedAt: timestamp, paidAt: null, txHash: null, rejectReason: null
    };
    const userTx = {
      type: "bumper_offer_withdrawal", subtype: `${CAMPAIGN.name} Withdrawal`,
      amount: amountVal, currency: "USDT", network: "BEP-20 / BNB Smart Chain",
      status: "pending", walletAddress: addr, withdrawalId, timestamp, date,
      description: `${CAMPAIGN.name} Withdrawal of $${amountVal} USDT (BEP-20)`, txId, txHash: null
    };

    try {
      await update(ref(db), {
        [`${P}/withdrawals/${withdrawalId}`]: adminData,
        [`${P}/user_withdrawals/${currentUserId}/${withdrawalId}`]: userWithdrawal,
        [`users/${currentUserId}/offer_transactions/${txId}`]: userTx,
        [`${P}/transactions/${txId}`]: { ...userTx, userId: currentUserId }
      });
    } catch (writeErr) {
      await update(lockRef, { status: "failed", updatedAt: Date.now() }).catch(() => {});
      throw writeErr;
    }

    showToast("✅ Withdrawal request submitted. Awaiting admin approval.", "success");
    el.confirmationModal?.classList.remove("visible");
    if (el.walletAddressInput) el.walletAddressInput.value = "";
    if (withdrawalAmountInput) withdrawalAmountInput.value = "";
    amountPrefilled = false;
  } catch (err) {
    console.error(err);
    showToast("❌ " + (err.message || "Withdrawal failed."), "error");
  } finally {
    isProcessingWithdrawal = false;
    if (el.confirmSubmit) { el.confirmSubmit.disabled = false; el.confirmSubmit.innerHTML = origHTML; }
  }
}

// ============================================================
// 🖱️ EVENTS & BOOT
// ============================================================
async function copyReferralLink() {
  const link = el.referralLinkDisplay?.textContent || "";
  if (!link || link === "Loading...") { showToast("Wait...", "warning"); return; }
  try {
    await navigator.clipboard.writeText(link);
    showToast("✅ Referral link copied!", "success");
    if (el.copyReferralBtn) {
      el.copyReferralBtn.classList.add("copied");
      el.copyReferralBtn.innerHTML = `<i class="bi bi-check-circle me-1"></i>Copied!`;
      setTimeout(() => { el.copyReferralBtn.classList.remove("copied"); el.copyReferralBtn.innerHTML = `<i class="bi bi-clipboard me-1"></i>Copy`; }, 3000);
    }
  } catch { showToast("Copy failed — please copy manually.", "error"); }
}

async function handleLogout() {
  try {
    stopAutoSync();
    await signOut(auth);
    window.location.href = "login.html";
  } catch { showToast("Logout error", "error"); }
}

function setupListeners() {
  el.copyReferralBtn?.addEventListener("click", copyReferralLink);
  el.logoutBtn?.addEventListener("click", handleLogout);
  el.withdrawBtn?.addEventListener("click", handleWithdrawClick);
  el.walletAddressInput?.addEventListener("input", validateWallet);
  el.popupCloseBtn?.addEventListener("click", () => el.daysPopup?.classList.remove("visible"));
  el.daysPopup?.addEventListener("click", (e) => { if (e.target === el.daysPopup) el.daysPopup.classList.remove("visible"); });
  el.confirmCancel?.addEventListener("click", () => el.confirmationModal?.classList.remove("visible"));
  el.confirmationModal?.addEventListener("click", (e) => { if (e.target === el.confirmationModal) el.confirmationModal.classList.remove("visible"); });
  el.confirmSubmit?.addEventListener("click", submitWithdrawal);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && currentUserId && getCampaignStatus() === "ACTIVE") syncRewards(currentUserId);
  });
}

const AUTH_TIMEOUT_MS = 10000;
let authResolved = false;
const authTimeoutHandle = setTimeout(() => {
  if (!authResolved) {
    el.loadingOverlay?.classList.add("hidden");
    if (!auth.currentUser) window.location.href = "login.html";
  }
}, AUTH_TIMEOUT_MS);

onAuthStateChanged(auth, async (user) => {
  authResolved = true;
  clearTimeout(authTimeoutHandle);

  if (!user) { window.location.href = "login.html"; return; }
  if (booted) return;
  booted = true;
  currentUserId = user.uid;

  try {
    await initServerTime();
    renderRewardsTable();
    setupListeners();
    await loadProfile(user.uid);
    startCountdown();
    startAutoSync(user.uid);
  } catch (e) {
    console.error(e);
    showToast("Failed to load data. Please refresh.", "error");
  } finally {
    el.loadingOverlay?.classList.add("hidden");
  }
});

window.addEventListener("beforeunload", () => {
  stopAutoSync();
  if (countdownInterval) clearInterval(countdownInterval);
});
