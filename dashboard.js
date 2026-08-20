// ============================================================
// RND STAKING PLATFORM - DASHBOARD.JS (PRODUCTION READY v6)
// WITH 2-LEG RANK & REWARD SYSTEM
// ============================================================
// 📌 ALL BUSINESS LOGIC HERE:
// Firebase Init | Auth | Login | Logout | Dashboard Load
// Wallet | Referral | Team | Transactions | Packages
// Transfer (UPDATED - UID + Username + Referral Code Search)
// Daily Release (Pending Days) | Commission (Duplicate Proof)
// Backup (Comprehensive) | Recovery (Referral Chain Verify)
// Validation | Security | Real-time Listener (Debounced)
// RANK SYSTEM: 2-Leg Rank & Reward Automation
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getDatabase, ref, get, update, runTransaction, onValue, set, query, orderByChild, equalTo, limitToLast } from "firebase/database";

// ============================================================
// 🔥 NEW FIREBASE CONFIG (rwebsite-e031b)
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

console.log('✅ Firebase initialized with NEW config (rwebsite-e031b)');

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
// 🔥 GET USER BY USERNAME, UID OR REFERRAL CODE (UPDATED)
// ============================================================
async function getUserByIdentifier(identifier) {
    try {
        if (!identifier) return null;
        
        const usersRef = ref(db, 'users');
        
        // 1. Try by UID (Direct lookup)
        const uidSnap = await get(ref(db, 'users/' + identifier));
        if (uidSnap.exists()) {
            const data = uidSnap.val();
            return { uid: identifier, data: data, source: 'uid' };
        }
        
        // 2. Try by Username
        const usernameQuery = query(usersRef, orderByChild('username'), equalTo(identifier));
        const usernameSnap = await get(usernameQuery);
        if (usernameSnap.exists()) {
            const data = usernameSnap.val();
            const uid = Object.keys(data)[0];
            return { uid: uid, data: data[uid], source: 'username' };
        }
        
        // 3. Try by Referral Code
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
// BACKUP SYSTEM (Comprehensive)
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

async function createComprehensiveBackup(userId, action) {
    try {
        const userSnap = await get(ref(db, 'users/' + userId));
        if (!userSnap.exists()) {
            console.log('⚠️ User data not found for backup');
            return null;
        }
        
        const userData = userSnap.val();
        
        const backupData = {
            uid: userData.uid,
            email: userData.email,
            username: userData.username,
            referralCode: userData.referralCode,
            referredBy: userData.referredBy,
            createdAt: userData.createdAt,
            rank: userData.rank,
            depositWallet: userData.depositWallet || 0,
            referralWallet: userData.referralWallet || 0,
            rndWallet: userData.rndWallet || 0,
            lockedRND: userData.lockedRND || 0,
            releaseWallet: userData.releaseWallet || 0,
            totalReleased: userData.totalReleased || 0,
            packages: userData.packages || {},
            totalReferrals: userData.totalReferrals || 0,
            teamBusiness: userData.teamBusiness || 0,
            teamStructure: userData.teamStructure || { level1: 0, level2: 0, level3: 0, level4: 0, level5: 0 },
            referralEarnings: userData.referralEarnings || 0,
            level1Earnings: userData.level1Earnings || 0,
            level2Earnings: userData.level2Earnings || 0,
            level3Earnings: userData.level3Earnings || 0,
            level4Earnings: userData.level4Earnings || 0,
            level5Earnings: userData.level5Earnings || 0,
            commissionHistory: userData.commissionHistory || [],
            transactions: userData.transactions || {},
            transferHistory: userData.transferHistory || [],
            lastReleaseDate: userData.lastReleaseDate || null,
            backupCreatedAt: Date.now(),
            backupAction: action
        };
        
        const backupId = await createBackup(userId, action, backupData);
        console.log(`✅ Comprehensive backup created: ${backupId} for action: ${action}`);
        return backupId;
    } catch (error) {
        console.error('❌ Comprehensive backup failed:', error);
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
// CHECK USER EXISTENCE (With Recovery Check)
// ============================================================
async function checkUserExists(userId) {
    try {
        const userSnap = await get(ref(db, 'users/' + userId));
        if (userSnap.exists()) {
            return { exists: true, data: userSnap.val(), source: 'main' };
        }
        
        const backupSnap = await get(ref(db, 'backups/' + userId));
        if (backupSnap.exists()) {
            const backups = backupSnap.val();
            const keys = Object.keys(backups);
            if (keys.length > 0) {
                const latestKey = keys.reduce((a, b) => {
                    return backups[a].timestamp > backups[b].timestamp ? a : b;
                });
                return { exists: true, data: backups[latestKey].data, source: 'backup', backupId: latestKey };
            }
        }
        
        const txSnap = await get(ref(db, 'users/' + userId + '/transactions'));
        if (txSnap.exists()) {
            return { exists: true, data: { transactions: txSnap.val() }, source: 'transactions' };
        }
        
        const pkgSnap = await get(ref(db, 'users/' + userId + '/packages'));
        if (pkgSnap.exists()) {
            return { exists: true, data: { packages: pkgSnap.val() }, source: 'packages' };
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
// RECOVER USER DATA (With Referral Chain Verification)
// ============================================================
async function recoverUserData(userId, authUser) {
    try {
        console.log('🔄 Starting recovery process for:', userId);
        
        const checkResult = await checkUserExists(userId);
        
        if (checkResult.exists) {
            console.log('✅ Found existing data from:', checkResult.source);
            
            let recoveredData = {};
            
            const userSnap = await get(ref(db, 'users/' + userId));
            if (userSnap.exists()) {
                recoveredData = userSnap.val();
                console.log('✅ Main user data found');
            }
            
            if (checkResult.source === 'backup' && checkResult.data) {
                const backupData = checkResult.data;
                
                const protectedFields = ['referralCode', 'referredBy', 'uid', 'createdAt'];
                for (let field of protectedFields) {
                    if (backupData[field]) {
                        recoveredData[field] = backupData[field];
                    }
                }
                
                const mergeFields = [
                    'depositWallet', 'referralWallet', 'rndWallet', 'lockedRND',
                    'releaseWallet', 'totalReleased', 'packages', 'transactions',
                    'transferHistory', 'commissionHistory', 'teamStructure',
                    'totalReferrals', 'teamBusiness', 'referralEarnings',
                    'level1Earnings', 'level2Earnings', 'level3Earnings',
                    'level4Earnings', 'level5Earnings', 'lastReleaseDate'
                ];
                
                for (let field of mergeFields) {
                    if (backupData[field] !== undefined && backupData[field] !== null) {
                        if (typeof backupData[field] === 'object' && !Array.isArray(backupData[field])) {
                            recoveredData[field] = { ...(recoveredData[field] || {}), ...backupData[field] };
                        } else {
                            recoveredData[field] = backupData[field];
                        }
                    }
                }
                
                console.log('✅ Restored from backup with referral chain preserved');
            }
            
            // ============================================================
            // CRITICAL: Verify Referral Chain
            // ============================================================
            if (recoveredData.referralCode) {
                console.log('✅ Referral Code preserved:', recoveredData.referralCode);
            } else {
                console.warn('⚠️ Referral Code missing, generating new one');
                recoveredData.referralCode = userId.substring(0, 8).toUpperCase();
            }
            
            if (recoveredData.referredBy) {
                console.log('✅ Referred By preserved:', recoveredData.referredBy);
                const referrer = await getUserByIdentifier(recoveredData.referredBy);
                if (!referrer) {
                    console.warn('⚠️ Referrer not found, keeping referral code anyway');
                }
            }
            
            if (!recoveredData.teamStructure) {
                recoveredData.teamStructure = { level1: 0, level2: 0, level3: 0, level4: 0, level5: 0 };
            }
            
            if (!recoveredData.commissionHistory) {
                recoveredData.commissionHistory = [];
            }
            
            // Verify packages
            const packages = recoveredData.packages || {};
            for (let key in packages) {
                const pkg = packages[key];
                if (pkg.status === 'completed' && pkg.commissionProcessed === undefined) {
                    pkg.commissionProcessed = true;
                }
            }
            recoveredData.packages = packages;
            
            if (!recoveredData.uid) recoveredData.uid = userId;
            if (!recoveredData.email) recoveredData.email = authUser.email || '';
            if (!recoveredData.name) recoveredData.name = authUser.displayName || 'User';
            
            const defaultFields = {
                username: authUser.email ? authUser.email.split('@')[0] : 'user_' + userId.substring(0, 8),
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
                packages: {},
                transactions: {},
                transferHistory: [],
                commissionHistory: [],
                teamStructure: { level1: 0, level2: 0, level3: 0, level4: 0, level5: 0 },
                lastReleaseDate: null
            };
            
            for (let key in defaultFields) {
                if (recoveredData[key] === undefined || recoveredData[key] === null) {
                    recoveredData[key] = defaultFields[key];
                }
            }
            
            const updateData = {};
            for (let key in recoveredData) {
                if (recoveredData[key] !== undefined && recoveredData[key] !== null) {
                    updateData[key] = recoveredData[key];
                }
            }
            
            await update(ref(db, 'users/' + userId), updateData);
            console.log('✅ User data recovered successfully with referral chain intact');
            
            return recoveredData;
        }
        
        // Check if email exists in any user record (prevent duplicate)
        const email = authUser.email;
        if (email) {
            const usersSnap = await get(ref(db, 'users'));
            if (usersSnap.exists()) {
                const users = usersSnap.val();
                for (let uid in users) {
                    if (users[uid].email === email && uid !== userId) {
                        console.warn('⚠️ Email already exists with different UID:', uid);
                        return null;
                    }
                }
            }
        }
        
        console.log('🆕 Creating new user record for:', userId);
        
        const newUserData = {
            uid: userId,
            email: authUser.email || '',
            username: authUser.email ? authUser.email.split('@')[0] : 'user_' + userId.substring(0, 8),
            referralCode: userId.substring(0, 8).toUpperCase(),
            name: authUser.displayName || 'User',
            createdAt: Date.now(),
            lastLogin: Date.now(),
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
        console.log('✅ New user created successfully');
        
        return newUserData;
        
    } catch (error) {
        console.error('❌ Error in recovery process:', error);
        return null;
    }
}

// ============================================================
// PROCESS DAILY RELEASE (With Pending Days Calculation)
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
            
            // Calculate pending days
            let pendingDays = 0;
            if (lastReleaseDate) {
                const daysDiff = getDaysBetween(lastReleaseDate, today);
                if (daysDiff === 0) {
                    return currentData;
                }
                pendingDays = Math.max(0, daysDiff - 1);
            }
            
            if (!lastReleaseDate) {
                pendingDays = 0;
            }
            
            const packages = currentData.packages || {};
            let updatedPackages = {};
            let releaseTransactions = [];
            let totalReleaseToday = 0;
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
                totalReleaseToday += todayReleaseAmount;
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
                    description: `Daily release of ${todayReleaseAmount.toFixed(4)} RND from ${pkg.planName || 'Package'}`
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
                        description: `Pending release of ${pendingAmount.toFixed(4)} RND from ${pkg.planName || 'Package'} (${pendingDays} days pending)`
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
            const data = result.snapshot.val();
            console.log('✅ Daily release processed successfully');
            // Trigger rank evaluation after release
            await triggerRankEvaluation(userId);
            return data;
        }
        return null;
    } catch (error) {
        console.error('❌ Error processing daily release:', error);
        return null;
    } finally {
        releaseInProgress = false;
    }
}

// ============================================================
// PROCESS REFERRAL COMMISSION (Duplicate Proof with Lock)
// ============================================================
async function processReferralCommission(userId, packageId, packageData) {
    if (commissionInProgress) {
        console.log('⏳ Commission already in progress, skipping...');
        return null;
    }
    
    commissionInProgress = true;
    
    try {
        if (packageData.commissionProcessed === true) {
            console.log('⚠️ Commission already processed for package:', packageId);
            return null;
        }
        if (packageData.status !== 'active') {
            console.log('⚠️ Package not active, skipping commission:', packageId);
            return null;
        }
        
        // Lock the package to prevent duplicate processing
        const lockRef = ref(db, `processing_locks/${packageId}`);
        const lockSnap = await get(lockRef);
        
        if (lockSnap.exists()) {
            console.log('⚠️ Package is being processed by another instance:', packageId);
            return null;
        }
        
        await set(lockRef, {
            lockedAt: Date.now(),
            userId: userId,
            packageId: packageId
        });
        
        try {
            const userSnapshot = await get(ref(db, 'users/' + userId));
            if (!userSnapshot.exists()) {
                console.log('❌ User not found for commission:', userId);
                return null;
            }
            
            const userData = userSnapshot.val();
            const referralCode = userData.referralCode;
            const packageAmount = packageData.usdtAmount || 0;
            
            if (packageAmount <= 0) {
                console.log('⚠️ Package amount is 0, skipping commission');
                return null;
            }
            
            const commissionLevels = [
                { level: 1, percent: 0.08 },
                { level: 2, percent: 0.04 },
                { level: 3, percent: 0.02 },
                { level: 4, percent: 0.01 },
                { level: 5, percent: 0.01 }
            ];
            
            let currentRefCode = referralCode;
            let level = 1;
            let commissionProcessed = false;
            
            while (currentRefCode && level <= 5) {
                const refResult = await getUserByIdentifier(currentRefCode);
                
                if (!refResult || refResult.uid === userId) break;
                
                const referrerData = refResult.data;
                const uid = refResult.uid;
                
                const commissionPercent = commissionLevels.find(l => l.level === level)?.percent || 0;
                const commissionAmount = packageAmount * commissionPercent;
                
                if (commissionAmount > 0) {
                    const referrerRef = ref(db, 'users/' + uid);
                    await runTransaction(referrerRef, (currentData) => {
                        if (!currentData) return currentData;
                        
                        currentData.referralWallet = (currentData.referralWallet || 0) + commissionAmount;
                        const levelKey = `level${level}Earnings`;
                        currentData[levelKey] = (currentData[levelKey] || 0) + commissionAmount;
                        currentData.referralEarnings = (currentData.referralEarnings || 0) + commissionAmount;
                        currentData.teamBusiness = (currentData.teamBusiness || 0) + packageAmount;
                        
                        const commissionHistory = currentData.commissionHistory || [];
                        const existing = commissionHistory.find(h => 
                            h.packageId === packageId && h.level === level && h.fromUser === (userData.username || userData.referralCode || userId)
                        );
                        
                        if (!existing) {
                            commissionHistory.push({
                                type: 'referral_commission',
                                level: level,
                                percent: commissionPercent * 100,
                                amount: commissionAmount,
                                fromUser: userData.username || userData.referralCode || userId,
                                fromUid: userId,
                                packageId: packageId,
                                timestamp: Date.now(),
                                date: getTodayDate(),
                                description: `${commissionPercent * 100}% commission from Level ${level} referral`
                            });
                            currentData.commissionHistory = commissionHistory;
                            
                            const transactions = currentData.transactions || {};
                            transactions[generateTxId()] = {
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
                                description: `Received ${commissionPercent * 100}% commission ($${commissionAmount.toFixed(2)}) from Level ${level} referral`
                            };
                            currentData.transactions = transactions;
                        }
                        
                        return currentData;
                    });
                    commissionProcessed = true;
                }
                
                currentRefCode = referrerData.referredBy || null;
                level++;
            }
            
            await update(ref(db, 'users/' + userId + '/packages/' + packageId), {
                commissionProcessed: true,
                commissionProcessedAt: Date.now()
            });
            
            console.log('✅ Commission processed for package ' + packageId);
            // Trigger rank evaluation after commission
            await triggerRankEvaluation(userId);
            return true;
            
        } finally {
            await set(lockRef, null);
        }
        
    } catch (error) {
        console.error('❌ Error processing commission:', error);
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
    
    return {
        totalLockedRND,
        totalDailyRelease,
        activePackages,
        totalStake,
        totalReleased
    };
}

// ============================================================
// 🔥 ATOMIC TRANSFER (UPDATED - UID + Username + Referral Code Search)
// ============================================================
async function atomicTransfer(senderUid, recipientUid, recipientData, amount, walletType, currency, senderUsername, senderUidForHistory) {
    if (amount <= 0) return { success: false, error: 'Invalid amount' };
    
    const senderRef = ref(db, 'users/' + senderUid);
    const timestamp = Date.now();
    const date = getTodayDate();
    const txId = generateTxId();
    
    const recipientUsername = recipientData.username || recipientData.referralCode || recipientUid;
    const recipientUidForHistory = recipientUid;
    
    await createComprehensiveBackup(senderUid, 'transfer_sender');
    await createComprehensiveBackup(recipientUid, 'transfer_recipient');
    
    const senderResult = await runTransaction(senderRef, (currentData) => {
        if (!currentData) return currentData;
        const balance = currentData[walletType] || 0;
        if (balance < amount) {
            return currentData;
        }
        currentData[walletType] = balance - amount;
        
        const transferHistory = currentData.transferHistory || [];
        transferHistory.push({
            type: 'sent',
            to: recipientUsername,
            toUid: recipientUidForHistory,
            amount: amount,
            from: senderUsername,
            fromUid: senderUidForHistory || senderUid,
            currency: currency,
            timestamp: timestamp,
            txId: txId,
            status: 'completed'
        });
        currentData.transferHistory = transferHistory;
        
        const transactions = currentData.transactions || {};
        transactions[txId] = {
            type: 'transfer_sent',
            amount: amount,
            currency: currency,
            to: recipientUsername,
            toUid: recipientUidForHistory,
            from: senderUsername,
            fromUid: senderUidForHistory || senderUid,
            timestamp: timestamp,
            date: date,
            status: 'completed'
        };
        currentData.transactions = transactions;
        
        return currentData;
    });
    
    if (!senderResult.committed) {
        return { success: false, error: 'Insufficient balance or sender update failed' };
    }
    
    const recipientRef = ref(db, 'users/' + recipientUid);
    const recipientResult = await runTransaction(recipientRef, (currentData) => {
        if (!currentData) return currentData;
        currentData[walletType] = (currentData[walletType] || 0) + amount;
        
        const transferHistory = currentData.transferHistory || [];
        transferHistory.push({
            type: 'received',
            from: senderUsername,
            fromUid: senderUidForHistory || senderUid,
            to: recipientUsername,
            toUid: recipientUidForHistory,
            amount: amount,
            currency: currency,
            timestamp: timestamp,
            txId: txId,
            status: 'completed'
        });
        currentData.transferHistory = transferHistory;
        
        const transactions = currentData.transactions || {};
        transactions[txId] = {
            type: 'transfer_received',
            amount: amount,
            currency: currency,
            from: senderUsername,
            fromUid: senderUidForHistory || senderUid,
            to: recipientUsername,
            toUid: recipientUidForHistory,
            timestamp: timestamp,
            date: date,
            status: 'completed'
        };
        currentData.transactions = transactions;
        
        return currentData;
    });
    
    if (!recipientResult.committed) {
        await runTransaction(senderRef, (currentData) => {
            if (!currentData) return currentData;
            currentData[walletType] = (currentData[walletType] || 0) + amount;
            const transactions = currentData.transactions || {};
            if (transactions[txId]) {
                transactions[txId].status = 'rolled_back';
            }
            currentData.transactions = transactions;
            return currentData;
        });
        return { success: false, error: 'Recipient update failed, funds returned' };
    }
    
    return { success: true, txId: txId };
}

// ============================================================
// REAL-TIME LISTENER (Debounced - No Duplicate)
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
                // Update rank UI when packages change
                updateRankUI(currentUserData);
            }
            updateTimer = null;
        }, 500);
    });
}

// ============================================================
// UPDATE DASHBOARD UI (Safe - No Database Writes)
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
    const rank = u.rank || 'Member';
    const isMember = rank === 'Member' || rank === 'member' || !rank;
    
    const teamStructure = u.teamStructure || { level1: 0, level2: 0, level3: 0, level4: 0, level5: 0 };
    const directReferrals = teamStructure.level1 || 0;
    const totalReferrals = (teamStructure.level1 || 0) + 
                          (teamStructure.level2 || 0) + 
                          (teamStructure.level3 || 0) + 
                          (teamStructure.level4 || 0) + 
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
            const released = pkg.releasedRND || 0;
            const days = Math.floor(released / pkg.dailyRelease);
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
    
    const transferHistory = u.transferHistory || [];
    const sortedHistory = [...transferHistory].reverse().slice(0, 5);

    // Calculate rank progress
    const rankOrder = ['Member', 'Executive', 'Senior Executive', 'Manager', 'Senior Manager', 'Diamond'];
    const currentRankIndex = rankOrder.indexOf(rank);
    const progressPercent = ((currentRankIndex) / (rankOrder.length - 1)) * 100;

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
            
            <!-- ====== 4 WALLETS ====== -->
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
            
            <!-- ====== DAILY RELEASE & STATS ====== -->
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
            
            <!-- ====== RELEASE INFO BOX ====== -->
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

            <!-- ====== RANK PROGRESS CARD - NEW ====== -->
            <div class="col-12">
                <div class="rank-progress-card">
                    <div class="rank-header">
                        <div>
                            <span class="rank-badge ${rank.toLowerCase().replace(/ /g, '-')}" id="currentRankBadge">${rank}</span>
                            <span class="rank-label">Current Rank</span>
                        </div>
                        <div>
                            <span class="rank-reward" id="totalRankRewards">$${Object.values(u.rankRewards || {}).reduce((sum, r) => sum + (r.amount || 0), 0).toFixed(2)}</span>
                            <span class="rank-label">Total Rank Rewards</span>
                        </div>
                    </div>
                    
                    <div class="progress-steps">
                        <div class="step ${currentRankIndex >= 0 ? 'completed' : ''}" id="stepMember">
                            <span class="step-icon">1</span>
                            <span class="step-label">Member</span>
                        </div>
                        <div class="step ${currentRankIndex >= 1 ? 'completed' : ''} ${currentRankIndex === 1 ? 'active' : ''}" id="stepExecutive">
                            <span class="step-icon">2</span>
                            <span class="step-label">Executive</span>
                            <span class="step-reward">+$100</span>
                        </div>
                        <div class="step ${currentRankIndex >= 2 ? 'completed' : ''} ${currentRankIndex === 2 ? 'active' : ''}" id="stepSeniorExecutive">
                            <span class="step-icon">3</span>
                            <span class="step-label">Sr. Exec</span>
                            <span class="step-reward">+$200</span>
                        </div>
                        <div class="step ${currentRankIndex >= 3 ? 'completed' : ''} ${currentRankIndex === 3 ? 'active' : ''}" id="stepManager">
                            <span class="step-icon">4</span>
                            <span class="step-label">Manager</span>
                            <span class="step-reward">+$500</span>
                        </div>
                        <div class="step ${currentRankIndex >= 4 ? 'completed' : ''} ${currentRankIndex === 4 ? 'active' : ''}" id="stepSeniorManager">
                            <span class="step-icon">5</span>
                            <span class="step-label">Sr. Mgr</span>
                            <span class="step-reward">+$1,000</span>
                        </div>
                        <div class="step ${currentRankIndex >= 5 ? 'completed' : ''} ${currentRankIndex === 5 ? 'active' : ''}" id="stepDiamond">
                            <span class="step-icon">6</span>
                            <span class="step-label">Diamond</span>
                            <span class="step-reward">+$2,500</span>
                        </div>
                    </div>
                    
                    <div class="rank-details">
                        <div class="detail-item">
                            <span class="detail-label">Personal Business</span>
                            <span class="detail-value" id="personalBusiness">$${(u.personalBusiness || 0).toFixed(2)}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">Team Business</span>
                            <span class="detail-value" id="teamBusiness">$${(u.teamBusiness || 0).toFixed(2)}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">Left Leg Business</span>
                            <span class="detail-value" id="leftLegBusiness">$${(u.leftLegBusiness || 0).toFixed(2)}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">Right Leg Business</span>
                            <span class="detail-value" id="rightLegBusiness">$${(u.rightLegBusiness || 0).toFixed(2)}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">Qualified Directs</span>
                            <span class="detail-value" id="qualifiedDirects">${Object.keys(u.qualifiedDirects || {}).reduce((sum, key) => sum + (u.qualifiedDirects[key] || []).length, 0)} / 2</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">Next Rank</span>
                            <span class="detail-value" id="nextRank">${rank === 'Diamond' ? '🏆 Max Achieved' : (['Executive','Senior Executive','Manager','Senior Manager','Diamond'][currentRankIndex] || 'Executive')}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">Next Reward</span>
                            <span class="detail-value" id="nextReward">${rank === 'Diamond' ? '🏆 Max' : ['$100','$200','$500','$1,000','$2,500'][currentRankIndex] || '$100'}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">Progress</span>
                            <div class="progress-bar-container">
                                <div class="progress-bar-fill" id="rankProgressBar" style="width: ${Math.min(progressPercent, 100)}%;"></div>
                            </div>
                            <span class="detail-value" id="rankProgressPercent">${Math.min(Math.round(progressPercent), 100)}%</span>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- ====== STATISTICS ====== -->
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
            
            <!-- ====== 5 LEVEL MEMBERS ====== -->
            <div class="col-12">
                <h5 class="fw-bold mb-3"><i class="bi bi-people text-success me-2"></i>Team Members by Level</h5>
                <div class="level-stats">
                    <div class="level-stat-card">
                        <div class="number">${teamLevels.level1 || 0}</div>
                        <div class="label">Level 1</div>
                    </div>
                    <div class="level-stat-card">
                        <div class="number">${teamLevels.level2 || 0}</div>
                        <div class="label">Level 2</div>
                    </div>
                    <div class="level-stat-card">
                        <div class="number">${teamLevels.level3 || 0}</div>
                        <div class="label">Level 3</div>
                    </div>
                    <div class="level-stat-card">
                        <div class="number">${teamLevels.level4 || 0}</div>
                        <div class="label">Level 4</div>
                    </div>
                    <div class="level-stat-card">
                        <div class="number">${teamLevels.level5 || 0}</div>
                        <div class="label">Level 5</div>
                    </div>
                </div>
            </div>
            
            <!-- ====== 5 LEVEL COMMISSIONS ====== -->
            <div class="col-12">
                <div class="card-glass">
                    <div class="card-title"><i class="bi bi-cash-stack text-success me-2"></i>5 Level Referral Commissions</div>
                    <div class="row">
                        <div class="col-md-8">
                            <div class="commission-row">
                                <span class="level">Level 1 (8%)</span>
                                <span class="earnings">$${(level1Earn || 0).toFixed(2)}</span>
                            </div>
                            <div class="commission-row">
                                <span class="level">Level 2 (4%)</span>
                                <span class="earnings">$${(level2Earn || 0).toFixed(2)}</span>
                            </div>
                            <div class="commission-row">
                                <span class="level">Level 3 (2%)</span>
                                <span class="earnings">$${(level3Earn || 0).toFixed(2)}</span>
                            </div>
                            <div class="commission-row">
                                <span class="level">Level 4 (1%)</span>
                                <span class="earnings">$${(level4Earn || 0).toFixed(2)}</span>
                            </div>
                            <div class="commission-row">
                                <span class="level">Level 5 (1%)</span>
                                <span class="earnings">$${(level5Earn || 0).toFixed(2)}</span>
                            </div>
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
            
            <!-- ====== REFERRAL LINK ====== -->
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
            
            <!-- ====== TRANSFER SYSTEM ====== -->
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
            
            <!-- ====== QUICK LINKS ====== -->
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
    
    // Update rank UI after render
    updateRankUI(u);
}

// ============================================================
// COPY USER ID
// ============================================================
window.copyUserId = function(username) {
    navigator.clipboard.writeText(username).then(() => {
        showToast('✅ User ID copied to clipboard!', 'success');
    }).catch(() => {
        const textArea = document.createElement('textarea');
        textArea.value = username;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        showToast('✅ User ID copied to clipboard!', 'success');
    });
};

// ============================================================
// 🔥 TRANSFER HANDLER (UPDATED)
// ============================================================
async function handleTransfer() {
    const recipientIdentifier = document.getElementById('transferUserId').value.trim();
    const amount = parseFloat(document.getElementById('transferAmount').value);
    const walletType = document.getElementById('transferWallet').value;
    const btn = document.querySelector('#transferForm button[type="submit"]');
    
    if (!recipientIdentifier) { showToast('❌ Please enter recipient User ID, Username or Referral Code', 'error'); return; }
    if (!amount || amount <= 0) { showToast('❌ Please enter a valid amount', 'error'); return; }
    
    const user = auth.currentUser;
    if (!user) { showToast('❌ Please login first', 'error'); return; }
    
    const senderSnap = await get(ref(db, 'users/' + user.uid));
    if (!senderSnap.exists()) { showToast('❌ User data not found', 'error'); return; }
    const senderData = senderSnap.val();
    const senderUsername = senderData.username || senderData.referralCode;
    const senderUid = user.uid;
    
    const recipient = await getUserByIdentifier(recipientIdentifier);
    if (!recipient) { showToast('❌ User not found! Please check the ID, Username or Referral Code.', 'error'); return; }
    
    const recipientUid = recipient.uid;
    const recipientData = recipient.data;
    const recipientUsername = recipientData.username || recipientData.referralCode;
    
    if (recipientUid === senderUid) { 
        showToast('❌ You cannot send money to yourself!', 'error'); 
        return; 
    }
    
    const senderBalance = senderData[walletType] || 0;
    if (senderBalance < amount) {
        const walletLabels = {
            'depositWallet': 'Deposit Wallet (USDT)',
            'referralWallet': 'Referral Wallet (USDT)',
            'rndWallet': 'RND Wallet (RND)'
        };
        showToast(`❌ Insufficient balance in ${walletLabels[walletType] || 'Wallet'}! You have ${senderBalance.toFixed(4)}`, 'error');
        return;
    }
    
    const currency = walletType === 'rndWallet' ? 'RND' : 'USDT';
    
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Sending...';
    
    try {
        const result = await atomicTransfer(
            senderUid,
            recipientUid,
            recipientData,
            amount,
            walletType,
            currency,
            senderUsername,
            senderUid
        );
        
        if (result.success) {
            showToast(`✅ ${amount} ${currency} sent successfully to ${recipientUsername}!`, 'success');
            document.getElementById('transferUserId').value = '';
            document.getElementById('transferAmount').value = '';
            await loadDashboardData(user.uid);
        } else {
            showToast('❌ ' + (result.error || 'Transfer failed. Please try again.'), 'error');
        }
        
    } catch (error) {
        console.error('Transfer error:', error);
        showToast('❌ Error sending. Please try again.', 'error');
    }
    
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-send me-1"></i>Send';
}

// ============================================================
// ============================================================
// 🔥 RANK SYSTEM - 2-LEG RANK & REWARD ENGINE (NEW)
// ============================================================
// ============================================================

// ============================================================
// RANK CONFIGURATION
// ============================================================
const RANK_CONFIG = {
  MEMBER: {
    name: 'Member',
    order: 0,
    personalBusiness: 0,
    teamBusiness: 0,
    requiredDirectRank: null,
    requiredDirectCount: 0,
    requiredLegs: 0,
    reward: 0,
    nextRank: 'Executive'
  },
  EXECUTIVE: {
    name: 'Executive',
    order: 1,
    personalBusiness: 3000,
    teamBusiness: 0,
    requiredDirectRank: null,
    requiredDirectCount: 0,
    requiredLegs: 0,
    reward: 100,
    nextRank: 'Senior Executive'
  },
  SENIOR_EXECUTIVE: {
    name: 'Senior Executive',
    order: 2,
    personalBusiness: 0,
    teamBusiness: 10000,
    requiredDirectRank: 'Executive',
    requiredDirectCount: 2,
    requiredLegs: 2,
    reward: 200,
    nextRank: 'Manager'
  },
  MANAGER: {
    name: 'Manager',
    order: 3,
    personalBusiness: 0,
    teamBusiness: 25000,
    requiredDirectRank: 'Senior Executive',
    requiredDirectCount: 2,
    requiredLegs: 2,
    reward: 500,
    nextRank: 'Senior Manager'
  },
  SENIOR_MANAGER: {
    name: 'Senior Manager',
    order: 4,
    personalBusiness: 0,
    teamBusiness: 50000,
    requiredDirectRank: 'Manager',
    requiredDirectCount: 2,
    requiredLegs: 2,
    reward: 1000,
    nextRank: 'Diamond'
  },
  DIAMOND: {
    name: 'Diamond',
    order: 5,
    personalBusiness: 0,
    teamBusiness: 100000,
    requiredDirectRank: 'Senior Manager',
    requiredDirectCount: 2,
    requiredLegs: 2,
    reward: 2500,
    nextRank: null
  }
};

// ============================================================
// 🔥 MAIN RANK EVALUATION ENGINE
// ============================================================
async function evaluateUserRank(userId) {
  try {
    // Check if evaluation is already running
    const lockRef = ref(db, `rankLocks/${userId}`);
    const lockSnap = await get(lockRef);
    if (lockSnap.exists()) {
      console.log(`⏳ Rank evaluation already running for ${userId}`);
      return null;
    }
    
    // Set lock
    await set(lockRef, { lockedAt: Date.now(), userId });
    
    try {
      // Get user data
      const userSnap = await get(ref(db, `users/${userId}`));
      if (!userSnap.exists()) {
        console.log(`❌ User ${userId} not found`);
        return null;
      }
      
      const userData = userSnap.val();
      const currentRank = userData.rank || 'Member';
      const currentRankOrder = RANK_CONFIG[currentRank.replace(/ /g, '_').toUpperCase()]?.order || 0;
      
      // Calculate personal business
      const personalBusiness = userData.personalBusiness || userData.depositWallet || 0;
      
      // Get direct referrals (level 1)
      const directReferrals = await getDirectReferrals(userId);
      
      // Calculate team business and leg-wise business
      const { totalTeamBusiness, leftLegBusiness, rightLegBusiness, qualifiedDirects } = 
        await calculateTeamBusinessAndQualifiedDirects(userId, directReferrals);
      
      // Determine highest eligible rank
      const eligibleRank = await determineHighestEligibleRank(
        userId,
        personalBusiness,
        totalTeamBusiness,
        leftLegBusiness,
        rightLegBusiness,
        qualifiedDirects,
        currentRankOrder
      );
      
      if (!eligibleRank) {
        console.log(`ℹ️ No rank upgrade for ${userId}`);
        await updateRankEvaluation(userId, userData, personalBusiness, totalTeamBusiness);
        return null;
      }
      
      // Check if already processed this rank
      const rankKey = eligibleRank.replace(/ /g, '_').toUpperCase();
      const rewardKey = `${userId}_${rankKey}_RANK_REWARD`;
      const rewardCheck = await get(ref(db, `rankRewards/${rewardKey}`));
      
      if (rewardCheck.exists()) {
        console.log(`⚠️ Rank reward already processed: ${eligibleRank} for ${userId}`);
        return null;
      }
      
      // Process rank upgrade
      const result = await processRankUpgrade(
        userId,
        userData,
        eligibleRank,
        personalBusiness,
        totalTeamBusiness,
        leftLegBusiness,
        rightLegBusiness,
        qualifiedDirects
      );
      
      if (result.success) {
        console.log(`✅ Rank upgraded to ${eligibleRank} for ${userId}`);
        await createNotification(userId, eligibleRank, result.rewardAmount);
        return result;
      }
      
      return null;
      
    } finally {
      // Release lock
      await set(lockRef, null);
    }
    
  } catch (error) {
    console.error(`❌ Error evaluating rank for ${userId}:`, error);
    return null;
  }
}

// ============================================================
// 🔥 GET DIRECT REFERRALS
// ============================================================
async function getDirectReferrals(userId) {
  try {
    const referrals = [];
    const usersSnap = await get(ref(db, 'users'));
    if (!usersSnap.exists()) return referrals;
    
    const users = usersSnap.val();
    for (let uid in users) {
      const user = users[uid];
      if (user.referredBy === userId || 
          user.referredBy === user.referralCode || 
          user.sponsor === userId) {
        referrals.push({
          uid: uid,
          data: user,
          rank: user.rank || 'Member'
        });
      }
    }
    
    return referrals;
  } catch (error) {
    console.error('Error getting direct referrals:', error);
    return [];
  }
}

// ============================================================
// 🔥 CALCULATE TEAM BUSINESS & QUALIFIED DIRECTS
// ============================================================
async function calculateTeamBusinessAndQualifiedDirects(userId, directReferrals) {
  let totalTeamBusiness = 0;
  let leftLegBusiness = 0;
  let rightLegBusiness = 0;
  const qualifiedDirects = {
    executive: [],
    seniorExecutive: [],
    manager: [],
    seniorManager: [],
    diamond: []
  };
  
  // Process each direct referral
  for (let i = 0; i < directReferrals.length; i++) {
    const direct = directReferrals[i];
    const directUid = direct.uid;
    const directData = direct.data;
    const directRank = directData.rank || 'Member';
    
    // Calculate business for this direct's entire team
    const teamBusiness = await calculateTeamBusinessForUser(directUid);
    totalTeamBusiness += teamBusiness;
    
    // Determine leg (alternate for now, will use actual leg data)
    const isLeftLeg = i % 2 === 0;
    if (isLeftLeg) {
      leftLegBusiness += teamBusiness;
    } else {
      rightLegBusiness += teamBusiness;
    }
    
    // Track qualified directs by rank
    if (directRank === 'Executive' || directRank === 'Senior Executive' || 
        directRank === 'Manager' || directRank === 'Senior Manager' || 
        directRank === 'Diamond') {
      qualifiedDirects.executive.push(directUid);
    }
    if (directRank === 'Senior Executive' || directRank === 'Manager' || 
        directRank === 'Senior Manager' || directRank === 'Diamond') {
      qualifiedDirects.seniorExecutive.push(directUid);
    }
    if (directRank === 'Manager' || directRank === 'Senior Manager' || directRank === 'Diamond') {
      qualifiedDirects.manager.push(directUid);
    }
    if (directRank === 'Senior Manager' || directRank === 'Diamond') {
      qualifiedDirects.seniorManager.push(directUid);
    }
    if (directRank === 'Diamond') {
      qualifiedDirects.diamond.push(directUid);
    }
  }
  
  return {
    totalTeamBusiness,
    leftLegBusiness,
    rightLegBusiness,
    qualifiedDirects
  };
}

// ============================================================
// 🔥 CALCULATE TEAM BUSINESS FOR A USER
// ============================================================
async function calculateTeamBusinessForUser(userId) {
  try {
    const userSnap = await get(ref(db, `users/${userId}`));
    if (!userSnap.exists()) return 0;
    
    const userData = userSnap.val();
    let business = userData.teamBusiness || 0;
    
    if (business === 0) {
      const transactions = userData.transactions || {};
      for (let key in transactions) {
        const tx = transactions[key];
        if ((tx.type === 'deposit' || tx.type === 'package') && tx.status === 'approved') {
          business += (tx.amount || 0);
        }
      }
    }
    
    return business;
  } catch (error) {
    console.error('Error calculating team business:', error);
    return 0;
  }
}

// ============================================================
// 🔥 DETERMINE HIGHEST ELIGIBLE RANK
// ============================================================
async function determineHighestEligibleRank(
  userId,
  personalBusiness,
  totalTeamBusiness,
  leftLegBusiness,
  rightLegBusiness,
  qualifiedDirects,
  currentRankOrder
) {
  // Check ranks from highest to lowest
  const rankOrder = ['DIAMOND', 'SENIOR_MANAGER', 'MANAGER', 'SENIOR_EXECUTIVE', 'EXECUTIVE'];
  
  for (let rankKey of rankOrder) {
    const config = RANK_CONFIG[rankKey];
    if (!config) continue;
    
    const rankOrderValue = config.order;
    if (rankOrderValue <= currentRankOrder) continue; // Skip if already achieved
    
    // Check personal business requirement
    if (config.personalBusiness > 0 && personalBusiness < config.personalBusiness) {
      continue;
    }
    
    // Check team business requirement
    if (config.teamBusiness > 0 && totalTeamBusiness < config.teamBusiness) {
      continue;
    }
    
    // Check required direct rank
    if (config.requiredDirectRank) {
      const requiredRankKey = config.requiredDirectRank.replace(/ /g, '_').toLowerCase();
      const qualifiedList = qualifiedDirects[requiredRankKey] || [];
      
      if (qualifiedList.length < config.requiredDirectCount) {
        continue;
      }
      
      // Check two-leg rule
      if (config.requiredLegs === 2) {
        const legQualified = await checkTwoLegQualification(userId, qualifiedList);
        if (!legQualified) {
          continue;
        }
      }
    }
    
    // All conditions met
    return config.name;
  }
  
  // Check if Executive qualifies (special case)
  if (currentRankOrder < RANK_CONFIG.EXECUTIVE.order && personalBusiness >= RANK_CONFIG.EXECUTIVE.personalBusiness) {
    return 'Executive';
  }
  
  return null;
}

// ============================================================
// 🔥 CHECK TWO-LEG QUALIFICATION
// ============================================================
async function checkTwoLegQualification(userId, qualifiedList) {
  try {
    if (qualifiedList.length < 2) return false;
    
    const directReferrals = await getDirectReferrals(userId);
    
    // Group qualified members by their direct parent
    const groups = {};
    for (let qualifiedUid of qualifiedList) {
      for (let direct of directReferrals) {
        if (await isUserInChain(direct.uid, qualifiedUid)) {
          if (!groups[direct.uid]) groups[direct.uid] = [];
          groups[direct.uid].push(qualifiedUid);
          break;
        }
      }
    }
    
    const groupKeys = Object.keys(groups);
    return groupKeys.length >= 2;
    
  } catch (error) {
    console.error('Error checking two-leg qualification:', error);
    return false;
  }
}

// ============================================================
// 🔥 CHECK IF USER IS IN CHAIN
// ============================================================
async function isUserInChain(ancestorUid, targetUid) {
  if (ancestorUid === targetUid) return true;
  
  try {
    const usersSnap = await get(ref(db, 'users'));
    if (!usersSnap.exists()) return false;
    
    const users = usersSnap.val();
    let queue = [ancestorUid];
    let visited = new Set();
    
    while (queue.length > 0) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      
      if (current === targetUid) return true;
      
      for (let uid in users) {
        const user = users[uid];
        if (!visited.has(uid) && 
            (user.referredBy === current || 
             user.referredBy === user.referralCode || 
             user.sponsor === current)) {
          queue.push(uid);
        }
      }
    }
    
    return false;
    
  } catch (error) {
    console.error('Error checking user in chain:', error);
    return false;
  }
}

// ============================================================
// 🔥 PROCESS RANK UPGRADE
// ============================================================
async function processRankUpgrade(
  userId,
  userData,
  newRank,
  personalBusiness,
  totalTeamBusiness,
  leftLegBusiness,
  rightLegBusiness,
  qualifiedDirects
) {
  const rankKey = newRank.replace(/ /g, '_').toUpperCase();
  const config = RANK_CONFIG[rankKey];
  if (!config) {
    return { success: false, error: 'Invalid rank configuration' };
  }
  
  const rewardAmount = config.reward || 0;
  const rewardKey = `${userId}_${rankKey}_RANK_REWARD`;
  
  try {
    const userRef = ref(db, `users/${userId}`);
    const result = await runTransaction(userRef, (currentData) => {
      if (!currentData) return currentData;
      
      // Check if already processed
      const rankRewards = currentData.rankRewards || {};
      if (rankRewards[rankKey]) {
        return currentData;
      }
      
      // Update rank
      const oldRank = currentData.rank || 'Member';
      currentData.rank = newRank;
      
      // Update rank history
      const rankHistory = currentData.rankHistory || {};
      const historyId = 'history_' + Date.now();
      rankHistory[historyId] = {
        previousRank: oldRank,
        newRank: newRank,
        timestamp: Date.now(),
        personalBusiness: personalBusiness,
        teamBusiness: totalTeamBusiness,
        leftLegBusiness: leftLegBusiness,
        rightLegBusiness: rightLegBusiness,
        qualifiedDirects: qualifiedDirects,
        rewardAmount: rewardAmount,
        status: 'completed'
      };
      currentData.rankHistory = rankHistory;
      
      // Record reward
      const rankRewards = currentData.rankRewards || {};
      rankRewards[rankKey] = {
        rank: newRank,
        amount: rewardAmount,
        status: 'credited',
        timestamp: Date.now(),
        transactionId: rewardKey
      };
      currentData.rankRewards = rankRewards;
      
      // Credit reward to deposit wallet
      if (rewardAmount > 0) {
        currentData.depositWallet = (currentData.depositWallet || 0) + rewardAmount;
        
        const transactions = currentData.transactions || {};
        const txId = 'tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
        transactions[txId] = {
          type: 'rank_reward',
          rank: newRank,
          amount: rewardAmount,
          currency: 'USD',
          timestamp: Date.now(),
          date: getTodayDate(),
          status: 'completed',
          description: `Rank reward for achieving ${newRank}`
        };
        currentData.transactions = transactions;
      }
      
      if (qualifiedDirects) {
        currentData.qualifiedDirects = qualifiedDirects;
      }
      
      currentData.lastRankEvaluation = Date.now();
      
      return currentData;
    });
    
    if (result.committed) {
      console.log(`✅ Rank upgrade to ${newRank} processed successfully for ${userId}`);
      await createComprehensiveBackup(userId, `rank_upgrade_to_${newRank}`);
      
      return {
        success: true,
        newRank: newRank,
        rewardAmount: rewardAmount,
        transactionId: rewardKey
      };
    } else {
      return {
        success: false,
        error: 'Transaction failed - duplicate or insufficient data'
      };
    }
    
  } catch (error) {
    console.error('Error processing rank upgrade:', error);
    return { success: false, error: error.message };
  }
}

// ============================================================
// 🔥 CREATE NOTIFICATION
// ============================================================
async function createNotification(userId, newRank, rewardAmount) {
  try {
    const notificationRef = ref(db, `notifications/${userId}`);
    const notificationId = 'notif_' + Date.now();
    
    const notification = {
      id: notificationId,
      type: 'rank_upgrade',
      rank: newRank,
      rewardAmount: rewardAmount,
      message: `🎉 Congratulations! You have achieved ${newRank} rank. Your reward of $${rewardAmount} has been credited to your Deposit Wallet.`,
      timestamp: Date.now(),
      read: false,
      status: 'sent'
    };
    
    await set(ref(db, `notifications/${userId}/${notificationId}`), notification);
    console.log(`✅ Notification created for ${userId}`);
    
  } catch (error) {
    console.error('Error creating notification:', error);
  }
}

// ============================================================
// 🔥 UPDATE RANK EVALUATION (For tracking)
// ============================================================
async function updateRankEvaluation(userId, userData, personalBusiness, totalTeamBusiness) {
  try {
    await update(ref(db, `users/${userId}`), {
      personalBusiness: personalBusiness,
      teamBusiness: totalTeamBusiness,
      lastRankEvaluation: Date.now()
    });
  } catch (error) {
    console.error('Error updating rank evaluation:', error);
  }
}

// ============================================================
// 🔥 RANK UI UPDATE FUNCTION
// ============================================================
function updateRankUI(userData) {
    const rank = userData.rank || 'Member';
    const rankRewards = userData.rankRewards || {};
    const personalBusiness = userData.personalBusiness || 0;
    const teamBusiness = userData.teamBusiness || 0;
    const qualifiedDirects = userData.qualifiedDirects || { 
      executive: [], seniorExecutive: [], manager: [], seniorManager: [], diamond: [] 
    };
    
    // Update rank badge
    const badge = document.getElementById('currentRankBadge');
    if (badge) {
        badge.textContent = rank;
        badge.className = 'rank-badge ' + rank.toLowerCase().replace(/ /g, '-');
    }
    
    // Calculate total rewards
    let totalRewards = 0;
    for (let key in rankRewards) {
        totalRewards += (rankRewards[key].amount || 0);
    }
    const rewardElement = document.getElementById('totalRankRewards');
    if (rewardElement) rewardElement.textContent = '$' + totalRewards.toFixed(2);
    
    // Update business values
    const personalEl = document.getElementById('personalBusiness');
    if (personalEl) personalEl.textContent = '$' + personalBusiness.toFixed(2);
    
    const teamEl = document.getElementById('teamBusiness');
    if (teamEl) teamEl.textContent = '$' + teamBusiness.toFixed(2);
    
    // Update leg business
    const leftLegEl = document.getElementById('leftLegBusiness');
    if (leftLegEl) leftLegEl.textContent = '$' + (userData.leftLegBusiness || 0).toFixed(2);
    
    const rightLegEl = document.getElementById('rightLegBusiness');
    if (rightLegEl) rightLegEl.textContent = '$' + (userData.rightLegBusiness || 0).toFixed(2);
    
    // Update qualified directs
    const qualifiedEl = document.getElementById('qualifiedDirects');
    if (qualifiedEl) {
        let totalQualified = 0;
        for (let key in qualifiedDirects) {
            totalQualified += (qualifiedDirects[key] || []).length;
        }
        qualifiedEl.textContent = totalQualified + ' / 2';
    }
    
    // Update progress steps
    const rankOrder = ['Member', 'Executive', 'Senior Executive', 'Manager', 'Senior Manager', 'Diamond'];
    const currentIndex = rankOrder.indexOf(rank);
    
    rankOrder.forEach((r, index) => {
        const stepId = 'step' + r.replace(/ /g, '');
        const stepEl = document.getElementById(stepId);
        if (stepEl) {
            stepEl.className = 'step';
            if (index < currentIndex) {
                stepEl.classList.add('completed');
            } else if (index === currentIndex) {
                stepEl.classList.add('active');
            }
        }
    });
    
    // Update next rank
    const nextRankMap = {
        'Member': 'Executive',
        'Executive': 'Senior Executive',
        'Senior Executive': 'Manager',
        'Manager': 'Senior Manager',
        'Senior Manager': 'Diamond',
        'Diamond': '🏆 Max Rank Achieved!'
    };
    const nextRankEl = document.getElementById('nextRank');
    if (nextRankEl) nextRankEl.textContent = nextRankMap[rank] || '🏆 Max Rank Achieved!';
    
    // Update next reward
    const rewardMap = {
        'Executive': '$100',
        'Senior Executive': '$200',
        'Manager': '$500',
        'Senior Manager': '$1,000',
        'Diamond': '$2,500'
    };
    const nextRewardEl = document.getElementById('nextReward');
    if (nextRewardEl) nextRewardEl.textContent = rewardMap[rank] || '🏆 Max Achieved';
    
    // Update progress bar
    const progress = (currentIndex / (rankOrder.length - 1)) * 100;
    const progressBar = document.getElementById('rankProgressBar');
    if (progressBar) progressBar.style.width = Math.min(progress, 100) + '%';
    
    const progressPercent = document.getElementById('rankProgressPercent');
    if (progressPercent) progressPercent.textContent = Math.min(Math.round(progress), 100) + '%';
}

// ============================================================
// 🔥 TRIGGER RANK EVALUATION (On Business Change)
// ============================================================
async function triggerRankEvaluation(userId) {
    try {
        const lockSnap = await get(ref(db, `rankLocks/${userId}`));
        if (lockSnap.exists()) return;
        
        const result = await evaluateUserRank(userId);
        
        if (result && result.success) {
            await loadDashboardData(userId);
            showToast(`🎉 Congratulations! You've achieved ${result.newRank} rank! Reward $${result.rewardAmount} credited.`, 'success');
        }
        
    } catch (error) {
        console.error('Error triggering rank evaluation:', error);
    }
}

// ============================================================
// LOAD DASHBOARD DATA
// ============================================================
async function loadDashboardData(userId) {
    if (isDashboardLoading) return;
    isDashboardLoading = true;
    
    try {
        const userSnap = await get(ref(db, 'users/' + userId));
        
        if (!userSnap.exists()) {
            const authUser = auth.currentUser;
            if (authUser) {
                const checkResult = await checkUserExists(userId);
                
                if (checkResult.exists) {
                    console.log('🔄 Found existing data, attempting recovery...');
                    const recovered = await recoverUserData(userId, authUser);
                    if (recovered) {
                        await processDailyRelease(userId);
                        const stats = calculateUserStats(recovered);
                        currentUserData = recovered;
                        currentUserId = userId;
                        renderDashboard(recovered);
                        setupRealtimeListener(userId);
                        // Trigger rank evaluation
                        await triggerRankEvaluation(userId);
                        showToast('✅ Your data has been recovered successfully', 'success');
                    }
                } else {
                    console.log('🆕 No existing data found, creating new user...');
                    const newUser = await recoverUserData(userId, authUser);
                    if (newUser) {
                        const stats = calculateUserStats(newUser);
                        currentUserData = newUser;
                        currentUserId = userId;
                        renderDashboard(newUser);
                        setupRealtimeListener(userId);
                        // Trigger rank evaluation for new user
                        await triggerRankEvaluation(userId);
                    }
                }
            }
            isDashboardLoading = false;
            return;
        }
        
        const u = userSnap.val();
        
        await createComprehensiveBackup(userId, 'dashboard_load');
        await processDailyRelease(userId);
        
        const packages = u.packages || {};
        for (let [key, pkg] of Object.entries(packages)) {
            if (pkg.status === 'active' && !pkg.commissionProcessed) {
                await processReferralCommission(userId, key, pkg);
            }
        }
        
        const updatedSnap = await get(ref(db, 'users/' + userId));
        const updatedData = updatedSnap.exists() ? updatedSnap.val() : u;
        const stats = calculateUserStats(updatedData);
        
        currentUserData = updatedData;
        currentUserId = userId;
        
        renderDashboard(updatedData);
        setupRealtimeListener(userId);
        
        // Trigger rank evaluation after loading
        await triggerRankEvaluation(userId);
        
    } catch (error) {
        console.error('Error loading dashboard:', error);
        document.getElementById('dashboardContent').innerHTML = `
            <div class="text-center py-5">
                <i class="bi bi-exclamation-triangle text-danger fs-1 d-block mb-3"></i>
                <h4>Error Loading Dashboard</h4>
                <p class="text-muted">${error.message || 'Please check your internet connection.'}</p>
                <button class="btn btn-primary-custom mt-3" onclick="location.reload()">Refresh</button>
            </div>
        `;
    } finally {
        isDashboardLoading = false;
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
            console.log('🔄 User authenticated, checking for existing data...');
            const checkResult = await checkUserExists(user.uid);
            
            if (checkResult.exists) {
                console.log('✅ Found existing data in:', checkResult.source);
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
                        console.warn('⚠️ Email already exists with different UID');
                        document.getElementById('dashboardContent').innerHTML = `
                            <div class="text-center py-5">
                                <i class="bi bi-exclamation-triangle text-warning fs-1 d-block mb-3"></i>
                                <h4>Account Already Exists</h4>
                                <p class="text-muted">This email is already registered with another account.</p>
                                <button class="btn btn-primary-custom mt-3" onclick="location.reload()">Try Again</button>
                            </div>
                        `;
                        return;
                    }
                }
                
                console.log('🆕 Creating new user account...');
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
        console.error('Error in auth handler:', error);
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

// Clean up listener on page unload
window.addEventListener('beforeunload', () => {
    if (listenerOff) {
        listenerOff();
        listenerOff = null;
    }
    if (listenerTimeout) {
        clearTimeout(listenerTimeout);
        listenerTimeout = null;
    }
    if (updateTimer) {
        clearTimeout(updateTimer);
        updateTimer = null;
    }
});
