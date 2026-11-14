// ============================================================
// BUMPER REFERRAL OFFER 2026
// File: direct-offer.js
// ============================================================
// 🧪 TESTING MODE ACTIVE (dates: today → 30 Nov 2026)
// 🔁 LIVE करने के लिए सिर्फ नीचे CAMPAIGN में 2 lines बदलें
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
// 🎯 CAMPAIGN CONFIG
// ============================================================
// 🧪 अभी TESTING MODE चालू है (आज से 30 Nov तक)
// ============================================================
const CAMPAIGN = {
  id: "bumper_referral_offer_2026",
  name: "Bumper Referral Offer 2026",

  // 🧪 TESTING DATES (आज से चालू)
  startDate: new Date("2026-11-12T00:00:00+05:30"),
  endDate:   new Date("2026-11-30T23:59:59.999+05:30"),

  // Reward tiers (range-based) - UPDATED REWARDS
  tiers: [
    { min: 50,   max: 100,      reward: 10,  key: "50",   label: "$50 – $99"     },
    { min: 100,  max: 200,      reward: 20,  key: "100",  label: "$100 – $199"   },
    { min: 200,  max: 500,      reward: 40,  key: "200",  label: "$200 – $499"   },
    { min: 500,  max: 1000,     reward: 80,  key: "500",  label: "$500 – $999"   },
    { min: 1000, max: Infinity, reward: 200, key: "1000", label: "$1,000+"       }
  ]
};

// 🔎 Find reward tier for a purchase amount
function getTierForAmount(amount) {
  const amt = Number(amount || 0);
  if (!amt || amt < CAMPAIGN.tiers[0].min) return null;
  for (const t of CAMPAIGN.tiers) {
    if (amt >= t.min && amt < t.max) return t;
  }
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
  confirmSubmit: $("confirmSubmit"),
  rewardsTableBody: $("rewardsTableBody")
};

let currentUserId = null;
let currentUserData = null;
let calculatedRewards = {
  totalEarned: 0, paidAmount: 0, pendingAmount: 0, withdrawable: 0,
  counts: {}, breakdown: {}, currentStatus: "available", currentWithdrawal: null
};
let countdownInterval = null;
let isProcessingWithdrawal = false;
let isSyncing = false;
let syncInterval = null;
let withdrawalAmountInput = null;

// ============================================================
// UTILS
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

// ============================================================
// ⏱️ COUNTDOWN
// ============================================================
function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);

  const update = () => {
    const now = getNow().getTime();
    const start = CAMPAIGN.startDate.getTime();
    const end = CAMPAIGN.endDate.getTime();

    if (now > end) {
      if (el.countdownWrapper) el.countdownWrapper.style.display = "none";
      if (el.campaignEndedMessage) el.campaignEndedMessage.style.display = "block";
      if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
      return;
    }

    const targetTime = now < start ? start : end;
    const diff = targetTime - now;

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);

    if (el.countdownDays) el.countdownDays.textContent = String(days).padStart(2, "0");
    if (el.countdownHours) el.countdownHours.textContent = String(hours).padStart(2, "0");
    if (el.countdownMinutes) el.countdownMinutes.textContent = String(minutes).padStart(2, "0");
    if (el.countdownSeconds) el.countdownSeconds.textContent = String(seconds).padStart(2, "0");
  };

  update();
  countdownInterval = setInterval(update, 1000);
}

// ============================================================
// 📋 RENDER REWARD TABLE
// ============================================================
function renderRewardsTable() {
  if (!el.rewardsTableBody) return;
  el.rewardsTableBody.innerHTML = CAMPAIGN.tiers.map((t, i) => {
    const isLast = i === CAMPAIGN.tiers.length - 1;
    return `
      <tr class="${isLast ? "highlight-row" : ""}">
        <td><strong>${t.label}</strong></td>
        <td><span class="gold-text ${isLast ? "big" : ""}">$${t.reward}</span>${isLast ? '<span class="star">★</span>' : ''}</td>
      </tr>
    `;
  }).join("");
}

// ============================================================
// 🔥 WITHDRAWAL AMOUNT INPUT INJECTION
// ============================================================
function injectWithdrawalInput() {
  if (!document.getElementById('withdrawAmountInput')) {
    const formGroup = el.walletFormGroup;
    if (formGroup) {
      const amountDiv = document.createElement('div');
      amountDiv.className = 'form-group mt-3';
      amountDiv.innerHTML = `
        <label><i class="bi bi-cash me-1"></i> Withdrawal Amount (USDT)</label>
        <input type="number" id="withdrawAmountInput" class="form-control-custom" placeholder="Enter amount" min="1" step="0.01"/>
        <div id="amountValidationMsg" class="wallet-validation-msg"></div>
      `;
      formGroup.parentNode.insertBefore(amountDiv, formGroup);
      withdrawalAmountInput = document.getElementById('withdrawAmountInput');
    }
  }
}

// ============================================================
// 🔥 SYNC FUNCTION — Perfect Balance, Paid & Pending Logic
// ============================================================
async function syncOfferData(uid) {
  if (isSyncing) return;
  isSyncing = true;

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

    // -------- 1. Fetch all users --------
    const usersSnap = await get(ref(db, "users"));
    const allUsers = usersSnap.val() || {};
    const referredUsers = new Set();

    for (const [uId, uData] of Object.entries(allUsers)) {
      if (uId === uid) continue;
      const referredBy = uData.referredBy || uData.referredByUid || uData.sponsorUid || uData.referrerUid || uData.referrer;
      if (String(referredBy) === String(refCode) || String(referredBy) === String(uid)) {
        referredUsers.add(uId);
      }
    }

    // -------- 2. Fetch existing offer data --------
    const offerSnap = await get(ref(db, CAMPAIGN.id));
    const offerData = offerSnap.val() || {};
    const existingPurchases = offerData.purchases || {};
    const userWithdrawals = offerData.withdrawals || {};

    const counts = {}; const breakdown = {};
    CAMPAIGN.tiers.forEach(t => { counts[t.key] = 0; breakdown[t.key] = 0; });

    let totalEarned = 0;
    const updates = {};

    // -------- 3. Calculate Total Earned (range-based tiering) --------
    for (const [refUserUid, refUserData] of Object.entries(allUsers)) {
      if (!referredUsers.has(refUserUid)) continue;

      const packages = refUserData.packages || {};

      for (const [pkgId, pkg] of Object.entries(packages)) {
        if (pkg.status !== "active" && pkg.status !== "completed") continue;

        const amt = Number(pkg.usdtAmount || 0);
        const tier = getTierForAmount(amt);
        if (!tier) continue;

        const purchaseTime = pkg.purchaseDate || pkg.timestamp || 0;
        if (purchaseTime < CAMPAIGN.startDate.getTime()) continue;
        if (purchaseTime > CAMPAIGN.endDate.getTime()) continue;

        const rewardAmt = tier.reward;
        const purchaseId = `${refUserUid}_${pkgId}`;

        if (!existingPurchases[purchaseId]) {
          updates[`purchases/${purchaseId}`] = {
            purchaseId,
            buyerUid: refUserUid,
            directReferrerUid: uid,
            packageAmount: amt,
            tierKey: tier.key,
            rewardAmount: rewardAmt,
            status: "completed",
            timestamp: purchaseTime,
            campaignId: CAMPAIGN.id
          };

          updates[`user_claims/${uid}/${purchaseId}`] = {
            purchaseId,
            amount: amt,
            tierKey: tier.key,
            reward: rewardAmt,
            claimedAt: Date.now()
          };
        }

        counts[tier.key]++;
        breakdown[tier.key] += rewardAmt;
        totalEarned += rewardAmt;
      }
    }

    if (Object.keys(updates).length > 0) {
      await update(ref(db, CAMPAIGN.id), updates);
      console.log("🔥 New offer data synced!");
    }

    // -------- 4. Calculate Paid & Pending (✅ FIXED) --------
    // paid       → Already Paid
    // pending / approved → Pending
    // rejected   → कुछ नहीं (balance वापस withdrawable में)
    let latestWithdrawal = null;
    let totalPaid = 0;
    let totalPending = 0;

    for (const [wId, w] of Object.entries(userWithdrawals)) {
      if (w.userId !== uid) continue;

      const amt = Number(w.amount || 0);

      if (w.status === 'paid') {
        totalPaid += amt;
      } else if (w.status === 'pending' || w.status === 'approved') {
        totalPending += amt;
      }

      // Latest withdrawal = जो सबसे हाल में request हुई (status बताने के लिए)
      if (!latestWithdrawal || (w.requestedAt || 0) > (latestWithdrawal.requestedAt || 0)) {
        latestWithdrawal = w;
      }
    }

    // -------- 5. Final Withdrawable --------
    const actualWithdrawable = Math.max(0, totalEarned - totalPaid - totalPending);

    calculatedRewards = {
      totalEarned,
      paidAmount: totalPaid,
      pendingAmount: totalPending,
      withdrawable: actualWithdrawable,
      counts, breakdown,
      currentStatus: latestWithdrawal ? latestWithdrawal.status : "available",
      currentWithdrawal: latestWithdrawal
    };

    updateUI();
  } catch (err) {
    console.error("Sync error:", err);
  } finally {
    isSyncing = false;
  }
}

function startAutoSync(uid) {
  if (syncInterval) clearInterval(syncInterval);
  syncOfferData(uid);
  syncInterval = setInterval(() => syncOfferData(uid), 2000);
}

function stopAutoSync() {
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
}

// ============================================================
// 🎨 UI RENDER
// ============================================================
function updateUI() {
  const status = getCampaignStatus();

  const startStr = CAMPAIGN.startDate.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  const endStr   = CAMPAIGN.endDate.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  if (el.campaignDates) el.campaignDates.textContent = `${startStr} – ${endStr}`;

  // Dynamic duration pill
  const totalDays = Math.max(1, Math.round((CAMPAIGN.endDate - CAMPAIGN.startDate) / (1000 * 60 * 60 * 24)));
  if (el.campaignDuration) el.campaignDuration.textContent = `${totalDays} Days Only`;

  const badges = {
    UPCOMING: { cls: "upcoming", txt: `⏳ Upcoming` },
    ACTIVE:   { cls: "active",   txt: "🔥 ACTIVE" },
    ENDED:    { cls: "ended",    txt: "🏁 ENDED" }
  };
  if (el.campaignStatusBadge) el.campaignStatusBadge.innerHTML = `<span class="campaign-status-badge ${badges[status].cls}">${badges[status].txt}</span>`;

  const totalEarned = Number(calculatedRewards.totalEarned || 0);
  const totalPaid = Number(calculatedRewards.paidAmount || 0);
  const withdrawable = Number(calculatedRewards.withdrawable || 0);
  const counts = calculatedRewards.counts || {};
  const breakdown = calculatedRewards.breakdown || {};
  const totalIds = Object.values(counts).reduce((a, b) => a + Number(b || 0), 0);

  if (el.walletAmount) el.walletAmount.textContent = fmt(withdrawable);
  if (el.statEligibleIds) el.statEligibleIds.textContent = totalIds;
  if (el.statEligibleReward) el.statEligibleReward.textContent = `$${fmt(totalEarned)}`;
  if (el.statPaid) el.statPaid.textContent = `$${fmt(totalPaid)}`;
  if (el.statWithdrawable) el.statWithdrawable.textContent = `$${fmt(withdrawable)}`;

  if (el.statRewardNote) el.statRewardNote.textContent = `${totalIds} eligible purchase${totalIds === 1 ? "" : "s"}`;
  if (el.statWithdrawNote) el.statWithdrawNote.textContent = status === "ENDED" ? "Available to withdraw" : `Locked until ${endStr}`;

  CAMPAIGN.tiers.forEach(t => {
    const cEl = $(`bdCount${t.key}`);
    const rEl = $(`bdReward${t.key}`);
    if (cEl) cEl.textContent = counts[t.key] || 0;
    if (rEl) rEl.textContent = (breakdown[t.key] || 0).toLocaleString();
  });

  updateWithdrawalUI(withdrawable, status);
}

function updateWithdrawalUI(withdrawable, status) {
  const withdrawalStatus = String(calculatedRewards.currentStatus || "").toLowerCase();
  
  // ✅ TESTING FIX: Withdrawal चालू है अभी के लिए, चाहे ऑफर चल रहा हो या खत्म
  const canWithdraw = withdrawable > 0 && withdrawalStatus !== "pending" && withdrawalStatus !== "approved";

  injectWithdrawalInput();

  if (el.withdrawAmount) el.withdrawAmount.textContent = `$${fmt(withdrawable)} USDT`;
  if (el.withdrawalInfoBox) el.withdrawalInfoBox.classList.add("visible");

  if (el.withdrawalInfoText) {
    if (withdrawalStatus === "pending") {
      el.withdrawalInfoText.textContent = `⏳ Your previous withdrawal is pending approval.`;
    } else if (withdrawalStatus === "approved") {
      el.withdrawalInfoText.textContent = `✅ Your previous withdrawal is approved.`;
    } else if (canWithdraw) {
      el.withdrawalInfoText.textContent = `🔓 You can withdraw your balance now.`;
    } else {
      el.withdrawalInfoText.textContent = `Waiting for rewards...`;
    }
  }

  if (["pending", "approved", "paid"].includes(withdrawalStatus)) {
    if (el.withdrawBtn) {
      el.withdrawBtn.disabled = true;
      if (withdrawalStatus === "pending") el.withdrawBtn.innerHTML = `<i class="bi bi-clock me-2"></i>Pending Approval`;
      else if (withdrawalStatus === "approved") el.withdrawBtn.innerHTML = `<i class="bi bi-check-circle me-2"></i>Approved`;
      else if (withdrawalStatus === "paid") {
        if (canWithdraw) {
          el.withdrawBtn.disabled = false;
          el.withdrawBtn.innerHTML = `<i class="bi bi-arrow-up-right me-2"></i>Withdraw New Rewards`;
          el.withdrawBtn.className = "btn-withdraw";
        } else {
          el.withdrawBtn.innerHTML = `<i class="bi bi-check-circle-fill me-2"></i>Paid ✓`;
        }
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

    if (withdrawalStatus === "paid" && el.withdrawalDetails && calculatedRewards.currentWithdrawal) {
      el.withdrawalDetails.classList.add("visible");
      if (el.detailAmount) el.detailAmount.textContent = `$${fmt(calculatedRewards.currentWithdrawal.amount)} USDT`;
      if (el.detailWallet) el.detailWallet.textContent = calculatedRewards.currentWithdrawal.walletAddress || "---";
      if (el.detailPaidDate) el.detailPaidDate.textContent = calculatedRewards.currentWithdrawal.paidAt ? new Date(calculatedRewards.currentWithdrawal.paidAt).toLocaleString() : "---";
      if (el.detailTxHash) el.detailTxHash.textContent = calculatedRewards.currentWithdrawal.txHash || "---";
    }

    if (el.walletFormGroup) el.walletFormGroup.style.display = canWithdraw ? "block" : "none";
    return;
  }

  if (canWithdraw) {
    if (el.withdrawBtn) {
      el.withdrawBtn.disabled = false;
      el.withdrawBtn.innerHTML = `<i class="bi bi-arrow-up-right me-2"></i>Withdraw Offer Reward`;
      el.withdrawBtn.className = "btn-withdraw";
    }
    if (el.walletFormGroup) el.walletFormGroup.style.display = "block";
    if (el.withdrawalStatus) el.withdrawalStatus.classList.remove("visible");
    if (el.withdrawalDetails) el.withdrawalDetails.classList.remove("visible");
  } else {
    if (el.withdrawBtn) {
      el.withdrawBtn.disabled = true;
      el.withdrawBtn.innerHTML = `Nothing to Withdraw`;
      el.withdrawBtn.className = "btn-withdraw withdrawal-locked";
    }
    if (el.walletFormGroup) el.walletFormGroup.style.display = "none";
  }
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
  // ✅ TESTING FIX: डेट चेक हटा दिया, अब कभी भी विदड्रॉल लग सकता है
  const avail = calculatedRewards.withdrawable;
  if (avail <= 0) { showToast("Nothing to withdraw.", "warning"); return; }
  if (!validateWallet()) { showToast("Enter a valid BEP-20 wallet address.", "error"); return; }

  const amountVal = parseFloat(withdrawalAmountInput?.value || 0);
  if (!amountVal || amountVal <= 0) { showToast("Enter a valid amount.", "error"); return; }
  if (amountVal > avail) { showToast("Amount exceeds available balance.", "error"); return; }

  const addr = el.walletAddressInput.value.trim();
  if (el.confirmAmount) el.confirmAmount.textContent = `$${fmt(amountVal)} USDT`;
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

    const amountVal = parseFloat(withdrawalAmountInput?.value || 0);
    const avail = calculatedRewards.withdrawable;

    if (amountVal <= 0 || amountVal > avail) { showToast("Invalid amount.", "error"); return; }

    const rewardsRoot = ref(db, `${CAMPAIGN.id}/rewards/${currentUserId}`);
    const withdrawalId = generateId("dw");
    const txId = generateId("tx");
    const timestamp = Date.now();

    const lockResult = await runTransaction(rewardsRoot, (current) => {
      if (current && (current.status === "pending" || current.status === "approved")) {
        return;
      }
      return {
        ...(current || {}),
        status: "pending",
        walletAddress: addr,
        withdrawalId,
        transactionId: txId,
        requestedAmount: amountVal,
        requestedAt: timestamp,
        updatedAt: timestamp
      };
    });

    if (!lockResult.committed) { showToast("Withdrawal already submitted or nothing available.", "warning"); return; }

    const date = new Date(timestamp).toISOString().split("T")[0];
    const adminData = {
      campaignName: CAMPAIGN.name, campaignId: CAMPAIGN.id, type: "bumper_offer_withdrawal",
      asset: "USDT", network: "BEP-20 / BNB Smart Chain", amount: amountVal, status: "pending",
      userId: currentUserId, username: currentUserData?.username || currentUserData?.name || currentUserId,
      walletAddress: addr, requestedAt: timestamp, withdrawalId
    };
    const userTx = {
      type: "bumper_offer_withdrawal", subtype: `${CAMPAIGN.name} Withdrawal`,
      amount: amountVal, currency: "USDT", network: "BEP-20 / BNB Smart Chain",
      status: "pending", walletAddress: addr, withdrawalId, timestamp, date,
      description: `${CAMPAIGN.name} Withdrawal of $${amountVal} USDT (BEP-20)`, txId, txHash: null
    };
    const globalTx = { ...userTx, userId: currentUserId };

    await update(ref(db), {
      [`${CAMPAIGN.id}/withdrawals/${withdrawalId}`]: adminData,
      [`users/${currentUserId}/offer_transactions/${txId}`]: userTx,
      [`${CAMPAIGN.id}/transactions/${txId}`]: globalTx
    });

    showToast("✅ Withdrawal request submitted. Awaiting admin approval.", "success");
    if (el.confirmationModal) el.confirmationModal.classList.remove("visible");
    if (el.walletAddressInput) el.walletAddressInput.value = "";
    if (withdrawalAmountInput) withdrawalAmountInput.value = "";

    calculatedRewards.withdrawable = Math.max(0, calculatedRewards.withdrawable - amountVal);
    calculatedRewards.pendingAmount += amountVal;
    calculatedRewards.currentStatus = "pending";

    updateUI();
    syncOfferData(currentUserId);

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
  } catch (e) { showToast("Logout error", "error"); }
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

  renderRewardsTable();
  setupListeners();
  startCountdown();
  startAutoSync(user.uid);

  if (el.loadingOverlay) el.loadingOverlay.classList.add("hidden");
});

window.addEventListener("beforeunload", () => {
  stopAutoSync();
  if (countdownInterval) clearInterval(countdownInterval);
});
