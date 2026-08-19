// transactions.js - COMPLETE WITH SMART PENDING DAYS PARSING
// Firebase v10 Modular SDK - Real-time Database

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getDatabase, ref, get, onValue, off } from "firebase/database";

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

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// ============================================================
// 🔥 STATE
// ============================================================
let currentFilter = 'all';
let currentSearch = '';
let allTransactions = [];
let usersCache = {};
let usersCacheLoaded = false;
let unsubscribeListener = null;
let unsubscribeUsers = null;
let currentUid = null;
let isInitialLoad = true;

// ============================================================
// 🔥 TOAST SYSTEM
// ============================================================
function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    
    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;
    const icon = type === 'success' ? 'bi-check-circle-fill text-success' : 'bi-exclamation-triangle-fill text-danger';
    toast.innerHTML = `
        <i class="bi ${icon}"></i>
        <span class="toast-msg">${message}</span>
    `;
    toast.style.cssText = `
        background: rgba(19,34,55,0.95);
        backdrop-filter: blur(10px);
        border: 1px solid ${type === 'success' ? 'rgba(46,204,113,0.3)' : 'rgba(239,68,68,0.3)'};
        border-radius: 12px;
        padding: 12px 20px;
        margin-bottom: 10px;
        color: #fff;
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 0.9rem;
        transform: translateX(120%);
        transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        box-shadow: 0 10px 40px rgba(0,0,0,0.5);
        min-width: 280px;
        max-width: 450px;
        z-index: 9999;
    `;
    container.appendChild(toast);
    
    requestAnimationFrame(() => {
        toast.style.transform = 'translateX(0)';
    });
    
    setTimeout(() => {
        toast.style.transform = 'translateX(120%)';
        setTimeout(() => toast.remove(), 400);
    }, 5000);
}

// ============================================================
// 🔥 SIDEBAR CONTROLS
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

if (sidebarToggle) sidebarToggle.addEventListener('click', openSidebar);
if (sidebarClose) sidebarClose.addEventListener('click', closeSidebar);
if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeSidebar);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidebar(); });

// Logout
document.getElementById('logoutBtnSidebar')?.addEventListener('click', async (e) => {
    e.preventDefault();
    await signOut(auth);
    window.location.href = 'login.html';
});

// ============================================================
// 🔥 HELPERS - FORMATTING
// ============================================================
function formatDate(timestamp) {
    if (!timestamp) return 'N/A';
    const d = new Date(timestamp);
    return d.toLocaleString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatDateShort(timestamp) {
    if (!timestamp) return 'N/A';
    const d = new Date(timestamp);
    return d.toLocaleString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
    });
}

// ============================================================
// 🔥 SMART PENDING DAYS PARSER - Extracts days from description
// ============================================================
function extractPendingDays(description) {
    if (!description) return null;
    
    // Pattern 1: "(10 days pending)" or "(1 day pending)"
    const match1 = description.match(/\((\d+)\s+days?\s+pending\)/i);
    if (match1) {
        return parseInt(match1[1], 10);
    }
    
    // Pattern 2: "10 days pending" without parentheses
    const match2 = description.match(/(\d+)\s+days?\s+pending/i);
    if (match2) {
        return parseInt(match2[1], 10);
    }
    
    // Pattern 3: "pending for 10 days"
    const match3 = description.match(/pending\s+for\s+(\d+)\s+days?/i);
    if (match3) {
        return parseInt(match3[1], 10);
    }
    
    // Pattern 4: "10 day pending" (singular)
    const match4 = description.match(/(\d+)\s+day\s+pending/i);
    if (match4) {
        return parseInt(match4[1], 10);
    }
    
    return null;
}

// ============================================================
// 🔥 EXTRACT PACKAGE NAME FROM DESCRIPTION
// ============================================================
function extractPackageName(description) {
    if (!description) return null;
    
    // Pattern: "from Gold Package" or "from Gold Package (10 days pending)"
    const match = description.match(/from\s+(.+?)(?:\s*\(|$)/i);
    if (match) {
        return match[1].trim();
    }
    
    // Pattern: "Gold Package pending release"
    const match2 = description.match(/^(.+?)\s+pending\s+release/i);
    if (match2) {
        return match2[1].trim();
    }
    
    return null;
}

// ============================================================
// 🔥 TYPE MAPS WITH PENDING RELEASE SUPPORT
// ============================================================
function getTypeIcon(type) {
    const map = {
        'deposit': 'bi-arrow-down-circle',
        'withdrawal': 'bi-arrow-up-circle',
        'package': 'bi-box-seam',
        'transfer_sent': 'bi-arrow-up-right',
        'transfer_received': 'bi-arrow-down-left',
        'referral_commission': 'bi-people',
        'daily_release': 'bi-clock-history',
        'pending_release': 'bi-clock-history',
        'admin_credit': 'bi-plus-circle',
        'admin_debit': 'bi-dash-circle',
        'bonus': 'bi-gift',
        'package_completed': 'bi-check-circle'
    };
    return map[type] || 'bi-circle';
}

function getTypeClass(type) {
    const map = {
        'deposit': 'deposit',
        'withdrawal': 'withdraw',
        'package': 'package',
        'transfer_sent': 'transfer-sent',
        'transfer_received': 'transfer-received',
        'referral_commission': 'referral',
        'daily_release': 'release',
        'pending_release': 'release',
        'admin_credit': 'admin',
        'admin_debit': 'admin',
        'bonus': 'bonus',
        'package_completed': 'package'
    };
    return map[type] || 'deposit';
}

function getTypeLabel(type) {
    const map = {
        'deposit': 'Deposit',
        'withdrawal': 'Withdrawal',
        'package': 'Package Purchase',
        'transfer_sent': 'Transfer Sent',
        'transfer_received': 'Transfer Received',
        'referral_commission': 'Referral Commission',
        'daily_release': 'Daily Release',
        'pending_release': 'Pending Release',
        'admin_credit': 'Admin Credit',
        'admin_debit': 'Admin Debit',
        'bonus': 'Bonus Credit',
        'package_completed': 'Package Completed'
    };
    return map[type] || type;
}

function getAmountClass(type) {
    const negative = ['withdrawal', 'transfer_sent', 'admin_debit'];
    const positive = ['deposit', 'transfer_received', 'referral_commission', 'daily_release', 'pending_release', 'admin_credit', 'bonus', 'package_completed'];
    if (negative.includes(type)) return 'negative';
    if (positive.includes(type)) return 'positive';
    return 'neutral';
}

function getAmountSign(type) {
    const negative = ['withdrawal', 'transfer_sent', 'admin_debit'];
    const positive = ['deposit', 'transfer_received', 'referral_commission', 'daily_release', 'pending_release', 'admin_credit', 'bonus', 'package_completed'];
    if (negative.includes(type)) return '-';
    if (positive.includes(type)) return '+';
    return '';
}

function getStatusClass(status) {
    if (!status) return 'approved';
    const s = status.toLowerCase();
    if (s === 'pending') return 'pending';
    if (s === 'approved' || s === 'active' || s === 'completed' || s === 'success') return 'approved';
    if (s === 'rejected' || s === 'failed') return 'rejected';
    return 'approved';
}

function getStatusLabel(status) {
    if (!status) return 'Completed';
    const s = status.toLowerCase();
    if (s === 'pending') return '⏳ Pending';
    if (s === 'approved') return '✅ Approved';
    if (s === 'completed') return '✅ Completed';
    if (s === 'active') return '🟢 Active';
    if (s === 'rejected') return '❌ Rejected';
    if (s === 'failed') return '❌ Failed';
    if (s === 'success') return '✅ Success';
    return status;
}

// ============================================================
// 🔥 LOAD ALL USERS CACHE
// ============================================================
function loadUsersCache() {
    if (unsubscribeUsers) {
        unsubscribeUsers();
        unsubscribeUsers = null;
    }
    
    const usersRef = ref(db, 'users');
    unsubscribeUsers = onValue(usersRef, (snapshot) => {
        if (snapshot.exists()) {
            const data = snapshot.val();
            usersCache = {};
            Object.keys(data).forEach(uid => {
                const user = data[uid];
                const name = user.name || user.username || user.referralCode || user.fullName || 'User';
                usersCache[uid] = name;
            });
            usersCacheLoaded = true;
            
            if (allTransactions.length > 0) {
                allTransactions = enrichTransactionsFromCache(allTransactions);
                renderTransactions(currentFilter, currentSearch);
            }
        }
    }, (error) => {
        console.warn('Users cache error:', error);
    });
}

// ============================================================
// 🔥 ENRICH TRANSACTIONS FROM CACHE
// ============================================================
function enrichTransactionsFromCache(transactions) {
    return transactions.map(t => {
        const enriched = { ...t };
        
        if (enriched.fromUser && !enriched.fromName) {
            enriched.fromName = usersCache[enriched.fromUser] || 'Unknown';
        }
        if (enriched.fromUserId && !enriched.fromName) {
            enriched.fromName = usersCache[enriched.fromUserId] || 'Unknown';
        }
        if (enriched.toUserId && !enriched.toName) {
            enriched.toName = usersCache[enriched.toUserId] || 'Unknown';
        }
        if (enriched.referredUserId && !enriched.referredName) {
            enriched.referredName = usersCache[enriched.referredUserId] || 'Unknown';
        }
        if (enriched.senderUid && !enriched.fromName) {
            enriched.fromName = usersCache[enriched.senderUid] || 'Unknown';
        }
        if (enriched.receiverUid && !enriched.toName) {
            enriched.toName = usersCache[enriched.receiverUid] || 'Unknown';
        }
        if (enriched.toUid && !enriched.toName) {
            enriched.toName = usersCache[enriched.toUid] || 'Unknown';
        }
        if (enriched.fromUid && !enriched.fromName) {
            enriched.fromName = usersCache[enriched.fromUid] || 'Unknown';
        }
        if (enriched.referralUid && !enriched.referredName) {
            enriched.referredName = usersCache[enriched.referralUid] || 'Unknown';
        }
        
        return enriched;
    });
}

function getUserNameFromCache(uid) {
    if (!uid) return 'Unknown';
    return usersCache[uid] || 'Unknown';
}

// ============================================================
// 🔥 REAL-TIME TRANSACTION LISTENER
// ============================================================
function setupRealTimeListener(uid) {
    if (unsubscribeListener) {
        unsubscribeListener();
        unsubscribeListener = null;
    }
    
    currentUid = uid;
    const userRef = ref(db, 'users/' + uid);
    
    unsubscribeListener = onValue(userRef, (snapshot) => {
        if (!snapshot.exists()) {
            showToast('User data not found', 'error');
            return;
        }
        
        const userData = snapshot.val();
        const transactions = userData.transactions || {};
        
        let txArray = Object.keys(transactions).map(key => ({
            id: key,
            ...transactions[key]
        }));
        
        txArray.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        allTransactions = txArray;
        
        if (usersCacheLoaded) {
            allTransactions = enrichTransactionsFromCache(allTransactions);
        }
        
        renderTransactions(currentFilter, currentSearch);
        
        if (isInitialLoad) {
            isInitialLoad = false;
            showToast(`✅ ${allTransactions.length} transactions loaded`, 'success');
        }
        
    }, (error) => {
        console.error('Listener error:', error);
        showToast('Error loading transactions: ' + error.message, 'error');
    });
}

// ============================================================
// 🔥 RENDER TRANSACTIONS
// ============================================================
function renderTransactions(filter = 'all', search = '') {
    currentFilter = filter;
    currentSearch = search || '';
    
    let filtered = [...allTransactions];
    
    // Apply filter
    if (filter !== 'all') {
        filtered = filtered.filter(t => {
            if (filter === 'deposit') return t.type === 'deposit';
            if (filter === 'withdrawal') return t.type === 'withdrawal';
            if (filter === 'package') return t.type === 'package' || t.type === 'package_completed';
            if (filter === 'transfer') return t.type === 'transfer_sent' || t.type === 'transfer_received';
            if (filter === 'referral') return t.type === 'referral_commission';
            if (filter === 'release') return t.type === 'daily_release' || t.type === 'pending_release';
            if (filter === 'bonus') return t.type === 'bonus';
            if (filter === 'admin') return t.type === 'admin_credit' || t.type === 'admin_debit';
            return true;
        });
    }
    
    // Apply search
    if (search && search.trim().length > 0) {
        const q = search.toLowerCase().trim();
        filtered = filtered.filter(t => {
            const searchable = [
                t.type,
                t.description,
                t.planName,
                t.packageName,
                t.fromName,
                t.toName,
                t.referredName,
                t.status,
                t.currency,
                t.txHash,
                t.walletAddress,
                t.remark,
                t.reason,
                t.bonusName,
                t.id,
                t.fromUser,
                t.fromUid,
                t.toUid
            ].filter(Boolean).join(' ').toLowerCase();
            
            const amountStr = String(t.amount || '');
            const dateStr = t.timestamp ? new Date(t.timestamp).toLocaleDateString('en-IN') : '';
            
            return searchable.includes(q) || 
                   amountStr.includes(q) || 
                   dateStr.includes(q);
        });
    }
    
    // Calculate summary stats
    const totalDeposits = allTransactions
        .filter(t => t.type === 'deposit' && t.status !== 'rejected')
        .reduce((sum, t) => sum + (t.amount || 0), 0);
    
    const totalWithdrawals = allTransactions
        .filter(t => t.type === 'withdrawal' && (t.status === 'approved' || t.status === 'completed' || t.status === 'success'))
        .reduce((sum, t) => sum + (t.amount || 0), 0);
    
    const totalReferralIncome = allTransactions
        .filter(t => t.type === 'referral_commission')
        .reduce((sum, t) => sum + (t.amount || 0), 0);
    
    const totalDailyRelease = allTransactions
        .filter(t => t.type === 'daily_release' || t.type === 'pending_release')
        .reduce((sum, t) => sum + (t.amount || 0), 0);
    
    const totalBonus = allTransactions
        .filter(t => t.type === 'bonus')
        .reduce((sum, t) => sum + (t.amount || 0), 0);
    
    const totalTransactions = allTransactions.length;
    
    // Filter buttons
    const filterButtons = `
        <div class="filter-buttons">
            <button class="filter-btn ${filter === 'all' ? 'active' : ''}" data-filter="all">
                <i class="bi bi-list"></i> All
            </button>
            <button class="filter-btn ${filter === 'deposit' ? 'active' : ''}" data-filter="deposit">
                <i class="bi bi-arrow-down-circle"></i> Deposits
            </button>
            <button class="filter-btn ${filter === 'withdrawal' ? 'active' : ''}" data-filter="withdrawal">
                <i class="bi bi-arrow-up-circle"></i> Withdrawals
            </button>
            <button class="filter-btn ${filter === 'package' ? 'active' : ''}" data-filter="package">
                <i class="bi bi-box-seam"></i> Packages
            </button>
            <button class="filter-btn ${filter === 'release' ? 'active' : ''}" data-filter="release">
                <i class="bi bi-clock-history"></i> Releases
            </button>
            <button class="filter-btn ${filter === 'referral' ? 'active' : ''}" data-filter="referral">
                <i class="bi bi-people"></i> Referrals
            </button>
            <button class="filter-btn ${filter === 'transfer' ? 'active' : ''}" data-filter="transfer">
                <i class="bi bi-arrow-left-right"></i> Transfers
            </button>
            <button class="filter-btn ${filter === 'admin' ? 'active' : ''}" data-filter="admin">
                <i class="bi bi-shield"></i> Admin
            </button>
            <button class="filter-btn ${filter === 'bonus' ? 'active' : ''}" data-filter="bonus">
                <i class="bi bi-gift"></i> Bonus
            </button>
        </div>
    `;
    
    // Build transaction items
    let transactionsHtml = '';
    if (filtered.length === 0) {
        transactionsHtml = `
            <div class="no-transactions">
                <i class="bi bi-inbox"></i>
                <p>No ${filter === 'all' ? '' : filter} transactions found.</p>
                <p class="text-muted small">${allTransactions.length} total transactions available</p>
            </div>
        `;
    } else {
        transactionsHtml = filtered.map(t => {
            const icon = getTypeIcon(t.type);
            const iconClass = getTypeClass(t.type);
            const label = getTypeLabel(t.type);
            const amountClass = getAmountClass(t.type);
            const sign = getAmountSign(t.type);
            const statusClass = getStatusClass(t.status);
            const statusLabel = getStatusLabel(t.status);
            
            let extraHtml = '';
            let description = t.description || '';
            let packageName = t.packageName || t.planName || '';
            
            // ============================================================
            // 🔥 SPECIAL HANDLING FOR PENDING RELEASE
            // ============================================================
            if (t.type === 'pending_release') {
                // Try to get pending days from description
                let pendingDays = t.pendingDays || t.days || null;
                let extractedPackageName = packageName;
                
                // If pendingDays not in transaction, extract from description
                if (pendingDays === null) {
                    pendingDays = extractPendingDays(description);
                }
                
                // If package name not available, extract from description
                if (!extractedPackageName) {
                    extractedPackageName = extractPackageName(description) || 'Package';
                }
                
                // Build extra HTML for pending release
                let daysHtml = '';
                if (pendingDays !== null && pendingDays > 0) {
                    daysHtml = `| Pending: ${pendingDays} day${pendingDays > 1 ? 's' : ''}`;
                }
                
                extraHtml = `
                    <div class="sub-detail">
                        <i class="bi bi-clock-history"></i> 
                        ${extractedPackageName}
                        ${daysHtml}
                        ${t.totalReleased !== undefined ? `| Released: ${t.totalReleased.toFixed(2)} RND` : ''}
                    </div>
                `;
                
                // Create clean description
                if (!description || description === 'Pending Release') {
                    description = pendingDays !== null && pendingDays > 0
                        ? `Pending release for ${pendingDays} day${pendingDays > 1 ? 's' : ''}`
                        : 'Pending release';
                }
            }
            else if (t.type === 'daily_release') {
                extraHtml = `
                    <div class="sub-detail">
                        <i class="bi bi-clock-history"></i> 
                        ${packageName || 'Package'} 
                        ${t.remainingRND !== undefined ? `| Remaining: ${t.remainingRND.toFixed(2)} RND` : ''}
                        ${t.totalReleased !== undefined ? `| Total Released: ${t.totalReleased.toFixed(2)} RND` : ''}
                    </div>
                `;
                if (!description) description = 'Daily release from ' + (packageName || 'package');
            }
            else if (t.type === 'package' || t.type === 'package_completed') {
                const pkgName = t.planName || t.packageName || 'Package';
                extraHtml = `
                    <div class="sub-detail">
                        <i class="bi bi-box-seam"></i> 
                        ${pkgName}
                        ${t.totalRND ? `| Total: ${t.totalRND.toFixed(2)} RND` : ''}
                        ${t.dailyRelease ? `| Daily: ${t.dailyRelease.toFixed(4)} RND` : ''}
                        ${t.completedDate ? `| Completed: ${formatDateShort(t.completedDate)}` : ''}
                    </div>
                `;
                if (!description) description = `${pkgName} purchase`;
            } 
            else if (t.type === 'deposit') {
                extraHtml = `
                    <div class="sub-detail">
                        <i class="bi bi-wallet2"></i> ${t.walletAddress ? t.walletAddress.substring(0, 16) + '...' : 'Wallet'}
                        ${t.txHash ? `| TX: <span style="font-family:monospace;font-size:0.6rem;color:#60a5fa;">${t.txHash.substring(0, 14)}...</span>` : ''}
                    </div>
                `;
                if (!description) description = 'Deposit via ' + (t.currency || 'USDT');
            }
            else if (t.type === 'withdrawal') {
                extraHtml = `
                    <div class="sub-detail">
                        <i class="bi bi-wallet2"></i> ${t.walletAddress ? t.walletAddress.substring(0, 16) + '...' : 'External Wallet'}
                        ${t.network ? `| Network: ${t.network}` : ''}
                        ${t.txHash ? `| TX: <span style="font-family:monospace;font-size:0.6rem;color:#60a5fa;">${t.txHash.substring(0, 14)}...</span>` : ''}
                    </div>
                `;
                if (!description) description = 'Withdrawal request';
            }
            else if (t.type === 'transfer_sent' || t.type === 'transfer_received') {
                const otherName = t.type === 'transfer_sent' ? (t.toName || 'Unknown') : (t.fromName || 'Unknown');
                const action = t.type === 'transfer_sent' ? 'To' : 'From';
                const emoji = t.type === 'transfer_sent' ? '↗️' : '↙️';
                extraHtml = `
                    <div class="sub-detail">
                        <i class="bi bi-person"></i> ${action}: <span class="name">${otherName}</span>
                        ${t.type === 'transfer_sent' ? ' (sent)' : ' (received)'}
                    </div>
                `;
                if (!description) description = `${emoji} ${action} ${otherName}`;
            }
            else if (t.type === 'referral_commission') {
                const refName = t.referredName || t.fromName || getUserNameFromCache(t.fromUser) || 'Unknown';
                const level = t.level || t.referralLevel || '';
                extraHtml = `
                    <div class="sub-detail">
                        <i class="bi bi-people"></i> 
                        Level ${level ? level + ' | ' : ''}
                        From: <span class="name">${refName}</span>
                        ${t.packageName ? `| Package: ${t.packageName}` : ''}
                    </div>
                `;
                if (!description) description = `Level ${level || 1} referral commission`;
            }
            else if (t.type === 'bonus') {
                extraHtml = `
                    <div class="sub-detail">
                        <i class="bi bi-gift"></i> 
                        ${t.bonusName || 'Bonus'}
                        ${t.description && t.description !== description ? `| ${t.description}` : ''}
                    </div>
                `;
                if (!description) description = t.bonusName || 'Bonus credit';
            }
            else if (t.type === 'admin_credit' || t.type === 'admin_debit') {
                const action = t.type === 'admin_credit' ? 'Credit' : 'Debit';
                extraHtml = `
                    <div class="sub-detail">
                        <i class="bi bi-shield"></i> 
                        ${action} ${t.reason || ''}
                        ${t.remark ? `| Remark: ${t.remark}` : ''}
                    </div>
                `;
                if (!description) description = `Admin ${action}`;
            }
            
            const refNum = t.id ? t.id.substring(0, 8) : 'N/A';
            const currency = t.currency || 'USDT';
            const amountDisplay = (t.amount || 0).toFixed(currency === 'RND' ? 4 : 2);
            
            return `
                <div class="transaction-item">
                    <div class="d-flex align-items-center gap-3" style="flex:1;min-width:0;">
                        <div class="type-icon ${iconClass}">
                            <i class="bi ${icon}"></i>
                        </div>
                        <div class="info">
                            <h6>${label}</h6>
                            <div class="sub-detail">${description}</div>
                            ${extraHtml}
                            <div class="from-to">
                                <i class="bi bi-clock"></i> ${formatDate(t.timestamp)}
                                ${t.packageId ? ` | ID: ${t.packageId.substring(0, 10)}...` : ''}
                            </div>
                        </div>
                    </div>
                    <div class="amount-section">
                        <div class="amount ${amountClass}">
                            ${sign}${amountDisplay} ${currency}
                        </div>
                        <div class="status ${statusClass}">${statusLabel}</div>
                        <div class="date">#${refNum}</div>
                    </div>
                </div>
            `;
        }).join('');
    }
    
    // Build final HTML
    const container = document.getElementById('transactionsContent');
    container.innerHTML = `
        <div class="row g-4">
            <div class="col-12">
                <div class="d-flex flex-wrap justify-content-between align-items-center gap-3">
                    <h4 class="fw-bold"><i class="bi bi-receipt text-success me-2"></i>Transaction History</h4>
                    <div class="d-flex flex-wrap align-items-center gap-3">
                        <div class="real-time-badge">
                            <span class="dot"></span> Real-time
                        </div>
                        <span class="text-muted small">${totalTransactions} transactions</span>
                        <input type="text" class="search-box" id="searchInput" 
                               placeholder="Search transactions..." value="${search}" />
                    </div>
                </div>
                <hr class="border-secondary">
            </div>

            <!-- Summary Stats -->
            <div class="col-12">
                <div class="summary-stats">
                    <div class="stat-box">
                        <div class="num green">${totalDeposits.toFixed(2)}</div>
                        <div class="label">💰 Total Deposits</div>
                    </div>
                    <div class="stat-box">
                        <div class="num gold">${totalWithdrawals.toFixed(2)}</div>
                        <div class="label">🏦 Total Withdrawn</div>
                    </div>
                    <div class="stat-box">
                        <div class="num purple">${totalReferralIncome.toFixed(2)}</div>
                        <div class="label">👥 Referral Income</div>
                    </div>
                    <div class="stat-box">
                        <div class="num" style="color:#34d399;">${totalDailyRelease.toFixed(2)}</div>
                        <div class="label">📈 Total Release (Daily + Pending)</div>
                    </div>
                    <div class="stat-box">
                        <div class="num pink">${totalBonus.toFixed(2)}</div>
                        <div class="label">🎁 Bonus Received</div>
                    </div>
                    <div class="stat-box">
                        <div class="num blue">${totalTransactions}</div>
                        <div class="label">📋 Total Transactions</div>
                    </div>
                </div>
            </div>

            <!-- Filters -->
            <div class="col-12">
                ${filterButtons}
            </div>

            <!-- Transactions List -->
            <div class="col-12">
                <div class="card-glass">
                    ${transactionsHtml}
                </div>
            </div>

            <!-- Print Button -->
            <div class="col-12 text-center">
                <button class="btn-print" onclick="window.print()" style="
                    background: linear-gradient(135deg, #2ecc71, #27ae60);
                    border: none;
                    color: #fff;
                    font-weight: 600;
                    padding: 12px 28px;
                    border-radius: 60px;
                    transition: all 0.3s ease;
                    font-size: 0.9rem;
                    display: inline-flex;
                    align-items: center;
                    gap: 10px;
                    cursor: pointer;
                ">
                    <i class="bi bi-printer"></i> Print / PDF
                </button>
            </div>
        </div>
    `;
    
    attachEventListeners(filter);
}

// ============================================================
// 🔥 ATTACH EVENT LISTENERS
// ============================================================
function attachEventListeners(currentFilter) {
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const filter = this.dataset.filter;
            const search = document.getElementById('searchInput')?.value || '';
            renderTransactions(filter, search);
        });
    });
    
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        let debounceTimer;
        searchInput.addEventListener('input', function() {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                renderTransactions(currentFilter, this.value);
            }, 300);
        });
    }
}

// ============================================================
// 🔥 MAIN - AUTH STATE
// ============================================================
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'login.html';
        return;
    }
    
    try {
        const userSnap = await get(ref(db, 'users/' + user.uid));
        if (!userSnap.exists()) {
            window.location.href = 'dashboard.html';
            return;
        }
        
        const userData = userSnap.val();
        const name = userData.name || userData.username || 'User';
        const username = userData.username || userData.referralCode || 'USER';
        
        document.getElementById('sidebarName').textContent = name;
        document.getElementById('sidebarUserId').textContent = 'ID: ' + username.substring(0, 20) + '...';
        document.getElementById('sidebarAvatar').textContent = name.charAt(0).toUpperCase();
        
        const badge = document.getElementById('referralBadge');
        if (badge) {
            const totalRefs = userData.totalReferrals || userData.directReferrals || 0;
            badge.textContent = totalRefs;
        }
        
        loadUsersCache();
        setupRealTimeListener(user.uid);
        
    } catch (error) {
        console.error('Error loading page:', error);
        document.getElementById('transactionsContent').innerHTML = `
            <div class="text-center py-5">
                <i class="bi bi-exclamation-triangle text-danger fs-1 d-block mb-3"></i>
                <h4>Error Loading Page</h4>
                <p class="text-muted">${error.message || 'Please check your internet connection.'}</p>
                <button class="btn btn-primary-custom mt-3" onclick="location.reload()">Refresh</button>
            </div>
        `;
        showToast('Error loading transactions: ' + error.message, 'error');
    }
});

// ============================================================
// 🔥 CLEANUP
// ============================================================
window.addEventListener('beforeunload', () => {
    if (unsubscribeListener) {
        unsubscribeListener();
        unsubscribeListener = null;
    }
    if (unsubscribeUsers) {
        unsubscribeUsers();
        unsubscribeUsers = null;
    }
});

console.log('✅ Transactions page loaded successfully (SMART PENDING DAYS PARSING)');