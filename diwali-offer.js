// ============================================================
// DIWALI BUMPER OFFER 2026 — PRODUCTION SCRIPT
// ============================================================
// - Live Firebase (rwebsite-e031b)
// - Reads config from Firebase /settings/active_diwali_campaign
// - Auto-credits rewards on confirmed referral purchase
// - Atomic withdrawals via runTransaction (admin panel connected)
// - Duplicate block via creditedTx/{txId}
// - Backward compatible with existing user/auth structure
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import {
  getDatabase, ref, get, update, onValue, runTransaction, query,
  orderByChild, equalTo, serverTimestamp
} from "firebase/database";

// ============================================================
// 🔥 LIVE FIREBASE CONFIG (Production)
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
// 🎯 DYNAMIC CAMPAIGN CONFIG
// ============================================================
let CAMPAIGN = null;
let CAMPAIGN_LOADED = false;
let CAMPAIGN_ERROR = null;

// Live campaign ID (matches admin panel)
const LIVE_CAMPAIGN_ID = "diwali_2026";

// Fallback — only used if Firebase config is missing
const FALLBACK_CAMPAIGN = {
  campaignId: LIVE_CAMPAIGN_ID,
  campaignName: "Diwali Bumper Offer 2026",
  startDate: new Date("2026-11-02T00:00:00+05:30"),
  endDate:   new Date("2026-11-12T23:59:59+05:30"),
  rewards: { 50: 10, 100: 20, 200: 45, 500: 60, 1000: 250 },
  status: "active"
};

async function loadDynamicCampaign() {
  try {
    const activeIdSnap = await get(ref(db, "settings/active_diwali_campaign"));
    const activeId = activeIdSnap.val() || LIVE_CAMPAIGN_ID;

    const configSnap = await get(ref(db, `diwali_campaigns/${activeId}`));
    if (!configSnap.exists()) {
      console.warn("⚠️ Diwali campaign config not found, using fallback.");
      CAMPAIGN = { ...FALLBACK_CAMPAIGN, campaignId: activeId };
      CAMPAIGN_LOADED = true;
      return { success: true, isFallback: true };
    }

    const cfg = configSnap.val();
    if (!cfg.startAt || !cfg.endAt || !cfg.rewards) {
      throw new Error("Invalid Diwali campaign config: missing required fields.");
    }

    CAMPAIGN = {
      campaignId: activeId,
      campaignName: cfg.campaignName || "Diwali Bumper Offer 2026",
      startDate: new Date(cfg.startAt),
      endDate:   new Date(cfg.endAt),
      rewards: {
        50:   Number(cfg.rewards["50"]   || cfg.rewards[50]   || 10),
        100:  Number(cfg.rewards["100"]  || cfg.rewards[100]  || 20),
        200:  Number(cfg.rewards["200"]  || cfg.rewards[200]  || 45),
        500:  Number(cfg.rewards["500"]  || cfg.rewards[500]  || 60),
        1000: Number(cfg.rewards["1000"] || cfg.rewards[1000] || 250)
      },
      status: cfg.status || "active"
    };
    CAMPAIGN_LOADED = true;
    return { success: true, isFallback: false };
  } catch (err) {
    console.error("❌ Failed to load Diwali campaign config:", err);
    CAMPAIGN = { ...FALLBACK_CAMPAIGN };
    CAMPAIGN_LOADED = true;
    CAMPAIGN_ERROR = err.message;
    return { success: false, error: err.message };
  }
}

// ============================================================
// DOM REFS
// ============================================================
const $ = id => document.getElementById(id);
const el = {
  loadingOverlay: $("loadingOverlay"),
  toastContainer: $("toastContainer"),
  userAvatar: $("userAvatar"), userName: $("userName"), logoutBtn: $("logoutBtn"),
  campaignTitle: $("campaignTitle"),
  campaignDates: $("campaignDates"), campaignDuration: $("campaignDuration"),
  campaignStatusBadge: $("campaignStatusBadge"),
  countdownDays: $("countdownDays"), countdownHours: $("countdownHours"),
  countdownMinutes: $("countdownMinutes"), countdownSeconds: $("countdownSeconds"),
  countdownWrapper: $("countdownWrapper"), campaignEndedMessage: $("campaignEndedMessage"),
  rewardWalletCard: $("rewardWalletCard"),
  walletLabel: $("walletLabel"), walletAmount: $("walletAmount"),
  walletStatusText: $("walletStatusText"), finalBadge: $("finalBadge"),
  statEligibleIds: $("statEligibleIds"), statEligibleReward: $("statEligibleReward"),
  statRewardNote: $("statRewardNote"),
  statWithdrawable: $("statWithdrawable"), statWithdrawNote: $("statWithdrawNote"),
  statPaid: $("statPaid"),
  bdCount50: $("bdCount50"), bdCount100: $("bdCount100"),
  bdCount200: $("bdCount200"), bdCount500: $("bdCount500"), bdCount1000: $("bdCount1000"),
  bdReward50: $("bdReward50"), bdReward100: $("bdReward100"),
  bdReward200: $("bdReward200"), bdReward500: $("bdReward500"), bdReward1000: $("bdReward1000"),
  referralLinkDisplay: $("referralLinkDisplay"),
  referralCodeDisplay: $("referralCodeDisplay"),
  copyReferralBtn: $("copyReferralBtn"),
  withdrawalSection: $("withdrawalSection"),
  withdrawalSubtitle: $("withdrawalSubtitle"),
  withdrawAmount: $("withdrawAmount"),
  withdrawalInfoBox: $("withdrawalInfoBox"),
  withdrawalInfoText: $("withdrawalInfoText"),
  withdrawalDetails: $("withdrawalDetails"),
  detailAmount: $("detailAmount"), detailWallet: $("detailWallet"),
  detailPaidDate: $("detailPaidDate"), detailTxHash: $("detailTxHash"),
  walletFormGroup: $("walletFormGroup"),
  walletAddressInput: $("walletAddressInput"),
  walletValidationMsg: $("walletValidationMsg"),
  withdrawBtn: $("withdrawBtn"),
  withdrawalStatus: $("withdrawalStatus"),
  daysPopup: $("daysPopup"), popupIcon: $("popupIcon"), popupTitle: $("popupTitle"),
  popupText: $("popupText"),
  popupRewardAmount: $("popupRewardAmount"),
  popupDaysRemaining: $("popupDaysRemaining"),
  popupCloseBtn: $("popupCloseBtn"),
  confirmationModal: $("confirmationModal"),
  confirmAmount: $("confirmAmount"),
  confirmWallet: $("confirmWallet"),
  confirmCancel: $("confirmCancel"),
  confirmSubmit: $("confirmSubmit")
};

// ============================================================
// STATE
// ============================================================
let currentUserId = null;
let currentUserData = null;
let userDiwaliRewards = null;         // { balance, counts, breakdown, status, paidAmount, ... }
let countdownInterval = null;
let firebaseServerOffset = 0;
let serverTimeUnsub = null;
let rewardsUnsub = null;
let referralUnsub = null;
let isProcessingWithdrawal = false;
let listenersInitialized = false;

// ============================================================
// UTILS
// ============================================================
function getCampaignNow() { return new Date(Date.now() + firebaseServerOffset); }

function syncFirebaseServerTime() {
  if (serverTimeUnsub) { try { serverTimeUnsub(); } catch (e) {} }
  try {
    serverTimeUnsub = onValue(ref(db, ".info/serverTimeOffset"), (snap) => {
      const offset = Number(snap.val() || 0);
      firebaseServerOffset = Number.isFinite(offset) ? offset : 0;
      if (CAMPAIGN_LOADED) updateUI();
    }, () => { firebaseServerOffset = 0; });
  } catch (e) { firebaseServerOffset = 0; }
}

function getCampaignStatus() {
  if (!CAMPAIGN) return "NOT_LOADED";
  const now = getCampaignNow().getTime();
  const start = CAMPAIGN.startDate.getTime();
  const end = CAMPAIGN.endDate.getTime();
  const cfgStatus = String(CAMPAIGN.status || "").toLowerCase();
  if (cfgStatus === "inactive" || cfgStatus === "paused") {
    return now > end ? "ENDED" : "UPCOMING";
  }
  if (now < start) return "UPCOMING";
  if (now <= end) return "ACTIVE";
  return "ENDED";
}

function getTimeRemaining() {
  if (!CAMPAIGN) return { days: 0, hours: 0, minutes: 0, seconds: 0 };
  const now = getCampaignNow();
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

function fmt(n) {
  return Number(n || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
}

function validateBEP20Wallet(address) {
  return typeof address === "string" && /^0x[a-fA-F0-9]{40}$/.test(address.trim());
}

function showToast(message, type = "success") {
  const container = el.toastContainer;
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast-custom ${type}`;
  const iconMap = {
    success: "bi-check-circle-fill",
    error:   "bi-exclamation-triangle-fill",
    warning: "bi-exclamation-triangle-fill",
    info:    "bi-info-circle-fill"
  };
  toast.innerHTML = `<i class="bi ${iconMap[type] || iconMap.success}"></i><span class="toast-msg">${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(100%)";
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

// ============================================================
// 🧮 CALCULATOR
// ============================================================
function initCalculator() {
  const inputs = [50, 100, 200, 500, 1000];
  const recalc = () => {
    if (!CAMPAIGN) return;
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
// 🎁 REWARD CREDITING (exposed global — used by main script.js)
// ============================================================
/**
 * Credit a Diwali reward for a confirmed referral purchase.
 * Call this from your main purchase-confirmation logic:
 *
 *   window.creditDiwaliReward({
 *     referrerUid: "<uid>",
 *     txId: "<unique-tx-id>",
 *     packageAmount: 50|100|200|500|1000,
 *     purchaserUid: "<uid>"
 *   });
 */
window.creditDiwaliReward = async function ({
  referrerUid, txId, packageAmount, purchaserUid
}) {
  try {
    if (!CAMPAIGN) return { ok: false, reason: "no_campaign" };
    const amt = Number(packageAmount);
    const rewardAmt = CAMPAIGN.rewards[amt];
    if (!rewardAmt) return { ok: false, reason: "invalid_amount" };
    if (getCampaignNow().getTime() > CAMPAIGN.endDate.getTime()) {
      return { ok: false, reason: "campaign_ended" };
    }
    if (!referrerUid || !txId) return { ok: false, reason: "missing_fields" };

    const rewardsRoot = ref(db, `diwali_rewards/${CAMPAIGN.campaignId}/${referrerUid}`);
    const dupRef = ref(db, `diwali_rewards/${CAMPAIGN.campaignId}/${referrerUid}/creditedTx/${txId}`);
    const dup = await get(dupRef);
    if (dup.exists()) return { ok: false, reason: "duplicate" };

    const timestamp = Date.now();
    let committed = false;
    const result = await runTransaction(rewardsRoot, (current) => {
      const cur = current || {
        balance: 0, counts: {}, breakdown: {},
        creditedTx: {}, createdAt: timestamp
      };
      const counts    = { ...(cur.counts    || {}) };
      const breakdown = { ...(cur.breakdown || {}) };
      const creditedTx = { ...(cur.creditedTx || {}) };

      if (creditedTx[txId]) return cur; // already exists — abort

      counts[amt]    = (counts[amt]    || 0) + 1;
      breakdown[amt] = (breakdown[amt] || 0) + rewardAmt;
      creditedTx[txId] = {
        packageAmount: amt, reward: rewardAmt,
        purchaserUid: purchaserUid || null, creditedAt: timestamp
      };

      return {
        ...cur,
        balance: (cur.balance || 0) + rewardAmt,
        counts, breakdown, creditedTx,
        lastCreditAt: timestamp,
        updatedAt: timestamp
      };
    });

    committed = result.committed;
    if (!committed) return { ok: false, reason: "transaction_aborted" };

    // If the credit was for the current user, UI updates via listener
    return { ok: true, reward: rewardAmt };
  } catch (err) {
    console.error("creditDiwaliReward error:", err);
    return { ok: false, reason: "error", error: err.message };
  }
};

// ============================================================
// 📡 LISTENERS
// ============================================================
function attachRewardsListener(uid) {
  if (rewardsUnsub) { rewardsUnsub(); rewardsUnsub = null; }
  rewardsUnsub = onValue(
    ref(db, `diwali_rewards/${CAMPAIGN.campaignId}/${uid}`),
    (snap) => {
      userDiwaliRewards = snap.exists() ? snap.val() : null;
      updateUI();
    },
    () => { userDiwaliRewards = null; updateUI(); }
  );
}

function attachReferralListener(uid) {
  if (referralUnsub) { referralUnsub(); referralUnsub = null; }
  // Listen to user's transactions where referrerId == uid
  const q = query(
    ref(db, "transactions"),
    orderByChild("referrerId"),
    equalTo(uid)
  );
  referralUnsub = onValue(q, () => updateUI(), () => {});
}

// ============================================================
// 🎨 UI RENDER
// ============================================================
function updateUI() {
  if (!CAMPAIGN_LOADED || !CAMPAIGN) return;
  const status = getCampaignStatus();
  const startStr = CAMPAIGN.startDate.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  const endStr   = CAMPAIGN.endDate.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

  // Campaign meta
  if (el.campaignTitle) el.campaignTitle.textContent = `🪔 ${CAMPAIGN.campaignName.toUpperCase()} 🎆`;
  if (el.campaignDates) el.campaignDates.textContent = `${startStr} – ${endStr}`;
  if (el.campaignDuration) {
    const days = Math.round((CAMPAIGN.endDate - CAMPAIGN.startDate) / 86400000);
    el.campaignDuration.textContent = `${days} Days Only`;
  }

  // Rewards table (dynamic, fallback safe)
  renderRewardsTable();

  // Badge
  const badges = {
    UPCOMING: { cls: "upcoming", txt: `⏳ Upcoming — Starts ${startStr}` },
    ACTIVE:   { cls: "active",   txt: `🔥 ACTIVE — Earn Up To $250 per ID!` },
    ENDED:    { cls: "ended",    txt: "🏁 Offer Ended — Withdrawal Available" }
  };
  const b = badges[status] || badges.UPCOMING;
  if (el.campaignStatusBadge) {
    el.campaignStatusBadge.innerHTML = `<span class="campaign-status-badge ${b.cls}">${b.txt}</span>`;
  }

  // Wallet
  const balance    = Number(userDiwaliRewards?.balance    || 0);
  const paidAmount = Number(userDiwaliRewards?.paidAmount || 0);
  const counts     = userDiwaliRewards?.counts    || {};
  const breakdown  = userDiwaliRewards?.breakdown || {};
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

  // Breakdown cards
  [50, 100, 200, 500, 1000].forEach(amt => {
    if ($(`bdCount${amt}`))  $(`bdCount${amt}`).textContent  = counts[amt] || 0;
    if ($(`bdReward${amt}`)) $(`bdReward${amt}`).textContent = (breakdown[amt] || 0).toLocaleString();
  });

  // Wallet status text
  if (el.walletStatusText) {
    if (status === "UPCOMING") el.walletStatusText.textContent = `Campaign starts ${startStr}. Get ready to refer!`;
    else if (status === "ENDED") el.walletStatusText.textContent = balance > 0 ? `🏆 Final earnings locked! $${fmt(balance)} total.` : "Campaign ended — no rewards earned.";
    else if (balance === 0) el.walletStatusText.textContent = "Refer eligible IDs to grow your Diwali reward balance!";
    else el.walletStatusText.textContent = `💰 $${fmt(balance)} earned so far. Keep referring!`;
  }
  if (el.finalBadge) el.finalBadge.style.display = status === "ENDED" && balance > 0 ? "inline-block" : "none";

  // Withdrawal UI
  updateWithdrawalUI(balance, paidAmount, withdrawable, status, endStr);
}

function renderRewardsTable() {
  if (!CAMPAIGN) return;
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

function updateWithdrawalUI(balance, paid, withdrawable, status, endStr) {
  const withdrawalStatus = String(userDiwaliRewards?.status || "").toLowerCase();
  const isWithdrawn = ["pending", "approved", "paid"].includes(withdrawalStatus);

  // Amount display
  if (el.withdrawAmount) el.withdrawAmount.textContent = `$${fmt(balance)} USDT`;

  // Withdrawal info box
  if (el.withdrawalInfoBox) el.withdrawalInfoBox.classList.add("visible");
  if (el.withdrawalInfoText) {
    if (status === "UPCOMING") {
      el.withdrawalInfoText.textContent = `📅 Campaign starts ${CAMPAIGN.startDate.toLocaleDateString()}. Withdrawals unlock after ${endStr}.`;
    } else if (status === "ACTIVE") {
      el.withdrawalInfoText.textContent = `🔒 Withdrawals locked while campaign is active. They open after ${endStr}.`;
    } else if (status === "ENDED") {
      if (withdrawable > 0) el.withdrawalInfoText.textContent = `🎉 Offer ended! You can withdraw $${fmt(withdrawable)} USDT now.`;
      else if (balance > 0) el.withdrawalInfoText.textContent = `✅ All rewards already withdrawn.`;
      else el.withdrawalInfoText.textContent = `No Diwali rewards to withdraw.`;
    }
  }

  // Status-specific button handling
  if (isWithdrawn) {
    if (el.withdrawBtn) {
      el.withdrawBtn.disabled = true;
      if (withdrawalStatus === "pending") {
        el.withdrawBtn.innerHTML = `<i class="bi bi-clock me-2"></i>Pending Approval`;
      } else if (withdrawalStatus === "approved") {
        el.withdrawBtn.innerHTML = `<i class="bi bi-check-circle me-2"></i>Approved`;
      } else if (withdrawalStatus === "paid") {
        el.withdrawBtn.innerHTML = `<i class="bi bi-check-circle-fill me-2"></i>Paid ✓`;
      }
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
      if (el.detailAmount) el.detailAmount.textContent = `$${fmt(userDiwaliRewards?.paidAmount || balance)} USDT`;
      if (el.detailWallet) el.detailWallet.textContent = userDiwaliRewards?.paidWallet || userDiwaliRewards?.walletAddress || "---";
      if (el.detailPaidDate) el.detailPaidDate.textContent = userDiwaliRewards?.paidAt
        ? new Date(userDiwaliRewards.paidAt).toLocaleString() : "---";
      if (el.detailTxHash) el.detailTxHash.textContent = userDiwaliRewards?.txHash || "---";
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
      el.withdrawBtn.innerHTML = status === "ENDED"
        ? `Nothing to Withdraw`
        : `🔒 Withdrawal Locked — Offer Active`;
    }
    if (el.walletFormGroup) el.walletFormGroup.style.display = "none";
  }
}

// ============================================================
// 🕒 COUNTDOWN
// ============================================================
function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  const update = () => {
    if (!CAMPAIGN) return;
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
  if (!CAMPAIGN) return;
  const status = getCampaignStatus();
  if (status !== "ENDED") {
    // Show days-remaining popup
    const balance = Number(userDiwaliRewards?.balance || 0);
    const time = getTimeRemaining();
    if (el.popupRewardAmount) el.popupRewardAmount.textContent = fmt(balance);
    if (el.popupDaysRemaining) {
      el.popupDaysRemaining.textContent = status === "UPCOMING"
        ? `${time.days}d ${time.hours}h`
        : `${time.days} day${time.days === 1 ? "" : "s"}`;
    }
    if (el.popupTitle) {
      el.popupTitle.textContent = status === "UPCOMING"
        ? "Offer Not Started Yet"
        : "Withdrawal Locked — Offer Active";
    }
    if (el.daysPopup) el.daysPopup.classList.add("visible");
    return;
  }
  const bal = Number(userDiwaliRewards?.balance || 0);
  const paid = Number(userDiwaliRewards?.paidAmount || 0);
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
  if (el.confirmSubmit) {
    el.confirmSubmit.disabled = true;
    el.confirmSubmit.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>Processing...`;
  }

  try {
    const addr = el.walletAddressInput?.value.trim() || "";
    if (!validateBEP20Wallet(addr)) { showToast("Invalid wallet.", "error"); return; }
    if (getCampaignStatus() !== "ENDED") { showToast("Offer still active.", "error"); return; }

    const bal = Number(userDiwaliRewards?.balance || 0);
    const paid = Number(userDiwaliRewards?.paidAmount || 0);
    const avail = Math.max(0, bal - paid);
    if (avail <= 0) { showToast("Nothing to withdraw.", "warning"); return; }

    // Atomic lock on diwali_rewards/{campaignId}/{uid}
    const rewardsRoot = ref(db, `diwali_rewards/${CAMPAIGN.campaignId}/${currentUserId}`);
    const withdrawalId = generateId("dw");
    const txId = generateId("tx");
    const timestamp = Date.now();

    const lockResult = await runTransaction(rewardsRoot, (current) => {
      if (!current) return current;
      const cBal = Number(current.balance || 0);
      const cPaid = Number(current.paidAmount || 0);
      const cAvail = Math.max(0, cBal - cPaid);
      if (cAvail <= 0) return; // abort
      const cStatus = String(current.status || "").toLowerCase();
      if (["pending", "approved", "paid"].includes(cStatus)) return; // abort — already in progress

      return {
        ...current,
        status: "pending",
        walletAddress: addr,
        withdrawalId,
        transactionId: txId,
        requestedAmount: cAvail,
        requestedAt: timestamp,
        updatedAt: timestamp
      };
    });

    if (!lockResult.committed) {
      showToast("Withdrawal already submitted or nothing to withdraw.", "warning");
      return;
    }

    const locked = lockResult.snapshot.val();
    const finalAmt = Number(locked?.requestedAmount || avail);
    const date = new Date(timestamp).toISOString().split("T")[0];
    const campaignName = CAMPAIGN.campaignName;

    // Write to admin panel + user transactions + global transactions
    const adminData = {
      ...locked,
      campaignName, campaignId: CAMPAIGN.campaignId,
      type: "diwali_offer_withdrawal",
      asset: "USDT",
      network: "BEP-20 / BNB Smart Chain",
      amount: finalAmt,
      status: "pending",
      userId: currentUserId,
      username: currentUserData?.username || currentUserData?.name || currentUserId
    };
    const userTx = {
      type: "diwali_offer_withdrawal",
      subtype: `${campaignName} Withdrawal`,
      amount: finalAmt, currency: "USDT",
      network: "BEP-20 / BNB Smart Chain",
      status: "pending",
      walletAddress: addr,
      withdrawalId, timestamp, date,
      description: `${campaignName} Withdrawal of $${finalAmt} USDT (BEP-20)`,
      txId, txHash: null
    };
    const globalTx = { ...userTx, userId: currentUserId };

    await update(ref(db), {
      [`admin/withdrawals/${withdrawalId}`]: adminData,
      [`users/${currentUserId}/transactions/${txId}`]: userTx,
      [`transactions/${txId}`]: globalTx
    });

    showToast("✅ Withdrawal request submitted. Awaiting admin approval.", "success");
    if (el.confirmationModal) el.confirmationModal.classList.remove("visible");
    if (el.walletAddressInput) el.walletAddressInput.value = "";
    if (el.walletValidationMsg) { el.walletValidationMsg.textContent = ""; el.walletValidationMsg.className = "wallet-validation-msg"; }
  } catch (err) {
    console.error(err);
    showToast("❌ " + (err.message || "Withdrawal failed."), "error");
  } finally {
    isProcessingWithdrawal = false;
    if (el.confirmSubmit) {
      el.confirmSubmit.disabled = false;
      el.confirmSubmit.innerHTML = origHTML;
    }
  }
}

// ============================================================
// 👤 USER LOAD
// ============================================================
async function loadUserData(user) {
  try {
    if (!user || !user.uid) { showToast("Session error.", "error"); return; }
    currentUserId = user.uid;

    const snap = await get(ref(db, "users/" + user.uid));
    if (!snap.exists()) { showToast("Complete registration.", "error"); return; }
    currentUserData = snap.val();

    const name = currentUserData.name || currentUserData.username || "User";
    if (el.userName) el.userName.textContent = name;
    if (el.userAvatar) el.userAvatar.textContent = name.charAt(0).toUpperCase();

    const refCode = currentUserData.referralCode || user.uid.substring(0, 8).toUpperCase();
    if (el.referralCodeDisplay) el.referralCodeDisplay.textContent = refCode;
    if (el.referralLinkDisplay) {
      el.referralLinkDisplay.textContent = `https://staking.randigital.in/register.html?ref=${refCode}`;
    }

    attachRewardsListener(user.uid);
    attachReferralListener(user.uid);
    startCountdown();
    updateUI();

    // Greeting
    const status = getCampaignStatus();
    if (status === "UPCOMING") showToast(`📢 Campaign starts ${CAMPAIGN.startDate.toLocaleDateString()}!`, "warning");
    else if (status === "ACTIVE") showToast(`🎯 ACTIVE! Earn up to $250 per qualified ID!`, "success");
    else if (status === "ENDED") showToast(`🏁 Campaign ended — withdrawals available.`, "info");
  } catch (e) {
    console.error(e);
    showToast("Error loading user data: " + (e.message || "Unknown"), "error");
  } finally {
    if (el.loadingOverlay) el.loadingOverlay.classList.add("hidden");
  }
}

// ============================================================
// 🖱️ EVENT LISTENERS
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
      setTimeout(() => {
        el.copyReferralBtn.classList.remove("copied");
        el.copyReferralBtn.innerHTML = `<i class="bi bi-clipboard me-1"></i>Copy`;
      }, 3000);
    }
  } catch {
    showToast("Copy failed — please copy manually.", "error");
  }
}

async function handleLogout() {
  try {
    await signOut(auth);
    window.location.href = "login.html";
  } catch (e) {
    showToast("Logout error", "error");
  }
}

function setupListeners() {
  if (listenersInitialized) return;
  listenersInitialized = true;

  el.copyReferralBtn?.addEventListener("click", copyReferralLink);
  el.logoutBtn?.addEventListener("click", handleLogout);
  el.withdrawBtn?.addEventListener("click", handleWithdrawClick);
  el.walletAddressInput?.addEventListener("input", validateWallet);

  el.popupCloseBtn?.addEventListener("click", () => el.daysPopup?.classList.remove("visible"));
  el.daysPopup?.addEventListener("click", (e) => {
    if (e.target === el.daysPopup) el.daysPopup.classList.remove("visible");
  });

  el.confirmCancel?.addEventListener("click", () => el.confirmationModal?.classList.remove("visible"));
  el.confirmationModal?.addEventListener("click", (e) => {
    if (e.target === el.confirmationModal) el.confirmationModal.classList.remove("visible");
  });
  el.confirmSubmit?.addEventListener("click", submitWithdrawal);

  initCalculator();
}

// ============================================================
// 🚀 BOOT
// ============================================================
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

  const res = await loadDynamicCampaign();
  if (!res.success) showToast("⚠️ Campaign config fallback applied.", "warning");

  syncFirebaseServerTime();
  await loadUserData(user);
  setupListeners();
});

// Cleanup
window.addEventListener("beforeunload", () => {
  if (countdownInterval) clearInterval(countdownInterval);
  try { rewardsUnsub?.(); } catch (e) {}
  try { referralUnsub?.(); } catch (e) {}
  try { serverTimeUnsub?.(); } catch (e) {}
});