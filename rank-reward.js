// ============================================================
// RANK REWARD - PRODUCTION READY v8 (TRUE ATOMIC MULTI-LOCATION)
// ============================================================
// RANK SYSTEM:
// Member    → $0      → $0 reward
// Executive → $3,000  → $100 reward  ✅
// Senior Exec → $10,000 → $200 reward  ✅
// Manager   → $25,000 → $500 reward  ✅
// Sr. Manager → $50,000 → $1,000 reward  ✅
// Diamond   → $100,000 → $2,500 reward  ✅
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import {
    getDatabase,
    ref,
    get,
    runTransaction,
    onValue,
    set,
    update
} from "firebase/database";

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
// RANK THRESHOLDS (CUMULATIVE - NEVER SUBTRACT)
// ============================================================
const RANK_LEVELS = [
    { key: 'member', rank: 'Member', minBusiness: 0, reward: 0, icon: '👤' },
    { key: 'executive', rank: 'Executive', minBusiness: 3000, reward: 100, icon: '📈' },
    { key: 'seniorExecutive', rank: 'Senior Executive', minBusiness: 10000, reward: 200, icon: '⭐' },
    { key: 'manager', rank: 'Manager', minBusiness: 25000, reward: 500, icon: '👔' },
    { key: 'seniorManager', rank: 'Senior Manager', minBusiness: 50000, reward: 1000, icon: '🏆' },
    { key: 'diamond', rank: 'Diamond', minBusiness: 100000, reward: 2500, icon: '💎' }
];

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;
    const icon = type === 'success' ? 'bi-check-circle-fill' :
        type === 'error' ? 'bi-exclamation-triangle-fill' :
        type === 'warning' ? 'bi-exclamation-triangle-fill' :
        'bi-info-circle-fill';
    toast.innerHTML = `<i class="bi ${icon}"></i><span class="toast-msg">${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

function formatCurrency(amount) {
    const value = Number(amount);
    return '$' + (Number.isFinite(value) ? value : 0).toFixed(2);
}

function formatDateTime(timestamp) {
    if (!timestamp) return '-';
    return new Date(timestamp).toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function generateTxId() {
    return 'rank_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
}

function getTodayDate() {
    return new Date().toISOString().split('T')[0];
}

// ============================================================
// CALCULATE RANK - BASED ONLY ON teamBusiness
// ============================================================
function calculateRank(teamBusiness) {
    const business = Number(teamBusiness) || 0;
    let current = RANK_LEVELS[0];
    for (let level of RANK_LEVELS) {
        if (business >= level.minBusiness) {
            current = level;
        }
    }
    return current;
}

function getNextRank(teamBusiness) {
    const business = Number(teamBusiness) || 0;
    const current = calculateRank(business);
    const currentIndex = RANK_LEVELS.findIndex(level => level.key === current.key);
    if (currentIndex >= RANK_LEVELS.length - 1) {
        return null;
    }
    return RANK_LEVELS[currentIndex + 1];
}

function getRankByKey(key) {
    return RANK_LEVELS.find(r => r.key === key) || RANK_LEVELS[0];
}

// ============================================================
// GET RANK REWARD STATUS - SINGLE SOURCE OF TRUTH
// ============================================================
async function getRankRewardStatus(userId) {
    try {
        const refPath = ref(db, `rankRewards/${userId}`);
        const snap = await get(refPath);
        if (snap.exists()) {
            return snap.val();
        }
        return {};
    } catch (error) {
        console.error('Error getting rank reward status:', error);
        return {};
    }
}

function calculateTotalRankReward(rankRewardStatus) {
    let total = 0;
    for (let key in rankRewardStatus) {
        const reward = rankRewardStatus[key];
        if (reward && reward.status === 'completed') {
            total += Number(reward.rewardAmount) || 0;
        }
    }
    return total;
}

// ============================================================
// 🔥🔥🔥 TRUE ATOMIC TRANSACTION WITH MULTI-PATH UPDATE 🔥🔥🔥
// ============================================================
async function processSingleRankReward(userId, rankKey, teamBusiness) {
    try {
        const rankInfo = getRankByKey(rankKey);
        const rewardAmount = rankInfo.reward;
        
        if (rewardAmount <= 0) {
            console.log(`ℹ️ ${rankInfo.rank} has no reward to claim`);
            return { success: false, error: 'No reward for this rank' };
        }

        // ============================================================
        // Check if already claimed - SINGLE SOURCE OF TRUTH
        // ============================================================
        const rankRewardStatus = await getRankRewardStatus(userId);
        if (rankRewardStatus[rankKey] && rankRewardStatus[rankKey].status === 'completed') {
            console.log(`ℹ️ ${rankInfo.rank} already claimed (rankRewards record exists)`);
            return { success: false, alreadyClaimed: true };
        }

        const userSnap = await get(ref(db, 'users/' + userId));
        if (!userSnap.exists()) {
            return { success: false, error: 'User not found' };
        }
        
        const userData = userSnap.val();
        if (userData._rankRewardsClaimed && userData._rankRewardsClaimed[rankKey] === true) {
            console.log(`ℹ️ ${rankInfo.rank} already claimed (legacy user flag exists)`);
            // Repair: Create the rankRewards record if missing
            await set(ref(db, `rankRewards/${userId}/${rankKey}`), {
                rank: rankInfo.rank,
                rankKey: rankKey,
                requiredBusiness: rankInfo.minBusiness,
                rewardAmount: rewardAmount,
                teamBusinessAtReward: teamBusiness,
                creditedAt: Date.now(),
                creditedDate: getTodayDate(),
                status: 'completed',
                transactionId: 'legacy_' + Date.now()
            });
            return { success: false, alreadyClaimed: true, repaired: true };
        }

        const txId = generateTxId();
        const timestamp = Date.now();

        // ============================================================
        // 🔥🔥🔥 THE MAGIC: ATOMIC MULTI-PATH UPDATE 🔥🔥🔥
        // This updates BOTH locations in a SINGLE ATOMIC operation!
        // ============================================================
        
        // Prepare the multi-path update object
        const multiPathUpdate = {};
        
        // 1. Update user's wallet and claim status
        const currentWallet = Number(userData.depositWallet) || 0;
        const newWallet = currentWallet + rewardAmount;
        
        // User path updates
        multiPathUpdate[`users/${userId}/depositWallet`] = newWallet;
        multiPathUpdate[`users/${userId}/rank`] = rankInfo.rank;
        multiPathUpdate[`users/${userId}/_rankRewardsClaimed/${rankKey}`] = true;
        multiPathUpdate[`users/${userId}/transactions/${txId}`] = {
            type: 'rank_reward',
            rank: rankInfo.rank,
            rankKey: rankKey,
            amount: rewardAmount,
            currency: 'USDT',
            wallet: 'depositWallet',
            requiredTeamBusiness: rankInfo.minBusiness,
            teamBusinessAtReward: teamBusiness,
            timestamp: timestamp,
            date: getTodayDate(),
            status: 'completed',
            description: `🏆 ${rankInfo.rank} Rank Reward: $${rewardAmount} credited to Deposit Wallet`,
            source: 'rank_reward_system_v8',
            atomic: true
        };
        
        // 2. RankRewards record path
        multiPathUpdate[`rankRewards/${userId}/${rankKey}`] = {
            rank: rankInfo.rank,
            rankKey: rankKey,
            requiredBusiness: rankInfo.minBusiness,
            rewardAmount: rewardAmount,
            teamBusinessAtReward: teamBusiness,
            creditedAt: timestamp,
            creditedDate: getTodayDate(),
            status: 'completed',
            transactionId: txId,
            source: 'rank_reward_system_v8',
            atomic: true
        };

        // ============================================================
        // 🔥🔥🔥 SINGLE ATOMIC UPDATE - ALL OR NOTHING 🔥🔥🔥
        // ============================================================
        console.log(`🔍 Attempting atomic multi-path update for ${rankInfo.rank}...`);
        console.log(`   - Updating wallet: $${currentWallet} → $${newWallet}`);
        console.log(`   - Setting claim flag for: ${rankKey}`);
        console.log(`   - Creating rankRewards record for: ${rankKey}`);
        console.log(`   - Creating transaction: ${txId}`);
        
        await update(ref(db), multiPathUpdate);
        
        console.log(`✅ TRUE ATOMIC transaction completed for ${rankInfo.rank}`);
        console.log(`   - ALL writes succeeded together`);
        console.log(`   - No partial updates possible`);
        
        showToast(`🏆 ${rankInfo.rank} Rank Reward: $${rewardAmount} credited to Deposit Wallet!`, 'success');
        
        // Verify the update was successful
        const verifySnap = await get(ref(db, `rankRewards/${userId}/${rankKey}`));
        if (verifySnap.exists()) {
            console.log(`✅ Verification: rankRewards record exists for ${rankKey}`);
        } else {
            console.log(`⚠️ Warning: rankRewards record not found after atomic update`);
            // This should never happen with a true atomic update
        }
        
        return { 
            success: true, 
            alreadyClaimed: false, 
            rank: rankInfo.rank, 
            amount: rewardAmount, 
            txId: txId,
            atomic: true
        };

    } catch (error) {
        console.error('❌ Error in atomic transaction:', error);
        
        // ============================================================
        // 🔥 With true atomic updates, we DON'T need reversal logic
        // because either ALL writes succeed or NONE do.
        // ============================================================
        
        // Check if any partial writes occurred (shouldn't happen with atomic)
        try {
            const checkRankReward = await get(ref(db, `rankRewards/${userId}/${rankKey}`));
            const checkWallet = await get(ref(db, `users/${userId}/depositWallet`));
            
            if (checkRankReward.exists() || checkWallet.exists()) {
                console.log('⚠️ Partial write detected despite atomic attempt - manual intervention may be needed');
                // Log for monitoring
                console.log(`🚨 MANUAL CHECK REQUIRED: User ${userId}, Rank ${rankKey}`);
                console.log(`   - rankRewards exists: ${checkRankReward.exists()}`);
                console.log(`   - wallet exists: ${checkWallet.exists()}`);
            }
        } catch (checkError) {
            console.error('Error checking for partial writes:', checkError);
        }
        
        return { success: false, error: error.message };
    }
}

// ============================================================
// CHECK AND PROCESS ALL ELIGIBLE RANK REWARDS
// ============================================================
async function checkAndProcessAllRankRewards(userId, teamBusiness) {
    try {
        const rankRewardStatus = await getRankRewardStatus(userId);
        const userSnap = await get(ref(db, 'users/' + userId));
        const userData = userSnap.exists() ? userSnap.val() : {};
        const userClaimed = userData._rankRewardsClaimed || {};

        const processed = [];
        const errors = [];
        let anyProcessed = false;

        for (let level of RANK_LEVELS) {
            if (level.reward === 0) continue;

            const isClaimedInRankRewards = rankRewardStatus[level.key] && 
                                          rankRewardStatus[level.key].status === 'completed';
            const isClaimedInUser = userClaimed[level.key] === true;

            if (isClaimedInRankRewards) {
                continue;
            }

            if (isClaimedInUser && !isClaimedInRankRewards) {
                // Repair missing rankRewards record
                console.log(`🔧 Repairing missing rankRewards record for ${level.rank}`);
                try {
                    await set(ref(db, `rankRewards/${userId}/${level.key}`), {
                        rank: level.rank,
                        rankKey: level.key,
                        requiredBusiness: level.minBusiness,
                        rewardAmount: level.reward,
                        teamBusinessAtReward: teamBusiness,
                        creditedAt: Date.now(),
                        creditedDate: getTodayDate(),
                        status: 'completed',
                        transactionId: 'repaired_' + Date.now(),
                        source: 'repair_system'
                    });
                    console.log(`✅ Repaired rankRewards record for ${level.rank}`);
                } catch (repairError) {
                    console.error(`❌ Failed to repair ${level.rank}:`, repairError);
                }
                continue;
            }

            if (teamBusiness >= level.minBusiness) {
                console.log(`🔍 Processing ${level.rank} reward with atomic update...`);
                const result = await processSingleRankReward(
                    userId,
                    level.key,
                    teamBusiness
                );
                
                if (result.success) {
                    processed.push(level.rank);
                    anyProcessed = true;
                } else if (result.alreadyClaimed) {
                    console.log(`ℹ️ ${level.rank} was claimed by another process`);
                } else if (result.error) {
                    errors.push({ rank: level.rank, error: result.error });
                }
            }
        }

        return { processed, errors, anyProcessed };

    } catch (error) {
        console.error('Error checking rank rewards:', error);
        return { processed: [], errors: [{ rank: 'System', error: error.message }], anyProcessed: false };
    }
}

// ============================================================
// RENDER UI (SAME AS BEFORE)
// ============================================================
function renderUI(userData, rankRewardStatus) {
    const teamBusiness = Number(userData.teamBusiness) || 0;
    const currentRank = calculateRank(teamBusiness);
    const nextRank = getNextRank(teamBusiness);
    const name = userData.name || 'User';
    const depositWallet = Number(userData.depositWallet) || 0;
    const username = userData.username || userData.referralCode || 'USER';

    const totalRankReward = calculateTotalRankReward(rankRewardStatus);
    const rewardCount = Object.values(rankRewardStatus)
        .filter(r => r.status === 'completed').length;

    document.getElementById('sidebarName').textContent = name;
    document.getElementById('sidebarEmail').textContent = userData.email || 'user@example.com';
    document.getElementById('sidebarUserId').textContent = 'ID: ' + username.substring(0, 20) + '...';
    document.getElementById('sidebarAvatar').textContent = name.charAt(0).toUpperCase();

    document.getElementById('totalBusiness').textContent = formatCurrency(teamBusiness);
    document.getElementById('currentRankDisplay').textContent = currentRank.rank;
    document.getElementById('rankRewardDisplay').textContent = currentRank.reward > 0 ? 
        `Reward: ${formatCurrency(currentRank.reward)}` : 'No reward for this rank';
    document.getElementById('totalRankReward').textContent = formatCurrency(totalRankReward);
    document.getElementById('rewardCount').textContent = rewardCount + ' rewards earned';

    document.getElementById('currentRankText').textContent = currentRank.rank + ' ' + currentRank.icon;
    document.getElementById('currentBusinessDisplay').textContent = formatCurrency(teamBusiness);

    const nextRankInfo = document.getElementById('nextRankInfo');
    const nextRankText = document.getElementById('nextRankText');
    const needForNext = document.getElementById('needForNext');

    if (nextRank && currentRank.key !== 'diamond') {
        const remaining = Math.max(0, nextRank.minBusiness - teamBusiness);
        const progress = Math.min(100, (teamBusiness / nextRank.minBusiness) * 100);
        
        nextRankText.textContent = nextRank.rank + ' ' + nextRank.icon;
        needForNext.textContent = formatCurrency(remaining);
        nextRankInfo.style.display = 'block';
        
        document.getElementById('rankProgressFill').style.width = progress + '%';
        document.getElementById('progressCurrent').textContent = formatCurrency(teamBusiness);
        document.getElementById('progressTarget').textContent = formatCurrency(nextRank.minBusiness);
        document.getElementById('progressPercent').textContent = progress.toFixed(1) + '%';
    } else if (currentRank.key === 'diamond') {
        nextRankText.textContent = '🏆 MAX RANK';
        needForNext.textContent = '$0';
        nextRankInfo.style.display = 'block';
        document.getElementById('rankProgressFill').style.width = '100%';
        document.getElementById('progressCurrent').textContent = formatCurrency(teamBusiness);
        document.getElementById('progressTarget').textContent = formatCurrency(teamBusiness);
        document.getElementById('progressPercent').textContent = '100%';
    } else {
        nextRankInfo.style.display = 'none';
    }

    const tableBody = document.getElementById('rankTableBody');
    let tableRows = '';

    for (let level of RANK_LEVELS) {
        const isAchieved = rankRewardStatus[level.key]?.status === 'completed';
        const isCurrent = level.key === currentRank.key;
        const isEligible = !isAchieved && teamBusiness >= level.minBusiness && level.reward > 0;

        let statusBadge = '';
        if (isAchieved) {
            statusBadge = `<span class="badge-status achieved">✅ Achieved</span>`;
        } else if (isEligible) {
            statusBadge = `<span class="badge-status eligible">⏳ Eligible</span>`;
        } else if (isCurrent && level.reward === 0) {
            statusBadge = `<span class="badge-status current">Current</span>`;
        } else if (isCurrent) {
            statusBadge = `<span class="badge-status current">Current</span>`;
        } else {
            statusBadge = `<span class="badge-status locked">🔒 Locked</span>`;
        }

        const rewardDisplay = level.reward > 0 ? formatCurrency(level.reward) : '$0';
        const rowClass = isCurrent ? 'style="background:rgba(251,191,36,0.05);"' : '';

        tableRows += `
            <tr ${rowClass}>
                <td><span class="rank-icon-small">${level.icon}</span> ${level.rank}</td>
                <td>${formatCurrency(level.minBusiness)}</td>
                <td>${rewardDisplay}</td>
                <td>${statusBadge}</td>
            </tr>
        `;
    }

    tableBody.innerHTML = tableRows;

    const historyList = document.getElementById('historyList');
    const historyItems = Object.values(rankRewardStatus)
        .filter(r => r.status === 'completed')
        .sort((a, b) => (b.creditedAt || 0) - (a.creditedAt || 0));

    if (historyItems.length === 0) {
        historyList.innerHTML = `
            <div class="history-empty">
                <i class="bi bi-clock"></i>
                No rank rewards earned yet.
                <br><span style="font-size:13px;">Build your team business to unlock ranks!</span>
                <br><span style="font-size:12px;color:#556688;">Start with Executive at $3,000</span>
            </div>
        `;
    } else {
        let historyHTML = '';
        for (let item of historyItems) {
            historyHTML += `
                <div class="history-item">
                    <div class="h-left">
                        <div class="h-icon">🏆</div>
                        <div>
                            <div class="h-rank">${item.rank}</div>
                            <div class="h-desc">Required: ${formatCurrency(item.requiredBusiness)}</div>
                            <div class="h-desc" style="font-size:11px;color:rgba(255,255,255,0.2);">Tx: ${item.transactionId || 'N/A'}</div>
                        </div>
                    </div>
                    <div class="h-right">
                        <div class="h-amount">+${formatCurrency(item.rewardAmount)}</div>
                        <div class="h-date">${formatDateTime(item.creditedAt)}</div>
                    </div>
                </div>
            `;
        }
        historyList.innerHTML = historyHTML;
    }
}

// ============================================================
// LOAD RANK DATA
// ============================================================
let currentUserId = null;
let teamBusinessListenerOff = null;
let isProcessing = false;
let processingLock = false;

async function loadRankData(userId) {
    try {
        document.getElementById('loadingContainer').style.display = 'flex';
        document.getElementById('contentContainer').style.display = 'none';

        const userSnap = await get(ref(db, 'users/' + userId));
        if (!userSnap.exists()) {
            showToast('❌ User data not found', 'error');
            return;
        }

        const userData = userSnap.val();
        const teamBusiness = Number(userData.teamBusiness) || 0;

        let rankRewardStatus = await getRankRewardStatus(userId);

        if (!isProcessing && !processingLock) {
            processingLock = true;
            isProcessing = true;
            try {
                const processingResult = await checkAndProcessAllRankRewards(userId, teamBusiness);
                if (processingResult && processingResult.anyProcessed) {
                    rankRewardStatus = await getRankRewardStatus(userId);
                    showToast(`✅ ${processingResult.processed.join(', ')} rank rewards earned!`, 'success');
                }
                if (processingResult && processingResult.errors && processingResult.errors.length > 0) {
                    console.error('Errors during processing:', processingResult.errors);
                }
            } catch (error) {
                console.error('Error processing rewards:', error);
            } finally {
                isProcessing = false;
                processingLock = false;
            }
        }

        renderUI(userData, rankRewardStatus);

        document.getElementById('loadingContainer').style.display = 'none';
        document.getElementById('contentContainer').style.display = 'block';

        setupTeamBusinessListener(userId);

    } catch (error) {
        console.error('Error loading rank data:', error);
        document.getElementById('loadingContainer').innerHTML = `
            <div style="color:#ef4444;font-size:16px;text-align:center;">
                <i class="bi bi-exclamation-triangle-fill" style="font-size:28px;display:block;margin-bottom:12px;"></i>
                Error loading data: ${error.message}
                <br><br>
                <button onclick="location.reload()" style="padding:10px 24px;background:rgba(46,204,113,0.1);border:1px solid rgba(46,204,113,0.2);border-radius:10px;color:#2ecc71;cursor:pointer;">Retry</button>
            </div>
        `;
    }
}

// ============================================================
// REAL-TIME TEAM BUSINESS LISTENER
// ============================================================
function setupTeamBusinessListener(userId) {
    if (teamBusinessListenerOff) {
        teamBusinessListenerOff();
        teamBusinessListenerOff = null;
    }

    const teamBusinessRef = ref(db, 'users/' + userId + '/teamBusiness');

    teamBusinessListenerOff = onValue(teamBusinessRef, async (snapshot) => {
        const teamBusiness = snapshot.val();
        if (teamBusiness === null || teamBusiness === undefined) return;

        console.log(`📊 Real-time teamBusiness update: $${teamBusiness}`);

        const userSnap = await get(ref(db, 'users/' + userId));
        if (!userSnap.exists()) return;

        const userData = userSnap.val();

        let rankRewardStatus = await getRankRewardStatus(userId);

        if (!isProcessing && !processingLock) {
            processingLock = true;
            isProcessing = true;
            try {
                const processingResult = await checkAndProcessAllRankRewards(userId, teamBusiness);
                if (processingResult && processingResult.anyProcessed) {
                    rankRewardStatus = await getRankRewardStatus(userId);
                    showToast(`✅ ${processingResult.processed.join(', ')} rank rewards earned!`, 'success');
                }
            } catch (error) {
                console.error('Error processing rewards:', error);
            } finally {
                isProcessing = false;
                processingLock = false;
            }
        }

        renderUI(userData, rankRewardStatus);
    });
}

// ============================================================
// CLEANUP
// ============================================================
function cleanup() {
    if (teamBusinessListenerOff) {
        teamBusinessListenerOff();
        teamBusinessListenerOff = null;
    }
}

// ============================================================
// SIDEBAR CONTROLS
// ============================================================
const sidebarPanel = document.getElementById('sidebarPanel');
const sidebarOverlay = document.getElementById('sidebarOverlay');
const sidebarToggle = document.getElementById('sidebarToggle');
const sidebarClose = document.getElementById('sidebarClose');

function openSidebar() {
    sidebarPanel.classList.add('open');
    sidebarOverlay.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeSidebar() {
    sidebarPanel.classList.remove('open');
    sidebarOverlay.classList.remove('active');
    document.body.style.overflow = '';
}

sidebarToggle.addEventListener('click', openSidebar);
sidebarClose.addEventListener('click', closeSidebar);
sidebarOverlay.addEventListener('click', closeSidebar);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidebar(); });

document.getElementById('logoutBtnSidebar').addEventListener('click', async (e) => {
    e.preventDefault();
    await signOut(auth);
    window.location.href = 'login.html';
});

// ============================================================
// AUTH HANDLER
// ============================================================
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'login.html';
        return;
    }

    currentUserId = user.uid;
    await loadRankData(user.uid);
});

window.addEventListener('beforeunload', cleanup);
