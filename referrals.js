// ============================================================
// RND STAKING - REFERRALS.JS (PRODUCTION READY v5)
// ============================================================
// 📌 RULES:
// 1. NO WARNING MESSAGES TO USER - Clean UI
// 2. ALL DATA SHOWS - Name, Email, User ID, Commission
// 3. SAME AS DASHBOARD - No extra calculations
// 4. ONLY READ - No writes to database
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getDatabase, ref, get, onValue, query, orderByChild, equalTo } from "firebase/database";

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

console.log('✅ Firebase initialized with NEW config (rwebsite-e031b)');

const DOMAIN = "https://staking.randigital.in";
const REGISTER_URL = `${DOMAIN}/register.html`;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// ============================================================
// GLOBAL VARIABLES
// ============================================================
let currentUserData = null;
let currentUserId = null;
let listenerOff = null;
let historyLimit = 20;
let allUsersCache = null;
let isLoading = false;

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

function formatDate(timestamp) {
    if (!timestamp) return 'N/A';
    return new Date(timestamp).toLocaleDateString('hi-IN');
}

function safeGet(obj, path, defaultValue = 0) {
    const keys = path.split('.');
    let result = obj;
    for (let key of keys) {
        if (result === undefined || result === null) return defaultValue;
        result = result[key];
    }
    return result !== undefined && result !== null ? result : defaultValue;
}

function getLevelCommission(stake, level) {
    const rates = { 1: 0.08, 2: 0.04, 3: 0.02, 4: 0.01, 5: 0.01 };
    return (stake || 0) * (rates[level] || 0);
}

function getLevelColor(level) {
    const colors = {
        1: '#fbbf24',
        2: '#60a5fa',
        3: '#a78bfa',
        4: '#f472b6',
        5: '#fb923c'
    };
    return colors[level] || '#fbbf24';
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
    try {
        await signOut(auth);
        window.location.href = 'login.html';
    } catch (error) {
        showToast('❌ Error logging out', 'error');
    }
});

// ============================================================
// GET ALL USERS (Cached for Level Members)
// ============================================================
async function getAllUsers() {
    if (allUsersCache) return allUsersCache;
    try {
        console.log('📥 Fetching all users from Firebase...');
        const snapshot = await get(ref(db, 'users'));
        if (snapshot.exists()) {
            allUsersCache = snapshot.val();
            console.log('✅ Users cached, total:', Object.keys(allUsersCache).length);
            return allUsersCache;
        }
        return {};
    } catch (error) {
        console.error('Error getting all users:', error);
        return {};
    }
}

// ============================================================
// GET LEVEL MEMBERS (Using Cache)
// ============================================================
function getLevelMembersFromCache(userId, referralCode, level) {
    const members = [];
    if (!allUsersCache) return members;
    
    let currentLevel = 1;
    let currentRefCode = referralCode;
    
    function findMembers(refCode, targetLevel, currentLevel) {
        const result = [];
        for (let uid in allUsersCache) {
            const user = allUsersCache[uid];
            if (user.referredBy === refCode && uid !== userId) {
                result.push({ uid, ...user });
            }
        }
        
        if (currentLevel === targetLevel) {
            return result;
        }
        
        let allNext = [];
        for (let member of result) {
            const next = findMembers(member.referralCode, targetLevel, currentLevel + 1);
            allNext = [...allNext, ...next];
        }
        return allNext;
    }
    
    return findMembers(referralCode, level, 1);
}

// ============================================================
// RENDER REFERRAL DATA (Clean - No Warnings)
// ============================================================
async function renderReferralData(u) {
    if (isLoading) return;
    isLoading = true;
    
    try {
        const username = u.username || u.referralCode || 'USER';
        const name = u.name || 'User';
        
        // ✅ FIX: Calculate totalReferrals from teamStructure (All Levels Combined)
        const teamStructure = safeGet(u, 'teamStructure', { level1: 0, level2: 0, level3: 0, level4: 0, level5: 0 });
        const directReferrals = teamStructure.level1 || 0;
        const totalReferrals = (teamStructure.level1 || 0) + 
                              (teamStructure.level2 || 0) + 
                              (teamStructure.level3 || 0) + 
                              (teamStructure.level4 || 0) + 
                              (teamStructure.level5 || 0);
        
        const referralWallet = safeGet(u, 'referralWallet', 0);
        
        // ✅ FIX: Total Referral Earnings = All Levels Combined
        const level1Earn = safeGet(u, 'level1Earnings', 0);
        const level2Earn = safeGet(u, 'level2Earnings', 0);
        const level3Earn = safeGet(u, 'level3Earnings', 0);
        const level4Earn = safeGet(u, 'level4Earnings', 0);
        const level5Earn = safeGet(u, 'level5Earnings', 0);
        const totalReferralEarnings = level1Earn + level2Earn + level3Earn + level4Earn + level5Earn;
        
        const level1Count = teamStructure.level1 || 0;
        const level2Count = teamStructure.level2 || 0;
        const level3Count = teamStructure.level3 || 0;
        const level4Count = teamStructure.level4 || 0;
        const level5Count = teamStructure.level5 || 0;
        
        const totalDownline = level2Count + level3Count + level4Count + level5Count;
        const totalDownlineEarnings = level2Earn + level3Earn + level4Earn + level5Earn;
        
        const commissionHistory = safeGet(u, 'commissionHistory', []);
        const sortedHistory = [...commissionHistory].reverse();
        const displayHistory = sortedHistory.slice(0, historyLimit);
        const hasMore = sortedHistory.length > historyLimit;
        
        const referralLink = `${REGISTER_URL}?ref=${u.referralCode}`;
        
        // Get all users for level members
        await getAllUsers();
        
        // Get Level Members
        const level1Members = getLevelMembersFromCache(currentUserId, u.referralCode, 1);
        const level2Members = getLevelMembersFromCache(currentUserId, u.referralCode, 2);
        const level3Members = getLevelMembersFromCache(currentUserId, u.referralCode, 3);
        const level4Members = getLevelMembersFromCache(currentUserId, u.referralCode, 4);
        const level5Members = getLevelMembersFromCache(currentUserId, u.referralCode, 5);
        
        console.log('📊 Level Members - L1:', level1Members.length, 'L2:', level2Members.length, 'L3:', level3Members.length, 'L4:', level4Members.length, 'L5:', level5Members.length);
        
        // Update sidebar
        document.getElementById('sidebarName').textContent = name;
        document.getElementById('sidebarUserId').textContent = 'ID: ' + username.substring(0, 20) + '...';
        document.getElementById('sidebarAvatar').textContent = name.charAt(0).toUpperCase();
        
        const badge = document.getElementById('referralBadge');
        if (badge) badge.textContent = directReferrals;
        
        document.getElementById('referralContent').innerHTML = `
            <div class="row g-4">
                <div class="col-12">
                    <h4 class="fw-bold"><i class="bi bi-people text-success me-2"></i>Referral Program</h4>
                    <hr class="border-secondary">
                </div>
                
                <!-- ====== STATS ====== -->
                <div class="col-12">
                    <div class="stats-grid">
                        <div class="stat-item">
                            <div class="number">${totalReferrals}</div>
                            <div class="label">Total Referrals</div>
                            <div class="earnings">💰 $${(totalReferralEarnings || 0).toFixed(2)} Earned</div>
                        </div>
                        <div class="stat-item">
                            <div class="number">${totalDownline}</div>
                            <div class="label">Total Downline</div>
                            <div class="earnings">💰 $${(totalDownlineEarnings || 0).toFixed(2)} Earned</div>
                        </div>
                    </div>
                </div>
                
                <!-- ====== REFERRAL LINK ====== -->
                <div class="col-md-6">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-link-45deg"></i>Your Referral Link</div>
                        <div class="referral-box">
                            <code>${referralLink}</code>
                            <button class="copy-btn" data-copy="${referralLink}"><i class="bi bi-clipboard me-1"></i>Copy</button>
                        </div>
                        <div class="mt-2">
                            <small class="text-muted"><i class="bi bi-info-circle me-1"></i> Referral Code: <strong style="color:#2ecc71;font-size:0.7rem;">${u.referralCode}</strong></small>
                        </div>
                        <div class="mt-2">
                            <small class="text-muted"><i class="bi bi-wallet2 me-1"></i> Referral Wallet: <strong style="color:#fbbf24;">${(referralWallet || 0).toFixed(2)} USDT</strong></small>
                        </div>
                    </div>
                </div>
                
                <!-- ====== COMMISSION STRUCTURE ====== -->
                <div class="col-md-6">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-diagram-3"></i>Commission Structure</div>
                        <div class="row g-2">
                            <div class="col-6"><small>Level 1 (8%)</small></div>
                            <div class="col-6"><small>Level 2 (4%)</small></div>
                            <div class="col-6"><small>Level 3 (2%)</small></div>
                            <div class="col-6"><small>Level 4 (1%)</small></div>
                            <div class="col-6"><small>Level 5 (1%)</small></div>
                            <div class="col-6"><strong class="text-success">Total 16%</strong></div>
                        </div>
                        <div class="mt-3 pt-2 border-top border-secondary">
                            <div class="d-flex justify-content-between">
                                <span class="text-muted">Total Referral Earnings</span>
                                <span class="text-success fw-bold">$${(totalReferralEarnings || 0).toFixed(2)}</span>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- ====== 5 LEVEL EARNINGS ====== -->
                <div class="col-12">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-cash-stack text-success me-2"></i>5 Level Referral Earnings</div>
                        <div class="row g-3">
                            <div class="col-md-2 col-6">
                                <div class="earnings-box" style="border-color:rgba(46,204,113,0.15);">
                                    <span class="label">👥 Level 1</span>
                                    <span class="value" style="font-size:1rem;">${level1Count}</span>
                                    <span class="label" style="font-size:0.65rem;color:#fbbf24;">$${(level1Earn || 0).toFixed(2)}</span>
                                </div>
                            </div>
                            <div class="col-md-2 col-6">
                                <div class="earnings-box" style="border-color:rgba(59,130,246,0.15);">
                                    <span class="label">👥 Level 2</span>
                                    <span class="value" style="font-size:1rem;color:#60a5fa;">${level2Count}</span>
                                    <span class="label" style="font-size:0.65rem;color:#60a5fa;">$${(level2Earn || 0).toFixed(2)}</span>
                                </div>
                            </div>
                            <div class="col-md-2 col-6">
                                <div class="earnings-box" style="border-color:rgba(167,139,250,0.15);">
                                    <span class="label">👥 Level 3</span>
                                    <span class="value" style="font-size:1rem;color:#a78bfa;">${level3Count}</span>
                                    <span class="label" style="font-size:0.65rem;color:#a78bfa;">$${(level3Earn || 0).toFixed(2)}</span>
                                </div>
                            </div>
                            <div class="col-md-2 col-6">
                                <div class="earnings-box" style="border-color:rgba(244,114,182,0.15);">
                                    <span class="label">👥 Level 4</span>
                                    <span class="value" style="font-size:1rem;color:#f472b6;">${level4Count}</span>
                                    <span class="label" style="font-size:0.65rem;color:#f472b6;">$${(level4Earn || 0).toFixed(2)}</span>
                                </div>
                            </div>
                            <div class="col-md-2 col-6">
                                <div class="earnings-box" style="border-color:rgba(251,146,60,0.15);">
                                    <span class="label">👥 Level 5</span>
                                    <span class="value" style="font-size:1rem;color:#fb923c;">${level5Count}</span>
                                    <span class="label" style="font-size:0.65rem;color:#fb923c;">$${(level5Earn || 0).toFixed(2)}</span>
                                </div>
                            </div>
                            <div class="col-md-2 col-6">
                                <div class="earnings-box" style="border-color:rgba(46,204,113,0.3);background:rgba(46,204,113,0.05);">
                                    <span class="label">🏆 Total</span>
                                    <span class="value" style="font-size:1.2rem;color:#2ecc71;">$${(totalReferralEarnings || 0).toFixed(2)}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- ====== LEVEL 1 MEMBERS ====== -->
                <div class="col-12">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-list-ul text-success me-2"></i>Level 1 - Direct Referrals (${level1Count}) <span class="level-badge">8%</span></div>
                        ${level1Members.length === 0 ? `
                            <div class="text-center text-muted py-4">
                                <i class="bi bi-people fs-1 d-block mb-2"></i>
                                <p>No referrals yet. Share your referral link to earn!</p>
                            </div>
                        ` : `
                            <div class="level-members-table">
                                <table class="table table-custom">
                                    <thead>
                                        <tr>
                                            <th>#</th>
                                            <th>Name</th>
                                            <th>Email</th>
                                            <th>User ID</th>
                                            <th>Stake</th>
                                            <th>Commission</th>
                                            <th>Joined</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${level1Members.map((r, i) => `
                                            <tr>
                                                <td>${i + 1}</td>
                                                <td>${r.name || 'N/A'}</td>
                                                <td>${r.email || 'N/A'}</td>
                                                <td style="font-size:0.7rem;color:#a0b8d0;">${r.uid ? r.uid.substring(0, 12) + '...' : 'N/A'}</td>
                                                <td>$${(r.totalStake || 0).toFixed(2)}</td>
                                                <td style="color:#fbbf24;">$${getLevelCommission(r.totalStake, 1).toFixed(2)}</td>
                                                <td style="font-size:0.7rem;color:#556688;">${formatDate(r.createdAt)}</td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            </div>
                        `}
                    </div>
                </div>
                
                <!-- ====== LEVEL 2 MEMBERS ====== -->
                ${level2Count > 0 ? `
                <div class="col-12">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-diagram-3 text-success me-2"></i>Level 2 Referrals (${level2Count}) <span class="level-badge">4%</span></div>
                        <div class="level-members-table">
                            <table class="table table-custom">
                                <thead>
                                    <tr>
                                        <th>#</th>
                                        <th>Name</th>
                                        <th>Email</th>
                                        <th>User ID</th>
                                        <th>Stake</th>
                                        <th>Commission</th>
                                        <th>Joined</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${level2Members.map((r, i) => `
                                        <tr>
                                            <td>${i + 1}</td>
                                            <td>${r.name || 'N/A'}</td>
                                            <td>${r.email || 'N/A'}</td>
                                            <td style="font-size:0.7rem;color:#a0b8d0;">${r.uid ? r.uid.substring(0, 12) + '...' : 'N/A'}</td>
                                            <td>$${(r.totalStake || 0).toFixed(2)}</td>
                                            <td style="color:#60a5fa;">$${getLevelCommission(r.totalStake, 2).toFixed(2)}</td>
                                            <td style="font-size:0.7rem;color:#556688;">${formatDate(r.createdAt)}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
                ` : ''}
                
                <!-- ====== LEVEL 3 MEMBERS ====== -->
                ${level3Count > 0 ? `
                <div class="col-12">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-diagram-3 text-success me-2"></i>Level 3 Referrals (${level3Count}) <span class="level-badge">2%</span></div>
                        <div class="level-members-table">
                            <table class="table table-custom">
                                <thead>
                                    <tr>
                                        <th>#</th>
                                        <th>Name</th>
                                        <th>Email</th>
                                        <th>User ID</th>
                                        <th>Stake</th>
                                        <th>Commission</th>
                                        <th>Joined</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${level3Members.map((r, i) => `
                                        <tr>
                                            <td>${i + 1}</td>
                                            <td>${r.name || 'N/A'}</td>
                                            <td>${r.email || 'N/A'}</td>
                                            <td style="font-size:0.7rem;color:#a0b8d0;">${r.uid ? r.uid.substring(0, 12) + '...' : 'N/A'}</td>
                                            <td>$${(r.totalStake || 0).toFixed(2)}</td>
                                            <td style="color:#a78bfa;">$${getLevelCommission(r.totalStake, 3).toFixed(2)}</td>
                                            <td style="font-size:0.7rem;color:#556688;">${formatDate(r.createdAt)}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
                ` : ''}
                
                <!-- ====== LEVEL 4 MEMBERS ====== -->
                ${level4Count > 0 ? `
                <div class="col-12">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-diagram-3 text-success me-2"></i>Level 4 Referrals (${level4Count}) <span class="level-badge">1%</span></div>
                        <div class="level-members-table">
                            <table class="table table-custom">
                                <thead>
                                    <tr>
                                        <th>#</th>
                                        <th>Name</th>
                                        <th>Email</th>
                                        <th>User ID</th>
                                        <th>Stake</th>
                                        <th>Commission</th>
                                        <th>Joined</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${level4Members.map((r, i) => `
                                        <tr>
                                            <td>${i + 1}</td>
                                            <td>${r.name || 'N/A'}</td>
                                            <td>${r.email || 'N/A'}</td>
                                            <td style="font-size:0.7rem;color:#a0b8d0;">${r.uid ? r.uid.substring(0, 12) + '...' : 'N/A'}</td>
                                            <td>$${(r.totalStake || 0).toFixed(2)}</td>
                                            <td style="color:#f472b6;">$${getLevelCommission(r.totalStake, 4).toFixed(2)}</td>
                                            <td style="font-size:0.7rem;color:#556688;">${formatDate(r.createdAt)}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
                ` : ''}
                
                <!-- ====== LEVEL 5 MEMBERS ====== -->
                ${level5Count > 0 ? `
                <div class="col-12">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-diagram-3 text-success me-2"></i>Level 5 Referrals (${level5Count}) <span class="level-badge">1%</span></div>
                        <div class="level-members-table">
                            <table class="table table-custom">
                                <thead>
                                    <tr>
                                        <th>#</th>
                                        <th>Name</th>
                                        <th>Email</th>
                                        <th>User ID</th>
                                        <th>Stake</th>
                                        <th>Commission</th>
                                        <th>Joined</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${level5Members.map((r, i) => `
                                        <tr>
                                            <td>${i + 1}</td>
                                            <td>${r.name || 'N/A'}</td>
                                            <td>${r.email || 'N/A'}</td>
                                            <td style="font-size:0.7rem;color:#a0b8d0;">${r.uid ? r.uid.substring(0, 12) + '...' : 'N/A'}</td>
                                            <td>$${(r.totalStake || 0).toFixed(2)}</td>
                                            <td style="color:#fb923c;">$${getLevelCommission(r.totalStake, 5).toFixed(2)}</td>
                                            <td style="font-size:0.7rem;color:#556688;">${formatDate(r.createdAt)}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
                ` : ''}
                
                <!-- ====== COMMISSION HISTORY ====== -->
                <div class="col-12">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-clock-history text-success me-2"></i>Commission History</div>
                        ${displayHistory.length === 0 ? `
                            <div class="text-center text-muted py-4">
                                <i class="bi bi-inbox fs-1 d-block mb-2"></i>
                                <p>No commission history yet.</p>
                            </div>
                        ` : `
                            <div class="history-scroll">
                                ${displayHistory.map(item => `
                                    <div class="commission-history-item">
                                        <div>
                                            <span class="level-tag">Level ${item.level || 1}</span>
                                            <span class="user">${item.fromUser || 'Unknown'}</span>
                                            ${item.packageId ? `<span class="text-muted" style="font-size:0.6rem;">(${item.packageId.substring(0, 8)})</span>` : ''}
                                        </div>
                                        <div>
                                            <span class="amount">+$${(item.amount || 0).toFixed(2)}</span>
                                            <span class="text-muted" style="font-size:0.6rem;">(${item.percent || 0}%)</span>
                                            <div class="date">${item.date ? formatDate(item.date) : formatDate(item.timestamp)}</div>
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                            ${hasMore ? `
                                <div class="text-center mt-3">
                                    <button class="load-more-btn" id="loadMoreHistory">
                                        <i class="bi bi-plus-circle me-1"></i> Load More (${sortedHistory.length - historyLimit} remaining)
                                    </button>
                                </div>
                            ` : ''}
                        `}
                    </div>
                </div>
            </div>
        `;
        
        // Copy buttons
        document.querySelectorAll('.copy-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                navigator.clipboard.writeText(btn.dataset.copy).then(() => {
                    btn.innerHTML = '<i class="bi bi-check-circle me-1"></i>Copied!';
                    setTimeout(() => { btn.innerHTML = '<i class="bi bi-clipboard me-1"></i>Copy'; }, 2000);
                });
            });
        });
        
        // Load More button
        const loadMoreBtn = document.getElementById('loadMoreHistory');
        if (loadMoreBtn) {
            loadMoreBtn.addEventListener('click', () => {
                historyLimit += 20;
                renderReferralData(currentUserData);
            });
        }
        
    } catch (error) {
        console.error('Error rendering referral data:', error);
    } finally {
        isLoading = false;
    }
}

// ============================================================
// SETUP REAL-TIME LISTENER
// ============================================================
function setupRealtimeListener(userId) {
    if (listenerOff) {
        listenerOff();
        listenerOff = null;
    }
    
    const userRef = ref(db, 'users/' + userId);
    
    listenerOff = onValue(userRef, (snapshot) => {
        try {
            if (!snapshot.exists()) return;
            const data = snapshot.val();
            currentUserData = data;
            
            // Clear cache on data change to refresh members
            allUsersCache = null;
            
            renderReferralData(data);
        } catch (error) {
            console.error('Realtime listener error:', error);
        }
    });
}

// ============================================================
// LOAD REFERRAL DATA
// ============================================================
async function loadReferralData(userId) {
    try {
        const userSnap = await get(ref(db, 'users/' + userId));
        
        if (!userSnap.exists()) {
            document.getElementById('referralContent').innerHTML = `
                <div class="text-center py-5">
                    <i class="bi bi-exclamation-triangle text-warning fs-1 d-block mb-3"></i>
                    <h4>Profile Not Found</h4>
                    <p class="text-muted">Please complete your profile first.</p>
                    <a href="dashboard.html" class="btn btn-primary-custom mt-3">Go to Dashboard</a>
                </div>
            `;
            return;
        }
        
        const u = userSnap.val();
        currentUserData = u;
        currentUserId = userId;
        
        // Clear cache on load
        allUsersCache = null;
        
        await renderReferralData(u);
        setupRealtimeListener(userId);
        
    } catch (error) {
        console.error('Error loading referral data:', error);
        document.getElementById('referralContent').innerHTML = `
            <div class="text-center py-5">
                <i class="bi bi-exclamation-triangle text-danger fs-1 d-block mb-3"></i>
                <h4>Unable to Load Referrals</h4>
                <p class="text-muted">Please try again later.</p>
                <button class="btn btn-primary-custom mt-3" onclick="location.reload()">Refresh</button>
            </div>
        `;
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
        await loadReferralData(user.uid);
    } catch (error) {
        console.error('Error in auth handler:', error);
        document.getElementById('referralContent').innerHTML = `
            <div class="text-center py-5">
                <i class="bi bi-exclamation-triangle text-danger fs-1 d-block mb-3"></i>
                <h4>Authentication Error</h4>
                <p class="text-muted">Please try again later.</p>
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
});