// ============================================================
// 🔥 BUY PACKAGE PAGE LOGIC - RND STAKING (v2 - SAFE PURCHASE + REFERRAL FIX)
// ============================================================
// ✅ CRITICAL FIX: Purchase transaction में "insufficient balance" पर पहले `return null` होता था,
//    जो Firebase में पूरा user node DELETE कर देता है। अब सही तरीके से abort होता है।
// ✅ Referral commission: पूरे "users" node को डाउनलोड करना बंद। Sponsor सीधे UID से मिलता है।
// ✅ Sponsor न मिलने / lookup error पर चेन चुपचाप टूटकर "processed" नहीं होती - अब retry होती है
// ✅ Dashboard.js (v12) वाली ही logic: claim-lock, duplicate-payment सुरक्षा, same txId (comm_<pkg>_L<level>)
// ✅ "Balance verification failed" की झूठी error हटाई (पैकेज बन जाने के बाद भी दिख सकती थी)
// ✅ payFrom सिर्फ़ depositWallet / referralWallet हो सकता है
// ✅ Purchase से ठीक पहले RND rate दोबारा लिया जाता है (पुराना rate इस्तेमाल नहीं होगा)
// ✅ Double-submit से बचाव, banned user की रोक
// ✅ Toast / package history / error text escape होकर दिखता है (XSS से बचाव)
// ⚠️ Firebase config / database structure में कोई बदलाव नहीं
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getDatabase, ref, get, update, set, runTransaction, query, orderByChild, equalTo } from "firebase/database";

// ============================================================
// 🔥 FIREBASE CONFIG
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

// 🔥 PLANS
const PLANS = [
    { 
        id: '6months', 
        name: '6 Months Plan', 
        days: 180, 
        bonus: 25, 
        color: '#2ecc71',
        bonusText: '+25% Bonus',
        minAmount: 10
    },
    { 
        id: '12months', 
        name: '12 Months Plan', 
        days: 365, 
        bonus: 60, 
        color: '#fbbf24',
        bonusText: '+60% Bonus',
        minAmount: 100
    },
    { 
        id: '18months', 
        name: '18 Months Plan', 
        days: 540, 
        bonus: 100, 
        color: '#f472b6',
        bonusText: '+100% Bonus',
        minAmount: 200
    }
];

// Commission settings (dashboard.js के साथ same)
const COMMISSION_LEVELS = [
    { level: 1, percent: 0.08 },
    { level: 2, percent: 0.04 },
    { level: 3, percent: 0.02 },
    { level: 4, percent: 0.01 },
    { level: 5, percent: 0.01 }
];
const COMMISSION_STALE_MS = 2 * 60 * 1000;
const ALLOWED_PAY_WALLETS = ['depositWallet', 'referralWallet'];

// ============================================================
// HELPERS
// ============================================================
function roundTo8(value) {
    if (value === undefined || value === null || isNaN(value)) return 0;
    return parseFloat(Math.round(value * 100000000) / 100000000);
}

function roundTo2(value) {
    if (value === undefined || value === null || isNaN(value)) return 0;
    return Math.round(value * 100) / 100;
}

function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function isValidFirebaseKey(key) {
    return typeof key === 'string' && key.length > 0 && !/[.#$\[\]\/]/.test(key);
}

function generateTxId() {
    return 'tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
}

function getTodayDate() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function normalizeList(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.filter(Boolean);
    return Object.values(raw).filter(Boolean);
}

function calculateStaking(usdtAmount, rndPrice, plan) {
    if (!usdtAmount || usdtAmount <= 0 || !rndPrice || rndPrice <= 0) {
        return {
            baseRND: 0,
            bonusRND: 0,
            totalRND: 0,
            dailyRelease: 0,
            bonusPercent: plan ? plan.bonus : 0,
            planDays: plan ? plan.days : 0
        };
    }
    const baseRND = roundTo8(usdtAmount / rndPrice);
    const bonusRND = roundTo8(baseRND * (plan.bonus / 100));
    const totalRND = roundTo8(baseRND + bonusRND);
    const dailyRelease = roundTo8(totalRND / plan.days);
    return {
        baseRND,
        bonusRND,
        totalRND,
        dailyRelease,
        bonusPercent: plan.bonus,
        planDays: plan.days
    };
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
let rndPrice = 1.00;
let isPurchasing = false;

function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;
    const icon = type === 'success' ? 'bi-check-circle-fill text-success' : 'bi-exclamation-triangle-fill text-danger';

    const iconEl = document.createElement('i');
    iconEl.className = 'bi ' + icon;
    const msgEl = document.createElement('span');
    msgEl.className = 'toast-msg';
    msgEl.textContent = message;
    toast.appendChild(iconEl);
    toast.appendChild(msgEl);

    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

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

async function getUserData(uid) {
    const snap = await get(ref(db, 'users/' + uid));
    return snap.exists() ? snap.val() : null;
}

async function getRNDPrice() {
    try {
        const rateSnap = await get(ref(db, 'settings/rate'));
        if (rateSnap.exists()) {
            const r = Number(rateSnap.val());
            rndPrice = (isFinite(r) && r > 0) ? r : 1.00;
        } else {
            await set(ref(db, 'settings/rate'), 1.00);
            rndPrice = 1.00;
        }
    } catch (error) { console.error('Error fetching RND price:', error); rndPrice = 1.00; }
    return rndPrice;
}

// ============================================================
// 🔥 Check duplicate purchase
// ============================================================
async function checkDuplicatePurchase(uid, planId, amount, timestamp) {
    const userSnap = await get(ref(db, 'users/' + uid));
    if (!userSnap.exists()) return false;
    
    const userData = userSnap.val();
    const packages = userData.packages || {};
    const windowMs = 10000;
    
    for (let key in packages) {
        const pkg = packages[key];
        if (pkg && pkg.planId === planId && 
            Math.abs((pkg.timestamp || 0) - timestamp) < windowMs &&
            Math.abs((pkg.usdtAmount || 0) - amount) < 0.01) {
            console.log('⚠️ Duplicate purchase detected for plan:', planId);
            return true;
        }
    }
    return false;
}

// ============================================================
// 🔥 ATOMIC PURCHASE
// ⚠️ Transaction में कभी `return null` नहीं - वह पूरा user node DELETE कर देता है.
//    Abort करने के लिए `return;` (undefined) इस्तेमाल होता है.
// ============================================================
async function processAtomicPurchase(uid, plan, payAmount, payFrom, result) {
    if (!ALLOWED_PAY_WALLETS.includes(payFrom)) {
        return { success: false, error: 'Invalid wallet selected' };
    }

    const userRef = ref(db, 'users/' + uid);
    const packageId = 'pkg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
    const timestamp = Date.now();
    const date = new Date().toDateString();
    
    try {
        const userSnap = await get(userRef);
        if (!userSnap.exists()) {
            return { success: false, error: 'User not found' };
        }
        
        const userData = userSnap.val();
        const currentBalance = Number(userData[payFrom]) || 0;
        
        if (currentBalance < payAmount) {
            return { 
                success: false, 
                error: 'Insufficient balance',
                balance: currentBalance,
                needed: payAmount
            };
        }
        
        const isDuplicate = await checkDuplicatePurchase(uid, plan.id, payAmount, timestamp);
        if (isDuplicate) {
            return { 
                success: false, 
                error: 'Duplicate purchase detected. Please wait a moment.'
            };
        }
        
        const txResult = await runTransaction(userRef, (currentData) => {
            if (!currentData) return currentData; // cache खाली - server data के साथ retry होगा
            
            const balance = Number(currentData[payFrom]) || 0;
            
            if (balance < payAmount) {
                console.log('⚠️ Insufficient balance (transaction abort):', balance, 'needed:', payAmount);
                return; // ✅ ABORT (undefined). null लौटाने से user node मिट जाता है!
            }
            
            const packages = currentData.packages || {};
            packages[packageId] = {
                planId: plan.id,
                planName: plan.name,
                usdtAmount: payAmount,
                totalRND: result.totalRND,
                remainingRND: result.totalRND,
                releasedRND: 0,
                dailyRelease: result.dailyRelease,
                planDays: plan.days,
                bonusPercent: plan.bonus,
                status: 'active',
                purchaseDate: timestamp,
                rndPriceAtTime: rndPrice || 1,
                timestamp: timestamp
            };
            
            const newBalance = roundTo8(balance - payAmount);
            const currentLocked = currentData.lockedRND || 0;
            const newLocked = roundTo8(currentLocked + result.totalRND);
            const totalStake = roundTo8((currentData.totalStake || 0) + payAmount);
            
            const transactions = currentData.transactions || {};
            const txId = 'tx_' + timestamp + '_' + Math.random().toString(36).substr(2, 8);
            transactions[txId] = {
                type: 'package',
                packageId: packageId,
                amount: payAmount,
                currency: 'USDT',
                rndReceived: result.totalRND,
                planName: plan.name,
                dailyRelease: result.dailyRelease,
                planDays: plan.days,
                bonusPercent: plan.bonus,
                timestamp: timestamp,
                date: date,
                status: 'completed',
                description: `Purchased ${plan.name} - ${result.totalRND.toFixed(2)} RND locked`
            };
            
            return {
                ...currentData,
                [payFrom]: newBalance,
                packages: packages,
                lockedRND: newLocked,
                totalStake: totalStake,
                transactions: transactions
            };
        });
        
        if (txResult.committed && txResult.snapshot && txResult.snapshot.exists()) {
            const updatedData = txResult.snapshot.val();
            // ✅ Balance की तुलना नहीं (concurrent commission से बदल सकता है) - पैकेज मौजूद है या नहीं देखो
            if (updatedData.packages && updatedData.packages[packageId]) {
                console.log('✅ Atomic purchase completed:', packageId);
                return { success: true, packageId: packageId };
            }
            return {
                success: false,
                error: 'Purchase could not be verified. Please check Package History before trying again.'
            };
        }

        // Aborted - सबसे संभावित वजह: balance कम पड़ गया
        const latest = await getUserData(uid);
        const latestBalance = latest ? (Number(latest[payFrom]) || 0) : 0;
        return { 
            success: false, 
            error: 'Insufficient balance',
            balance: latestBalance,
            needed: payAmount
        };
    } catch (error) {
        console.error('Atomic purchase error:', error);
        return { success: false, error: error.message };
    }
}

// ============================================================
// 🔥 REFERRER LOOKUP (dashboard.js के साथ same)
// - मिल गया   => { uid, data }
// - नहीं मिला => null
// - network / permission error => THROW (ताकि चेन चुपचाप न टूटे)
// क्रम: UID (referralCode = UID) -> पुराना referralCode -> username
// ============================================================
async function resolveReferrer(identifier) {
    if (!identifier || typeof identifier !== 'string') return null;
    const id = identifier.trim();
    if (!id) return null;
    const usersRef = ref(db, 'users');

    if (isValidFirebaseKey(id)) {
        const uidSnap = await get(ref(db, 'users/' + id));
        if (uidSnap.exists()) {
            return { uid: id, data: uidSnap.val() };
        }
    }

    const codeCandidates = [id];
    if (id.toUpperCase() !== id) codeCandidates.push(id.toUpperCase());
    for (const code of codeCandidates) {
        const snap = await get(query(usersRef, orderByChild('referralCode'), equalTo(code)));
        if (snap.exists()) {
            const data = snap.val();
            const uids = Object.keys(data);
            if (uids.length > 1) console.warn('⚠️ Duplicate referralCode found:', code, uids);
            return { uid: uids[0], data: data[uids[0]] };
        }
    }

    const unameSnap = await get(query(usersRef, orderByChild('username'), equalTo(id)));
    if (unameSnap.exists()) {
        const data = unameSnap.val();
        const uids = Object.keys(data);
        if (uids.length > 1) console.warn('⚠️ Duplicate username found:', id, uids);
        return { uid: uids[0], data: data[uids[0]] };
    }

    return null;
}

async function releaseCommissionClaim(pkgRef, claimToken) {
    await runTransaction(pkgRef, (pkg) => {
        if (!pkg) return pkg;
        if (pkg.commissionClaimToken !== claimToken) return; // हमारा lock नहीं - छेड़ो मत
        pkg.commissionProcessing = false;
        pkg.commissionClaimToken = null;
        return pkg;
    });
}

// ============================================================
// 🔥 ATOMIC REFERRAL COMMISSION (dashboard.js की processReferralCommission जैसा)
// - Claim-lock: दो जगह (buy page + dashboard) से एक साथ नहीं चलेगा
// - Buyer के referredBy से upline चलती है, हर level पर strict lookup
// - Error आए तो lock छूटता है और dashboard अगली बार retry करता है
// - हर level की commission सिर्फ़ एक बार मिलती है (txId = comm_<package>_L<level>)
// ============================================================
async function distributeReferralCommissionAtomic(userUid, amount, rndPriceAtTime, packageId) {
    const pkgRef = ref(db, `users/${userUid}/packages/${packageId}`);
    const claimToken = generateTxId();
    let claimed = false;

    try {
        // ---------- STEP 1: Claim ----------
        const claimResult = await runTransaction(pkgRef, (pkg) => {
            if (!pkg) return pkg;
            if (pkg.commissionProcessed === true) return;
            if (pkg.status !== 'active' && pkg.status !== 'completed') return;
            if (pkg.commissionProcessing === true) {
                const age = Date.now() - (pkg.commissionProcessingAt || 0);
                if (age < COMMISSION_STALE_MS) return;
            }
            pkg.commissionProcessing = true;
            pkg.commissionProcessingAt = Date.now();
            pkg.commissionClaimToken = claimToken;
            return pkg;
        });

        if (!claimResult.committed) {
            return { totalCommission: 0, commissionCount: 0, successCount: 0, failedCount: 0, allSuccess: true, skipped: true };
        }
        const claimedPkg = claimResult.snapshot.val();
        if (!claimedPkg || claimedPkg.commissionClaimToken !== claimToken) {
            return { totalCommission: 0, commissionCount: 0, successCount: 0, failedCount: 0, allSuccess: true, skipped: true };
        }
        claimed = true;

        const packageAmount = claimedPkg.usdtAmount || amount || 0;
        if (packageAmount <= 0) {
            await releaseCommissionClaim(pkgRef, claimToken);
            return { totalCommission: 0, commissionCount: 0, successCount: 0, failedCount: 0, allSuccess: true };
        }

        // ---------- STEP 2: Buyer ----------
        const buyerSnap = await get(ref(db, 'users/' + userUid));
        if (!buyerSnap.exists()) {
            await releaseCommissionClaim(pkgRef, claimToken);
            return { totalCommission: 0, commissionCount: 0, successCount: 0, failedCount: 0, allSuccess: false };
        }
        const buyer = buyerSnap.val();
        const fromUserName = buyer.username || buyer.referralCode || userUid;

        // ---------- STEP 3: Upline ----------
        let currentRefCode = buyer.referredBy || null;
        let level = 1;
        const visited = new Set([userUid]);
        const processedTxIds = [];
        let totalCommission = 0;
        let chainNote = '';

        while (currentRefCode && level <= 5) {
            const sponsor = await resolveReferrer(currentRefCode); // error आए तो throw
            if (!sponsor) {
                chainNote = `Referrer not found at level ${level}: ${currentRefCode}`;
                console.warn('⚠️', chainNote);
                break;
            }
            const sponsorUid = sponsor.uid;
            if (visited.has(sponsorUid)) {
                chainNote = `Loop detected at level ${level}`;
                console.warn('⚠️', chainNote);
                break;
            }
            visited.add(sponsorUid);

            const lvl = level;
            const percent = COMMISSION_LEVELS.find(l => l.level === lvl)?.percent || 0;
            const commissionAmount = roundTo2(packageAmount * percent);
            const commissionTxId = `comm_${packageId}_L${lvl}`;

            if (commissionAmount > 0) {
                const txResult = await runTransaction(ref(db, 'users/' + sponsorUid), (currentData) => {
                    if (!currentData) return currentData;

                    const history = normalizeList(currentData.commissionHistory);
                    const transactions = currentData.transactions || {};

                    const alreadyPaid =
                        transactions[commissionTxId] ||
                        history.some(h => h.txId === commissionTxId ||
                            (h.type === 'referral_commission' &&
                             h.fromUid === userUid &&
                             h.packageId === packageId &&
                             h.level === lvl));
                    if (alreadyPaid) return currentData;

                    currentData.referralWallet = roundTo2((currentData.referralWallet || 0) + commissionAmount);
                    currentData.referralEarnings = roundTo2((currentData.referralEarnings || 0) + commissionAmount);
                    currentData.totalReferralCommission = roundTo2((currentData.totalReferralCommission || 0) + commissionAmount);
                    currentData.teamBusiness = roundTo2((currentData.teamBusiness || 0) + packageAmount);
                    const levelKey = `level${lvl}Earnings`;
                    currentData[levelKey] = roundTo2((currentData[levelKey] || 0) + commissionAmount);

                    history.push({
                        type: 'referral_commission',
                        level: lvl,
                        percent: percent * 100,
                        amount: commissionAmount,
                        fromUser: fromUserName,
                        fromUid: userUid,
                        packageId: packageId,
                        txId: commissionTxId,
                        timestamp: Date.now(),
                        date: getTodayDate(),
                        description: `${percent * 100}% from Level ${lvl}`
                    });
                    currentData.commissionHistory = history;

                    transactions[commissionTxId] = {
                        type: 'referral_commission',
                        amount: commissionAmount,
                        currency: 'USDT',
                        level: lvl,
                        percent: percent * 100,
                        fromUser: fromUserName,
                        fromUid: userUid,
                        packageId: packageId,
                        rate: rndPriceAtTime,
                        timestamp: Date.now(),
                        date: getTodayDate(),
                        status: 'completed',
                        txId: commissionTxId
                    };
                    currentData.transactions = transactions;

                    return currentData;
                });

                // ✅ Verify: commission सच में लिखी गई?
                const after = txResult.snapshot && txResult.snapshot.exists() ? txResult.snapshot.val() : null;
                const written = !!(txResult.committed && after && after.transactions && after.transactions[commissionTxId]);
                const paidEarlier = !!(after && normalizeList(after.commissionHistory).some(h =>
                    h.type === 'referral_commission' && h.fromUid === userUid &&
                    h.packageId === packageId && h.level === lvl));
                if (!written && !paidEarlier) {
                    throw new Error(`Commission write not confirmed for level ${lvl} (${sponsorUid})`);
                }

                processedTxIds.push(commissionTxId);
                totalCommission = roundTo2(totalCommission + commissionAmount);
            }

            currentRefCode = sponsor.data.referredBy || null;
            level++;
        }

        // ---------- STEP 4: Processed mark ----------
        const finalizeResult = await runTransaction(pkgRef, (pkg) => {
            if (!pkg) return pkg;
            if (pkg.commissionClaimToken && pkg.commissionClaimToken !== claimToken) return;
            pkg.commissionProcessed = true;
            pkg.commissionProcessedAt = Date.now();
            pkg.commissionProcessing = false;
            pkg.commissionTxIds = processedTxIds;
            pkg.commissionClaimToken = null;
            pkg.commissionPartial = false;
            if (chainNote) pkg.commissionNote = chainNote;
            return pkg;
        });
        if (!finalizeResult.committed) {
            console.warn('⚠️ Finalize not committed for', packageId);
        }

        console.log('✅ Commission processed for:', packageId, '| levels paid:', processedTxIds.length);
        return {
            totalCommission: totalCommission,
            commissionCount: processedTxIds.length,
            successCount: processedTxIds.length,
            failedCount: 0,
            allSuccess: true
        };

    } catch (error) {
        console.error('❌ Commission error (dashboard will retry):', error);
        if (claimed) {
            try { await releaseCommissionClaim(pkgRef, claimToken); } catch (_) {}
        }
        return {
            totalCommission: 0,
            commissionCount: 0,
            successCount: 0,
            failedCount: 1,
            failedSponsors: [],
            allSuccess: false,
            error: error.message
        };
    }
}

// ============================================================
// 🔥 MAIN
// ============================================================
onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = 'login.html'; return; }

    try {
        await getRNDPrice();
        let userData = await getUserData(user.uid);
        if (!userData) { window.location.href = 'dashboard.html'; return; }

        if (userData.banned === true) {
            alert('Your account has been banned.');
            await signOut(auth);
            window.location.href = 'login.html';
            return;
        }

        const finalUserData = userData;

        const name = finalUserData.name || 'User';
        document.getElementById('sidebarName').textContent = name;
        document.getElementById('sidebarUserId').textContent = 'ID: ' + user.uid.substring(0, 20) + '...';
        document.getElementById('sidebarAvatar').textContent = name.charAt(0).toUpperCase();

        const badge = document.getElementById('referralBadge');
        if (badge) badge.textContent = (finalUserData.teamStructure && finalUserData.teamStructure.level1) || finalUserData.totalReferrals || 0;

        const packages = finalUserData.packages || {};
        const userPackages = Object.keys(packages).map(key => ({ id: key, ...packages[key] }));
        userPackages.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        const depositWallet = finalUserData.depositWallet || 0;
        const referralWallet = finalUserData.referralWallet || 0;

        let packagesHtml = '';
        userPackages.forEach((p) => {
            const statusClass = p.status === 'active' ? 'status-active' : 'status-completed';
            const statusText = p.status === 'active' ? '🟢 Active' : '🔵 Completed';
            const released = p.releasedRND || 0;
            const remaining = p.remainingRND || 0;
            const total = p.totalRND || 0;
            const progress = total > 0 ? (released / total * 100) : 0;
            
            packagesHtml += `
                <div class="package-item">
                    <div>
                        <span class="plan">${escapeHtml(p.planName || 'Package')}</span>
                        <div class="date">${escapeHtml(new Date(p.purchaseDate || p.timestamp).toLocaleString('hi-IN'))}</div>
                        ${p.rndPriceAtTime ? `<span class="rate-badge">Rate: $${Number(p.rndPriceAtTime).toFixed(4)}/RND</span>` : ''}
                        <div class="mt-1">
                            <div class="progress"><div class="progress-bar" style="width:${Math.min(progress, 100)}%;"></div></div>
                            <small class="text-muted">${progress.toFixed(1)}% Released</small>
                        </div>
                    </div>
                    <div>
                        <span class="amount">$${(p.usdtAmount || 0).toFixed(2)}</span>
                        <span class="total-rnd">→ ${(total || 0).toFixed(2)} RND</span>
                        <span class="${statusClass} ms-2">${statusText}</span>
                        ${p.dailyRelease ? `<div class="daily">📈 Daily: ${(p.dailyRelease || 0).toFixed(4)} RND</div>` : ''}
                        ${released > 0 ? `<div class="released">✅ Released: ${released.toFixed(2)} RND</div>` : ''}
                        ${remaining > 0 ? `<div class="locked">🔒 Remaining: ${remaining.toFixed(2)} RND</div>` : ''}
                        ${p.planDays ? `<div class="daily">📅 ${escapeHtml(p.planDays)} Days</div>` : ''}
                    </div>
                </div>
            `;
        });

        document.getElementById('packageContent').innerHTML = `
            <div class="row g-4">
                <div class="col-12">
                    <div class="page-header-section">
                        <h4><i class="bi bi-box-seam"></i> Buy Package</h4>
                        <span class="rnd-price-badge"><i class="bi bi-currency-dollar"></i> 1 RND = $${(rndPrice || 1).toFixed(4)}</span>
                    </div>
                </div>

                <div class="col-12">
                    <div class="card-glass">
                        <div class="wallet-cards-row">
                            <div class="wallet-card-new deposit">
                                <div class="wallet-card-header">
                                    <span class="wallet-card-label">Deposit Wallet</span>
                                    <div class="wallet-card-icon">
                                        <i class="bi bi-wallet2"></i>
                                    </div>
                                </div>
                                <div class="wallet-card-value">
                                    $${(depositWallet || 0).toFixed(2)}
                                    <span class="wallet-card-currency">USDT</span>
                                </div>
                                <div class="wallet-card-footer">
                                    <i class="bi bi-shield-check"></i>
                                    <span>Used for package purchases</span>
                                </div>
                            </div>
                            
                            <div class="wallet-card-new referral">
                                <div class="wallet-card-header">
                                    <span class="wallet-card-label">Referral Wallet</span>
                                    <div class="wallet-card-icon">
                                        <i class="bi bi-people-fill"></i>
                                    </div>
                                </div>
                                <div class="wallet-card-value">
                                    ${(referralWallet || 0).toFixed(2)}
                                    <span class="wallet-card-currency">USDT</span>
                                </div>
                                <div class="wallet-card-footer">
                                    <i class="bi bi-gift"></i>
                                    <span>Earned from referrals</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="col-12">
                    <div class="row g-4">
                        ${PLANS.map((plan) => {
                            const example = calculateStaking(plan.minAmount, rndPrice || 1, plan);
                            return `
                            <div class="col-md-4">
                                <div class="package-card" data-plan="${plan.id}">
                                    <h5 class="plan-name" style="color:${plan.color};">${plan.name}</h5>
                                    <div class="price">$${plan.minAmount} <span>USDT</span></div>
                                    <div class="reward">${plan.bonusText}</div>
                                    <div class="duration">⏱ ${plan.days} Days</div>
                                    <div class="you-will-receive">📊 You Will Receive: ${example.totalRND.toFixed(2)} RND</div>
                                    <div class="daily-release">📈 Daily: ${example.dailyRelease.toFixed(4)} RND</div>
                                    <div class="features">
                                        <li><i class="bi bi-check-circle"></i> ${plan.bonus}% Bonus</li>
                                        <li><i class="bi bi-check-circle"></i> Fixed Daily Release</li>
                                        <li><i class="bi bi-check-circle"></i> ${plan.days} Days Lock</li>
                                        <li><i class="bi bi-check-circle"></i> Min: $${plan.minAmount}</li>
                                    </div>
                                    <button class="plan-cta" data-plan-id="${plan.id}">
                                        <i class="bi bi-lightning-charge-fill"></i> Select ${plan.name}
                                    </button>
                                </div>
                            </div>
                            `;
                        }).join('')}
                    </div>
                </div>

                <div class="col-12">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-cart-check text-success me-2"></i>Confirm Purchase</div>
                        <form id="buyForm">
                            <div class="row g-3">
                                <div class="col-md-3">
                                    <label class="form-label">Selected Plan</label>
                                    <input type="text" id="selectedPlan" class="form-control form-control-custom" value="None" readonly>
                                </div>
                                <div class="col-md-2">
                                    <label class="form-label">Amount (USDT)</label>
                                    <input type="number" id="payAmount" class="form-control form-control-custom" placeholder="Enter amount" min="10" step="1" required>
                                </div>
                                <div class="col-md-2">
                                    <label class="form-label">You Will Receive</label>
                                    <input type="text" id="totalRNDDisplay" class="form-control form-control-custom" value="0 RND" readonly>
                                </div>
                                <div class="col-md-2">
                                    <label class="form-label">Daily Release</label>
                                    <input type="text" id="dailyReleaseDisplay" class="form-control form-control-custom" value="0 RND" readonly>
                                </div>
                                <div class="col-md-3">
                                    <label class="form-label">Pay From</label>
                                    <select id="payFrom" class="form-select form-control-custom">
                                        <option value="depositWallet">💰 Deposit Wallet (USDT)</option>
                                        <option value="referralWallet">💳 Referral Wallet (USDT)</option>
                                    </select>
                                </div>
                            </div>
                            <div class="row mt-3">
                                <div class="col-12">
                                    <button type="submit" class="btn-primary-custom" id="buyBtn"><i class="bi bi-check-circle me-1"></i>Buy Now</button>
                                </div>
                            </div>
                        </form>
                    </div>
                </div>

                <div class="col-12">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-clock-history text-success me-2"></i>Package History</div>
                        ${userPackages.length === 0 ? `
                            <div class="text-center text-muted py-4">
                                <i class="bi bi-box-seam fs-1 d-block mb-2"></i>
                                <p>No packages purchased yet.</p>
                            </div>
                        ` : `<div class="package-history">${packagesHtml}</div>`}
                    </div>
                </div>
            </div>
        `;

        document.querySelectorAll('.plan-cta').forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                const planId = this.dataset.planId;
                const plan = PLANS.find(p => p.id === planId);
                if (!plan) return;
                
                document.querySelectorAll('.package-card').forEach(c => c.classList.remove('selected'));
                const parentCard = this.closest('.package-card');
                if (parentCard) parentCard.classList.add('selected');
                
                document.getElementById('selectedPlan').value = plan.name;
                document.getElementById('payAmount').value = plan.minAmount;
                document.getElementById('payAmount').min = plan.minAmount;
                const result = calculateStaking(plan.minAmount, rndPrice || 1, plan);
                document.getElementById('totalRNDDisplay').value = result.totalRND.toFixed(2) + ' RND';
                document.getElementById('dailyReleaseDisplay').value = result.dailyRelease.toFixed(4) + ' RND';
                document.getElementById('buyBtn').innerHTML = `<i class="bi bi-check-circle me-1"></i>Buy ${plan.name}`;
            });
        });

        const payAmountInput = document.getElementById('payAmount');
        if (payAmountInput) {
            payAmountInput.addEventListener('input', function() {
                const planName = document.getElementById('selectedPlan').value;
                if (planName === 'None') {
                    document.getElementById('totalRNDDisplay').value = '0 RND';
                    document.getElementById('dailyReleaseDisplay').value = '0 RND';
                    return;
                }
                const plan = PLANS.find(p => p.name === planName);
                if (!plan) return;
                const amount = parseFloat(this.value);
                if (!amount || amount < plan.minAmount) {
                    document.getElementById('totalRNDDisplay').value = '0 RND';
                    document.getElementById('dailyReleaseDisplay').value = '0 RND';
                    return;
                }
                const result = calculateStaking(amount, rndPrice || 1, plan);
                document.getElementById('totalRNDDisplay').value = result.totalRND.toFixed(2) + ' RND';
                document.getElementById('dailyReleaseDisplay').value = result.dailyRelease.toFixed(4) + ' RND';
            });
        }

        const buyForm = document.getElementById('buyForm');
        if (buyForm) {
            buyForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                if (isPurchasing) return;
                
                const planName = document.getElementById('selectedPlan').value;
                let payAmount = parseFloat(document.getElementById('payAmount').value);
                const payFrom = document.getElementById('payFrom').value;
                const buyBtn = document.getElementById('buyBtn');

                if (!planName || planName === 'None') { 
                    showToast('❌ Please select a plan first!', 'error'); 
                    return; 
                }

                const plan = PLANS.find(p => p.name === planName);
                if (!plan) { 
                    showToast('❌ Invalid plan selected!', 'error'); 
                    return; 
                }

                if (!isFinite(payAmount)) {
                    showToast('❌ Please enter a valid amount!', 'error');
                    return;
                }
                payAmount = roundTo2(payAmount);
                
                if (!payAmount || payAmount < plan.minAmount) { 
                    showToast(`❌ Minimum investment for ${plan.name} is $${plan.minAmount} USDT!`, 'error'); 
                    return; 
                }

                if (!ALLOWED_PAY_WALLETS.includes(payFrom)) {
                    showToast('❌ Invalid wallet selected!', 'error');
                    return;
                }

                isPurchasing = true;
                buyBtn.disabled = true;
                buyBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Processing...';

                try {
                    // ✅ Purchase से ठीक पहले ताज़ा rate लो
                    await getRNDPrice();
                    const result = calculateStaking(payAmount, rndPrice || 1, plan);
                    
                    const purchaseResult = await processAtomicPurchase(
                        auth.currentUser.uid, 
                        plan, 
                        payAmount, 
                        payFrom, 
                        result
                    );
                    
                    if (!purchaseResult.success) {
                        let errorMsg = '❌ Purchase failed!';
                        if (purchaseResult.error === 'Insufficient balance') {
                            errorMsg = `❌ Insufficient balance! You have $${(purchaseResult.balance || 0).toFixed(2)}, need $${(purchaseResult.needed || payAmount).toFixed(2)}`;
                        } else if (purchaseResult.error === 'Duplicate purchase detected. Please wait a moment.') {
                            errorMsg = '⚠️ ' + purchaseResult.error;
                        } else {
                            errorMsg = '❌ ' + purchaseResult.error;
                        }
                        showToast(errorMsg, 'error');
                        isPurchasing = false;
                        buyBtn.disabled = false;
                        buyBtn.innerHTML = `<i class="bi bi-check-circle me-1"></i>Buy ${plan.name}`;
                        return;
                    }
                    
                    try {
                        const commissionResult = await distributeReferralCommissionAtomic(
                            auth.currentUser.uid, 
                            payAmount, 
                            rndPrice || 1,
                            purchaseResult.packageId
                        );
                        
                        if (commissionResult.failedCount > 0) {
                            console.warn('⚠️ Referral commission incomplete:', commissionResult.error || '');
                            console.log('ℹ️ Dashboard will auto-retry pending commissions on next load.');
                        }
                    } catch (commissionError) {
                        console.warn('Referral commission error (non-critical):', commissionError);
                    }

                    showToast(`✅ ${plan.name} purchased! ${result.totalRND.toFixed(2)} RND locked. Daily release: ${result.dailyRelease.toFixed(4)} RND from tomorrow.`, 'success');
                    
                    setTimeout(() => { 
                        window.location.reload(); 
                    }, 2500);

                } catch (error) {
                    console.error('Purchase error:', error);
                    showToast(`❌ Error purchasing plan: ${error.message || 'Please try again.'}`, 'error');
                    isPurchasing = false;
                    buyBtn.disabled = false;
                    buyBtn.innerHTML = `<i class="bi bi-check-circle me-1"></i>Buy ${plan.name}`;
                }
            });
        }

    } catch (error) {
        console.error('Error loading packages:', error);
        document.getElementById('packageContent').innerHTML = `
            <div class="text-center py-5">
                <i class="bi bi-exclamation-triangle text-danger fs-1 d-block mb-3"></i>
                <h4>Error Loading Page</h4>
                <p class="text-muted">${escapeHtml(error.message || 'Please check your internet connection.')}</p>
                <button class="btn btn-primary-custom mt-3" onclick="location.reload()">Refresh</button>
            </div>
        `;
    }
});
