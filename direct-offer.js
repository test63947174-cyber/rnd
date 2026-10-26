// ============================================================
// DIWALI BUMPER OFFER 2026 — PERFECT FIX (Live Node & Balance)
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getDatabase, ref, get, update, onValue, runTransaction } from "firebase/database";

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
// 🎯 CONFIGURATION (Correct Node Name)
// ============================================================
const CAMPAIGN = {
  id: "direct_diwali_offer_2026", // 🔥 यहाँ नाम सही कर दिया गया है
  name: "Diwali Bumper Offer 2026",
  startDate: new Date("2026-10-26T00:00:00+05:30"), 
  endDate:   new Date("2026-11-07T23:59:59.999+05:30"),
  rewards: { 
    50: 10, 
    100: 25, 
    200: 60, 
    500: 120, 
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
let calculatedRewards = { totalEarned: 0, paidAmount: 0, pendingAmount: 0, withdrawable: 0, counts: {}, breakdown: {}, currentStatus: "available", currentWithdrawal: null };
let countdownInterval = null;
let isProcessingWithdrawal = false;
let isSyncing = false; 
let syncInterval = null;
let withdrawalAmountInput = null; 

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
// ⏱️ COUNTDOWN TIMER
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
// 🔥 WITHDRAWAL INPUT INJECTION
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
// 🔥 AUTO-SYNC FUNCTION (Correct Balance Engine)
// ============================================================
async function syncDiwaliData(uid) {
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

    // 1. Fetch all users
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

    // 2. Fetch existing Diwali data
    const diwaliSnap = await get(ref(db, CAMPAIGN.id));
    const diwaliData = diwaliSnap.val() || {};
    const existingPurchases = diwaliData.purchases || {};
    const userWithdrawals = diwaliData.withdrawals || {};
    
    const counts = { 50: 0, 100: 0, 200: 0, 500: 0, 1000: 0 };
    const breakdown = { 50: 0, 100: 0, 200: 0, 500: 0, 1000: 0 };
    let totalEarned = 0;
    const updates = {};

    // 3. Calculate Total Earned
    for (const [refUserUid, refUserData] of Object.entries(allUsers)) {
      if (!referredUsers.has(refUserUid)) continue;
      
      const packages = refUserData.packages || {};
      
      for (const [pkgId, pkg] of Object.entries(packages)) {
        if (pkg.status !== "active" && pkg.status !== "completed") continue;

        const amt = Number(pkg.usdtAmount || 0);
        if (!CAMPAIGN.rewards[amt]) continue; 

        const purchaseTime = pkg.purchaseDate || pkg.timestamp || 0;
        if (purchaseTime < CAMPAIGN.startDate.getTime() || purchaseTime > CAMPAIGN.endDate.getTime()) continue;

        const rewardAmt = CAMPAIGN.rewards[amt];
        const purchaseId = pkgId; 

        if (!existingPurchases[purchaseId]) {
          updates[`purchases/${purchaseId}`] = {
            purchaseId: purchaseId,
            buyerUid: refUserUid,
            directReferrerUid: uid,
            packageAmount: amt,
            rewardAmount: rewardAmt,
            status: "completed",
            timestamp: purchaseTime,
            campaignId: CAMPAIGN.id
          };
          
          updates[`user_claims/${uid}/${purchaseId}`] = {
            purchaseId: purchaseId,
            amount: amt,
            reward: rewardAmt,
            claimedAt: Date.now()
          };
        }

        counts[amt]++;
        breakdown[amt] += rewardAmt;
        totalEarned += rewardAmt; 
      }
    }

    if (Object.keys(updates).length > 0) {
      await update(ref(db, CAMPAIGN.id), updates);
      console.log("🔥 New Diwali data synced!");
    }

    // 4. Calculate Pending & Paid
    let latestWithdrawal = null;
    let totalPaid = 0;
    let totalPending = 0;

    for (const [wId, w] of Object.entries(userWithdrawals)) {
      if (w.userId !== uid) continue;
      
      const amt = Number(w.amount || 0);
      if (w.status === 'paid' || w.status === 'approved') {
        totalPaid += amt; 
      } else if (w.status === 'pending') {
        totalPending += amt;
      }
      
      if (!latestWithdrawal || w.requestedAt > latestWithdrawal.requestedAt) {
        latestWithdrawal = w;
      }
    }

    // 5. Final Withdrawable Balance Calculation
    const actualWithdrawable = Math.max(0, totalEarned - totalPaid - totalPending);

    calculatedRewards = {
      totalEarned: totalEarned,
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
  syncDiwaliData(uid); 
  syncInterval = setInterval(() => syncDiwaliData(uid), 2000);
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
  if (el.campaignDates) el.campaignDates.textContent = `${startStr} - ${endStr}`;
  
  const badges = {
    UPCOMING: { cls: "upcoming", txt: `⏳ Upcoming` },
    ACTIVE:   { cls: "active",   txt: "🔥 ACTIVE" },
    ENDED:    { cls: "ended",    txt: "🏁 ENDED" }
  };
  if (el.campaignStatusBadge) el.campaignStatusBadge.innerHTML = `<span class="campaign-status-badge ${badges[status].cls}">${badges[status].txt}</span>`;

  const totalEarned = Number(calculatedRewards.totalEarned || 0);
  const totalPaid = Number(calculatedRewards.paidAmount || 0);
  const withdrawable = Number(calculatedRewards.withdrawable || 0);
  const counts     = calculatedRewards.counts || {};
  const breakdown  = calculatedRewards.breakdown || {};
  const totalIds   = Object.values(counts).reduce((a, b) => a + Number(b || 0), 0);

  if (el.walletAmount) el.walletAmount.textContent = fmt(withdrawable);
  if (el.statEligibleIds) el.statEligibleIds.textContent = totalIds;
  if (el.statEligibleReward) el.statEligibleReward.textContent = `$${fmt(totalEarned)}`;
  if (el.statPaid) el.statPaid.textContent = `$${fmt(totalPaid)}`;
  if (el.statWithdrawable) el.statWithdrawable.textContent = `$${fmt(withdrawable)}`;

  [50, 100, 200, 500, 1000].forEach(amt => {
    if ($(`bdCount${amt}`))  $(`bdCount${amt}`).textContent  = counts[amt] || 0;
    if ($(`bdReward${amt}`)) $(`bdReward${amt}`).textContent = (breakdown[amt] || 0).toLocaleString();
  });

  updateWithdrawalUI(withdrawable, status);
}

function updateWithdrawalUI(withdrawable, status) {
  const withdrawalStatus = String(calculatedRewards.currentStatus || "").toLowerCase();
  const canWithdraw = withdrawable > 0 && withdrawalStatus !== "pending" && withdrawalStatus !== "approved";

  injectWithdrawalInput(); 
  
  if (el.withdrawAmount) el.withdrawAmount.textContent = `$${fmt(withdrawable)} USDT`;
  
  if (el.withdrawalInfoBox) el.withdrawalInfoBox.classList.add("visible");
  
  if (el.withdrawalInfoText) {
    if (status === "ENDED") el.withdrawalInfoText.textContent = `Offer ended. You can withdraw earned rewards.`;
    else if (withdrawalStatus === "pending") el.withdrawalInfoText.textContent = `⏳ Your previous withdrawal is pending approval.`;
    else if (withdrawalStatus === "approved") el.withdrawalInfoText.textContent = `✅ Your previous withdrawal is approved.`;
    else el.withdrawalInfoText.textContent = `🔓 Withdrawals are unlocked.`;
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
      el.withdrawBtn.innerHTML = `<i class="bi bi-arrow-up-right me-2"></i>Withdraw Diwali Reward`;
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

    const withdrawalId = generateId("dw");
    const txId = generateId("tx");
    const timestamp = Date.now();

    const adminData = {
      campaignName: CAMPAIGN.name, campaignId: CAMPAIGN.id, type: "diwali_offer_withdrawal",
      asset: "USDT", network: "BEP-20 / BNB Smart Chain", amount: amountVal, status: "pending",
      userId: currentUserId, username: currentUserData?.username || currentUserData?.name || currentUserId,
      walletAddress: addr, requestedAt: timestamp, withdrawalId
    };
    const userTx = {
      type: "diwali_offer_withdrawal", subtype: `${CAMPAIGN.name} Withdrawal`,
      amount: amountVal, currency: "USDT", network: "BEP-20 / BNB Smart Chain",
      status: "pending", walletAddress: addr, withdrawalId, timestamp, date: new Date(timestamp).toISOString().split("T")[0],
      description: `${CAMPAIGN.name} Withdrawal of $${amountVal} USDT (BEP-20)`, txId, txHash: null
    };
    const globalTx = { ...userTx, userId: currentUserId };

    await update(ref(db), {
      [`${CAMPAIGN.id}/withdrawals/${withdrawalId}`]: adminData,
      [`users/${currentUserId}/diwali_transactions/${txId}`]: userTx,
      [`${CAMPAIGN.id}/transactions/${txId}`]: globalTx
    });

    showToast("✅ Withdrawal request submitted. Awaiting admin approval.", "success");
    if (el.confirmationModal) el.confirmationModal.classList.remove("visible");
    if (el.walletAddressInput) el.walletAddressInput.value = "";
    if (withdrawalAmountInput) withdrawalAmountInput.value = "";

    // 🔥 तुरंत बैलेंस काटें
    calculatedRewards.withdrawable = Math.max(0, calculatedRewards.withdrawable - amountVal);
    calculatedRewards.pendingAmount += amountVal;
    calculatedRewards.currentStatus = "pending";
    
    updateUI();
    syncDiwaliData(currentUserId); // तुरंत रिफ्रेश करें

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
  
  setupListeners();
  startCountdown(); 
  startAutoSync(user.uid); 
  
  if (el.loadingOverlay) el.loadingOverlay.classList.add("hidden");
});

window.addEventListener("beforeunload", () => {
  stopAutoSync();
  if (countdownInterval) clearInterval(countdownInterval);
});
