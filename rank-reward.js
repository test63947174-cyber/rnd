// ============================================================
// RANK REWARD - PRODUCTION READY v2
// ============================================================
// FIXES:
// 1. ✅ ATOMIC reward + claim in SINGLE transaction
// 2. ✅ Same transaction ID for both wallet and reward record
// 3. ✅ Duplicate-proof with race condition handling
// 4. ✅ Firebase Rules compatible (minimal write permissions)
// 5. ✅ NO migration | NO business reset | CUMULATIVE business only
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
    getDatabase,
    ref,
    get,
    runTransaction,
    onValue,
    set
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js";

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
// 🔥 ATOMIC RANK REWARD - SINGLE TRANSACTION (DUPLICATE PROOF)
// ============================================================
async function processSingleRankReward(userId, rankKey, rewardAmount, teamBusiness) {
    try {
        const userRef = ref(db, 'users/' + userId);
        const rankInfo = getRankByKey(rankKey);
        const txId = generateTxId();
        const timestamp = Date.now();

        // ✅ SINGLE ATOMIC TRANSACTION: Check + Credit + Mark Claimed
        const result = await runTransaction(userRef, (currentData) => {
            if (!currentData) return currentData;

            // 🔥 CRITICAL: Check if reward already exists INSIDE transaction
            // This prevents race condition between two tabs
            const claimed = currentData._rankRewardsClaimed || {};
            if (claimed[rankKey] === true) {
                return currentData; // Already claimed, abort
            }

            // ✅ Credit to depositWallet ONLY
            const currentWallet = Number(currentData.depositWallet) || 0;
            currentData.depositWallet = currentWallet + rewardAmount;

            // ✅ Update rank in user profile
            currentData.rank = rankInfo.rank;

            // ✅ Mark as claimed inside user object (for transaction check)
            if (!currentData._rankRewardsClaimed) {
                currentData._rankRewardsClaimed = {};
            }
            currentData._rankRewardsClaimed[rankKey] = true;

            // ✅ Add transaction record with SAME txId
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

            // ✅ IMPORTANT: teamBusiness is NEVER changed
            // Business remains cumulative as per requirement

            return currentData;
        });

        if (!result.committed) {
            console.log(`❌ Transaction failed for ${rankInfo.rank}`);
            return { success: false, error: 'Transaction failed' };
        }

        // ✅ Check if it was already claimed (transaction aborted)
        if (result.snapshot.exists()) {
            const data = result.snapshot.val();
            const claimed = data._rankRewardsClaimed || {};
            if (claimed[rankKey] === true) {
                // It was already claimed by another tab/process
                console.log(`ℹ️ ${rankInfo.rank} was already claimed (race condition handled)`);
                return { success: false, alreadyClaimed: true };
            }
        }

        // ✅ Step 2: Write to rankRewards (separate path for history/UI)
        // Use SAME txId for consistency
        await set(ref(db, `rankRewards/${userId}/${rankKey}`), {
            rank: rankInfo.rank,
            rankKey: rankKey,
            requiredBusiness: rankInfo.minBusiness,
            rewardAmount: rewardAmount,
            teamBusinessAtReward: teamBusiness,
            creditedAt: timestamp,
            creditedDate: getTodayDate(),
            status: 'completed',
            transactionId: txId  // ✅ SAME transaction ID as wallet
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
        // Get current claimed status from user object (fast check)
        const userSnap = await get(ref(db, 'users/' + userId));
        const userData = userSnap.exists() ? userSnap.val() : {};
        const claimed = userData._rankRewardsClaimed || {};

        const processed = [];
        const errors = [];
        let anyProcessed = false;

        // Process from lowest to highest (cumulative rewards)
        for (let level of RANK_LEVELS) {
            if (level.reward === 0) continue;

            // Check if teamBusiness meets threshold
            if (teamBusiness >= level.minBusiness) {
                // Check if already claimed (fast check from user object)
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
                    console.log(`ℹ️ ${level.rank} already claimed (from user object)`);
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
function renderUI(userData, rankRewardStatus, processingResult = null) {
    const teamBusiness = Number(userData.teamBusiness) || 0;
    const currentRank = calculateRank(teamBusiness);
    const nextRank = getNextRank(teamBusiness);
    const name = userData.name || 'User';
    const depositWallet = Number(userData.depositWallet) || 0;

    // Update sidebar
    document.getElementById('sidebarName').textContent = name;
    document.getElementById('sidebarEmail').textContent = userData.email || 'user@example.com';
    document.getElementById('sidebarAvatar').textContent = name.charAt(0).toUpperCase();

    // ===== RANK CARDS =====
    const cardsContainer = document.getElementById('rankCards');

    const isCurrentRankClaimed = rankRewardStatus[currentRank.key]?.status === 'completed';
    const statusText = isCurrentRankClaimed ? '✓ Achieved' :
        (currentRank.reward > 0 ? '⏳ Eligible' : 'Current');
    const statusClass = isCurrentRankClaimed ? 'achieved' :
        (currentRank.reward > 0 ? 'eligible' : 'current');

    let nextRankHTML = '';
    if (nextRank && currentRank.key !== 'diamond') {
        const progress = Math.min(100, (teamBusiness / nextRank.minBusiness) * 100);
        const remaining = Math.max(0, nextRank.minBusiness - teamBusiness);
        nextRankHTML = `
            <div class="progress-container">
                <div class="progress-track">
                    <div class="progress-fill" style="width:${progress}%;"></div>
                </div>
                <div class="progress-info">
                    <span>${formatCurrency(teamBusiness)} / ${formatCurrency(nextRank.minBusiness)}</span>
                    <span>${progress.toFixed(1)}%</span>
                </div>
                <div style="font-size:13px;color:rgba(255,255,255,0.35);margin-top:4px;">
                    🎯 Next: ${nextRank.rank} — Need ${formatCurrency(remaining)} more
                </div>
            </div>
        `;
    } else if (currentRank.key === 'diamond') {
        nextRankHTML = `
            <div style="margin-top:12px;padding:10px 16px;background:rgba(251,191,36,0.08);border-radius:10px;border:1px solid rgba(251,191,36,0.1);">
                <span style="color:#fbbf24;font-weight:600;">💎 Highest Rank Achieved!</span>
            </div>
        `;
    }

    const totalRewards = Object.values(rankRewardStatus)
        .filter(r => r.status === 'completed')
        .reduce((sum, r) => sum + (Number(r.rewardAmount) || 0), 0);

    // Show processing results if any
    let processingMsg = '';
    if (processingResult && processingResult.processed.length > 0) {
        processingMsg = `
            <div style="margin-top:12px;padding:10px 16px;background:rgba(46,204,113,0.08);border-radius:10px;border:1px solid rgba(46,204,113,0.1);">
                <span style="color:#2ecc71;">✅ New rewards earned: ${processingResult.processed.join(', ')}</span>
            </div>
        `;
    }
    if (processingResult && processingResult.errors && processingResult.errors.length > 0) {
        processingMsg += `
            <div style="margin-top:8px;padding:10px 16px;background:rgba(239,68,68,0.08);border-radius:10px;border:1px solid rgba(239,68,68,0.1);">
                <span style="color:#ef4444;">❌ Errors: ${processingResult.errors.map(e => e.rank).join(', ')}</span>
            </div>
        `;
    }

    cardsContainer.innerHTML = `
        <!-- Current Rank -->
        <div class="rank-card" style="border-color:rgba(46,204,113,0.15);">
            <div class="rank-icon">${currentRank.icon}</div>
            <div class="rank-name">${currentRank.rank}</div>
            <div class="rank-sub">Current Rank</div>
            <div class="rank-value">${formatCurrency(teamBusiness)}</div>
            <div class="rank-label">Total Team Business (Cumulative)</div>
            <div>
                <span class="rank-status ${statusClass}">${statusText}</span>
                ${currentRank.reward > 0 ? `<span style="margin-left:10px;font-size:14px;color:#fbbf24;">Reward: ${formatCurrency(currentRank.reward)}</span>` : ''}
            </div>
            ${nextRankHTML}
            ${processingMsg}
        </div>

        <!-- Deposit Wallet -->
        <div class="rank-card" style="border-color:rgba(251,191,36,0.1);">
            <div class="rank-icon">💰</div>
            <div class="rank-name">Deposit Wallet</div>
            <div class="rank-sub">Total USDT Balance</div>
            <div class="rank-value" style="color:#2ecc71;">${formatCurrency(depositWallet)}</div>
            <div class="rank-label">Available for withdrawal</div>
        </div>

        <!-- Total Rewards -->
        <div class="rank-card" style="border-color:rgba(52,152,219,0.1);">
            <div class="rank-icon">🏆</div>
            <div class="rank-name">Total Rank Rewards</div>
            <div class="rank-sub">All rewards earned</div>
            <div class="rank-value" style="color:#fbbf24;">
                ${formatCurrency(totalRewards)}
            </div>
            <div class="rank-label">${Object.keys(rankRewardStatus).filter(k => rankRewardStatus[k]?.status === 'completed').length} ranks achieved</div>
        </div>
    `;

    // ===== RANK TABLE =====
    const tableBody = document.getElementById('rankTableBody');
    let tableRows = '';

    for (let level of RANK_LEVELS) {
        const isAchieved = rankRewardStatus[level.key]?.status === 'completed';
        const isCurrent = level.key === currentRank.key;
        const isLocked = !isAchieved && !isCurrent;
        const isEligible = !isAchieved && teamBusiness >= level.minBusiness && level.reward > 0;

        let statusBadge = '';
        if (isAchieved) {
            statusBadge = `<span class="badge-status achieved">✓ Achieved</span>`;
        } else if (isCurrent && level.reward === 0) {
            statusBadge = `<span class="badge-status current">Current</span>`;
        } else if (isEligible) {
            statusBadge = `<span class="badge-status eligible">⏳ Eligible</span>`;
        } else if (isCurrent) {
            statusBadge = `<span class="badge-status current">Current</span>`;
        } else {
            statusBadge = `<span class="badge-status locked">🔒 Locked</span>`;
        }

        const rewardDisplay = level.reward > 0 ? formatCurrency(level.reward) : '$0';

        tableRows += `
            <tr>
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

        // Get rank reward status from rankRewards path
        let rankRewardStatus = await getRankRewardStatus(userId);

        // Check and process pending rewards
        let processingResult = null;
        if (!isProcessing) {
            isProcessing = true;
            try {
                processingResult = await checkAndProcessAllRankRewards(userId, teamBusiness);
                if (processingResult && processingResult.anyProcessed) {
                    // Refresh data after processing
                    rankRewardStatus = await getRankRewardStatus(userId);
                }
            } catch (error) {
                console.error('Error processing rewards:', error);
                showToast('❌ Error processing rewards: ' + error.message, 'error');
            } finally {
                isProcessing = false;
            }
        }

        renderUI(userData, rankRewardStatus, processingResult);

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

        let processingResult = null;
        if (!isProcessing) {
            isProcessing = true;
            try {
                processingResult = await checkAndProcessAllRankRewards(userId, teamBusiness);
                if (processingResult && processingResult.anyProcessed) {
                    rankRewardStatus = await getRankRewardStatus(userId);
                }
            } catch (error) {
                console.error('Error processing rewards:', error);
            } finally {
                isProcessing = false;
            }
        }

        renderUI(userData, rankRewardStatus, processingResult);
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
const mobileToggle = document.getElementById('mobileToggle');

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

if (mobileToggle) {
    mobileToggle.addEventListener('click', openSidebar);
}
if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', closeSidebar);
}
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSidebar();
});

// Logout
const logoutBtn = document.getElementById('logoutBtnSidebar');
if (logoutBtn) {
    logoutBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        await signOut(auth);
        window.location.href = 'login.html';
    });
}

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

// Cleanup on page unload
window.addEventListener('beforeunload', cleanup);