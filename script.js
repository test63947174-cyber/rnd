// ============================================================
// FIREBASE IMPORTS
// ============================================================
import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getDatabase, ref, get, update, set, onValue, runTransaction } from "firebase/database";

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
// NEW CAMPAIGN CONFIGURATION — 14 DAY $50 PACKAGE OFFER
// ============================================================
const CAMPAIGN = {
    campaignId: 'direct_offer_50pack_oct2026',
    startDate: new Date('2026-10-10T00:00:00+05:30'),
    endDate: new Date('2026-10-24T23:59:59+05:30'),
    requiredPackageAmount: 50,      // Only $50 package qualifies
    rewardPerReferral: 10,          // $10 per qualified referral
    cycleSize: 5,                   // 5 referrals = $50 cycle
    cycleReward: 50,                // $50 per cycle
    maxQualifying: Infinity         // Unlimited cycles
};

// ============================================================
// DOM REFS
// ============================================================
const $ = id => document.getElementById(id);
const el = {
    loadingOverlay: $('loadingOverlay'),
    toastContainer: $('toastContainer'),
    userAvatar: $('userAvatar'),
    userName: $('userName'),
    logoutBtn: $('logoutBtn'),
    countdownDays: $('countdownDays'),
    countdownHours: $('countdownHours'),
    countdownMinutes: $('countdownMinutes'),
    countdownSeconds: $('countdownSeconds'),
    countdownWrapper: $('countdownWrapper'),
    campaignEndedMessage: $('campaignEndedMessage'),
    campaignStatusBadge: $('campaignStatusBadge'),
    statDirectRefs: $('statDirectRefs'),
    statReferralPeriod: $('statReferralPeriod'),
    statEligibleReward: $('statEligibleReward'),
    statRewardNote: $('statRewardNote'),
    statNextMilestone: $('statNextMilestone'),
    statNextMilestoneSub: $('statNextMilestoneSub'),
    statMaxReward: $('statMaxReward'),
    progressCurrent: $('progressCurrent'),
    progressTarget: $('progressTarget'),
    progressFill: $('progressFill'),
    needMore: $('needMore'),
    nextMilestoneText: $('nextMilestoneText'),
    cycleProgressGrid: $('cycleProgressGrid'),
    referralLinkDisplay: $('referralLinkDisplay'),
    copyReferralBtn: $('copyReferralBtn'),
    totalReferralsDisplay: $('totalReferralsDisplay'),
    referralCodeDisplay: $('referralCodeDisplay'),
    withdrawalSection: $('withdrawalSection'),
    withdrawAmount: $('withdrawAmount'),
    walletAddressInput: $('walletAddressInput'),
    walletValidationMsg: $('walletValidationMsg'),
    walletFormGroup: $('walletFormGroup'),
    withdrawBtn: $('withdrawBtn'),
    withdrawalStatus: $('withdrawalStatus'),
    withdrawalInfoBox: $('withdrawalInfoBox'),
    withdrawalInfoText: $('withdrawalInfoText'),
    withdrawalDetails: $('withdrawalDetails'),
    detailAmount: $('detailAmount'),
    detailWallet: $('detailWallet'),
    detailPaidDate: $('detailPaidDate'),
    detailTxHash: $('detailTxHash'),
    withdrawalSubtitle: $('withdrawalSubtitle'),
    notEligibleBox: $('notEligibleBox'),
    walletAmount: $('walletAmount'),
    walletLabel: $('walletLabel'),
    walletStatusText: $('walletStatusText'),
    finalBadge: $('finalBadge'),
    rewardWalletCard: $('rewardWalletCard'),
    daysPopup: $('daysPopup'),
    popupIcon: $('popupIcon'),
    popupTitle: $('popupTitle'),
    popupText: $('popupText'),
    popupRewardAmount: $('popupRewardAmount'),
    popupDaysRemaining: $('popupDaysRemaining'),
    popupCloseBtn: $('popupCloseBtn'),
    confirmationModal: $('confirmationModal'),
    confirmAmount: $('confirmAmount'),
    confirmWallet: $('confirmWallet'),
    confirmCancel: $('confirmCancel'),
    confirmSubmit: $('confirmSubmit')
};

// ============================================================
// GLOBAL STATE
// ============================================================
let currentUserId = null;
let currentUserData = null;
let directReferrals = 0;
let countdownInterval = null;
let withdrawalData = null;
let campaignRewardSnapshot = null;
let isWithdrawalFinalized = false;
let isProcessingWithdrawal = false;
let referralRefreshInterval = null;
let firebaseServerOffset = 0;

// ============================================================
// FIREBASE SERVER-ADJUSTED TIME
// ============================================================
async function syncFirebaseServerTime() {
    try {
        const snap = await get(ref(db, '.info/serverTimeOffset'));
        firebaseServerOffset = snap.exists() ? Number(snap.val() || 0) : 0;
    } catch (error) {
        console.error('Unable to read Firebase server time offset:', error);
        firebaseServerOffset = 0;
    }
}

function getCampaignNow() {
    return new Date(Date.now() + firebaseServerOffset);
}

// ============================================================
// ACTIVE USER CHECK
// ============================================================
function isUserActive(userData) {
    if (!userData || typeof userData !== 'object') {
        return false;
    }

    const packages = userData.packages || {};

    for (const packageId of Object.keys(packages)) {
        const pkg = packages[packageId];
        if (!pkg || typeof pkg !== 'object') continue;
        if (String(pkg.status || '').toLowerCase() === 'active' && Number(pkg.usdtAmount || 0) > 0) {
            return true;
        }
    }

    return false;
}

// ============================================================
// NORMALIZE TIMESTAMP
// ============================================================
function normalizeTimestamp(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) && value > 0 ? value : null;
    }
    if (/^\d+$/.test(String(value))) {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : null;
    }
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// ============================================================
// PACKAGE ACTIVATION TIME
// ============================================================
function getPackageActivationTime(pkg) {
    if (!pkg || typeof pkg !== 'object') {
        return null;
    }

    const activationFields = [pkg.activationAt, pkg.activatedAt, pkg.activeAt];

    for (const value of activationFields) {
        const ts = normalizeTimestamp(value);
        if (ts) return ts;
    }

    if (String(pkg.status || '').toLowerCase() === 'active') {
        const purchaseTime = normalizeTimestamp(pkg.purchaseDate) || normalizeTimestamp(pkg.createdAt);
        return purchaseTime;
    }

    return null;
}

// ============================================================
// CAMPAIGN ELIGIBLE ACTIVE PACKAGE CHECK — $50 ONLY
// ============================================================
function hasCampaignActivePackage(userData) {
    if (!isUserActive(userData)) {
        return false;
    }

    const packages = userData.packages || {};

    for (const packageId of Object.keys(packages)) {
        const pkg = packages[packageId];
        if (!pkg || typeof pkg !== 'object') continue;

        if (String(pkg.status || '').toLowerCase() !== 'active') continue;

        // Only $50 package qualifies for this offer
        const pkgAmount = Number(pkg.usdtAmount || 0);
        if (pkgAmount !== CAMPAIGN.requiredPackageAmount) continue;

        const activationTime = getPackageActivationTime(pkg);
        if (!activationTime) continue;

        // Must become active during campaign
        if (activationTime >= CAMPAIGN.startDate.getTime() && activationTime <= CAMPAIGN.endDate.getTime()) {
            return true;
        }
    }

    return false;
}

// ============================================================
// GET CAMPAIGN DIRECT REFERRALS — $50 PACKAGE ONLY
// ============================================================
async function getCampaignDirectReferrals(userId) {
    try {
        if (!db || !userId) return 0;

        const ownerSnap = await get(ref(db, 'users/' + userId));
        if (!ownerSnap.exists()) return 0;

        const owner = ownerSnap.val();
        if (!isUserActive(owner)) return 0;

        const usersSnap = await get(ref(db, 'users'));
        if (!usersSnap.exists()) return 0;

        const users = usersSnap.val() || {};
        const counted = new Set();

        for (const [candidateUid, candidate] of Object.entries(users)) {
            if (!candidate || typeof candidate !== 'object' || candidateUid === userId) continue;

            let isDirect = false;

            // Canonical UID
            if (candidate.sponsorUid && String(candidate.sponsorUid) === String(userId)) {
                isDirect = true;
            }

            // Legacy UID
            if (!isDirect && candidate.referredByUid && String(candidate.referredByUid) === String(userId)) {
                isDirect = true;
            }

            // Legacy code/username
            if (!isDirect) {
                const legacySponsor = candidate.referredBy || candidate.sponsor || null;
                if (legacySponsor && (
                    String(legacySponsor) === String(userId) ||
                    String(legacySponsor) === String(owner.referralCode || '') ||
                    String(legacySponsor) === String(owner.username || '')
                )) {
                    isDirect = true;
                }
            }

            if (!isDirect) continue;

            // Must be active
            if (!isUserActive(candidate)) continue;

            // Must have $50 package active during campaign
            if (!hasCampaignActivePackage(candidate)) continue;

            counted.add(candidateUid);
        }

        return Math.min(counted.size, CAMPAIGN.maxQualifying);

    } catch (error) {
        console.error('Campaign direct referral calculation failed:', error);
        return 0;
    }
}

// ============================================================
// NEW REWARD CALCULATION — $10 PER QUALIFIED REFERRAL
// ============================================================
function calculateReward(directCount) {
    if (directCount <= 0) return 0;
    return directCount * CAMPAIGN.rewardPerReferral;
}

function getCurrentCycleProgress(directCount) {
    if (directCount <= 0) return 0;
    const remainder = directCount % CAMPAIGN.cycleSize;
    return remainder === 0 ? CAMPAIGN.cycleSize : remainder;
}

function getTotalCyclesCompleted(directCount) {
    return Math.floor(directCount / CAMPAIGN.cycleSize);
}

// ============================================================
// CAMPAIGN STATUS WITH SERVER TIME
// ============================================================
function getCampaignStatus() {
    const now = getCampaignNow();
    if (now < CAMPAIGN.startDate) return 'UPCOMING';
    if (now >= CAMPAIGN.startDate && now <= CAMPAIGN.endDate) return 'ACTIVE';
    return 'ENDED';
}

function getTimeRemaining() {
    const now = getCampaignNow();
    const status = getCampaignStatus();

    if (status === 'UPCOMING') {
        const diff = CAMPAIGN.startDate - now;
        if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0 };
        return {
            days: Math.floor(diff / (1000 * 60 * 60 * 24)),
            hours: Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
            minutes: Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)),
            seconds: Math.floor((diff % (1000 * 60)) / 1000)
        };
    } else if (status === 'ACTIVE') {
        const diff = CAMPAIGN.endDate - now;
        if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0 };
        return {
            days: Math.floor(diff / (1000 * 60 * 60 * 24)),
            hours: Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
            minutes: Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)),
            seconds: Math.floor((diff % (1000 * 60)) / 1000)
        };
    }
    return { days: 0, hours: 0, minutes: 0, seconds: 0 };
}

function formatTimeRemaining(time) {
    if (time.days === 0 && time.hours === 0 && time.minutes === 0 && time.seconds === 0) {
        return 'Offer has ended';
    }
    return `${time.days}d ${time.hours}h ${time.minutes}m ${time.seconds}s`;
}

// ============================================================
// CAMPAIGN REWARD SNAPSHOT
// ============================================================
async function getCampaignRewardSnapshot(userId) {
    try {
        const snap = await get(ref(db, `campaign_rewards/${userId}/${CAMPAIGN.campaignId}`));
        if (snap.exists()) {
            const data = snap.val();
            isWithdrawalFinalized = true;
            return data;
        }
        return null;
    } catch (error) {
        console.error('Error getting campaign snapshot:', error);
        return null;
    }
}

// ============================================================
// FINALIZE CAMPAIGN REWARD WITH TRANSACTION
// ============================================================
async function finalizeCampaignReward(userId) {
    try {
        if (!db || !userId) return null;

        if (getCampaignStatus() !== 'ENDED') {
            console.warn('Campaign cannot be finalized before end time.');
            return null;
        }

        const existing = await getCampaignRewardSnapshot(userId);
        if (existing) return existing;

        const finalDirectCount = await getCampaignDirectReferrals(userId);
        const finalReward = calculateReward(finalDirectCount);

        const snapshotData = {
            campaignId: CAMPAIGN.campaignId,
            userId: userId,
            finalDirectCount: finalDirectCount,
            finalReward: finalReward,
            snapshotAt: Date.now(),
            status: 'available',
            isFinalized: true,
            walletAddress: null,
            withdrawalId: null,
            transactionId: null,
            txHash: null,
            paidAt: null
        };

        const result = await runTransaction(
            ref(db, `campaign_rewards/${userId}/${CAMPAIGN.campaignId}`),
            (currentData) => {
                if (currentData) return currentData;
                return snapshotData;
            }
        );

        if (result.committed && result.snapshot.exists()) {
            campaignRewardSnapshot = result.snapshot.val();
            isWithdrawalFinalized = true;
            return campaignRewardSnapshot;
        }

        return null;

    } catch (error) {
        console.error('❌ Error finalizing campaign reward:', error);
        return null;
    }
}

// ============================================================
// WITHDRAWAL MANAGEMENT
// ============================================================
async function checkWithdrawalStatus(userId) {
    try {
        const snap = await get(ref(db, `campaign_rewards/${userId}/${CAMPAIGN.campaignId}`));
        if (!snap.exists()) return null;
        return snap.val();
    } catch (error) {
        console.error('Error checking withdrawal status:', error);
        return null;
    }
}

function setupWithdrawalListener(userId) {
    const refPath = ref(db, `campaign_rewards/${userId}/${CAMPAIGN.campaignId}`);
    onValue(refPath, (snapshot) => {
        if (snapshot.exists()) {
            withdrawalData = snapshot.val();
            updateUI();
        }
    });
}

function generateWithdrawalId() {
    return 'wd_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

function generateTxId() {
    return 'tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
}

function validateBEP20Wallet(address) {
    const regex = /^0x[a-fA-F0-9]{40}$/;
    return regex.test(address);
}

// ============================================================
// ATOMIC WITHDRAWAL CREATION
// ============================================================
async function createAtomicWithdrawal(userId, userData, walletAddress) {
    if (isProcessingWithdrawal) {
        throw new Error('Withdrawal already in progress');
    }

    isProcessingWithdrawal = true;

    try {
        if (getCampaignStatus() !== 'ENDED') {
            throw new Error('Campaign has not ended yet');
        }

        if (!isUserActive(userData)) {
            throw new Error('Your ID is not active');
        }

        if (!validateBEP20Wallet(walletAddress)) {
            throw new Error('Invalid BEP-20 wallet address');
        }

        const campaignRef = ref(db, `campaign_rewards/${userId}/${CAMPAIGN.campaignId}`);
        const withdrawalId = generateWithdrawalId();
        const txId = generateTxId();
        const timestamp = Date.now();

        const lockResult = await runTransaction(
            campaignRef,
            current => {
                if (!current) return;
                if (!current.isFinalized) return;
                const reward = Number(current.finalReward || 0);
                if (reward <= 0) return;
                if (['pending', 'approved', 'paid'].includes(current.status)) return;

                return {
                    ...current,
                    status: 'pending',
                    walletAddress: walletAddress,
                    withdrawalId: withdrawalId,
                    transactionId: txId,
                    requestedAt: timestamp,
                    updatedAt: timestamp
                };
            }
        );

        if (!lockResult.committed) {
            throw new Error('Withdrawal already submitted or reward unavailable');
        }

        const lockedCampaign = lockResult.snapshot.val();
        if (!lockedCampaign || lockedCampaign.withdrawalId !== withdrawalId) {
            throw new Error('Withdrawal request could not be locked');
        }

        const finalReward = Number(lockedCampaign.finalReward || 0);
        if (finalReward <= 0) {
            throw new Error('No eligible reward');
        }

        const date = new Date(timestamp).toISOString().split('T')[0];

        const adminData = {
            ...lockedCampaign,
            campaignName: 'RND Direct Referral $50 Package Offer',
            type: 'direct_offer_50pack_withdrawal',
            asset: 'USDT',
            network: 'BEP-20 / BNB Smart Chain',
            amount: finalReward,
            status: 'pending'
        };

        const transactionData = {
            type: 'direct_offer_50pack_withdrawal',
            subtype: 'Direct Referral $50 Package Offer Withdrawal',
            amount: finalReward,
            currency: 'USDT',
            network: 'BEP-20 / BNB Smart Chain',
            status: 'pending',
            walletAddress: walletAddress,
            withdrawalId: withdrawalId,
            timestamp: timestamp,
            date: date,
            description: `Direct Referral $50 Package Offer Withdrawal of $${finalReward} USDT (BEP-20)`,
            txId: txId,
            txHash: null
        };

        const globalTxData = {
            ...transactionData,
            userId: userId,
            username: userData.username || userData.referralCode || userId
        };

        await update(
            ref(db),
            {
                [`admin/withdrawals/${withdrawalId}`]: adminData,
                [`users/${userId}/transactions/${txId}`]: transactionData,
                [`transactions/${txId}`]: globalTxData
            }
        );

        return { success: true, withdrawalId, txId };

    } finally {
        isProcessingWithdrawal = false;
    }
}

// ============================================================
// TOAST UTILITY
// ============================================================
function showToast(message, type = 'success') {
    const container = el.toastContainer;
    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;
    const iconMap = {
        success: 'bi-check-circle-fill text-success',
        error: 'bi-exclamation-triangle-fill text-danger',
        warning: 'bi-exclamation-triangle-fill text-warning',
        info: 'bi-info-circle-fill text-info'
    };
    toast.innerHTML = `<i class="bi ${iconMap[type] || iconMap.success}"></i><span class="toast-msg">${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

// ============================================================
// RENDER CYCLE PROGRESS CARDS
// ============================================================
function renderCycleProgress(directCount) {
    const grid = el.cycleProgressGrid;
    grid.innerHTML = '';

    const totalCycles = Math.max(1, Math.ceil(directCount / CAMPAIGN.cycleSize) + 1);
    let foundNext = false;

    for (let i = 1; i <= totalCycles; i++) {
        const cycleStart = (i - 1) * CAMPAIGN.cycleSize;
        const cycleEnd = i * CAMPAIGN.cycleSize;
        const cycleReward = CAMPAIGN.cycleReward * i;

        const achieved = directCount >= cycleEnd;
        const isNext = !achieved && !foundNext && (directCount < cycleEnd);
        if (isNext) foundNext = true;

        let statusClass = 'locked';
        let statusText = 'Locked';
        if (achieved) { statusClass = 'achieved'; statusText = '✓ Complete'; }
        else if (isNext) { statusClass = 'next'; statusText = 'Current'; }

        const card = document.createElement('div');
        card.className = `cycle-card ${statusClass}`;
        card.innerHTML = `
            <div class="cycle-label">Cycle ${i}</div>
            <div class="cycle-refs">${cycleEnd} <small>refs</small></div>
            <div class="cycle-reward">$${cycleReward}</div>
            <span class="cycle-status ${statusClass}">${statusText}</span>
        `;
        grid.appendChild(card);
    }
}

// ============================================================
// UPDATE WITHDRAWAL UI — NEW RULES
// ============================================================
function updateWithdrawalUI(reward, status) {
    const campaignStatus = getCampaignStatus();
    const isEligible = directReferrals > 0 && reward > 0;
    const isWithdrawn = status && ['pending', 'approved', 'paid'].includes(status.status);

    let displayReward = reward;
    if (campaignStatus === 'ENDED' && campaignRewardSnapshot) {
        displayReward = Number(campaignRewardSnapshot.finalReward ?? 0);
    }

    el.withdrawAmount.textContent = '$' + displayReward.toFixed(2) + ' USDT';

    const showWalletForm = campaignStatus === 'ENDED' && isEligible && !isWithdrawn;
    el.walletFormGroup.style.display = showWalletForm ? 'block' : 'none';

    el.withdrawalInfoBox.style.display = 'block';

    if (status) {
        if (status.status === 'pending') {
            el.withdrawBtn.disabled = true;
            el.withdrawBtn.innerHTML = '<i class="bi bi-clock me-2"></i>Pending Approval';
            el.withdrawBtn.className = 'btn-withdraw btn-pending';
            el.withdrawalInfoText.textContent = '⏳ Your withdrawal request is pending admin approval.';
            el.withdrawalStatus.className = 'withdrawal-status visible pending';
            el.withdrawalStatus.textContent = 'Your withdrawal request is under admin review.';
            el.withdrawalDetails.classList.remove('visible');
            el.withdrawalSubtitle.textContent = 'Withdrawal pending approval';
        } else if (status.status === 'approved') {
            el.withdrawBtn.disabled = true;
            el.withdrawBtn.innerHTML = '<i class="bi bi-check-circle me-2"></i>Approved';
            el.withdrawBtn.className = 'btn-withdraw btn-approved';
            el.withdrawalInfoText.textContent = '✅ Your withdrawal has been approved and is being processed.';
            el.withdrawalStatus.className = 'withdrawal-status visible approved';
            el.withdrawalStatus.textContent = 'Your withdrawal has been approved and is being processed.';
            el.withdrawalDetails.classList.remove('visible');
            el.withdrawalSubtitle.textContent = 'Withdrawal approved - processing payment';
        } else if (status.status === 'paid') {
            el.withdrawBtn.disabled = true;
            el.withdrawBtn.innerHTML = '<i class="bi bi-check-circle-fill me-2"></i>Paid ✓';
            el.withdrawBtn.className = 'btn-withdraw btn-paid';
            el.withdrawalInfoText.textContent = '✅ Payment completed successfully!';
            el.withdrawalStatus.className = 'withdrawal-status visible paid';
            el.withdrawalStatus.textContent = 'Payment has been sent to your wallet.';
            el.withdrawalDetails.classList.add('visible');
            el.detailAmount.textContent = '$' + (status.finalReward || displayReward).toFixed(2) + ' USDT';
            el.detailWallet.textContent = status.walletAddress || '---';
            el.detailPaidDate.textContent = status.paidAt ? new Date(status.paidAt).toLocaleString() : '---';
            el.detailTxHash.textContent = status.txHash || 'Pending';
            el.withdrawalSubtitle.textContent = '✅ Payment Completed';
        } else if (status.status === 'rejected') {
            el.withdrawBtn.disabled = false;
            el.withdrawBtn.innerHTML = '<i class="bi bi-arrow-up-right me-2"></i>Withdraw Reward';
            el.withdrawBtn.className = 'btn-withdraw btn-rejected';
            el.withdrawalInfoText.textContent = '⚠️ Your previous request was rejected. You can try again.';
            el.withdrawalStatus.className = 'withdrawal-status visible rejected';
            el.withdrawalStatus.textContent = 'Your request was rejected. Please check your wallet address and try again.';
            el.withdrawalDetails.classList.remove('visible');
            el.withdrawalSubtitle.textContent = 'Request rejected - try again';
        }
        return;
    }

    // No withdrawal request yet
    if (campaignStatus === 'UPCOMING') {
        el.withdrawBtn.disabled = true;
        el.withdrawBtn.innerHTML = '⏳ Withdrawal Opens After Offer Ends';
        el.withdrawBtn.className = 'btn-withdraw withdrawal-locked';
        const time = getTimeRemaining();
        el.withdrawalInfoText.textContent = `📅 Campaign starts on 10 October 2026. Withdrawal will be available after the offer ends on 24 October 2026. Time until start: ${formatTimeRemaining(time)}`;
        el.withdrawalStatus.classList.remove('visible');
        el.withdrawalDetails.classList.remove('visible');
        el.withdrawalSubtitle.textContent = 'Withdrawal not available yet';
    } else if (campaignStatus === 'ACTIVE') {
        el.withdrawBtn.disabled = false;
        el.withdrawBtn.innerHTML = '📅 Withdrawal Locked — Offer Active';
        el.withdrawBtn.className = 'btn-withdraw withdrawal-locked';
        const time = getTimeRemaining();
        el.withdrawalInfoText.textContent = `🔒 Withdrawal is locked while the offer is active. It will open after 24 October 2026. Time remaining: ${formatTimeRemaining(time)}`;
        el.withdrawalStatus.classList.remove('visible');
        el.withdrawalDetails.classList.remove('visible');
        el.withdrawalSubtitle.textContent = 'Withdrawal locked - offer active';
    } else if (campaignStatus === 'ENDED') {
        if (isEligible) {
            el.withdrawBtn.disabled = false;
            el.withdrawBtn.innerHTML = '<i class="bi bi-arrow-up-right me-2"></i>Withdraw Reward';
            el.withdrawBtn.className = 'btn-withdraw';
            el.withdrawalInfoText.textContent = '🎉 Offer ended! You are eligible to withdraw your reward.';
            el.withdrawalStatus.classList.remove('visible');
            el.withdrawalDetails.classList.remove('visible');
            el.withdrawalSubtitle.textContent = 'Withdrawal available - claim your reward!';
        } else {
            el.withdrawBtn.disabled = true;
            el.withdrawBtn.innerHTML = '⛔ Not Eligible';
            el.withdrawBtn.className = 'btn-withdraw withdrawal-locked';
            el.withdrawalInfoText.textContent = 'Complete at least 1 qualified referral to be eligible for withdrawal.';
            el.withdrawalStatus.classList.remove('visible');
            el.withdrawalDetails.classList.remove('visible');
            el.withdrawalSubtitle.textContent = 'Not eligible for withdrawal';
        }
    }
}

// ============================================================
// REFRESH CAMPAIGN DIRECT COUNT
// ============================================================
async function refreshCampaignDirectCount() {
    if (!currentUserId || getCampaignStatus() !== 'ACTIVE' || isWithdrawalFinalized) {
        return;
    }

    const latest = await getCampaignDirectReferrals(currentUserId);

    if (latest !== directReferrals) {
        directReferrals = latest;
        el.totalReferralsDisplay.textContent = directReferrals;
        updateUI();
    }
}

function startReferralRefresh() {
    if (referralRefreshInterval) clearInterval(referralRefreshInterval);
    referralRefreshInterval = setInterval(refreshCampaignDirectCount, 60000);
}

// ============================================================
// UPDATE UI — NEW RULES
// ============================================================
function updateUI() {
    const campaignStatus = getCampaignStatus();
    const statusBadge = {
        'UPCOMING': { class: 'upcoming', text: '⏳ Upcoming - Starts 10 Oct 2026' },
        'ACTIVE': { class: 'active', text: '🔥 ACTIVE - Refer & Earn $10 per Referral!' },
        'ENDED': { class: 'ended', text: '🏁 Offer Ended - Withdrawal Available' }
    }[campaignStatus] || { class: 'upcoming', text: '⏳ Upcoming' };

    el.campaignStatusBadge.innerHTML = `<span class="campaign-status-badge ${statusBadge.class}">${statusBadge.text}</span>`;

    let displayReward = calculateReward(directReferrals);
    let displayDirectCount = directReferrals;
    let isFinal = false;

    if (campaignStatus === 'ENDED' && campaignRewardSnapshot) {
        displayReward = Number(campaignRewardSnapshot.finalReward ?? 0);
        displayDirectCount = Number(campaignRewardSnapshot.finalDirectCount ?? 0);
        isFinal = true;
        isWithdrawalFinalized = true;
    }

    // Stats
    el.statDirectRefs.textContent = displayDirectCount;
    el.statEligibleReward.textContent = '$' + displayReward;
    el.statReferralPeriod.textContent = campaignStatus === 'ENDED' ? 'Final Count' : 'Campaign Period';

    if (displayDirectCount > 0) {
        const cycles = Math.floor(displayDirectCount / CAMPAIGN.cycleSize);
        const remainder = displayDirectCount % CAMPAIGN.cycleSize;
        const cycleInfo = cycles > 0 ? `${cycles} cycle${cycles > 1 ? 's' : ''} completed` : '';
        el.statRewardNote.textContent = isFinal
            ? `🏆 Final: $${displayReward} (${displayDirectCount} qualified refs)`
            : `💰 $${displayReward} earned (${displayDirectCount} refs)${cycleInfo ? ' • ' + cycleInfo : ''}`;
        el.statRewardNote.style.color = '#fbbf24';
    } else {
        el.statRewardNote.textContent = 'Earn $10 per qualified $50 package referral';
        el.statRewardNote.style.color = '#64748b';
    }

    // Next cycle target
    const currentProgress = getCurrentCycleProgress(displayDirectCount);
    const nextCycleEnd = displayDirectCount + (CAMPAIGN.cycleSize - currentProgress);
    if (displayDirectCount >= 0) {
        const nextMilestoneReward = (Math.floor(displayDirectCount / CAMPAIGN.cycleSize) + 1) * CAMPAIGN.cycleReward;
        el.statNextMilestone.textContent = `${nextCycleEnd} → $${nextMilestoneReward}`;
        const needed = nextCycleEnd - displayDirectCount;
        el.statNextMilestoneSub.textContent = `${needed} more needed for next cycle`;
    }

    el.statMaxReward.textContent = '∞';
    el.statMaxReward.style.color = '#a78bfa';

    // Progress bar (current cycle)
    const cycleProgress = getCurrentCycleProgress(displayDirectCount);
    const progressPercent = (cycleProgress / CAMPAIGN.cycleSize) * 100;
    el.progressCurrent.textContent = cycleProgress === 0 && displayDirectCount > 0 ? CAMPAIGN.cycleSize : cycleProgress;
    el.progressTarget.textContent = CAMPAIGN.cycleSize;
    el.progressFill.style.width = progressPercent + '%';

    const neededForCycle = CAMPAIGN.cycleSize - cycleProgress;
    if (cycleProgress === CAMPAIGN.cycleSize) {
        el.nextMilestoneText.innerHTML = '<i class="bi bi-trophy" style="color:#fbbf24;"></i> 🎉 Cycle complete! Start the next cycle by referring more $50 package users.';
    } else {
        el.needMore.textContent = neededForCycle;
        el.nextMilestoneText.innerHTML = `<i class="bi bi-bullseye" style="color:#fbbf24;"></i> Need <strong>${neededForCycle}</strong> more qualified referrals to complete this $50 cycle.`;
    }

    renderCycleProgress(displayDirectCount);

    // Not Eligible
    if (displayDirectCount === 0) {
        el.notEligibleBox.classList.add('visible');
    } else {
        el.notEligibleBox.classList.remove('visible');
    }

    // Wallet
    el.walletAmount.textContent = displayReward.toFixed(2);
    if (isFinal) {
        el.finalBadge.style.display = 'inline';
        el.walletLabel.textContent = 'Final Offer Earnings';
        if (displayReward > 0) {
            el.walletStatusText.textContent = `🏆 Final earnings locked! $${displayReward} USDT from ${displayDirectCount} qualified referrals.`;
        } else {
            el.walletStatusText.textContent = 'No reward earned this campaign.';
        }
    } else {
        el.finalBadge.style.display = 'none';
        el.walletLabel.textContent = 'Estimated Offer Earnings';
        if (displayReward === 0) {
            el.walletStatusText.textContent = '💡 Refer users who activate the $50 package to earn $10 each!';
        } else {
            const cycles = Math.floor(displayDirectCount / CAMPAIGN.cycleSize);
            const remainder = displayDirectCount % CAMPAIGN.cycleSize;
            if (remainder === 0 && cycles > 0) {
                el.walletStatusText.textContent = `💰 $${displayReward} USDT earned! ${cycles} full cycle${cycles > 1 ? 's' : ''} completed.`;
            } else {
                el.walletStatusText.textContent = `💰 $${displayReward} USDT estimated! ${CAMPAIGN.cycleSize - remainder} more to complete this cycle.`;
            }
        }
    }

    updateWithdrawalUI(displayReward, withdrawalData);
}

// ============================================================
// SHOW DAYS REMAINING POPUP
// ============================================================
function showDaysPopup() {
    const campaignStatus = getCampaignStatus();
    const reward = calculateReward(directReferrals);
    const time = getTimeRemaining();

    if (campaignStatus === 'UPCOMING') {
        el.popupIcon.textContent = '📅';
        el.popupTitle.textContent = 'Offer Not Started Yet';
        el.popupText.innerHTML = `
            The $50 Package Direct Referral Offer has not started yet.
            <br><br>
            <strong>Starts:</strong> 10 October 2026
            <br>
            <strong>Ends:</strong> 24 October 2026
            <br>
            <strong>Your Estimated Reward:</strong> $${reward.toFixed(2)} USDT
            <br><br>
            <span style="color:#94a3b8;font-size:0.9rem;">Time until offer starts:</span>
            <div class="popup-days">${time.days > 0 ? time.days + 'd' : ''} ${time.hours}h ${time.minutes}m</div>
        `;
    } else if (campaignStatus === 'ACTIVE') {
        el.popupIcon.textContent = '🔒';
        el.popupTitle.textContent = 'Withdrawal Locked — Offer Active';
        el.popupText.innerHTML = `
            🔒 Your reward is currently locked while the offer is active.
            <br><br>
            <strong>Your Estimated Reward:</strong> $${reward.toFixed(2)} USDT
            <br>
            <strong>Offer Ends:</strong> 24 October 2026 at 23:59:59 IST
            <br>
            <strong>Withdrawal Opens:</strong> After the campaign end time
            <br><br>
            <span style="color:#94a3b8;font-size:0.9rem;">Time Remaining:</span>
            <div class="popup-days">${formatTimeRemaining(time)}</div>
        `;
    } else if (campaignStatus === 'ENDED') {
        const finalReward = campaignRewardSnapshot ? Number(campaignRewardSnapshot.finalReward ?? 0) : reward;
        if (finalReward > 0) {
            el.popupIcon.textContent = '🎉';
            el.popupTitle.textContent = 'Offer Ended!';
            el.popupText.innerHTML = `
                Your withdrawal is now available.
                <br><br>
                <strong>Eligible Reward:</strong> $${finalReward.toFixed(2)} USDT
                <br><br>
                Click <strong>"Withdraw Reward"</strong> to continue.
            `;
        } else {
            el.popupIcon.textContent = '⛔';
            el.popupTitle.textContent = 'Not Eligible';
            el.popupText.innerHTML = `
                You are not eligible for withdrawal because you have 0 qualified referrals.
                <br><br>
                <strong>Minimum required:</strong> 1 Qualified Direct Referral ($50 package)
                <br>
                <strong>Your qualified referrals:</strong> ${directReferrals}
            `;
        }
    }

    el.daysPopup.classList.add('visible');
}

// ============================================================
// HANDLE WITHDRAWAL BUTTON CLICK
// ============================================================
function handleWithdrawClick() {
    const status = getCampaignStatus();

    if (status !== 'ENDED') {
        showDaysPopup();
        return;
    }

    let reward = 0;
    if (campaignRewardSnapshot) {
        reward = Number(campaignRewardSnapshot.finalReward ?? 0);
    } else {
        reward = calculateReward(directReferrals);
    }

    if (reward <= 0) {
        showDaysPopup();
        return;
    }

    if (withdrawalData && ['pending', 'approved', 'paid'].includes(withdrawalData.status)) {
        showToast('You have already submitted a withdrawal request.', 'warning');
        return;
    }

    const walletAddress = el.walletAddressInput.value.trim();
    if (!validateBEP20Wallet(walletAddress)) {
        showToast('Please enter a valid BEP-20 USDT wallet address (0x...).', 'error');
        el.walletAddressInput.classList.add('error');
        return;
    }

    showConfirmationModal(reward, walletAddress);
}

// ============================================================
// SHOW CONFIRMATION MODAL
// ============================================================
function showConfirmationModal(reward, walletAddress) {
    el.confirmAmount.textContent = '$' + reward.toFixed(2) + ' USDT';
    el.confirmWallet.textContent = walletAddress;
    el.confirmationModal.classList.add('visible');
}

// ============================================================
// PROCESS WITHDRAWAL WITH FINAL SNAPSHOT ONLY
// ============================================================
async function processWithdrawal() {
    const walletAddress = el.walletAddressInput.value.trim();

    if (!validateBEP20Wallet(walletAddress)) {
        showToast('Please enter a valid BEP-20 USDT wallet address.', 'error');
        return;
    }

    if (getCampaignStatus() !== 'ENDED') {
        showToast('Withdrawal is only available after the offer ends.', 'error');
        return;
    }

    const userSnap = await get(ref(db, 'users/' + currentUserId));
    if (!userSnap.exists()) {
        showToast('User data not found.', 'error');
        return;
    }

    const latestUserData = userSnap.val();

    if (!isUserActive(latestUserData)) {
        showToast('You are not eligible because your ID is not active.', 'error');
        return;
    }

    let snapshot = await getCampaignRewardSnapshot(currentUserId);

    if (!snapshot) {
        snapshot = await finalizeCampaignReward(currentUserId);
    }

    if (!snapshot || !snapshot.isFinalized || Number(snapshot.finalReward || 0) <= 0) {
        showToast('No finalized eligible reward is available.', 'error');
        return;
    }

    const reward = Number(snapshot.finalReward ?? 0);
    if (reward <= 0) {
        showToast('You are not eligible for this reward.', 'error');
        return;
    }

    if (withdrawalData && ['pending', 'approved', 'paid'].includes(withdrawalData.status)) {
        showToast('You have already submitted a withdrawal request.', 'warning');
        return;
    }

    el.confirmSubmit.disabled = true;
    el.confirmSubmit.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Processing...';

    try {
        const result = await createAtomicWithdrawal(currentUserId, latestUserData, walletAddress);

        if (result.success) {
            showToast('✅ Your withdrawal request has been submitted successfully.', 'success');
            withdrawalData = await checkWithdrawalStatus(currentUserId);
            el.walletAddressInput.value = '';
            el.confirmationModal.classList.remove('visible');
            updateUI();
        } else {
            showToast('❌ Failed to submit withdrawal request.', 'error');
        }
    } catch (error) {
        console.error('Withdrawal error:', error);
        showToast('❌ ' + (error.message || 'Error submitting withdrawal request. Please try again.'), 'error');
    }

    el.confirmSubmit.disabled = false;
    el.confirmSubmit.innerHTML = '<i class="bi bi-check-circle me-1"></i>Confirm Withdrawal';
}

// ============================================================
// LOAD USER DATA WITH ACTIVE CHECK
// ============================================================
async function loadUserData(user) {
    try {
        currentUserId = user.uid;
        const userSnap = await get(ref(db, 'users/' + user.uid));
        if (!userSnap.exists()) {
            showToast('User data not found. Please complete registration.', 'error');
            el.loadingOverlay.classList.add('hidden');
            return;
        }

        currentUserData = userSnap.val();
        const name = currentUserData.name || currentUserData.username || 'User';
        el.userName.textContent = name;
        el.userAvatar.textContent = name.charAt(0).toUpperCase();

        campaignRewardSnapshot = await getCampaignRewardSnapshot(user.uid);
        if (campaignRewardSnapshot) {
            isWithdrawalFinalized = true;
        }

        const userIsActive = isUserActive(currentUserData);

        if (!userIsActive) {
            directReferrals = 0;
            console.log('ℹ️ User inactive - offer count forced to 0');
        } else {
            directReferrals = await getCampaignDirectReferrals(user.uid);
        }

        if (getCampaignStatus() === 'ENDED' && !campaignRewardSnapshot) {
            campaignRewardSnapshot = await finalizeCampaignReward(user.uid);
            if (campaignRewardSnapshot) {
                isWithdrawalFinalized = true;
                directReferrals = Number(campaignRewardSnapshot.finalDirectCount ?? 0);
            }
        }

        setupWithdrawalListener(user.uid);
        withdrawalData = await checkWithdrawalStatus(user.uid);

        const referralCode = currentUserData.referralCode || user.uid.substring(0, 8).toUpperCase();
        const link = `https://staking.randigital.in/register.html?ref=${referralCode}`;
        el.referralLinkDisplay.textContent = link;
        el.referralCodeDisplay.textContent = referralCode;
        el.totalReferralsDisplay.textContent = directReferrals;

        startCountdown();
        updateUI();

        el.loadingOverlay.classList.add('hidden');

        const status = getCampaignStatus();
        if (status === 'UPCOMING') {
            showToast('📢 $50 Package Direct Referral Offer starts on 10 October 2026!', 'warning');
        } else if (status === 'ACTIVE') {
            if (userIsActive) {
                showToast('🎯 Offer is ACTIVE! Refer $50 package users and earn $10 each!', 'success');
                startReferralRefresh();
            } else {
                showToast('ℹ️ Activate your ID with a $50 package to participate in this offer.', 'info');
            }
        } else if (status === 'ENDED') {
            if (directReferrals > 0) {
                showToast('🏆 Offer ended! You are eligible for reward withdrawal.', 'success');
            } else {
                showToast('⏰ Offer ended. You need at least 1 qualified referral ($50 package) to qualify.', 'warning');
            }
        }

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                refreshCampaignDirectCount();
            }
        });

    } catch (error) {
        console.error('Error loading user data:', error);
        showToast('Error loading data: ' + error.message, 'error');
        el.loadingOverlay.classList.add('hidden');
    }
}

// ============================================================
// COUNTDOWN
// ============================================================
function startCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);

    function update() {
        const time = getTimeRemaining();
        const status = getCampaignStatus();

        if (status === 'ENDED') {
            el.countdownWrapper.style.display = 'none';
            el.campaignEndedMessage.style.display = 'block';
            if (countdownInterval) clearInterval(countdownInterval);

            if (!isWithdrawalFinalized && currentUserId) {
                finalizeCampaignReward(currentUserId).then(() => {
                    updateUI();
                });
            }
            updateUI();
            return;
        }

        el.countdownDays.textContent = String(time.days).padStart(2, '0');
        el.countdownHours.textContent = String(time.hours).padStart(2, '0');
        el.countdownMinutes.textContent = String(time.minutes).padStart(2, '0');
        el.countdownSeconds.textContent = String(time.seconds).padStart(2, '0');
    }

    update();
    countdownInterval = setInterval(update, 1000);
}

// ============================================================
// WALLET ADDRESS VALIDATION
// ============================================================
function setupWalletValidation() {
    el.walletAddressInput.addEventListener('input', () => {
        const value = el.walletAddressInput.value.trim();
        const msg = el.walletValidationMsg;

        if (!value) {
            el.walletAddressInput.className = 'form-control-custom';
            msg.className = 'wallet-validation-msg';
            msg.textContent = '';
            return;
        }

        if (validateBEP20Wallet(value)) {
            el.walletAddressInput.className = 'form-control-custom valid';
            msg.className = 'wallet-validation-msg valid';
            msg.textContent = '✅ Valid BEP-20 wallet address';
        } else {
            el.walletAddressInput.className = 'form-control-custom error';
            msg.className = 'wallet-validation-msg error';
            msg.textContent = '❌ Invalid BEP-20 wallet address. Must start with 0x and contain 40 hex characters.';
        }
    });
}

// ============================================================
// COPY REFERRAL LINK
// ============================================================
async function copyReferralLink() {
    const link = el.referralLinkDisplay.textContent;
    if (!link || link === 'Loading...') {
        showToast('Please wait, referral link is loading...', 'warning');
        return;
    }
    try {
        await navigator.clipboard.writeText(link);
        el.copyReferralBtn.innerHTML = '<i class="bi bi-check-circle me-1"></i>Copied!';
        el.copyReferralBtn.classList.add('copied');
        showToast('✅ Referral link copied!', 'success');
        setTimeout(() => {
            el.copyReferralBtn.innerHTML = '<i class="bi bi-clipboard me-1"></i>Copy Referral Link';
            el.copyReferralBtn.classList.remove('copied');
        }, 3000);
    } catch {
        const textArea = document.createElement('textarea');
        textArea.value = link;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        el.copyReferralBtn.innerHTML = '<i class="bi bi-check-circle me-1"></i>Copied!';
        showToast('✅ Referral link copied!', 'success');
        setTimeout(() => {
            el.copyReferralBtn.innerHTML = '<i class="bi bi-clipboard me-1"></i>Copy Referral Link';
        }, 3000);
    }
}

// ============================================================
// LOGOUT
// ============================================================
async function handleLogout() {
    try {
        await signOut(auth);
        window.location.href = 'login.html';
    } catch (error) {
        showToast('Error logging out.', 'error');
    }
}

// ============================================================
// SETUP LISTENERS
// ============================================================
function setupListeners() {
    el.copyReferralBtn.addEventListener('click', copyReferralLink);
    el.logoutBtn.addEventListener('click', handleLogout);
    el.withdrawBtn.addEventListener('click', handleWithdrawClick);
    el.popupCloseBtn.addEventListener('click', () => {
        el.daysPopup.classList.remove('visible');
    });
    el.daysPopup.addEventListener('click', (e) => {
        if (e.target === el.daysPopup) {
            el.daysPopup.classList.remove('visible');
        }
    });
    el.confirmCancel.addEventListener('click', () => {
        el.confirmationModal.classList.remove('visible');
    });
    el.confirmationModal.addEventListener('click', (e) => {
        if (e.target === el.confirmationModal) {
            el.confirmationModal.classList.remove('visible');
        }
    });
    el.confirmSubmit.addEventListener('click', processWithdrawal);

    setupWalletValidation();
}

// ============================================================
// CLEANUP
// ============================================================
window.addEventListener('beforeunload', () => {
    if (countdownInterval) clearInterval(countdownInterval);
    if (referralRefreshInterval) clearInterval(referralRefreshInterval);
});

// ============================================================
// MAIN AUTH HANDLER
// ============================================================
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'login.html';
        return;
    }

    await syncFirebaseServerTime();
    await loadUserData(user);
    setupListeners();
});

console.log('✅ $50 Package Direct Offer Page Loaded Successfully!');
console.log('📅 Campaign:', CAMPAIGN.campaignId, CAMPAIGN.startDate, '→', CAMPAIGN.endDate);
console.log('💰 Reward: $10 per qualified referral ($50 package only)');
console.log('🔄 Cycle: Every 5 referrals = $50');
console.log('🔒 Withdrawal: Locked until Offer ENDED');
console.log('✅ Only $50 package active users count as qualified referrals');
console.log('✅ Unlimited cycles — 5,10,15,20... referrals = $50,$100,$150,$200...');