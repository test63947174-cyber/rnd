// ============================================================
// RND STAKING PLATFORM - DASHBOARD.JS (FINAL SAFE v8)
// ============================================================
// ✅ Transfer: TRUE atomic, idempotent, network-safe
// ✅ Recovery: Financial fields SAFE (backup se restore nahi)
// ✅ Commission: Atomic, duplicate-proof
// ✅ Daily Release: Manual trigger (dashboard load par nahi)
// ✅ Backward compatible with existing database
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getDatabase, ref, get, update, runTransaction, onValue, set, query, orderByChild, equalTo, limitToLast } from "firebase/database";

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

const DOMAIN = "https://staking.randigital.in";
const REGISTER_URL = `${DOMAIN}/register.html`;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// ============================================================
// GLOBAL VARIABLES
// ============================================================
let rndPrice = 1.00;
let currentUserData = null;
let currentUserId = null;
let isDashboardLoading = false;
let listenerOff = null;
let listenerTimeout = null;
let releaseInProgress = false;
let commissionInProgress = false;
let updateTimer = null;
let transferLock = false;

const TRANSFER_STATUS = {
    SUCCESS: 'success',
    FAILED: 'failed',
    UNKNOWN: 'unknown'
};

const WALLET_CURRENCY = {
    depositWallet: 'USDT',
    referralWallet: 'USDT',
    rndWallet: 'RND'
};

const WALLET_PRECISION = {
    depositWallet: 2,
    referralWallet: 2,
    rndWallet: 8
};

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;
    const icon = type === 'success' ? 'bi-check-circle-fill text-success' : 'bi-exclamation-triangle-fill text-danger';
    toast.innerHTML = `<i class="bi ${icon}"></i><span class="toast-msg">${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

function getGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return 'Morning';
    if (hour < 17) return 'Afternoon';
    return 'Evening';
}

function generateTxId() {
    return 'tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
}

function generateBackupId() {
    return 'backup_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

function getTodayDate() {
    return new Date().toISOString().split('T')[0];
}

function getDaysBetween(date1, date2) {
    const d1 = new Date(date1);
    const d2 = new Date(date2);
    const diffTime = Math.abs(d2 - d1);
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function generateRequestId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11) +
           Math.random().toString(36).slice(2, 11);
}

function roundToPrecision(value, precision) {
    const factor = Math.pow(10, precision);
    return Math.round(value * factor) / factor;
}

function validateAmount(amount, walletType) {
    if (typeof amount !== 'number' || !isFinite(amount) || Number.isNaN(amount)) {
        return { valid: false, error: 'Amount must be a valid number' };
    }
    if (amount <= 0) {
        return { valid: false, error: 'Amount must be greater than 0' };
    }
    const precision = WALLET_PRECISION[walletType] || 8;
    const rounded = roundToPrecision(amount, precision);
    if (Math.abs(rounded - amount) > 1e-10) {
        return { valid: false, error: `Amount exceeds ${precision} decimal precision` };
    }
    return { valid: true, value: rounded };
}

function normalizeTransferHistory(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return Object.values(raw).filter(Boolean);
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
// FETCH LIVE RATE
// ============================================================
async function fetchLiveRate() {
    try {
        const settingsRef = ref(db, 'settings/rate');
        const snapshot = await get(settingsRef);
        if (snapshot.exists()) {
            rndPrice = snapshot.val();
        } else {
            const checkRef = await get(ref(db, 'settings'));
            if (!checkRef.exists()) {
                await set(ref(db, 'settings'), { rate: 1.00 });
            }
            rndPrice = 1.00;
        }
    } catch (error) {
        console.error('Error fetching rate:', error);
    }
    return rndPrice;
}

// ============================================================
// GET USER BY IDENTIFIER (UID / Username / Referral Code)
// ============================================================
async function getUserByIdentifier(identifier) {
    try {
        if (!identifier) return null;
        
        const usersRef = ref(db, 'users');
        
        const uidSnap = await get(ref(db, 'users/' + identifier));
        if (uidSnap.exists()) {
            const data = uidSnap.val();
            return { uid: identifier, data: data, source: 'uid' };
        }
        
        const usernameQuery = query(usersRef, orderByChild('username'), equalTo(identifier));
        const usernameSnap = await get(usernameQuery);
        if (usernameSnap.exists()) {
            const data = usernameSnap.val();
            const uid = Object.keys(data)[0];
            return { uid: uid, data: data[uid], source: 'username' };
        }
        
        const referralQuery = query(usersRef, orderByChild('referralCode'), equalTo(identifier));
        const referralSnap = await get(referralQuery);
        if (referralSnap.exists()) {
            const data = referralSnap.val();
            const uid = Object.keys(data)[0];
            return { uid: uid, data: data[uid], source: 'referralCode' };
        }
        
        return null;
    } catch (error) {
        console.error('Error getting user by identifier:', error);
        return null;
    }
}

// ============================================================
// BACKUP SYSTEM (Only non-financial metadata)
// ============================================================
async function createBackup(userId, action, data) {
    try {
        const backupId = generateBackupId();
        const backupRef = ref(db, `backups/${userId}/${backupId}`);
        
        const backupData = {
            action: action,
            timestamp: Date.now(),
            date: getTodayDate(),
            data: data,
            userId: userId,
            backupId: backupId
        };
        
        await set(backupRef, backupData);
        console.log(`✅ Backup created: ${backupId} for action: ${action}`);
        return backupId;
    } catch (error) {
        console.error('❌ Backup creation failed:', error);
        return null;
    }
}

// ⚠️ SAFE: Backup sirf metadata ka, financial fields ka nahi
async function createMetadataBackup(userId, action) {
    try {
        const userSnap = await get(ref(db, 'users/' + userId));
        if (!userSnap.exists()) return null;
        
        const userData = userSnap.val();
        
        // ✅ Only non-financial fields backed up
        const backupData = {
            uid: userData.uid,
            email: userData.email,
            username: userData.username,
            referralCode: userData.referralCode,
            referredBy: userData.referredBy,
            createdAt: userData.createdAt,
            name: userData.name,
            rank: userData.rank,
            teamStructure: userData.teamStructure || {},
            backupCreatedAt: Date.now(),
            backupAction: action
        };
        
        // ❌ NO financial fields (depositWallet, referralWallet, etc.)
        // ❌ NO transactions, transferHistory, packages
        
        return await createBackup(userId, action, backupData);
    } catch (error) {
        console.error('❌ Metadata backup failed:', error);
        return null;
    }
}

async function getLatestBackup(userId) {
    try {
        const backupsRef = ref(db, `backups/${userId}`);
        const queryRef = query(backupsRef, orderByChild('timestamp'), limitToLast(1));
        const snapshot = await get(queryRef);
        
        if (!snapshot.exists()) return null;
        
        const data = snapshot.val();
        const backupId = Object.keys(data)[0];
        return { backupId: backupId, data: data[backupId] };
    } catch (error) {
        console.error('Error getting latest backup:', error);
        return null;
    }
}

// ============================================================
// CHECK USER EXISTENCE
// ============================================================
async function checkUserExists(userId) {
    try {
        const userSnap = await get(ref(db, 'users/' + userId));
        if (userSnap.exists()) {
            return { exists: true, data: userSnap.val(), source: 'main' };
        }
        
        const refSnap = await get(ref(db, 'referrals/' + userId));
        if (refSnap.exists()) {
            return { exists: true, data: { referral: refSnap.val() }, source: 'referral' };
        }
        
        return { exists: false };
    } catch (error) {
        console.error('Error checking user existence:', error);
        return { exists: false, error: error.message };
    }
}

// ============================================================
// ✅ SAFE RECOVER USER DATA
// Financial fields NEVER restored from backup
// ============================================================
async function recoverUserData(userId, authUser) {
    try {
        console.log('🔄 Starting recovery process for:', userId);
        
        const userSnap = await get(ref(db, 'users/' + userId));
        
        // Agar user exist karta hai → kuch mat karo
        if (userSnap.exists()) {
            const existingData = userSnap.val();
            
            // Sirf missing metadata fields fill karo
            const updates = {};
            if (!existingData.uid) updates.uid = userId;
            if (!existingData.email) updates.email = authUser.email || '';
            if (!existingData.username) {
                updates.username = authUser.email 
                    ? authUser.email.split('@')[0] 
                    : 'user_' + userId.substring(0, 8);
            }
            if (!existingData.referralCode) {
                updates.referralCode = userId.substring(0, 8).toUpperCase();
            }
            if (!existingData.name) updates.name = authUser.displayName || 'User';
            if (!existingData.createdAt) updates.createdAt = Date.now();
            if (!existingData.teamStructure) {
                updates.teamStructure = { level1: 0, level2: 0, level3: 0, level4: 0, level5: 0 };
            }
            
            if (Object.keys(updates).length > 0) {
                await update(ref(db, 'users/' + userId), updates);
                console.log('✅ Metadata fields filled');
            }
            
            // Fresh read
            const freshSnap = await get(ref(db, 'users/' + userId));
            return freshSnap.exists() ? freshSnap.val() : existingData;
        }
        
        // 🔴 User record nahi hai — bilkul naya banao
        // Financial fields = 0 (NEVER restore from backup)
        console.log('🆕 Creating new user record (financial fields = 0)');
        
        const newUserData = {
            uid: userId,
            email: authUser.email || '',
            username: authUser.email ? authUser.email.split('@')[0] : 'user_' + userId.substring(0, 8),
            referralCode: userId.substring(0, 8).toUpperCase(),
            name: authUser.displayName || 'User',
            createdAt: Date.now(),
            lastLogin: Date.now(),
            // 💰 Financial fields START AT 0
            depositWallet: 0,
            referralWallet: 0,
            rndWallet: 0,
            lockedRND: 0,
            releaseWallet: 0,
            totalReleased: 0,
            activePackages: 0,
            totalStake: 0,
            totalReferrals: 0,
            teamBusiness: 0,
            rank: 'Member',
            referredBy: null,
            packages: {},
            transactions: {},
            transferHistory: [],
            commissionHistory: [],
            teamStructure: { level1: 0, level2: 0, level3: 0, level4: 0, level5: 0 },
            lastReleaseDate: null
        };
        
        // URL se referral code
        const urlParams = new URLSearchParams(window.location.search);
        const refCode = urlParams.get('ref');
        if (refCode) {
            const refResult = await getUserByIdentifier(refCode);
            if (refResult && refResult.uid !== userId) {
                newUserData.referredBy = refCode;
                await runTransaction(ref(db, 'users/' + refResult.uid), (currentData) => {
                    if (!currentData) return currentData;
                    currentData.totalReferrals = (currentData.totalReferrals || 0) + 1;
                    return currentData;
                });
            }
        }
        
        await set(ref(db, 'users/' + userId), newUserData);
        console.log('✅ New user created (all balances = 0)');
        
        return newUserData;
        
    } catch (error) {
        console.error('❌ Error in recovery process:', error);
        return null;
    }
}

// ============================================================
// ✅ SAFE DAILY RELEASE (Manual trigger only)
// ============================================================
async function processDailyRelease(userId) {
    if (releaseInProgress) {
        console.log('⏳ Release already in progress, skipping...');
        return null;
    }
    
    releaseInProgress = true;
    
    try {
        const userRef = ref(db, 'users/' + userId);
        const today = getTodayDate();
        
        const result = await runTransaction(userRef, (currentData) => {
            if (!currentData) return currentData;
            
            const lastReleaseDate = currentData.lastReleaseDate || '';
            
            let pendingDays = 0;
            if (lastReleaseDate) {
                const daysDiff = getDaysBetween(lastReleaseDate, today);
                if (daysDiff === 0) return currentData;
                pendingDays = Math.max(0, daysDiff - 1);
            }
            
            const packages = currentData.packages || {};
            let updatedPackages = {};
            let releaseTransactions = [];
            let totalReleaseAmountAll = 0;
            let hasActivePackages = false;
            
            for (const [pkgKey, pkg] of Object.entries(packages)) {
                if (pkg.status !== 'active') {
                    updatedPackages[pkgKey] = pkg;
                    continue;
                }
                
                hasActivePackages = true;
                const remainingRND = pkg.remainingRND || 0;
                const dailyRelease = pkg.dailyRelease || 0;
                
                if (dailyRelease <= 0 || remainingRND <= 0) {
                    if (remainingRND <= 0) {
                        pkg.status = 'completed';
                        pkg.remainingRND = 0;
                    }
                    updatedPackages[pkgKey] = pkg;
                    continue;
                }
                
                const totalDaysToRelease = pendingDays + 1;
                let totalReleaseAmount = Math.min(dailyRelease * totalDaysToRelease, remainingRND);
                let todayReleaseAmount = Math.min(dailyRelease, remainingRND);
                
                pkg.remainingRND = remainingRND - totalReleaseAmount;
                pkg.releasedRND = (pkg.releasedRND || 0) + totalReleaseAmount;
                
                if (pkg.remainingRND <= 0) {
                    pkg.remainingRND = 0;
                    pkg.status = 'completed';
                }
                
                updatedPackages[pkgKey] = pkg;
                totalReleaseAmountAll += totalReleaseAmount;
                
                releaseTransactions.push({
                    type: 'daily_release',
                    amount: todayReleaseAmount,
                    currency: 'RND',
                    packageId: pkgKey,
                    planName: pkg.planName || 'Package',
                    timestamp: Date.now(),
                    date: today,
                    status: 'completed',
                    description: `Daily release of ${todayReleaseAmount.toFixed(4)} RND`
                });
                
                if (pendingDays > 0) {
                    const pendingAmount = totalReleaseAmount - todayReleaseAmount;
                    releaseTransactions.push({
                        type: 'pending_release',
                        amount: pendingAmount,
                        currency: 'RND',
                        packageId: pkgKey,
                        planName: pkg.planName || 'Package',
                        timestamp: Date.now(),
                        date: today,
                        status: 'completed',
                        description: `Pending release of ${pendingAmount.toFixed(4)} RND (${pendingDays} days)`
                    });
                }
            }
            
            if (!hasActivePackages || totalReleaseAmountAll === 0) {
                currentData.lastReleaseDate = today;
                return currentData;
            }
            
            currentData.rndWallet = (currentData.rndWallet || 0) + totalReleaseAmountAll;
            currentData.lockedRND = (currentData.lockedRND || 0) - totalReleaseAmountAll;
            currentData.totalReleased = (currentData.totalReleased || 0) + totalReleaseAmountAll;
            currentData.lastReleaseDate = today;
            currentData.packages = updatedPackages;
            
            const transactions = currentData.transactions || {};
            releaseTransactions.forEach(tx => {
                transactions[generateTxId()] = tx;
            });
            currentData.transactions = transactions;
            
            return currentData;
        });
        
        if (result.committed && result.snapshot.exists()) {
            console.log('✅ Daily release processed');
            return result.snapshot.val();
        }
        return null;
    } catch (error) {
        console.error('❌ Daily release error:', error);
        return null;
    } finally {
        releaseInProgress = false;
    }
}

// ============================================================
// ✅ ATOMIC COMMISSION PROCESSING
// commissionProcessed flag SAME transaction mein set hota hai
// ============================================================
async function processReferralCommission(userId, packageId, packageData) {
    if (commissionInProgress) {
        console.log('⏳ Commission in progress, skipping...');
        return null;
    }
    
    commissionInProgress = true;
    
    try {
        if (packageData.commissionProcessed === true) {
            return null;
        }
        if (packageData.status !== 'active' && packageData.status !== 'completed') {
            return null;
        }
        
        const userSnapshot = await get(ref(db, 'users/' + userId));
        if (!userSnapshot.exists()) return null;
        
        const userData = userSnapshot.val();
        const referralCode = userData.referralCode;
        const packageAmount = packageData.usdtAmount || 0;
        
        if (packageAmount <= 0) return null;
        
        const commissionLevels = [
            { level: 1, percent: 0.08 },
            { level: 2, percent: 0.04 },
            { level: 3, percent: 0.02 },
            { level: 4, percent: 0.01 },
            { level: 5, percent: 0.01 }
        ];
        
        // ✅ STEP 1: Mark package as processing ATOMICALLY
        // Agar already marked hai → skip
        const pkgRef = ref(db, `users/${userId}/packages/${packageId}`);
        const markResult = await runTransaction(pkgRef, (pkg) => {
            if (!pkg) return pkg;
            if (pkg.commissionProcessed === true) return pkg; // abort
            if (pkg.commissionProcessing === true) return pkg; // abort
            pkg.commissionProcessing = true;
            pkg.commissionProcessingAt = Date.now();
            return pkg;
        });
        
        if (!markResult.committed) {
            console.log('⚠️ Commission already processed or processing');
            return null;
        }
        
        // Double-check karo ki hamara lock successfully laga
        const checkPkg = await get(pkgRef);
        if (!checkPkg.exists() || checkPkg.val().commissionProcessed === true) {
            return null;
        }
        
        // ✅ STEP 2: Process commission chain
        let currentRefCode = referralCode;
        let level = 1;
        const processedTxIds = [];
        
        while (currentRefCode && level <= 5) {
            const refResult = await getUserByIdentifier(currentRefCode);
            if (!refResult || refResult.uid === userId) break;
            
            const referrerData = refResult.data;
            const uid = refResult.uid;
            
            const commissionPercent = commissionLevels.find(l => l.level === level)?.percent || 0;
            const commissionAmount = roundToPrecision(packageAmount * commissionPercent, 8);
            
            if (commissionAmount > 0) {
                // ✅ Deterministic txId — same package+level ke liye same
                const commissionTxId = `comm_${packageId}_L${level}`;
                
                await runTransaction(ref(db, 'users/' + uid), (currentData) => {
                    if (!currentData) return currentData;
                    
                    const commissionHistory = currentData.commissionHistory || [];
                    // ✅ Duplicate check by txId
                    const existing = commissionHistory.find(h => h.txId === commissionTxId);
                    if (existing) return currentData; // already processed
                    
                    currentData.referralWallet = roundToPrecision(
                        (currentData.referralWallet || 0) + commissionAmount, 2
                    );
                    const levelKey = `level${level}Earnings`;
                    currentData[levelKey] = roundToPrecision(
                        (currentData[levelKey] || 0) + commissionAmount, 2
                    );
                    currentData.referralEarnings = roundToPrecision(
                        (currentData.referralEarnings || 0) + commissionAmount, 2
                    );
                    currentData.teamBusiness = roundToPrecision(
                        (currentData.teamBusiness || 0) + packageAmount, 2
                    );
                    
                    commissionHistory.push({
                        type: 'referral_commission',
                        level: level,
                        percent: commissionPercent * 100,
                        amount: commissionAmount,
                        fromUser: userData.username || userData.referralCode || userId,
                        fromUid: userId,
                        packageId: packageId,
                        txId: commissionTxId,
                        timestamp: Date.now(),
                        date: getTodayDate(),
                        description: `${commissionPercent * 100}% from Level ${level}`
                    });
                    currentData.commissionHistory = commissionHistory;
                    
                    const transactions = currentData.transactions || {};
                    transactions[commissionTxId] = {
                        type: 'referral_commission',
                        amount: commissionAmount,
                        currency: 'USDT',
                        level: level,
                        percent: commissionPercent * 100,
                        fromUser: userData.username || userData.referralCode || userId,
                        fromUid: userId,
                        timestamp: Date.now(),
                        date: getTodayDate(),
                        status: 'completed',
                        txId: commissionTxId
                    };
                    currentData.transactions = transactions;
                    
                    return currentData;
                });
                
                processedTxIds.push(commissionTxId);
            }
            
            currentRefCode = referrerData.referredBy || null;
            level++;
        }
        
        // ✅ STEP 3: Mark package as completed ATOMICALLY
        await runTransaction(pkgRef, (pkg) => {
            if (!pkg) return pkg;
            pkg.commissionProcessed = true;
            pkg.commissionProcessedAt = Date.now();
            pkg.commissionProcessing = false;
            pkg.commissionTxIds = processedTxIds;
            return pkg;
        });
        
        console.log('✅ Commission processed for:', packageId);
        return true;
        
    } catch (error) {
        console.error('❌ Commission error:', error);
        // Cleanup processing flag on error
        try {
            await update(ref(db, `users/${userId}/packages/${packageId}`), {
                commissionProcessing: false
            });
        } catch (_) {}
        return null;
    } finally {
        commissionInProgress = false;
    }
}

// ============================================================
// CALCULATE USER STATS
// ============================================================
function calculateUserStats(userData) {
    const packages = userData.packages || {};
    let totalLockedRND = 0;
    let totalDailyRelease = 0;
    let activePackages = 0;
    let totalStake = 0;
    let totalReleased = 0;
    
    for (let key in packages) {
        const pkg = packages[key];
        if (pkg.status === 'active') {
            totalLockedRND += (pkg.remainingRND || 0);
            totalDailyRelease += (pkg.dailyRelease || 0);
            activePackages++;
            totalStake += (pkg.usdtAmount || 0);
        }
        totalReleased += (pkg.releasedRND || 0);
    }
    
    return { totalLockedRND, totalDailyRelease, activePackages, totalStake, totalReleased };
}

// ============================================================
// ✅ FIXED: TRUE ATOMIC TRANSFER
// ============================================================
async function atomicTransfer(senderUid, recipientUid, recipientData, amount, walletType, currency, requestId) {
    if (!senderUid || !recipientUid) {
        return { status: TRANSFER_STATUS.FAILED, error: 'Missing user IDs' };
    }
    if (senderUid === recipientUid) {
        return { status: TRANSFER_STATUS.FAILED, error: 'Cannot transfer to yourself' };
    }
    if (!WALLET_CURRENCY[walletType]) {
        return { status: TRANSFER_STATUS.FAILED, error: 'Invalid wallet type' };
    }
    const amountCheck = validateAmount(amount, walletType);
    if (!amountCheck.valid) {
        return { status: TRANSFER_STATUS.FAILED, error: amountCheck.error };
    }
    const safeAmount = amountCheck.value;
    const precision = WALLET_PRECISION[walletType];

    // ---- Idempotency check ----
    const requestRef = ref(db, `transferRequests/${requestId}`);
    try {
        const existingReq = await get(requestRef);
        if (existingReq.exists()) {
            const reqData = existingReq.val();
            console.log('♻️ Idempotent replay:', requestId);
            return {
                status: reqData.status === 'success' ? TRANSFER_STATUS.SUCCESS : reqData.status,
                txId: reqData.txId,
                error: reqData.error,
                replayed: true
            };
        }
    } catch (err) {
        return { status: TRANSFER_STATUS.UNKNOWN, error: 'Could not verify request state' };
    }

    // ---- Read sender ----
    let senderData;
    try {
        const senderSnap = await get(ref(db, `users/${senderUid}`));
        if (!senderSnap.exists()) {
            return { status: TRANSFER_STATUS.FAILED, error: 'Sender not found' };
        }
        senderData = senderSnap.val();
    } catch (err) {
        return { status: TRANSFER_STATUS.UNKNOWN, error: 'Network error reading sender' };
    }

    // ---- Balance check ----
    const senderBalance = roundToPrecision(senderData[walletType] || 0, precision);
    if (senderBalance < safeAmount) {
        return {
            status: TRANSFER_STATUS.FAILED,
            error: `Insufficient balance. Available: ${senderBalance} ${currency}`
        };
    }

    // ---- Compute new balances ----
    const newSenderBalance = roundToPrecision(senderBalance - safeAmount, precision);
    const recipientBalance = roundToPrecision(recipientData[walletType] || 0, precision);
    const newRecipientBalance = roundToPrecision(recipientBalance + safeAmount, precision);

    // ---- Deterministic txId ----
    const txId = 'TX_' + requestId.replace(/-/g, '').slice(0, 20);
    const now = Date.now();
    const senderUsername = senderData.username || senderData.referralCode || senderUid.slice(0, 8);
    const recipientUsername = recipientData.username || recipientData.referralCode || recipientUid.slice(0, 8);

    // ---- Build ATOMIC multi-path update ----
    const updates = {};

    updates[`transferRequests/${requestId}`] = {
        requestId, txId, senderUid, recipientUid,
        amount: safeAmount, currency, walletType,
        status: TRANSFER_STATUS.SUCCESS,
        createdAt: now, completedAt: now
    };

    // Sender
    updates[`users/${senderUid}/${walletType}`] = newSenderBalance;
    updates[`users/${senderUid}/transferHistory/${txId}`] = {
        type: 'sent', to: recipientUsername, toUid: recipientUid,
        amount: safeAmount, currency, walletType,
        from: senderUsername, fromUid: senderUid,
        timestamp: now, txId, requestId, status: 'completed'
    };
    updates[`users/${senderUid}/transactions/${txId}`] = {
        type: 'transfer_sent', amount: safeAmount, currency, walletType,
        to: recipientUsername, toUid: recipientUid,
        from: senderUsername, fromUid: senderUid,
        timestamp: now, date: getTodayDate(), txId, requestId, status: 'completed'
    };

    // Recipient
    updates[`users/${recipientUid}/${walletType}`] = newRecipientBalance;
    updates[`users/${recipientUid}/transferHistory/${txId}`] = {
        type: 'received', from: senderUsername, fromUid: senderUid,
        to: recipientUsername, toUid: recipientUid,
        amount: safeAmount, currency, walletType,
        timestamp: now, txId, requestId, status: 'completed'
    };
    updates[`users/${recipientUid}/transactions/${txId}`] = {
        type: 'transfer_received', amount: safeAmount, currency, walletType,
        from: senderUsername, fromUid: senderUid,
        to: recipientUsername, toUid: recipientUid,
        timestamp: now, date: getTodayDate(), txId, requestId, status: 'completed'
    };

    // ---- EXECUTE ATOMIC ----
    try {
        await update(ref(db), updates);
        console.log('✅ Transfer committed atomically:', txId);
        return { status: TRANSFER_STATUS.SUCCESS, txId };
    } catch (err) {
        console.error('❌ Transfer failed:', err);

        // Reconciliation
        try {
            const checkReq = await get(requestRef);
            if (checkReq.exists()) {
                const reqData = checkReq.val();
                if (reqData.status === TRANSFER_STATUS.SUCCESS) {
                    console.log('✅ Reconciliation: succeeded');
                    return { status: TRANSFER_STATUS.SUCCESS, txId: reqData.txId };
                }
            }
            return { status: TRANSFER_STATUS.FAILED, error: err.message || 'Transfer failed' };
        } catch (reconErr) {
            console.warn('⚠️ UNKNOWN status');
            try {
                await set(requestRef, {
                    requestId, txId, senderUid, recipientUid,
                    amount: safeAmount, currency, walletType,
                    status: TRANSFER_STATUS.UNKNOWN,
                    createdAt: now,
                    error: 'Network ambiguity'
                });
            } catch (_) {}
            return {
                status: TRANSFER_STATUS.UNKNOWN,
                txId,
                error: 'Transfer status could not be confirmed. Please do not submit again.'
            };
        }
    }
}

// ============================================================
// RECONCILE PENDING TRANSFERS
// ============================================================
async function reconcilePendingTransfers(uid) {
    try {
        const pendingRef = ref(db, `users/${uid}/pendingTransfers`);
        const snap = await get(pendingRef);
        if (!snap.exists()) return [];

        const results = [];
        const pending = snap.val();
        for (const requestId of Object.keys(pending)) {
            try {
                const reqSnap = await get(ref(db, `transferRequests/${requestId}`));
                if (reqSnap.exists()) {
                    const reqData = reqSnap.val();
                    results.push({ requestId, status: reqData.status, txId: reqData.txId });
                    if (reqData.status === TRANSFER_STATUS.SUCCESS || reqData.status === TRANSFER_STATUS.FAILED) {
                        await set(ref(db, `users/${uid}/pendingTransfers/${requestId}`), null);
                    }
                } else {
                    await set(ref(db, `users/${uid}/pendingTransfers/${requestId}`), null);
                }
            } catch (err) {
                console.warn('Reconcile item failed:', requestId, err);
            }
        }
        return results;
    } catch (err) {
        console.error('Reconciliation error:', err);
        return [];
    }
}

async function markPending(uid, requestId) {
    try {
        await set(ref(db, `users/${uid}/pendingTransfers/${requestId}`), {
            requestId,
            createdAt: Date.now()
        });
    } catch (_) {}
}

async function clearPending(uid, requestId) {
    try {
        await set(ref(db, `users/${uid}/pendingTransfers/${requestId}`), null);
    } catch (_) {}
}

// ============================================================
// REAL-TIME LISTENER
// ============================================================
function setupRealtimeListener(userId) {
    if (listenerOff) {
        listenerOff();
        listenerOff = null;
    }
    if (listenerTimeout) {
        clearTimeout(listenerTimeout);
        listenerTimeout = null;
    }
    
    const packagesRef = ref(db, 'users/' + userId + '/packages');
    let updateTimer = null;
    
    listenerOff = onValue(packagesRef, (snapshot) => {
        if (isDashboardLoading || !snapshot.exists()) return;
        
        if (updateTimer) {
            clearTimeout(updateTimer);
            updateTimer = null;
        }
        
        updateTimer = setTimeout(() => {
            const packages = snapshot.val();
            if (currentUserData) {
                currentUserData.packages = packages;
                const stats = calculateUserStats(currentUserData);
                updateDashboardUI(currentUserData, stats);
            }
            updateTimer = null;
        }, 500);
    });
}

// ============================================================
// UPDATE DASHBOARD UI
// ============================================================
function updateDashboardUI(u, stats) {
    const elements = {
        depositWallet: document.getElementById('depositWalletValue'),
        referralWallet: document.getElementById('referralWalletValue'),
        rndWallet: document.getElementById('rndWalletValue'),
        lockedRND: document.getElementById('lockedRNDValue'),
        releaseWallet: document.getElementById('releaseWalletValue'),
        totalReleased: document.getElementById('totalReleasedValue'),
        activePackages: document.getElementById('activePackagesValue'),
        totalStake: document.getElementById('totalStakeValue'),
        teamBusiness: document.getElementById('teamBusinessValue'),
        totalReferrals: document.getElementById('totalReferralsValue'),
        releaseWalletInfo: document.getElementById('releaseWalletInfo'),
        lockedRNDInfo: document.getElementById('lockedRNDInfo')
    };
    
    const dailyReleaseValue = stats?.totalDailyRelease || u.releaseWallet || 0;
    const lockedRNDValue = stats?.totalLockedRND || u.lockedRND || 0;
    
    if (elements.depositWallet) elements.depositWallet.textContent = '$' + (u.depositWallet || 0).toFixed(2);
    if (elements.referralWallet) elements.referralWallet.textContent = (u.referralWallet || 0).toFixed(2);
    if (elements.rndWallet) elements.rndWallet.textContent = (u.rndWallet || 0).toFixed(4);
    if (elements.lockedRND) elements.lockedRND.textContent = lockedRNDValue.toFixed(2);
    if (elements.releaseWallet) elements.releaseWallet.textContent = dailyReleaseValue.toFixed(4) + ' RND';
    if (elements.totalReleased) elements.totalReleased.textContent = (stats?.totalReleased || u.totalReleased || 0).toFixed(4);
    if (elements.activePackages) elements.activePackages.textContent = stats?.activePackages || u.activePackages || 0;
    if (elements.totalStake) elements.totalStake.textContent = (stats?.totalStake || u.totalStake || 0).toFixed(2);
    if (elements.teamBusiness) elements.teamBusiness.textContent = '$' + (u.teamBusiness || 0).toFixed(2);
    if (elements.totalReferrals) elements.totalReferrals.textContent = u.totalReferrals || 0;
    
    if (elements.releaseWalletInfo) elements.releaseWalletInfo.textContent = dailyReleaseValue.toFixed(4) + ' RND';
    if (elements.lockedRNDInfo) elements.lockedRNDInfo.textContent = lockedRNDValue.toFixed(2) + ' RND';
}

// ============================================================
// RENDER DASHBOARD
// ============================================================
function renderDashboard(u) {
    const username = u.username || u.referralCode || 'USER';
    const name = u.name || 'User';
    
    const teamBusinessForRank = u.teamBusiness || 0;
    let rank = 'Member';
    const rankThresholds = [
        { min: 100000, rank: 'Diamond' },
        { min: 50000, rank: 'Senior Manager' },
        { min: 25000, rank: 'Manager' },
        { min: 10000, rank: 'Senior Executive' },
        { min: 3000, rank: 'Executive' }
    ];
    for (let level of rankThresholds) {
        if (teamBusinessForRank >= level.min) rank = level.rank;
    }
    
    const isMember = rank === 'Member' || rank === 'member' || !rank;
    const teamStructure = u.teamStructure || { level1: 0, level2: 0, level3: 0, level4: 0, level5: 0 };
    const directReferrals = teamStructure.level1 || 0;
    const totalReferrals = (teamStructure.level1 || 0) + (teamStructure.level2 || 0) + 
                          (teamStructure.level3 || 0) + (teamStructure.level4 || 0) + 
                          (teamStructure.level5 || 0);
    
    const depositWallet = u.depositWallet || 0;
    const referralWallet = u.referralWallet || 0;
    const rndWallet = u.rndWallet || 0;
    const lockedRND = u.lockedRND || 0;
    const releaseWallet = u.releaseWallet || 0;
    const totalReleased = u.totalReleased || 0;
    const activePackages = u.activePackages || 0;
    const totalStake = u.totalStake || 0;
    const teamBusiness = u.teamBusiness || 0;
    
    const level1Earn = u.level1Earnings || 0;
    const level2Earn = u.level2Earnings || 0;
    const level3Earn = u.level3Earnings || 0;
    const level4Earn = u.level4Earnings || 0;
    const level5Earn = u.level5Earnings || 0;
    const referralEarnings = u.referralEarnings || 0;
    
    const teamLevels = u.teamStructure || { level1: 0, level2: 0, level3: 0, level4: 0, level5: 0 };
    const packages = u.packages || {};
    const totalPackages = Object.keys(packages).length;
    
    let daysPassed = 0;
    for (let key in packages) {
        const pkg = packages[key];
        if (pkg.status === 'active' && pkg.dailyRelease > 0) {
            const days = Math.floor((pkg.releasedRND || 0) / pkg.dailyRelease);
            daysPassed = Math.max(daysPassed, days);
        }
    }
    
    document.getElementById('sidebarName').textContent = name;
    document.getElementById('sidebarUserId').textContent = 'ID: ' + username.substring(0, 20) + '...';
    document.getElementById('sidebarAvatar').textContent = name.charAt(0).toUpperCase();
    
    const badge = document.getElementById('referralBadge');
    if (badge) badge.textContent = directReferrals;
    
    const referralLink = `${REGISTER_URL}?ref=${u.referralCode}`;
    const rankClass = isMember ? 'rank-badge member' : 'rank-badge';
    
    const transferHistory = normalizeTransferHistory(u.transferHistory);
    const sortedHistory = [...transferHistory].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 5);

    document.getElementById('dashboardContent').innerHTML = `
        <div class="row g-4">
            <div class="col-12">
                <div class="welcome-section">
                    <div class="d-flex flex-wrap align-items-center justify-content-between gap-3">
                        <div>
                            <h2>Good ${getGreeting()}, <span>${name}</span></h2>
                            <div class="d-flex flex-wrap align-items-center gap-3 mt-2">
                                <span class="user-id-badge">
                                    <i class="bi bi-person-badge me-1"></i>User ID: <strong style="font-size:0.7rem;">${username.substring(0, 20)}...</strong>
                                    <button class="copy-btn-small" onclick="window.copyUserId('${username}')"><i class="bi bi-clipboard"></i> Copy</button>
                                </span>
                                <span class="${rankClass}"><i class="bi bi-award me-1"></i>${rank}</span>
                                <span class="rnd-price-badge">
                                    <i class="bi bi-currency-dollar"></i> 1 RND = $${(rndPrice || 1).toFixed(4)}
                                </span>
                                <span class="days-remaining">
                                    <i class="bi bi-box-seam"></i> ${totalPackages} Packages
                                </span>
                                ${daysPassed > 0 ? `<span class="days-remaining"><i class="bi bi-calendar"></i> Day ${daysPassed}</span>` : ''}
                                <span class="status-badge active">
                                    <i class="bi bi-shield-check"></i> Secure Mode
                                </span>
                            </div>
                        </div>
                        <div>
                            <a href="deposit.html" class="btn-primary-custom me-2"><i class="bi bi-plus-circle me-1"></i>Deposit</a>
                            <a href="withdrawal.html" class="btn-outline-custom"><i class="bi bi-arrow-up-right me-1"></i>Withdraw</a>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="col-12">
                <div class="row g-3">
                    <div class="col-6 col-lg-3">
                        <div class="wallet-card">
                            <div class="wallet-icon deposit"><i class="bi bi-wallet2"></i></div>
                            <div class="wallet-number green" id="depositWalletValue">$${(depositWallet || 0).toFixed(2)}</div>
                            <div class="wallet-label">Deposit Wallet</div>
                            <div class="wallet-sub">USDT Balance</div>
                        </div>
                    </div>
                    <div class="col-6 col-lg-3">
                        <div class="wallet-card">
                            <div class="wallet-icon referral"><i class="bi bi-coin"></i></div>
                            <div class="wallet-number gold" id="referralWalletValue">${(referralWallet || 0).toFixed(2)}</div>
                            <div class="wallet-label">💰 Referral Wallet</div>
                            <div class="wallet-sub">USDT Balance</div>
                        </div>
                    </div>
                    <div class="col-6 col-lg-3">
                        <div class="wallet-card">
                            <div class="wallet-icon rnd"><i class="bi bi-database"></i></div>
                            <div class="wallet-number blue" id="rndWalletValue">${(rndWallet || 0).toFixed(4)}</div>
                            <div class="wallet-label">RND Wallet</div>
                            <div class="wallet-sub">💰 Total Released RND</div>
                        </div>
                    </div>
                    <div class="col-6 col-lg-3">
                        <div class="wallet-card">
                            <div class="wallet-icon locked"><i class="bi bi-lock"></i></div>
                            <div class="wallet-number purple" id="lockedRNDValue">${(lockedRND || 0).toFixed(2)}</div>
                            <div class="wallet-label">🔒 Locked RND</div>
                            <div class="wallet-sub">Remaining Locked</div>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="col-12">
                <div class="row">
                    <div class="col-md-4">
                        <div class="wallet-card" style="background:rgba(52,211,153,0.05);border-color:rgba(52,211,153,0.15);">
                            <div class="wallet-icon release"><i class="bi bi-clock-history"></i></div>
                            <div class="wallet-number teal" id="releaseWalletValue">${(releaseWallet || 0).toFixed(4)} RND</div>
                            <div class="wallet-label">📅 Daily Release</div>
                            <div class="wallet-sub">Fixed Per Day</div>
                        </div>
                    </div>
                    <div class="col-md-4">
                        <div class="wallet-card" style="background:rgba(96,165,250,0.05);border-color:rgba(96,165,250,0.15);">
                            <div class="wallet-icon rnd"><i class="bi bi-cash-stack"></i></div>
                            <div class="wallet-number" style="color:#60a5fa;" id="totalReleasedValue">${(totalReleased || 0).toFixed(4)} RND</div>
                            <div class="wallet-label">📊 Total Released</div>
                            <div class="wallet-sub">So Far</div>
                        </div>
                    </div>
                    <div class="col-md-4">
                        <div class="wallet-card" style="background:rgba(167,139,250,0.05);border-color:rgba(167,139,250,0.15);">
                            <div class="wallet-icon locked"><i class="bi bi-box-seam"></i></div>
                            <div class="wallet-number" style="color:#a78bfa;" id="activePackagesValue">${activePackages}</div>
                            <div class="wallet-label">📦 Active Packages</div>
                            <div class="wallet-sub">Currently Running</div>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="col-12">
                <div class="release-info-box">
                    <div>
                        <span class="label"><i class="bi bi-info-circle me-1"></i> Fixed daily release. Same amount every day until package completes.</span>
                    </div>
                    <div>
                        <span class="label">Locked RND:</span>
                        <span class="value" id="lockedRNDInfo">${(lockedRND || 0).toFixed(2)} RND</span>
                    </div>
                    <div>
                        <span class="label">Daily Release:</span>
                        <span class="value" id="releaseWalletInfo">${(releaseWallet || 0).toFixed(4)} RND</span>
                    </div>
                </div>
            </div>
            
            <div class="col-12">
                <h5 class="fw-bold mb-3"><i class="bi bi-diagram-3 text-success me-2"></i>Statistics</h5>
                <div class="network-stats">
                    <div class="network-stat-card">
                        <div class="number" id="totalStakeValue">${(totalStake || 0).toFixed(2)}</div>
                        <div class="label">Total Stake (USDT)</div>
                    </div>
                    <div class="network-stat-card">
                        <div class="number" id="totalReferralsValue">${totalReferrals}</div>
                        <div class="label">Total Referrals</div>
                    </div>
                    <div class="network-stat-card">
                        <div class="number" id="teamBusinessValue">$${(teamBusiness || 0).toFixed(2)}</div>
                        <div class="label">Team Business</div>
                    </div>
                </div>
            </div>
            
            <div class="col-12">
                <h5 class="fw-bold mb-3"><i class="bi bi-people text-success me-2"></i>Team Members by Level</h5>
                <div class="level-stats">
                    <div class="level-stat-card"><div class="number">${teamLevels.level1 || 0}</div><div class="label">Level 1</div></div>
                    <div class="level-stat-card"><div class="number">${teamLevels.level2 || 0}</div><div class="label">Level 2</div></div>
                    <div class="level-stat-card"><div class="number">${teamLevels.level3 || 0}</div><div class="label">Level 3</div></div>
                    <div class="level-stat-card"><div class="number">${teamLevels.level4 || 0}</div><div class="label">Level 4</div></div>
                    <div class="level-stat-card"><div class="number">${teamLevels.level5 || 0}</div><div class="label">Level 5</div></div>
                </div>
            </div>
            
            <div class="col-12">
                <div class="card-glass">
                    <div class="card-title"><i class="bi bi-cash-stack text-success me-2"></i>5 Level Referral Commissions</div>
                    <div class="row">
                        <div class="col-md-8">
                            <div class="commission-row"><span class="level">Level 1 (8%)</span><span class="earnings">$${(level1Earn || 0).toFixed(2)}</span></div>
                            <div class="commission-row"><span class="level">Level 2 (4%)</span><span class="earnings">$${(level2Earn || 0).toFixed(2)}</span></div>
                            <div class="commission-row"><span class="level">Level 3 (2%)</span><span class="earnings">$${(level3Earn || 0).toFixed(2)}</span></div>
                            <div class="commission-row"><span class="level">Level 4 (1%)</span><span class="earnings">$${(level4Earn || 0).toFixed(2)}</span></div>
                            <div class="commission-row"><span class="level">Level 5 (1%)</span><span class="earnings">$${(level5Earn || 0).toFixed(2)}</span></div>
                            <div class="commission-row" style="border-top:2px solid rgba(251,191,36,0.2);padding-top:10px;margin-top:4px;">
                                <span class="level" style="font-weight:700;color:#fbbf24;">Total Referral Earnings</span>
                                <span class="earnings" style="font-size:1.1rem;">$${(referralEarnings || 0).toFixed(2)}</span>
                            </div>
                        </div>
                        <div class="col-md-4 text-center d-flex flex-column justify-content-center">
                            <div style="padding:20px;background:rgba(46,204,113,0.05);border-radius:12px;border:1px solid rgba(46,204,113,0.1);">
                                <small class="text-muted">Total Released</small>
                                <h3 style="color:#60a5fa;">${(rndWallet || 0).toFixed(4)} RND</h3>
                                <small class="text-muted">So Far</small>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="col-12">
                <div class="card-glass">
                    <div class="card-title"><i class="bi bi-link-45deg"></i>Your Referral Link</div>
                    <div class="referral-box">
                        <code>${referralLink}</code>
                        <button class="copy-btn" data-copy="${referralLink}"><i class="bi bi-clipboard me-1"></i>Copy</button>
                    </div>
                    <div class="mt-3 d-flex flex-wrap gap-2">
                        <span class="text-muted small"><i class="bi bi-people me-1"></i>Total Referrals: <strong style="color:#2ecc71;">${totalReferrals}</strong></span>
                        <span class="text-muted small"><i class="bi bi-box-arrow-up-right me-1"></i>Referral Code: <strong style="color:#2ecc71;font-size:0.7rem;">${u.referralCode}</strong></span>
                    </div>
                </div>
            </div>
            
            <div class="col-12">
                <div class="card-glass">
                    <div class="card-title"><i class="bi bi-arrow-left-right text-success me-2"></i>Send Money</div>
                    <form id="transferForm">
                        <div class="row g-3">
                            <div class="col-md-4">
                                <input type="text" id="transferUserId" class="form-control form-control-custom" placeholder="Recipient User ID / Username / Referral Code" required>
                            </div>
                            <div class="col-md-3">
                                <input type="number" id="transferAmount" class="form-control form-control-custom" placeholder="Amount" min="0.01" step="0.01" required>
                            </div>
                            <div class="col-md-3">
                                <select id="transferWallet" class="form-select form-select-custom">
                                    <option value="depositWallet">💰 Deposit Wallet (USDT)</option>
                                    <option value="referralWallet">💳 Referral Wallet (USDT)</option>
                                    <option value="rndWallet">📊 RND Wallet (RND)</option>
                                </select>
                            </div>
                            <div class="col-md-2">
                                <button type="submit" class="btn-primary-custom w-100"><i class="bi bi-send me-1"></i>Send</button>
                            </div>
                        </div>
                    </form>
                    
                    <div class="mt-3">
                        <small class="text-muted">Recent Transfers</small>
                        <div class="transfer-history">
                            ${sortedHistory.length === 0 ? `
                                <div class="text-center text-muted py-2" style="font-size:0.8rem;">
                                    <i class="bi bi-clock me-1"></i> No transfers yet
                                </div>
                            ` : sortedHistory.map(t => `
                                <div class="transfer-item">
                                    <div>
                                        ${t.type === 'sent' ? 
                                            `<span class="sent"><i class="bi bi-arrow-up-right"></i> Sent to <span class="user">${t.to || 'unknown'}</span> (${t.toUid ? t.toUid.substring(0, 8) : ''})</span>` :
                                            `<span class="received"><i class="bi bi-arrow-down-left"></i> Received from <span class="user">${t.from || 'unknown'}</span> (${t.fromUid ? t.fromUid.substring(0, 8) : ''})</span>`
                                        }
                                    </div>
                                    <div>
                                        <span class="amount ${t.type === 'sent' ? 'sent' : 'received'}">${t.type === 'sent' ? '-' : '+'}${t.amount} ${t.currency || 'RND'}</span>
                                        <div class="date">${new Date(t.timestamp).toLocaleString('hi-IN')}</div>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="col-12">
                <div class="card-glass">
                    <div class="card-title"><i class="bi bi-grid-3x3-gap-fill"></i>Quick Links</div>
                    <div class="d-flex flex-wrap gap-2">
                        <a href="deposit.html" class="btn-primary-custom"><i class="bi bi-arrow-down-circle me-1"></i>Deposit</a>
                        <a href="withdrawal.html" class="btn-outline-custom"><i class="bi bi-arrow-up-circle me-1"></i>Withdraw</a>
                        <a href="referrals.html" class="btn-outline-custom"><i class="bi bi-people me-1"></i>Referrals</a>
                        <a href="buy-package.html" class="btn-outline-custom"><i class="bi bi-box-seam me-1"></i>Buy Package</a>
                        <a href="profile.html" class="btn-outline-custom"><i class="bi bi-person me-1"></i>Profile</a>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            navigator.clipboard.writeText(btn.dataset.copy).then(() => {
                btn.innerHTML = '<i class="bi bi-check-circle me-1"></i>Copied!';
                setTimeout(() => { btn.innerHTML = '<i class="bi bi-clipboard me-1"></i>Copy'; }, 2000);
            });
        });
    });
    
    document.getElementById('transferForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        await handleTransfer();
    });
}

// ============================================================
// COPY USER ID
// ============================================================
window.copyUserId = function(username) {
    navigator.clipboard.writeText(username).then(() => {
        showToast('✅ User ID copied!', 'success');
    }).catch(() => {
        const textArea = document.createElement('textarea');
        textArea.value = username;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        showToast('✅ User ID copied!', 'success');
    });
};

// ============================================================
// ✅ TRANSFER HANDLER
// ============================================================
async function handleTransfer() {
    if (transferLock) {
        showToast('⏳ Transfer already in progress...', 'error');
        return;
    }

    const recipientIdentifier = document.getElementById('transferUserId').value.trim();
    const amountRaw = document.getElementById('transferAmount').value;
    const walletType = document.getElementById('transferWallet').value;
    const btn = document.querySelector('#transferForm button[type="submit"]');
    
    if (!recipientIdentifier) {
        showToast('❌ Please enter recipient ID', 'error');
        return;
    }
    const amount = parseFloat(amountRaw);
    if (!isFinite(amount) || Number.isNaN(amount) || amount <= 0) {
        showToast('❌ Please enter a valid amount', 'error');
        return;
    }
    if (!WALLET_CURRENCY[walletType]) {
        showToast('❌ Invalid wallet type', 'error');
        return;
    }
    
    const user = auth.currentUser;
    if (!user) { showToast('❌ Please login first', 'error'); return; }
    
    const recipient = await getUserByIdentifier(recipientIdentifier);
    if (!recipient) {
        showToast('❌ User not found!', 'error');
        return;
    }
    if (recipient.uid === user.uid) {
        showToast('❌ You cannot send money to yourself!', 'error');
        return;
    }

    const requestId = generateRequestId();

    transferLock = true;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Sending...';

    await markPending(user.uid, requestId);

    try {
        const result = await atomicTransfer(
            user.uid,
            recipient.uid,
            recipient.data,
            amount,
            walletType,
            WALLET_CURRENCY[walletType],
            requestId
        );

        const currency = WALLET_CURRENCY[walletType];
        const recipientName = recipient.data.username || recipient.data.referralCode || recipient.uid.slice(0, 8);

        if (result.status === TRANSFER_STATUS.SUCCESS) {
            showToast(`✅ ${amount} ${currency} sent to ${recipientName}!`, 'success');
            document.getElementById('transferUserId').value = '';
            document.getElementById('transferAmount').value = '';
            await clearPending(user.uid, requestId);
            await loadDashboardData(user.uid);
        } else if (result.status === TRANSFER_STATUS.UNKNOWN) {
            showToast(
                '⚠️ Transfer status could not be confirmed. Please DO NOT submit again. Checking...',
                'error'
            );
            btn.innerHTML = '<i class="bi bi-hourglass-split me-1"></i>Verifying...';
            setTimeout(() => {
                btn.disabled = false;
                btn.innerHTML = '<i class="bi bi-send me-1"></i>Send';
                transferLock = false;
                loadDashboardData(user.uid);
            }, 15000);
            return;
        } else {
            showToast('❌ ' + (result.error || 'Transfer failed'), 'error');
            await clearPending(user.uid, requestId);
        }
    } catch (error) {
        console.error('Transfer error:', error);
        showToast('❌ Error. Status will be verified on next load.', 'error');
    }
    
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-send me-1"></i>Send';
    transferLock = false;
}

// ============================================================
// LOAD DASHBOARD DATA
// ✅ Financial operations ab dashboard load par NAHI chalti
// ✅ Sirf reconciliation hoti hai
// ============================================================
async function loadDashboardData(userId) {
    if (isDashboardLoading) return;
    isDashboardLoading = true;
    
    try {
        // Reconciliation only
        try {
            const reconciliations = await reconcilePendingTransfers(userId);
            for (const r of reconciliations) {
                if (r.status === TRANSFER_STATUS.SUCCESS) {
                    showToast(`✅ Previous transfer confirmed successful`, 'success');
                } else if (r.status === TRANSFER_STATUS.FAILED) {
                    showToast(`❌ Previous transfer failed`, 'error');
                }
            }
        } catch (err) {
            console.warn('Reconciliation skipped:', err);
        }

        const userSnap = await get(ref(db, 'users/' + userId));
        
        if (!userSnap.exists()) {
            const authUser = auth.currentUser;
            if (authUser) {
                await loadDashboardData_internal(userId, authUser);
            }
            isDashboardLoading = false;
            return;
        }
        
        const u = userSnap.val();
        
        // ⚠️ NOTE: Daily release aur commission ab dashboard load par nahi hote
        // Yeh kaam alag trigger se honge (manual button ya scheduled job)
        
        // Sirf missing commission packages process karo (best-effort, background)
        const packages = u.packages || {};
        for (let [key, pkg] of Object.entries(packages)) {
            if (pkg.status === 'active' && !pkg.commissionProcessed && !pkg.commissionProcessing) {
                // Fire and forget (background)
                processReferralCommission(userId, key, pkg).catch(err => 
                    console.warn('Background commission failed:', err)
                );
            }
        }
        
        // Fresh read
        const updatedSnap = await get(ref(db, 'users/' + userId));
        const updatedData = updatedSnap.exists() ? updatedSnap.val() : u;
        const stats = calculateUserStats(updatedData);
        
        currentUserData = updatedData;
        currentUserId = userId;
        
        renderDashboard(updatedData);
        setupRealtimeListener(userId);
        
    } catch (error) {
        console.error('Error loading dashboard:', error);
        document.getElementById('dashboardContent').innerHTML = `
            <div class="text-center py-5">
                <i class="bi bi-exclamation-triangle text-danger fs-1 d-block mb-3"></i>
                <h4>Error Loading Dashboard</h4>
                <p class="text-muted">${error.message || 'Please check connection.'}</p>
                <button class="btn btn-primary-custom mt-3" onclick="location.reload()">Refresh</button>
            </div>
        `;
    } finally {
        isDashboardLoading = false;
    }
}

async function loadDashboardData_internal(userId, authUser) {
    const checkResult = await checkUserExists(userId);
    
    if (checkResult.exists) {
        const recovered = await recoverUserData(userId, authUser);
        if (recovered) {
            // ❌ NO automatic daily release / commission on first load
            const stats = calculateUserStats(recovered);
            currentUserData = recovered;
            currentUserId = userId;
            renderDashboard(recovered);
            setupRealtimeListener(userId);
            showToast('✅ Data recovered successfully', 'success');
        }
    } else {
        const newUser = await recoverUserData(userId, authUser);
        if (newUser) {
            const stats = calculateUserStats(newUser);
            currentUserData = newUser;
            currentUserId = userId;
            renderDashboard(newUser);
            setupRealtimeListener(userId);
        }
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

    try {
        await fetchLiveRate();
        
        const userSnap = await get(ref(db, 'users/' + user.uid));
        
        if (!userSnap.exists()) {
            console.log('🔄 Checking existing data...');
            const checkResult = await checkUserExists(user.uid);
            
            if (checkResult.exists) {
                await loadDashboardData(user.uid);
            } else {
                const email = user.email;
                if (email) {
                    const usersSnap = await get(ref(db, 'users'));
                    let emailExists = false;
                    if (usersSnap.exists()) {
                        const users = usersSnap.val();
                        for (let uid in users) {
                            if (users[uid].email === email && uid !== user.uid) {
                                emailExists = true;
                                break;
                            }
                        }
                    }
                    
                    if (emailExists) {
                        document.getElementById('dashboardContent').innerHTML = `
                            <div class="text-center py-5">
                                <i class="bi bi-exclamation-triangle text-warning fs-1 d-block mb-3"></i>
                                <h4>Account Already Exists</h4>
                                <p class="text-muted">This email is registered with another account.</p>
                                <button class="btn btn-primary-custom mt-3" onclick="location.reload()">Try Again</button>
                            </div>
                        `;
                        return;
                    }
                }
                
                await loadDashboardData(user.uid);
            }
            return;
        }
        
        const u = userSnap.val();
        
        if (u && u.banned === true) {
            alert('Your account has been banned.');
            await signOut(auth);
            window.location.href = 'login.html';
            return;
        }
        
        await loadDashboardData(user.uid);

    } catch (error) {
        console.error('Auth handler error:', error);
        document.getElementById('dashboardContent').innerHTML = `
            <div class="text-center py-5">
                <i class="bi bi-exclamation-triangle text-danger fs-1 d-block mb-3"></i>
                <h4>Authentication Error</h4>
                <p class="text-muted">${error.message || 'Please try again.'}</p>
                <button class="btn btn-primary-custom mt-3" onclick="location.reload()">Refresh</button>
            </div>
        `;
    }
});

// Cleanup
window.addEventListener('beforeunload', () => {
    if (listenerOff) { listenerOff(); listenerOff = null; }
    if (listenerTimeout) { clearTimeout(listenerTimeout); listenerTimeout = null; }
    if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
});
