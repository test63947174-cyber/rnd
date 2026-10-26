// ============================================================
// DIWALI BUMPER OFFER 2026 — TESTING SCRIPT (No Date Limit)
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
// 🎯 CONFIGURATION
// ============================================================
const CAMPAIGN = {
  id: "direct_diwali_offer_2026",
  name: "Diwali Bumper Offer 2026",
  // 🔥 टेस्टिंग के लिए तारीख 2026 से 2030 कर दी गई है
  startDate: new Date("2026-01-01T00:00:00+05:30"), 
  endDate:   new Date("2030-12-31T23:59:59.999+05:30"),
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
let calculatedRewards = { balance: 0, paidAmount: 0, counts: {}, breakdown: {} };
let countdownInterval = null;
let isProcessingWithdrawal = false;
let isSyncing = false; 
let syncInterval = null;

// ============================================================
// UTILS & TIME HELPERS
// ============================================================
function getNow() { return new Date(); }

function getCampaignStatus() {
  const now = getNow().getTime();
  const start = CAMPAIGN.startDate.getTime();
  const end = CAMPAIGN.endDate.getTime();
  // टेस्टिंग के लिए हमने इसे हमेशा ACTIVE रखा है
  return "ACTIVE";
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
// 🔥 AUTO-SYNC FUNCTION (Fixing the Package Counting)
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

    // Fetch all users
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

    // Fetch existing Diwali data
    const diwaliSnap = await get(ref(db, CAMPAIGN.id));
    const diwaliData = diwaliSnap.val() || {};
    const existingPurchases = diwaliData.purchases || {};
    
    const counts = { 50: 0, 100: 0, 200: 0, 500: 0, 1000: 0 };
    const breakdown = { 50: 0, 100: 0, 200: 0, 500: 0, 1000: 0 };
    let totalBal = 0;
    const updates = {};

    // Loop through direct referrals
    for (const [refUserUid, refUserData] of Object.entries(allUsers)) {
      if (!referredUsers.has(refUserUid)) continue;
      
      const packages = refUserData.packages || {};
      
      // Loop through packages
      for (const [pkgId, pkg] of Object.entries(packages)) {
        if (pkg.status !== "active" && pkg.status !== "completed") continue;

        const amt = Number(pkg.usdtAmount || 0);
        if (!CAMPAIGN.rewards[amt]) continue; 

        // टेस्टिंग मोड में डेट चेक नहीं करेंगे, सीधे रिवॉर्ड देंगे
        const rewardAmt = CAMPAIGN.rewards[amt];
        const purchaseId = pkgId; 

        // Save to new node if not exists
        if (!existingPurchases[purchaseId]) {
          updates[`purchases/${purchaseId}`] = {
            purchaseId: purchaseId,
            buyerUid: refUserUid,
            directReferrerUid: uid,
            packageAmount: amt,
            rewardAmount: rewardAmt,
            status: "completed",
            timestamp: pkg.purchaseDate || pkg.timestamp || Date.now(),
            campaignId: CAMPAIGN.id
          };
          
          updates[`user_claims/${uid}/${purchaseId}`] = {
            purchaseId: purchaseId,
            amount: amt,
            reward: rewardAmt,
            claimedAt: Date.now()
          };
        }

        // 🔥 यहाँ हम सिर्फ उन्हीं पैकेजेस को गिनेंगे जो वास्तव में दिवाली के तहत क्लेम हुए हैं
        // ताकि बार-बार रिफ्रेश करने पर काउंट न बढ़े
        if (!counts[amt]) counts[amt] = 0; // Initialize if undefined
        counts[amt]++;
        breakdown[amt] += rewardAmt;
        totalBal += rewardAmt;
      }
    }

    if (Object.keys(updates).length > 0) {
      await update(ref(db, CAMPAIGN.id), updates);
      console.log("🔥 New Diwali data synced from packages!");
    }

    // Fetch admin paid status
    const rewardSnap = await get(ref(db, `${CAMPAIGN.id}/rewards/${uid}`));
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
    console.error("Sync error:", err);
  } finally {
    isSyncing = false;
  }
}

// ============================================================
// ⏱️ AUTO-SYNC TIMER
// ============================================================
function startAutoSync(uid) {
  if (syncInterval) clearInterval(syncInterval);
  syncDiwaliData(uid); // Initial run
  syncInterval = setInterval(() => syncDiwaliData(uid), 2000);
}

function stopAutoSync() {
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
}

// ============================================================
// 🎨 UI RENDER (With Fixes)
// ============================================================
function updateUI() {
  const status = getCampaignStatus();
  
  // Static dates display for testing
  if (el.campaignDates) el.campaignDates.textContent = `Testing Mode (Withdrawals Open)`;
  if (el.campaignDuration) el.campaignDuration.textContent = `No Limit`;
  if (el.campaignStatusBadge) el.campaignStatusBadge.innerHTML = `<span class="campaign-status-badge active">🔥 TESTING ACTIVE</span>`;

  const balance    = Number(calculatedRewards.balance || 0);
  const paidAmount = Number(calculatedRewards.paidAmount || 0);
  const counts     = calculatedRewards.counts || {};
  const breakdown  = calculatedRewards.breakdown || {};
  const totalIds   = Object.values(counts).reduce((a, b) => a + Number(b || 0), 0);

  if (el.walletAmount) el.walletAmount.textContent = fmt(balance);
  if (el.statEligibleIds) el.statEligibleIds.textContent = totalIds;
  if (el.statEligibleReward) el.statEligibleReward.textContent = `$${fmt(balance)}`;
  if (el.statPaid) el.statPaid.textContent = `$${fmt(paidAmount)}`;

  // Testing Mode: Withdrawable is always available if balance > paid
  const withdrawable = Math.max(0, balance - paidAmount);
  if (el.statWithdrawable) el.statWithdrawable.textContent = `$${fmt(withdrawable)}`;
  if (el.statWithdrawNote) el.statWithdrawNote.textContent = `Testing mode: Open now!`;

  [50, 100, 200, 500, 1000].forEach(amt => {
    if ($(`bdCount${amt}`))  $(`bdCount${amt}`).textContent  = counts[amt] || 0;
    if ($(`bdReward${amt}`)) $(`bdReward${amt}`).textContent = (breakdown[amt] || 0).toLocaleString();
  });

  if (el.walletStatusText) {
    if (balance === 0) el.walletStatusText.textContent = "Refer eligible packages to grow your Diwali reward balance!";
    else el.walletStatusText.textContent = `💰 $${fmt(balance)} earned so far. Keep referring!`;
  }
  
  if (el.finalBadge) el.finalBadge.style.display = "none"; // Testing me hide

  updateWithdrawalUI(balance, paidAmount, withdrawable, status, "Testing Mode");
}

function updateWithdrawalUI(balance, paid, withdrawable, status, endStr) {
  const withdrawalStatus = String(calculatedRewards.status || "").toLowerCase();
  const canWithdraw = withdrawable > 0;

  if (el.withdrawAmount) el.withdrawAmount.textContent = `$${fmt(withdrawable)} USDT`;
  
  if (el.withdrawalInfoBox) el.withdrawalInfoBox.classList.add("visible");
  
  if (el.withdrawalInfoText) {
    el.withdrawalInfoText.textContent = `🔓 Testing Mode: Withdrawals are unlocked right now.`;
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
    
    if (withdrawalStatus === "paid" && el.withdrawalDetails) {
      el.withdrawalDetails.classList.add("visible");
      if (el.detailAmount) el.detailAmount.textContent = `$${fmt(calculatedRewards.paidAmount || balance)} USDT`;
      if (el.detailWallet) el.detailWallet.textContent = calculatedRewards.walletAddress || "---";
      if (el.detailPaidDate) el.detailPaidDate.textContent = calculatedRewards.paidAt ? new Date(calculatedRewards.paidAt).toLocaleString() : "---";
      if (el.detailTxHash) el.detailTxHash.textContent = calculatedRewards.txHash || "---";
    }
    
    if (el.walletFormGroup) el.walletFormGroup.style.display = canWithdraw ? "block" : "none";
    if (canWithdraw) return; 
    else return;
  }

  // Default Withdrawal State (Testing mode)
  if (withdrawable > 0) {
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
  // टेस्टिंग में सीधे विड्रॉल अलाउड है
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

    const bal = Number(calculatedRewards.balance || 0);
    const paid = Number(calculatedRewards.paidAmount || 0);
    const avail = Math.max(0, bal - paid);
    if (avail <= 0) { showToast("Nothing to withdraw.", "warning"); return; }

    const rewardsRoot = ref(db, `${CAMPAIGN.id}/rewards/${currentUserId}`);
    const withdrawalId = generateId("dw");
    const txId = generateId("tx");
    const timestamp = Date.now();

    const lockResult = await runTransaction(rewardsRoot, (current) => {
      if (!current) {
        return { status: "pending", walletAddress: addr, withdrawalId, transactionId: txId, requestedAmount: avail, requestedAt: timestamp, updatedAt: timestamp };
      }
      
      const cStatus = String(current.status || "").toLowerCase();
      if (cStatus === "pending" || cStatus === "approved") return; 
      
      const cPaid = Number(current.paidAmount || 0);
      const cBal = Number(calculatedRewards.balance || 0);
      const cAvail = Math.max(0, cBal - cPaid);
      
      if (cAvail <= 0) return;

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

    if (!lockResult.committed) { showToast("Withdrawal already submitted or nothing available.", "warning"); return; }

    const date = new Date(timestamp).toISOString().split("T")[0];

    // ये सारा डेटा सीधे direct_diwali_offer_2026 में जाएगा जहाँ से एडमिन पढ़ेगा
    const adminData = {
      campaignName: CAMPAIGN.name, campaignId: CAMPAIGN.id, type: "diwali_offer_withdrawal",
      asset: "USDT", network: "BEP-20 / BNB Smart Chain", amount: avail, status: "pending",
      userId: currentUserId, username: currentUserData?.username || currentUserData?.name || currentUserId,
      walletAddress: addr, requestedAt: timestamp, withdrawalId
    };
    const userTx = {
      type: "diwali_offer_withdrawal", subtype: `${CAMPAIGN.name} Withdrawal`,
      amount: avail, currency: "USDT", network: "BEP-20 / BNB Smart Chain",
      status: "pending", walletAddress: addr, withdrawalId, timestamp, date,
      description: `${CAMPAIGN.name} Withdrawal of $${avail} USDT (BEP-20)`, txId, txHash: null
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
  startAutoSync(user.uid); 
  
  if (el.loadingOverlay) el.loadingOverlay.classList.add("hidden");
});

window.addEventListener("beforeunload", () => {
  stopAutoSync();
  if (countdownInterval) clearInterval(countdownInterval);
});
