// ============================================================
// DIWALI BUMPER OFFER — STANDALONE SCRIPT (Test Mode Enabled)
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getDatabase, ref, get, update, runTransaction } from "firebase/database";

// ============================================================
// 🔥 LIVE FIREBASE CONFIG
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

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getDatabase(app);

// ============================================================
// 🎯 CONFIGURATION (LIVE TESTING - Dates Extended)
// ============================================================
const CAMPAIGN = {
  id: "diwali_2026",
  name: "Diwali Bumper Offer",
  // 🔥 TESTING DATES: Today se shuru hokar 30 din tak
  startDate: new Date("2026-10-25T00:00:00+05:30"), 
  endDate:   new Date("2026-11-25T23:59:59.999+05:30"),
  rewards: { 
    50: 10, 
    100: 25, 
    200: 50, 
    500: 90, 
    1000: 250 
  }
};

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
  bdCount50: $("bdCount50"), bdCount100: $("bdCount100"), bdCount200: $("bdCount200"),
  bdCount500: $("bdCount500"), bdCount1000: $("bdCount1000"),
  bdReward50: $("bdReward50"), bdReward100: $("bdReward100"), bdReward200: $("bdReward200"),
  bdReward500: $("bdReward500"), bdReward1000: $("bdReward1000"),
  referralLinkDisplay: $("referralLinkDisplay"), referralCodeDisplay: $("referralCodeDisplay"),
  copyReferralBtn: $("copyReferralBtn"),
  withdrawAmount: $("withdrawAmount"), withdrawalInfoBox: $("withdrawalInfoBox"),
  withdrawalInfoText: $("withdrawalInfoText"), withdrawalDetails: $("withdrawalDetails"),
  detailAmount: $("detailAmount"), detailWallet: $("detailWallet"),
  detailPaidDate: $("detailPaidDate"), detailTxHash: $("detailTxHash"),
  walletFormGroup: $("walletFormGroup"), walletAddressInput: $("walletAddressInput"),
  walletValidationMsg: $("walletValidationMsg"), withdrawBtn: $("withdrawBtn"),
  withdrawalStatus: $("withdrawalStatus"),
  daysPopup: $("daysPopup"), popupRewardAmount: $("popupRewardAmount"),
  popupDaysRemaining: $("popupDaysRemaining"), popupTitle: $("popupTitle"),
  popupCloseBtn: $("popupCloseBtn"),
  confirmationModal: $("confirmationModal"), confirmAmount: $("confirmAmount"),
  confirmWallet: $("confirmWallet"), confirmCancel: $("confirmCancel"),
  confirmSubmit: $("confirmSubmit")
};

let currentUserId = null;
let currentUserData = null;
let calculatedRewards = { balance: 0, paidAmount: 0, counts: {}, breakdown: {} };
let countdownInterval = null;
let isProcessingWithdrawal = false;

// ============================================================
// UTILS & TIME HELPERS
// ============================================================
function getNow() { return new Date(); }

function getCampaignStatus() {
  const now = getNow().getTime();
  const start = CAMPAIGN.startDate.getTime();
  const end = CAMPAIGN.endDate.getTime();
  if (now < start) return "UPCOMING";
  if (now <= end) return "ACTIVE";
  return "ENDED";
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  let timestamp;
  if (typeof value === "number") timestamp = value;
  else if (typeof value === "string") {
    const numericValue = Number(value);
    timestamp = Number.isFinite(numericValue) ? numericValue : Date.parse(value);
  } else return null;

  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  if (timestamp < 100000000000) timestamp *= 1000; // Seconds to ms
  return timestamp;
}

function isWithinDiwaliCampaign(tx) {
  const rawTime = tx.timestamp ?? tx.createdAt;
  const txTime = normalizeTimestamp(rawTime);
  if (txTime === null) return false;
  return txTime >= CAMPAIGN.startDate.getTime() && txTime <= CAMPAIGN.endDate.getTime();
}

function isEligiblePackagePurchase(tx) {
  if (!tx || typeof tx !== "object") return false;
  const txType = String(tx.type || "").trim().toLowerCase();
  const packageId = String(tx.packageId || "").trim();
  const amount = Number(tx.amount ?? tx.packageAmount);

  if (txType !== "package") return false;
  if (!packageId) return false;
  if (!Number.isFinite(amount) || amount <= 0) return false;
  return true;
}

function getTimeRemaining() {
  const now = getNow();
  const status = getCampaignStatus();
  const target = status === "UPCOMING" ? CAMPAIGN.startDate : CAMPAIGN.endDate;
  const diff = target - now;
  if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0 };
  return {
    days:    Math.floor(diff / 86400000),
    hours:   Math.floor((diff % 86400000) / 3600000),
    minutes: Math.floor((diff % 3600000) / 60000),
    seconds: Math.floor((diff % 60000) / 1000)
  };
}

function fmt(n) { return Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function validateBEP20Wallet(address) { return typeof address === "string" && /^0x[a-fA-F0-9]{40}$/.test(address.trim()); }

function showToast(message, type = "success") {
  const container = el.toastContainer;
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast-custom ${type}`;
  const iconMap = { success: "bi-check-circle-fill", error: "bi-exclamation-triangle-fill", warning: "bi-exclamation-triangle-fill", info: "bi-info-circle-fill" };
  toast.innerHTML = `<i class="bi ${iconMap[type] || iconMap.success}"></i><span class="toast-msg">${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = "0"; toast.style.transform = "translateX(100%)"; setTimeout(() => toast.remove(), 300); }, 5000);
}

function renderRewardsTable() {
  const tbody = $("rewardsTableBody");
  if (!tbody) return;
  const r = CAMPAIGN.rewards;
  tbody.innerHTML = `
    <tr><td>$50</td><td class="gold-text">$${r[50]}</td></tr>
    <tr><td>$100</td><td class="gold-text">$${r[100]}</td></tr>
    <tr><td>$200</td><td class="gold-text">$${r[200]}</td></tr>
    <tr><td>$500</td><td class="gold-text">$${r[500]}</td></tr>
    <tr class="highlight-row"><td>$1,000 <span class="star">★</span></td><td class="gold-text big">$${r[1000]}</td></tr>
  `;
}

function initCalculator() {
  const inputs = [50, 100, 200, 500, 1000];
  const recalc = () => {
    let total = 0;
    inputs.forEach(amt => {
      const qty = Math.max(0, parseInt($(`calc${amt}`).value, 10) || 0);
      const r   = qty * (CAMPAIGN.rewards[amt] || 0);
      $(`calcOut${amt}`).textContent = r.toLocaleString();
      total += r;
    });
    $("calcTotal").textContent = total.toLocaleString();
  };
  inputs.forEach(amt => $(`calc${amt}`)?.addEventListener("input", recalc));
}

// ============================================================
// 📊 CALCULATE & SECURE REWARDS
// ============================================================
async function calculateUserRewards(uid) {
  try {
    const userSnap = await get(ref(db, `users/${uid}`));
    if (!userSnap.exists()) return;
    currentUserData = userSnap.val();
    
    const name = currentUserData.name || currentUserData.username || "User";
    if (el.userName) el.userName.textContent = name;
    if (el.userAvatar) el.userAvatar.textContent = name.charAt(0).toUpperCase();
    
    const refCode = currentUserData.referralCode || uid.substring(0, 8);
    if (el.referralCodeDisplay) el.referralCodeDisplay.textContent = refCode;
    if (el.referralLinkDisplay) el.referralLinkDisplay.textContent = `https://staking.randigital.in/register.html?ref=${refCode}`;

    let mergedTx = {};
    
    if (currentUserData.transactions) {
      Object.entries(currentUserData.transactions).forEach(([id, t]) => {
        mergedTx[id] = { id, ...t };
      });
    }
    
    const txSnap = await get(ref(db, "transactions"));
    const allTx = txSnap.val() || {};
    Object.entries(allTx).forEach(([id, t]) => {
      if (t.userId === uid || t.uid === uid) {
        mergedTx[id] = { id, ...t };
      }
    });

    const rawTx = Object.values(mergedTx);

    const counts = { 50: 0, 100: 0, 200: 0, 500: 0, 1000: 0 };
    const breakdown = { 50: 0, 100: 0, 200: 0, 500: 0, 1000: 0 };
    let totalBal = 0;

    const securityRef = ref(db, `direct_diwali_offer/${CAMPAIGN.id}/user_claims/${uid}`);
    const securitySnap = await get(securityRef);
    const alreadyClaimed = securitySnap.val() || {};
    const newClaims = {};

    for (const tx of rawTx) {
      const txStatus = String(tx.status || "").toLowerCase();
      if (txStatus !== "confirmed" && txStatus !== "completed" && txStatus !== "success") continue;
      if (!isEligiblePackagePurchase(tx)) continue;

      const amt = Number(tx.amount ?? tx.packageAmount ?? 0);
      if (!CAMPAIGN.rewards[amt]) continue;
      if (!isWithinDiwaliCampaign(tx)) continue;

      const txId = tx.id || tx.txId;
      const rewardAmt = CAMPAIGN.rewards[amt];

      if (!alreadyClaimed[txId]) {
        newClaims[txId] = { amount: amt, reward: rewardAmt, claimedAt: Date.now() };
      }

      counts[amt]++;
      breakdown[amt] += rewardAmt;
      totalBal += rewardAmt;
    }

    if (Object.keys(newClaims).length > 0) {
      await update(securityRef, newClaims);
    }

    const rewardSnap = await get(ref(db, `direct_diwali_offer/${CAMPAIGN.id}/rewards/${uid}`));
    let adminPaidAmount = 0, adminStatus = "available", adminWallet = "", adminTxHash = "", adminPaidAt = null;

    if (rewardSnap.exists()) {
      const data = rewardSnap.val();
      adminPaidAmount = data.paidAmount || 0;
      adminStatus = data.status || "available";
      adminWallet = data.walletAddress || "";
      adminTxHash = data.txHash || "";
      adminPaidAt = data.paidAt || null;
    }

    calculatedRewards = {
      balance: totalBal,
      counts, breakdown,
      paidAmount: adminPaidAmount,
      status: adminStatus,
      walletAddress: adminWallet,
      txHash: adminTxHash,
      paidAt: adminPaidAt
    };

    updateUI();

  } catch (err) {
    console.error("Calculation error:", err);
    showToast("Failed to load reward data. Please refresh.", "error");
  }
}

// ============================================================
// 🎨 UI RENDER
// ============================================================
function updateUI() {
  const status = getCampaignStatus();
  const startStr = CAMPAIGN.startDate.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  const endStr   = CAMPAIGN.endDate.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

  if (el.campaignTitle) el.campaignTitle.textContent = `🪔 ${CAMPAIGN.name.toUpperCase()} 🎆`;
  if (el.campaignDates) el.campaignDates.textContent = `${startStr} – ${endStr}`;
  
  if (el.campaignDuration) {
    const days = Math.floor((CAMPAIGN.endDate - CAMPAIGN.startDate) / 86400000) + 1;
    el.campaignDuration.textContent = `${days} Days Only`;
  }

  const badges = {
    UPCOMING: { cls: "upcoming", txt: `⏳ Upcoming — Starts ${startStr}` },
    ACTIVE:   { cls: "active",   txt: "🔥 ACTIVE — Earn Up To $250 per Eligible $1,000 Purchase!" },
    ENDED:    { cls: "ended",    txt: "🏁 Offer Ended — Withdrawal Available" }
  };
  const b = badges[status] || badges.UPCOMING;
  if (el.campaignStatusBadge) el.campaignStatusBadge.innerHTML = `<span class="campaign-status-badge ${b.cls}">${b.txt}</span>`;

  const balance    = Number(calculatedRewards.balance || 0);
  const paidAmount = Number(calculatedRewards.paidAmount || 0);
  const counts     = calculatedRewards.counts || {};
  const breakdown  = calculatedRewards.breakdown || {};
  const totalIds   = Object.values(counts).reduce((a, b) => a + Number(b || 0), 0);

  if (el.walletAmount) el.walletAmount.textContent = fmt(balance);
  if (el.statEligibleIds) el.statEligibleIds.textContent = totalIds;
  if (el.statEligibleReward) el.statEligibleReward.textContent = `$${fmt(balance)}`;
  if (el.statPaid) el.statPaid.textContent = `$${fmt(paidAmount)}`;

  const withdrawable = status === "ENDED" ? Math.max(0, balance - paidAmount) : 0;
  if (el.statWithdrawable) el.statWithdrawable.textContent = `$${fmt(withdrawable)}`;
  if (el.statWithdrawNote) {
    el.statWithdrawNote.textContent = status === "ENDED"
      ? (withdrawable > 0 ? "Ready to withdraw" : "Nothing to withdraw")
      : `Locked until ${endStr}`;
  }

  [50, 100, 200, 500, 1000].forEach(amt => {
    if ($(`bdCount${amt}`))  $(`bdCount${amt}`).textContent  = counts[amt] || 0;
    if ($(`bdReward${amt}`)) $(`bdReward${amt}`).textContent = (breakdown[amt] || 0).toLocaleString();
  });

  if (el.walletStatusText) {
    if (status === "UPCOMING") el.walletStatusText.textContent = `Campaign starts ${startStr}. Get ready to buy!`;
    else if (status === "ENDED") el.walletStatusText.textContent = balance > 0 ? `🏆 Final earnings locked! $${fmt(balance)} total.` : "Campaign ended — no rewards earned.";
    else if (balance === 0) el.walletStatusText.textContent = "Buy eligible packages to grow your Diwali reward balance!";
    else el.walletStatusText.textContent = `💰 $${fmt(balance)} earned so far. Keep buying!`;
  }
  if (el.finalBadge) el.finalBadge.style.display = status === "ENDED" && balance > 0 ? "inline-block" : "none";

  updateWithdrawalUI(balance, paidAmount, withdrawable, status, endStr);
}

function updateWithdrawalUI(balance, paid, withdrawable, status, endStr) {
  const withdrawalStatus = String(calculatedRewards.status || "").toLowerCase();
  const isWithdrawn = ["pending", "approved", "paid"].includes(withdrawalStatus);

  if (el.withdrawAmount) el.withdrawAmount.textContent = `$${fmt(withdrawable)} USDT`;
  
  if (el.withdrawalInfoBox) el.withdrawalInfoBox.classList.add("visible");
  
  if (el.withdrawalInfoText) {
    if (status === "UPCOMING") el.withdrawalInfoText.textContent = `📅 Campaign starts ${CAMPAIGN.startDate.toLocaleDateString()}. Withdrawals unlock after ${endStr}.`;
    else if (status === "ACTIVE") el.withdrawalInfoText.textContent = `🔒 Withdrawals locked while campaign is active. They open after ${endStr}.`;
    else if (status === "ENDED") {
      if (withdrawable > 0) el.withdrawalInfoText.textContent = `🎉 Offer ended! You can withdraw $${fmt(withdrawable)} USDT now.`;
      else if (balance > 0) el.withdrawalInfoText.textContent = `✅ All rewards already withdrawn.`;
      else el.withdrawalInfoText.textContent = `No Diwali rewards to withdraw.`;
    }
  }

  if (isWithdrawn) {
    if (el.withdrawBtn) {
      el.withdrawBtn.disabled = true;
      if (withdrawalStatus === "pending") el.withdrawBtn.innerHTML = `<i class="bi bi-clock me-2"></i>Pending Approval`;
      else if (withdrawalStatus === "approved") el.withdrawBtn.innerHTML = `<i class="bi bi-check-circle me-2"></i>Approved`;
      else if (withdrawalStatus === "paid") el.withdrawBtn.innerHTML = `<i class="bi bi-check-circle-fill me-2"></i>Paid ✓`;
    }
    if (el.withdrawalStatus) {
      el.withdrawalStatus.classList.add("visible");
      el.withdrawalStatus.className = `withdrawal-status visible ${withdrawalStatus}`;
      el.withdrawalStatus.textContent =
        withdrawalStatus === "pending"  ? "⏳ Your withdrawal request is pending admin approval." :
        withdrawalStatus === "approved" ? "✅ Your withdrawal has been approved and is being processed." :
        "✅ Payment has been sent to your wallet.";
    }
    if (withdrawalStatus === "paid" && el.withdrawalDetails) {
      el.withdrawalDetails.classList.add("visible");
      if (el.detailAmount) el.detailAmount.textContent = `$${fmt(calculatedRewards.paidAmount || balance)} USDT`;
      if (el.detailWallet) el.detailWallet.textContent = calculatedRewards.walletAddress || "---";
      if (el.detailPaidDate) el.detailPaidDate.textContent = calculatedRewards.paidAt ? new Date(calculatedRewards.paidAt).toLocaleString() : "---";
      if (el.detailTxHash) el.detailTxHash.textContent = calculatedRewards.txHash || "---";
    }
    if (el.walletFormGroup) el.walletFormGroup.style.display = "none";
    return;
  }

  if (status === "ENDED" && withdrawable > 0) {
    if (el.withdrawBtn) {
      el.withdrawBtn.disabled = false;
      el.withdrawBtn.innerHTML = `<i class="bi bi-arrow-up-right me-2"></i>Withdraw Diwali Reward`;
    }
    if (el.walletFormGroup) el.walletFormGroup.style.display = "block";
    if (el.withdrawalStatus) el.withdrawalStatus.classList.remove("visible");
    if (el.withdrawalDetails) el.withdrawalDetails.classList.remove("visible");
  } else {
    if (el.withdrawBtn) {
      el.withdrawBtn.disabled = true;
      el.withdrawBtn.innerHTML = status === "ENDED" ? `Nothing to Withdraw` : `🔒 Withdrawal Locked — Offer Active`;
    }
    if (el.walletFormGroup) el.walletFormGroup.style.display = "none";
  }
}

function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  const update = () => {
    const status = getCampaignStatus();
    if (status === "ENDED") {
      if (el.countdownWrapper) el.countdownWrapper.style.display = "none";
      if (el.campaignEndedMessage) el.campaignEndedMessage.style.display = "block";
      if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
      return;
    }
    const t = getTimeRemaining();
    if (el.countdownDays) el.countdownDays.textContent = String(t.days).padStart(2, "0");
    if (el.countdownHours) el.countdownHours.textContent = String(t.hours).padStart(2, "0");
    if (el.countdownMinutes) el.countdownMinutes.textContent = String(t.minutes).padStart(2, "0");
    if (el.countdownSeconds) el.countdownSeconds.textContent = String(t.seconds).padStart(2, "0");
  };
  update();
  countdownInterval = setInterval(update, 1000);
}

// ============================================================
// 🏦 WITHDRAWAL
// ============================================================
function validateWallet() {
  const val = el.walletAddressInput?.value.trim() || "";
  const msg = el.walletValidationMsg;
  if (!msg) return false;
  if (!val) {
    el.walletAddressInput.className = "form-control-custom";
    msg.className = "wallet-validation-msg";
    msg.textContent = "";
    return false;
  }
  if (validateBEP20Wallet(val)) {
    el.walletAddressInput.className = "form-control-custom valid";
    msg.className = "wallet-validation-msg valid";
    msg.textContent = "✅ Valid BEP-20 wallet";
    return true;
  }
  el.walletAddressInput.className = "form-control-custom error";
  msg.className = "wallet-validation-msg error";
  msg.textContent = "❌ Invalid BEP-20 wallet";
  return false;
}

function handleWithdrawClick() {
  const status = getCampaignStatus();
  if (status !== "ENDED") {
    const time = getTimeRemaining();
    if (el.popupRewardAmount) el.popupRewardAmount.textContent = fmt(calculatedRewards.balance);
    if (el.popupDaysRemaining) el.popupDaysRemaining.textContent = `${time.days} day${time.days === 1 ? "" : "s"}`;
    if (el.popupTitle) el.popupTitle.textContent = status === "UPCOMING" ? "Offer Not Started Yet" : "Withdrawal Locked — Offer Active";
    if (el.daysPopup) el.daysPopup.classList.add("visible");
    return;
  }
  
  const bal = Number(calculatedRewards.balance || 0);
  const paid = Number(calculatedRewards.paidAmount || 0);
  const avail = Math.max(0, bal - paid);
  if (avail <= 0) { showToast("Nothing to withdraw.", "warning"); return; }
  if (!validateWallet()) { showToast("Enter a valid BEP-20 wallet address.", "error"); return; }

  const addr = el.walletAddressInput.value.trim();
  if (el.confirmAmount) el.confirmAmount.textContent = `$${fmt(avail)} USDT`;
  if (el.confirmWallet) el.confirmWallet.textContent = addr;
  if (el.confirmationModal) el.confirmationModal.classList.add("visible");
}

function generateId(prefix) {
  return prefix + "_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6);
}

async function submitWithdrawal() {
  if (isProcessingWithdrawal) return;
  isProcessingWithdrawal = true;
  const origHTML = '<i class="bi bi-check-circle me-1"></i>Confirm Withdrawal';
  if (el.confirmSubmit) { el.confirmSubmit.disabled = true; el.confirmSubmit.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>Processing...`; }

  try {
    const addr = el.walletAddressInput?.value.trim() || "";
    if (!validateBEP20Wallet(addr)) { showToast("Invalid wallet.", "error"); return; }
    if (getCampaignStatus() !== "ENDED") { showToast("Offer still active.", "error"); return; }

    const bal = Number(calculatedRewards.balance || 0);
    const paid = Number(calculatedRewards.paidAmount || 0);
    const avail = Math.max(0, bal - paid);
    if (avail <= 0) { showToast("Nothing to withdraw.", "warning"); return; }

    const rewardsRoot = ref(db, `direct_diwali_offer/${CAMPAIGN.id}/rewards/${currentUserId}`);
    const withdrawalId = generateId("dw");
    const txId = generateId("tx");
    const timestamp = Date.now();

    const lockResult = await runTransaction(rewardsRoot, (current) => {
      if (!current) {
        return { status: "pending", walletAddress: addr, withdrawalId, transactionId: txId, requestedAmount: avail, requestedAt: timestamp, updatedAt: timestamp };
      }
      const cStatus = String(current.status || "").toLowerCase();
      if (["pending", "approved", "paid"].includes(cStatus)) return;

      return { ...current, status: "pending", walletAddress: addr, withdrawalId, transactionId: txId, requestedAmount: avail, requestedAt: timestamp, updatedAt: timestamp };
    });

    if (!lockResult.committed) { showToast("Withdrawal already submitted.", "warning"); return; }

    const date = new Date(timestamp).toISOString().split("T")[0];

    const adminData = {
      campaignName: CAMPAIGN.name, campaignId: CAMPAIGN.id, type: "diwali_offer_withdrawal",
      asset: "USDT", network: "BEP-20 / BNB Smart Chain", amount: avail, status: "pending",
      userId: currentUserId, username: currentUserData?.username || currentUserData?.name || currentUserId,
      walletAddress: addr, requestedAt: timestamp
    };
    const userTx = {
      type: "diwali_offer_withdrawal", subtype: `${CAMPAIGN.name} Withdrawal`,
      amount: avail, currency: "USDT", network: "BEP-20 / BNB Smart Chain",
      status: "pending", walletAddress: addr, withdrawalId, timestamp, date,
      description: `${CAMPAIGN.name} Withdrawal of $${avail} USDT (BEP-20)`, txId, txHash: null
    };
    const globalTx = { ...userTx, userId: currentUserId };

    await update(ref(db), {
      [`direct_diwali_offer/${CAMPAIGN.id}/withdrawals/${withdrawalId}`]: adminData,
      [`users/${currentUserId}/diwali_transactions/${txId}`]: userTx,
      [`direct_diwali_offer/${CAMPAIGN.id}/transactions/${txId}`]: globalTx
    });

    showToast("✅ Withdrawal request submitted. Awaiting admin approval.", "success");
    if (el.confirmationModal) el.confirmationModal.classList.remove("visible");
    if (el.walletAddressInput) el.walletAddressInput.value = "";
    
    calculatedRewards.status = "pending";
    updateUI();
  } catch (err) {
    console.error(err);
    showToast("❌ " + (err.message || "Withdrawal failed."), "error");
  } finally {
    isProcessingWithdrawal = false;
    if (el.confirmSubmit) { el.confirmSubmit.disabled = false; el.confirmSubmit.innerHTML = origHTML; }
  }
}

// ============================================================
// 🖱️ EVENT LISTENERS & BOOT
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
  try { await signOut(auth); window.location.href = "login.html"; } 
  catch (e) { showToast("Logout error", "error"); } 
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
  initCalculator();
  renderRewardsTable();
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
  currentUserId = user.uid;
  
  startCountdown();
  updateUI(); 
  setupListeners();
  
  await calculateUserRewards(user.uid);
  
  if (el.loadingOverlay) el.loadingOverlay.classList.add("hidden");
});
