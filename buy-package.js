// ============================================================
// 🔥 BUY PACKAGE PAGE LOGIC - RND STAKING
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getDatabase, ref, get, update, set, runTransaction } from "firebase/database";

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

console.log('✅ Firebase initialized with NEW config (rwebsite-e031b)');

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

// 🔥 Floating point precision
function roundTo8(value) {
    if (value === undefined || value === null || isNaN(value)) return 0;
    return parseFloat(Math.round(value * 100000000) / 100000000);
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
            rndPrice = rateSnap.val();
        } else {
            await set(ref(db, 'settings/rate'), 1.00);
            rndPrice = 1.00;
        }
    } catch (error) { console.error('Error fetching RND price:', error); rndPrice = 1.00; }
    return rndPrice;
}

// ============================================================
// 🔥 ATOMIC saveTransaction()
// ============================================================
async function saveTransaction(uid, transactionData) {
    try {
        const userRef = ref(db, 'users/' + uid);
        
        const result = await runTransaction(userRef, (currentData) => {
            if (!currentData) {
                return { ...currentData };
            }
            
            const transactions = currentData.transactions || {};
            
            if (transactionData.type === 'daily_release') {
                const today = new Date().toDateString();
                for (let key in transactions) {
                    if (transactions[key].type === 'daily_release' && 
                        transactions[key].date === today) {
                        return { ...currentData };
                    }
                }
            }
            
            if (transactionData.type === 'package' && transactionData.packageId) {
                for (let key in transactions) {
                    const tx = transactions[key];
                    if (tx.type === 'package' && tx.packageId === transactionData.packageId) {
                        return { ...currentData };
                    }
                }
            }
            
            const txId = 'tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
            transactions[txId] = transactionData;
            
            return {
                ...currentData,
                transactions: transactions
            };
        });
        
        if (result.committed) {
            console.log('✅ Transaction saved atomically:', transactionData.type);
            return true;
        } else {
            console.log('⚠️ Transaction not committed (duplicate or no change)');
            return false;
        }
    } catch (error) {
        console.error('Error saving transaction:', error);
        return false;
    }
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
        if (pkg.planId === planId && 
            Math.abs((pkg.timestamp || 0) - timestamp) < windowMs &&
            Math.abs((pkg.usdtAmount || 0) - amount) < 0.01) {
            console.log('⚠️ Duplicate purchase detected for plan:', planId);
            return true;
        }
    }
    return false;
}

// ============================================================
// 🔥 ENHANCED ATOMIC PURCHASE
// ============================================================
async function processAtomicPurchase(uid, plan, payAmount, payFrom, result) {
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
        const currentBalance = userData[payFrom] || 0;
        
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
            if (!currentData) {
                return { ...currentData };
            }
            
            const balance = currentData[payFrom] || 0;
            
            if (balance < payAmount) {
                console.log('⚠️ Insufficient balance (transaction abort):', balance, 'needed:', payAmount);
                return null;
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
            const newBalance = updatedData[payFrom] || 0;
            
            if (newBalance <= currentBalance - payAmount + 0.001) {
                console.log('✅ Atomic purchase completed:', packageId);
                return { success: true, packageId: packageId };
            } else {
                return { success: false, error: 'Balance verification failed' };
            }
        } else {
            return { 
                success: false, 
                error: txResult.error || 'Transaction aborted - insufficient balance'
            };
        }
    } catch (error) {
        console.error('Atomic purchase error:', error);
        return { success: false, error: error.message };
    }
}

// ============================================================
// 🔥 ATOMIC REFERRAL COMMISSION
// ============================================================
async function distributeReferralCommissionAtomic(userUid, amount, rndPriceAtTime, packageId) {
    try {
        const rates = [0.08, 0.04, 0.02, 0.01, 0.01];
        const levelNames = ['Level 1 (8%)', 'Level 2 (4%)', 'Level 3 (2%)', 'Level 4 (1%)', 'Level 5 (1%)'];
        const timestamp = Date.now();
        const date = new Date().toDateString();
        
        const usersSnap = await get(ref(db, 'users'));
        if (!usersSnap.exists()) return { totalCommission: 0, commissionCount: 0 };
        const users = usersSnap.val();
        const currentUser = users[userUid];
        if (!currentUser) return { totalCommission: 0, commissionCount: 0 };
        
        let currentRefCode = currentUser.referredBy || '';
        let totalCommission = 0;
        let commissionCount = 0;
        let sponsors = [];
        
        for (let level = 0; level < 5; level++) {
            if (!currentRefCode) break;
            
            let sponsorUid = null;
            let sponsor = null;
            for (const uid in users) {
                if (users[uid].referralCode === currentRefCode) {
                    sponsorUid = uid;
                    sponsor = users[uid];
                    break;
                }
            }
            if (!sponsorUid || !sponsor) break;
            
            const commissionUSDT = roundTo8(amount * rates[level]);
            totalCommission = roundTo8(totalCommission + commissionUSDT);
            commissionCount++;
            
            sponsors.push({
                uid: sponsorUid,
                data: sponsor,
                level: level + 1,
                commission: commissionUSDT,
                levelName: levelNames[level]
            });
            
            currentRefCode = sponsor.referredBy || '';
        }
        
        if (sponsors.length === 0) {
            return { totalCommission: 0, commissionCount: 0 };
        }
        
        let successCount = 0;
        let failedSponsors = [];
        
        for (const sponsor of sponsors) {
            try {
                const sponsorRef = ref(db, 'users/' + sponsor.uid);
                const result = await runTransaction(sponsorRef, (currentData) => {
                    if (!currentData) return { ...currentData };
                    
                    const newReferralEarnings = roundTo8((currentData.referralEarnings || 0) + sponsor.commission);
                    const newReferralWallet = roundTo8((currentData.referralWallet || 0) + sponsor.commission);
                    const newTeamBusiness = roundTo8((currentData.teamBusiness || 0) + amount);
                    const newTotalReferralCommission = roundTo8((currentData.totalReferralCommission || 0) + sponsor.commission);
                    const newLevelEarnings = roundTo8((currentData[`level${sponsor.level}Earnings`] || 0) + sponsor.commission);
                    
                    const transactions = currentData.transactions || {};
                    const txId = 'tx_' + timestamp + '_' + Math.random().toString(36).substr(2, 8);
                    transactions[txId] = {
                        type: 'referral_commission',
                        level: sponsor.level,
                        amount: sponsor.commission,
                        currency: 'USDT',
                        fromUser: currentUser.username || userUid,
                        packageId: packageId,
                        rate: rndPriceAtTime,
                        timestamp: timestamp,
                        date: date,
                        status: 'completed',
                        description: `${sponsor.levelName} commission from package purchase`
                    };
                    
                    return {
                        ...currentData,
                        referralEarnings: newReferralEarnings,
                        referralWallet: newReferralWallet,
                        teamBusiness: newTeamBusiness,
                        totalReferralCommission: newTotalReferralCommission,
                        [`level${sponsor.level}Earnings`]: newLevelEarnings,
                        transactions: transactions
                    };
                });
                
                if (result.committed) {
                    successCount++;
                } else {
                    failedSponsors.push(sponsor.level);
                }
            } catch (err) {
                console.error(`❌ Error in level ${sponsor.level} commission:`, err);
                failedSponsors.push(sponsor.level);
            }
        }
        
        return { 
            totalCommission: roundTo8(totalCommission),
            commissionCount, 
            successCount,
            failedCount: sponsors.length - successCount,
            failedSponsors: failedSponsors
        };
    } catch (error) {
        console.error('Error distributing referral commission:', error);
        return { totalCommission: 0, commissionCount: 0, error: error.message };
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

        const finalSnap = await get(ref(db, 'users/' + user.uid));
        const finalUserData = finalSnap.exists() ? finalSnap.val() : userData;

        const username = finalUserData.username || finalUserData.referralCode || 'USER';
        const name = finalUserData.name || 'User';
        document.getElementById('sidebarName').textContent = name;
        document.getElementById('sidebarUserId').textContent = 'ID: ' + username.substring(0, 20) + '...';
        document.getElementById('sidebarAvatar').textContent = name.charAt(0).toUpperCase();

        const badge = document.getElementById('referralBadge');
        if (badge) badge.textContent = finalUserData.totalReferrals || 0;

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
                        <span class="plan">${p.planName || 'Package'}</span>
                        <div class="date">${new Date(p.purchaseDate || p.timestamp).toLocaleString('hi-IN')}</div>
                        ${p.rndPriceAtTime ? `<span class="rate-badge">Rate: $${p.rndPriceAtTime.toFixed(4)}/RND</span>` : ''}
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
                        ${p.planDays ? `<div class="daily">📅 ${p.planDays} Days</div>` : ''}
                    </div>
                </div>
            `;
        });

        document.getElementById('packageContent').innerHTML = `
            <div class="row g-4">
                <div class="col-12">
                    <div class="d-flex flex-wrap justify-content-between align-items-center">
                        <h4 class="fw-bold"><i class="bi bi-box-seam text-success me-2"></i>Buy Package</h4>
                        <span class="rnd-price-badge"><i class="bi bi-currency-dollar"></i> 1 RND = $${(rndPrice || 1).toFixed(4)}</span>
                    </div>
                    <hr class="border-secondary">
                </div>

                <div class="col-12">
                    <div class="card-glass">
                        <!-- WALLET CARDS: ONLY DEPOSIT + REFERRAL -->
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

        // ---- attach CTA button listeners ----
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

        // ---- input realtime calculation ----
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

        // ---- buy form submission ----
        const buyForm = document.getElementById('buyForm');
        if (buyForm) {
            buyForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                
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
                
                if (!payAmount || payAmount < plan.minAmount) { 
                    showToast(`❌ Minimum investment for ${plan.name} is $${plan.minAmount} USDT!`, 'error'); 
                    return; 
                }

                buyBtn.disabled = true;
                buyBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Processing...';

                try {
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
                        buyBtn.disabled = false;
                        buyBtn.innerHTML = `<i class="bi bi-check-circle me-1"></i>Buy ${planName}`;
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
                            console.warn(`⚠️ ${commissionResult.failedCount} referral commissions failed for levels:`, commissionResult.failedSponsors);
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
                    buyBtn.disabled = false;
                    buyBtn.innerHTML = `<i class="bi bi-check-circle me-1"></i>Buy ${planName}`;
                }
            });
        }

    } catch (error) {
        console.error('Error loading packages:', error);
        document.getElementById('packageContent').innerHTML = `
            <div class="text-center py-5">
                <i class="bi bi-exclamation-triangle text-danger fs-1 d-block mb-3"></i>
                <h4>Error Loading Page</h4>
                <p class="text-muted">${error.message || 'Please check your internet connection.'}</p>
                <button class="btn btn-primary-custom mt-3" onclick="location.reload()">Refresh</button>
            </div>
        `;
    }
});
