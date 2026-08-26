// ============================================================
// RANK REWARD - PRODUCTION READY v4 (FULL SETUP)
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
    set
} from "firebase/database";

// ============================================================
// FIREBASE CONFIG - UPDATED
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
    for (let i = RANK_LEVELS.length - 1; i >= 0; i--) {
        if (business < RANK_LEVELS[i].minBusiness) {
            return RANK_LEVELS[i];
        }
    }
    return null;
}

function getRankByKey(key) {
    return RANK_LEVELS.find(r => r.key === key) || RANK_LEVELS[0];
}

// ============================================================
// GET RANK REWARD STATUS
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

// ============================================================
// 🔥 CALCULATE TOTAL RANK REWARD - SUM OF ALL EARNED REWARDS
// ============================================================
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
// 🔥 ATOMIC RANK REWARD - SINGLE TRANSACTION
// ============================================================
async function processSingleRankReward(userId, rankKey, rewardAmount, teamBusiness) {
    try {
        const userRef = ref(db, 'users/' + userId);
        const rankInfo = getRankByKey(rankKey);
        const txId = generateTxId();
        const timestamp = Date.now();

        const result = await runTransaction(userRef, (currentData) => {
            if (!currentData) return currentData;

            const claimed = currentData._rankRewardsClaimed || {};
            if (claimed[rankKey] === true) {
                return currentData;
            }

            const currentWallet = Number(currentData.depositWallet) || 0;
            currentData.depositWallet = currentWallet + rewardAmount;

            currentData.rank = rankInfo.rank;

            if (!currentData._rankRewardsClaimed) {
                currentData._rankRewardsClaimed = {};
            }
            currentData._rankRewardsClaimed[rankKey] = true;

            if (!currentData.transactions) {
                currentData.transactions = {};
            }
            currentData.transactions[txId] = {
                type: 'rank_reward',
                rank: rankInfo.rank,
                amount: rewardAmount,
                currency: 'USDT',
                wallet: 'depositWallet',
                requiredTeamBusiness: rankInfo.minBusiness,
                teamBusinessAtReward: teamBusiness,
                timestamp: timestamp,
                date: getTodayDate(),
                status: 'completed',
                description: `🏆 ${rankInfo.rank} Rank Reward: $${rewardAmount} credited to Deposit Wallet`
            };

            return currentData;
        });

        if (!result.committed) {
            console.log(`❌ Transaction failed for ${rankInfo.rank}`);
            return { success: false, error: 'Transaction failed' };
        }

        if (result.snapshot.exists()) {
            const data = result.snapshot.val();
            const claimed = data._rankRewardsClaimed || {};
            if (claimed[rankKey] === true) {
                console.log(`ℹ️ ${rankInfo.rank} was already claimed`);
                return { success: false, alreadyClaimed: true };
            }
        }

        await set(ref(db, `rankRewards/${userId}/${rankKey}`), {
            rank: rankInfo.rank,
            rankKey: rankKey,
            requiredBusiness: rankInfo.minBusiness,
            rewardAmount: rewardAmount,
            teamBusinessAtReward: teamBusiness,
            creditedAt: timestamp,
            creditedDate: getTodayDate(),
            status: 'completed',
            transactionId: txId
        });

        console.log(`✅ Rank reward processed: ${rankInfo.rank} - $${rewardAmount}`);
        showToast(`🏆 ${rankInfo.rank} Rank Reward: $${rewardAmount} credited to Deposit Wallet!`, 'success');
        return { success: true, alreadyClaimed: false, rank: rankInfo.rank, amount: rewardAmount, txId: txId };

    } catch (error) {
        console.error('❌ Error processing rank reward:', error);
        return { success: false, error: error.message };
    }
}

// ============================================================
// 🔥 CHECK AND PROCESS ALL ELIGIBLE RANK REWARDS
// ============================================================
async function checkAndProcessAllRankRewards(userId, teamBusiness) {
    try {
        const userSnap = await get(ref(db, 'users/' + userId));
        const userData = userSnap.exists() ? userSnap.val() : {};
        const claimed = userData._rankRewardsClaimed || {};

        const processed = [];
        const errors = [];
        let anyProcessed = false;

        // Process ALL ranks from Executive to Diamond
        for (let level of RANK_LEVELS) {
            if (level.reward === 0) continue; // Skip Member (no reward)

            if (teamBusiness >= level.minBusiness) {
                if (claimed[level.key] !== true) {
                    console.log(`🔍 Processing ${level.rank} reward...`);
                    const result = await processSingleRankReward(
                        userId,
                        level.key,
                        level.reward,
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
                } else {
                    console.log(`ℹ️ ${level.rank} already claimed`);
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
// RENDER UI
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

    // Update sidebar
    document.getElementById('sidebarName').textContent = name;
    document.getElementById('sidebarEmail').textContent = userData.email || 'user@example.com';
    document.getElementById('sidebarUserId').textContent = 'ID: ' + username.substring(0, 20) + '...';
    document.getElementById('sidebarAvatar').textContent = name.charAt(0).toUpperCase();

    // ===== SUMMARY CARDS =====
    document.getElementById('totalBusiness').textContent = formatCurrency(teamBusiness);
    document.getElementById('currentRankDisplay').textContent = currentRank.rank;
    document.getElementById('rankRewardDisplay').textContent = currentRank.reward > 0 ? 
        `Reward: ${formatCurrency(currentRank.reward)}` : 'No reward for this rank';
    document.getElementById('totalRankReward').textContent = formatCurrency(totalRankReward);
    document.getElementById('rewardCount').textContent = rewardCount + ' rewards earned';

    // ===== RANK PROGRESS =====
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

    // ===== RANK TABLE =====
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

        // Highlight row if it's the current rank
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

    // ===== REWARD HISTORY =====
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

        if (!isProcessing) {
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

        if (!isProcessing) {
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
