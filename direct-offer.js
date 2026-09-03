// ============================================================
// DIRECT REFERRAL OFFER - COMPLETE JAVASCRIPT
// ============================================================

// ===== FIREBASE IMPORTS =====
import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getDatabase, ref, get, update, runTransaction, set, push, query, orderByChild, equalTo } from "firebase/database";

// ===== FIREBASE CONFIG =====
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
// CAMPAIGN CONFIGURATION
// ============================================================
const CAMPAIGN = {
    startDate: new Date('2026-09-06T00:00:00+05:30'), // IST
    endDate: new Date('2026-10-06T23:59:59+05:30'),   // IST
    name: 'RND Direct Referral Special Offer',
    maxReward: 100,
    minQualifying: 5,
    maxQualifying: 100,
    milestoneStep: 5
};

// ===== MILESTONE TABLE =====
const MILESTONES = [
    { refs: 5, reward: 5 },
    { refs: 10, reward: 10 },
    { refs: 15, reward: 15 },
    { refs: 20, reward: 20 },
    { refs: 25, reward: 25 },
    { refs: 30, reward: 30 },
    { refs: 35, reward: 35 },
    { refs: 40, reward: 40 },
    { refs: 45, reward: 45 },
    { refs: 50, reward: 50 },
    { refs: 55, reward: 55 },
    { refs: 60, reward: 60 },
    { refs: 65, reward: 65 },
    { refs: 70, reward: 70 },
    { refs: 75, reward: 75 },
    { refs: 80, reward: 80 },
    { refs: 85, reward: 85 },
    { refs: 90, reward: 90 },
    { refs: 95, reward: 95 },
    { refs: 100, reward: 100 }
];

// ============================================================
// GLOBAL STATE
// ============================================================
let currentUser = null;
let currentUserData = null;
let currentUserId = null;
let directReferrals = 0;
let eligibleReward = 0;
let campaignStatus = 'UPCOMING'; // UPCOMING | ACTIVE | ENDED
let withdrawalStatus = null; // null | pending | approved | rejected | paid
let countdownInterval = null;

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

    // Hero
    countdownDays: $('countdownDays'),
    countdownHours: $('countdownHours'),
    countdownMinutes: $('countdownMinutes'),
    countdownSeconds: $('countdownSeconds'),
    countdownWrapper: $('countdownWrapper'),
    campaignEndedMessage: $('campaignEndedMessage'),

    // Stats
    statDirectRefs: $('statDirectRefs'),
    statEligibleReward: $('statEligibleReward'),
    statNextMilestone: $('statNextMilestone'),
    statNextMilestoneSub: $('statNextMilestoneSub'),
    statMaxReward: $('statMaxReward'),

    // Progress
    progressCurrent: $('progressCurrent'),
    progressTarget: $('progressTarget'),
    progressFill: $('progressFill'),
    needMore: $('needMore'),
    nextReward: $('nextReward'),
    nextMilestoneText: $('nextMilestoneText'),

    // Milestones
    milestoneGrid: $('milestoneGrid'),

    // Referral
    referralLinkDisplay: $('referralLinkDisplay'),
    copyReferralBtn: $('copyReferralBtn'),
    totalReferralsDisplay: $('totalReferralsDisplay'),
    referralCodeDisplay: $('referralCodeDisplay'),

    // Withdrawal
    withdrawalSection: $('withdrawalSection'),
    withdrawAmount: $('withdrawAmount'),
    walletAddressInput: $('walletAddressInput'),
    withdrawBtn: $('withdrawBtn'),
    withdrawalStatus: $('withdrawalStatus'),

    // Not Eligible
    notEligibleBox: $('notEligibleBox')
};

// ============================================================
// TOAST SYSTEM
// ============================================================
function showToast(message, type = 'success') {
    const container = el.toastContainer;
    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;
    const iconMap = {
        success: 'bi-check-circle-fill text-success',
        error: 'bi-exclamation-triangle-fill text-danger',
        warning: 'bi-exclamation-triangle-fill text-warning'
    };
    const icon = iconMap[type] || iconMap.success;
    toast.innerHTML = `<i class="bi ${icon}"></i><span class="toast-msg">${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

// ============================================================
// CAMPAIGN STATUS
// ============================================================
function getCampaignStatus() {
    const now = new Date();
    if (now < CAMPAIGN.startDate) return 'UPCOMING';
    if (now >= CAMPAIGN.startDate && now <= CAMPAIGN.endDate) return 'ACTIVE';
    return 'ENDED';
}

// ============================================================
// COUNTDOWN
// ============================================================
function startCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);

    function update() {
        const now = new Date();
        const diff = CAMPAIGN.endDate - now;

        if (diff <= 0) {
            el.countdownWrapper.style.display = 'none';
            el.campaignEndedMessage.style.display = 'block';
            if (countdownInterval) clearInterval(countdownInterval);
            return;
        }

        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);

        el.countdownDays.textContent = String(days).padStart(2, '0');
        el.countdownHours.textContent = String(hours).padStart(2, '0');
        el.countdownMinutes.textContent = String(minutes).padStart(2, '0');
        el.countdownSeconds.textContent = String(seconds).padStart(2, '0');
    }

    update();
    countdownInterval = setInterval(update, 1000);
}

// ============================================================
// CALCULATE REWARD
// ============================================================
function calculateReward(directCount) {
    if (directCount < CAMPAIGN.minQualifying) return 0;
    const capped = Math.min(directCount, CAMPAIGN.maxQualifying);
    // Find the highest milestone <= capped
    let reward = 0;
    for (const m of MILESTONES) {
        if (m.refs <= capped) {
            reward = m.reward;
        }
    }
    return reward;
}

function getNextMilestone(directCount) {
    for (const m of MILESTONES) {
        if (m.refs > directCount) {
            return m;
        }
    }
    return null; // Already at max
}

// ============================================================
// GET DIRECT REFERRALS
// ============================================================
async function getDirectReferrals(userId) {
    try {
        const userSnap = await get(ref(db, 'users/' + userId));
        if (!userSnap.exists()) return 0;

        const userData = userSnap.val();
        // Direct referrals are level1 in teamStructure
        const teamStructure = userData.teamStructure || {};
        return teamStructure.level1 || 0;
    } catch (error) {
        console.error('Error getting direct referrals:', error);
        return 0;
    }
}

// ============================================================
// GET REFERRAL LINK
// ============================================================
function getReferralLink(referralCode) {
    const domain = 'https://staking.randigital.in';
    return `${domain}/register.html?ref=${referralCode}`;
}

// ============================================================
// CHECK WITHDRAWAL STATUS
// ============================================================
async function checkWithdrawalStatus(userId) {
    try {
        const campaignRef = ref(db, `campaign_rewards/${userId}`);
        const snap = await get(campaignRef);
        if (!snap.exists()) return null;

        const data = snap.val();
        return {
            status: data.status || 'pending',
            reward: data.eligibleReward || 0,
            walletAddress: data.walletAddress || '',
            requestedAt: data.requestedAt || null,
            paidAt: data.paidAt || null,
            txHash: data.txHash || null,
            transactionId: data.transactionId || null
        };
    } catch (error) {
        console.error('Error checking withdrawal status:', error);
        return null;
    }
}

// ============================================================
// CREATE WITHDRAWAL REQUEST
// ============================================================
async function createWithdrawalRequest(userId, rewardAmount, walletAddress) {
    try {
        // Check if already requested
        const existing = await checkWithdrawalStatus(userId);
        if (existing && existing.status !== 'rejected') {
            return { success: false, error: 'You have already submitted a withdrawal request for this campaign.' };
        }

        // Get user data for transaction
        const userSnap = await get(ref(db, 'users/' + userId));
        if (!userSnap.exists()) {
            return { success: false, error: 'User data not found.' };
        }
        const userData = userSnap.val();

        // Generate unique withdrawal ID
        const withdrawalId = 'wd_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

        // Create campaign reward record
        const campaignData = {
            campaignId: 'direct_offer_2026',
            campaignName: CAMPAIGN.name,
            userId: userId,
            username: userData.username || userData.referralCode || userId,
            email: userData.email || '',
            directCount: directReferrals,
            eligibleReward: rewardAmount,
            status: 'pending',
            walletAddress: walletAddress,
            requestedAt: Date.now(),
            updatedAt: Date.now(),
            withdrawalId: withdrawalId,
            transactionId: null,
            txHash: null,
            paidAt: null
        };

        await set(ref(db, `campaign_rewards/${userId}`), campaignData);

        // Also create a backup in admin/withdrawals for admin panel visibility
        const adminRef = ref(db, `admin/withdrawals/${withdrawalId}`);
        await set(adminRef, {
            ...campaignData,
            withdrawalId: withdrawalId,
            type: 'direct_offer_withdrawal',
            asset: 'USDT',
            network: 'BEP-20 / BNB Smart Chain',
            amount: rewardAmount,
            status: 'pending'
        });

        // Create transaction record in user's transaction history
        const txId = 'tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        const transaction = {
            type: 'direct_offer_withdrawal',
            subtype: 'Direct Referral Offer Withdrawal',
            amount: rewardAmount,
            currency: 'USDT',
            network: 'BEP-20 / BNB Smart Chain',
            status: 'pending',
            walletAddress: walletAddress,
            withdrawalId: withdrawalId,
            timestamp: Date.now(),
            date: new Date().toISOString().split('T')[0],
            description: `Direct Referral Offer Withdrawal of $${rewardAmount} USDT (BEP-20)`,
            txId: txId,
            txHash: null
        };

        const txRef = ref(db, `users/${userId}/transactions/${txId}`);
        await set(txRef, transaction);

        // Also add to global transactions for admin
        const globalTxRef = ref(db, `transactions/${txId}`);
        await set(globalTxRef, {
            ...transaction,
            userId: userId,
            username: userData.username || userData.referralCode || userId
        });

        return { success: true, withdrawalId: withdrawalId };

    } catch (error) {
        console.error('Error creating withdrawal request:', error);
        return { success: false, error: error.message || 'Failed to submit withdrawal request.' };
    }
}

// ============================================================
// RENDER MILESTONE CARDS
// ============================================================
function renderMilestones(directCount) {
    const grid = el.milestoneGrid;
    grid.innerHTML = '';

    for (const m of MILESTONES) {
        const achieved = directCount >= m.refs;
        const isNext = !achieved && (directCount < CAMPAIGN.maxQualifying);

        let statusClass = 'locked';
        let statusText = 'Locked';
        if (achieved) {
            statusClass = 'achieved';
            statusText = '✓ Achieved';
        } else if (isNext) {
            statusClass = 'next';
            statusText = 'Next Target';
        }

        const card = document.createElement('div');
        card.className = `milestone-card ${statusClass}`;
        card.innerHTML = `
            <div class="refs">${m.refs} <small>Direct</small></div>
            <div class="reward">$${m.reward}</div>
            <span class="status-badge ${statusClass}">${statusText}</span>
        `;
        grid.appendChild(card);
    }
}

// ============================================================
// UPDATE UI
// ============================================================
function updateUI() {
    const directCount = directReferrals;
    const reward = calculateReward(directCount);
    const next = getNextMilestone(directCount);
    const maxMilestone = MILESTONES[MILESTONES.length - 1];

    // Stats
    el.statDirectRefs.textContent = directCount;
    el.statEligibleReward.textContent = '$' + reward;

    if (next) {
        el.statNextMilestone.textContent = `${next.refs} → $${next.reward}`;
        const need = next.refs - directCount;
        el.statNextMilestoneSub.textContent = `${need} more needed`;
    } else if (directCount >= CAMPAIGN.maxQualifying) {
        el.statNextMilestone.textContent = '🎯 Max Reached!';
        el.statNextMilestoneSub.textContent = 'You\'ve hit the maximum!';
    } else {
        el.statNextMilestone.textContent = '--';
        el.statNextMilestoneSub.textContent = '';
    }

    el.statMaxReward.textContent = '$' + CAMPAIGN.maxReward;

    // Progress
    const progress = Math.min((directCount / CAMPAIGN.maxQualifying) * 100, 100);
    el.progressCurrent.textContent = Math.min(directCount, CAMPAIGN.maxQualifying);
    el.progressTarget.textContent = CAMPAIGN.maxQualifying;
    el.progressFill.style.width = progress + '%';

    if (next) {
        const need = next.refs - directCount;
        el.needMore.textContent = need;
        el.nextReward.textContent = '$' + next.reward;
        el.nextMilestoneText.style.display = 'block';
    } else if (directCount >= CAMPAIGN.maxQualifying) {
        el.needMore.textContent = '0';
        el.nextReward.textContent = '$' + CAMPAIGN.maxReward;
        el.nextMilestoneText.innerHTML = '<i class="bi bi-trophy" style="color:#fbbf24;"></i> 🎉 You\'ve reached the maximum reward of <strong>$' + CAMPAIGN.maxReward + '</strong>!';
    } else {
        el.nextMilestoneText.style.display = 'none';
    }

    // Milestones
    renderMilestones(directCount);

    // Not Eligible
    if (directCount < CAMPAIGN.minQualifying) {
        el.notEligibleBox.classList.add('visible');
    } else {
        el.notEligibleBox.classList.remove('visible');
    }

    // Withdrawal Section
    const status = getCampaignStatus();
    const isEligible = directCount >= CAMPAIGN.minQualifying && reward > 0;

    if (status === 'ENDED' && isEligible) {
        el.withdrawalSection.classList.add('visible');

        // Check if already requested
        checkWithdrawalStatus(currentUserId).then(wStatus => {
            if (wStatus) {
                el.withdrawAmount.textContent = '$' + wStatus.reward.toFixed(2) + ' USDT';
                if (wStatus.status === 'pending') {
                    el.withdrawBtn.disabled = true;
                    el.withdrawBtn.innerHTML = '<i class="bi bi-clock me-2"></i>Pending Approval';
                    showWithdrawalStatus('pending', 'Your withdrawal request is pending admin approval.');
                } else if (wStatus.status === 'approved') {
                    el.withdrawBtn.disabled = true;
                    el.withdrawBtn.innerHTML = '<i class="bi bi-check-circle me-2"></i>Approved';
                    showWithdrawalStatus('approved', 'Your withdrawal has been approved and is being processed.');
                } else if (wStatus.status === 'paid') {
                    el.withdrawBtn.disabled = true;
                    el.withdrawBtn.innerHTML = '<i class="bi bi-check-circle-fill me-2"></i>Paid';
                    showWithdrawalStatus('approved', '✅ Payment completed! Tx Hash: ' + (wStatus.txHash || 'N/A'));
                } else if (wStatus.status === 'rejected') {
                    el.withdrawBtn.disabled = false;
                    el.withdrawBtn.innerHTML = '<i class="bi bi-arrow-up-right me-2"></i>Withdraw Reward';
                    showWithdrawalStatus('rejected', 'Your previous request was rejected. You can try again.');
                }
            } else {
                el.withdrawAmount.textContent = '$' + reward.toFixed(2) + ' USDT';
                el.withdrawBtn.disabled = false;
                el.withdrawBtn.innerHTML = '<i class="bi bi-arrow-up-right me-2"></i>Withdraw Reward';
                el.withdrawalStatus.classList.remove('visible');
            }
        });

    } else if (status === 'ACTIVE') {
        el.withdrawalSection.classList.remove('visible');
        if (isEligible) {
            showToast('Withdrawal will be available after the offer ends.', 'warning');
        }
    } else if (status === 'UPCOMING') {
        el.withdrawalSection.classList.remove('visible');
    } else {
        el.withdrawalSection.classList.remove('visible');
    }
}

// ============================================================
// SHOW WITHDRAWAL STATUS
// ============================================================
function showWithdrawalStatus(type, message) {
    const statusEl = el.withdrawalStatus;
    statusEl.className = 'withdrawal-status visible ' + type;
    statusEl.textContent = message;
}

// ============================================================
// LOAD USER DATA
// ============================================================
async function loadUserData(user) {
    try {
        currentUserId = user.uid;
        const userSnap = await get(ref(db, 'users/' + user.uid));

        if (!userSnap.exists()) {
            showToast('User data not found. Please complete registration.', 'error');
            return;
        }

        currentUserData = userSnap.val();

        // Update user badge
        const name = currentUserData.name || currentUserData.username || 'User';
        el.userName.textContent = name;
        el.userAvatar.textContent = name.charAt(0).toUpperCase();

        // Get direct referrals
        directReferrals = await getDirectReferrals(user.uid);

        // Update referral link
        const referralCode = currentUserData.referralCode || user.uid.substring(0, 8).toUpperCase();
        const link = getReferralLink(referralCode);
        el.referralLinkDisplay.textContent = link;
        el.referralCodeDisplay.textContent = referralCode;
        el.totalReferralsDisplay.textContent = directReferrals;

        // Campaign status
        campaignStatus = getCampaignStatus();

        // Update UI
        updateUI();

        // Show toast based on status
        if (campaignStatus === 'UPCOMING') {
            showToast('📢 Direct Referral Offer starts on 6 September 2026!', 'warning');
        } else if (campaignStatus === 'ACTIVE') {
            showToast('🎯 Offer is ACTIVE! Refer more to earn more!', 'success');
        } else if (campaignStatus === 'ENDED') {
            if (directReferrals >= CAMPAIGN.minQualifying) {
                showToast('🏆 Offer ended! You are eligible for reward withdrawal.', 'success');
            } else {
                showToast('⏰ Offer ended. You need at least 5 Direct Referrals to qualify.', 'warning');
            }
        }

        // Hide loading
        el.loadingOverlay.classList.add('hidden');

    } catch (error) {
        console.error('Error loading user data:', error);
        showToast('Error loading data: ' + error.message, 'error');
        el.loadingOverlay.classList.add('hidden');
    }
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
        // Fallback
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
// HANDLE WITHDRAWAL
// ============================================================
async function handleWithdrawal() {
    const walletAddress = el.walletAddressInput.value.trim();

    // Validate wallet address (basic BEP-20 format check)
    if (!walletAddress) {
        showToast('Please enter a BEP-20 USDT wallet address.', 'error');
        return;
    }

    if (!walletAddress.startsWith('0x') || walletAddress.length !== 42) {
        showToast('Please enter a valid BEP-20 USDT wallet address (0x...).', 'error');
        return;
    }

    // Check campaign status
    if (getCampaignStatus() !== 'ENDED') {
        showToast('Withdrawal is only available after the offer ends.', 'error');
        return;
    }

    // Check eligibility
    if (directReferrals < CAMPAIGN.minQualifying) {
        showToast('You are not eligible for this reward.', 'error');
        return;
    }

    const reward = calculateReward(directReferrals);
    if (reward <= 0) {
        showToast('You are not eligible for this reward.', 'error');
        return;
    }

    // Check if already requested
    const existing = await checkWithdrawalStatus(currentUserId);
    if (existing && existing.status !== 'rejected') {
        showToast('You have already submitted a withdrawal request for this campaign.', 'warning');
        return;
    }

    // Disable button
    el.withdrawBtn.disabled = true;
    el.withdrawBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Submitting...';

    try {
        const result = await createWithdrawalRequest(currentUserId, reward, walletAddress);

        if (result.success) {
            showToast('✅ Your withdrawal request has been submitted successfully.', 'success');
            el.withdrawBtn.innerHTML = '<i class="bi bi-clock me-2"></i>Pending Approval';
            el.withdrawBtn.disabled = true;
            showWithdrawalStatus('pending', 'Your withdrawal request is pending admin approval.');
            el.walletAddressInput.value = '';
        } else {
            showToast('❌ ' + result.error, 'error');
            el.withdrawBtn.disabled = false;
            el.withdrawBtn.innerHTML = '<i class="bi bi-arrow-up-right me-2"></i>Withdraw Reward';
        }
    } catch (error) {
        console.error('Withdrawal error:', error);
        showToast('❌ Error submitting withdrawal request. Please try again.', 'error');
        el.withdrawBtn.disabled = false;
        el.withdrawBtn.innerHTML = '<i class="bi bi-arrow-up-right me-2"></i>Withdraw Reward';
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
        console.error('Logout error:', error);
        showToast('Error logging out.', 'error');
    }
}

// ============================================================
// SETUP LISTENERS
// ============================================================
function setupListeners() {
    el.copyReferralBtn.addEventListener('click', copyReferralLink);
    el.logoutBtn.addEventListener('click', handleLogout);
    el.withdrawBtn.addEventListener('click', handleWithdrawal);

    // Real-time update when user data changes
    if (currentUserId) {
        const userRef = ref(db, 'users/' + currentUserId);
        onValue(userRef, async (snapshot) => {
            if (snapshot.exists()) {
                currentUserData = snapshot.val();
                const newDirect = await getDirectReferrals(currentUserId);
                if (newDirect !== directReferrals) {
                    directReferrals = newDirect;
                    el.totalReferralsDisplay.textContent = directReferrals;
                    updateUI();
                }
            }
        });
    }
}

// ============================================================
// MAIN AUTH HANDLER
// ============================================================
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'login.html';
        return;
    }

    currentUser = user;
    await loadUserData(user);
    startCountdown();
    setupListeners();
});

// ============================================================
// CLEANUP
// ============================================================
window.addEventListener('beforeunload', () => {
    if (countdownInterval) {
        clearInterval(countdownInterval);
    }
});