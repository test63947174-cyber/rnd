// ============================================================
// 🔥 DEPOSIT PAGE LOGIC - RND STAKING
// ============================================================
// Firebase + Real Blockchain Verification
// Amount tolerance: ±0.5% (handles rounding like 5.012 vs 5.01)
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getDatabase, ref, get, onValue } from "firebase/database";

// Real verification from external file
import {
    completeDeposit as realCompleteDeposit,
    cleanupStaleLocks as realCleanupStaleLocks,
    checkPendingVerifications as realCheckPendingVerifications
} from './verifyTransaction.js';

// Wallet config from external file
import { WALLET_CONFIG } from './wallet.js';

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

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// ============================================================
// 🔥 TOAST NOTIFICATIONS
// ============================================================
function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;

    const icons = {
        success: 'bi-check-circle-fill',
        error: 'bi-exclamation-triangle-fill',
        info: 'bi-info-circle-fill'
    };

    const colors = {
        success: '#2ecc71',
        error: '#f87171',
        info: '#60a5fa'
    };

    toast.innerHTML = `
        <i class="bi ${icons[type] || icons.info}" style="color:${colors[type] || colors.info};"></i>
        <span class="toast-msg">${message}</span>
    `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

// ============================================================
// 🔥 CLIPBOARD
// ============================================================
function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text)
            .then(() => showToast('✅ Address copied to clipboard!', 'success'))
            .catch(() => fallbackCopy(text));
    } else {
        fallbackCopy(text);
    }
}

function fallbackCopy(text) {
    const input = document.createElement('input');
    input.value = text;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    try {
        document.execCommand('copy');
        showToast('✅ Address copied to clipboard!', 'success');
    } catch (err) {
        showToast('❌ Failed to copy. Please copy manually.', 'error');
    }
    document.body.removeChild(input);
}

// ============================================================
// 🔥 SIDEBAR
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

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSidebar();
});

const logoutBtn = document.getElementById('logoutBtnSidebar');
if (logoutBtn) {
    logoutBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        try { await signOut(auth); } catch (err) { console.error('Logout error:', err); }
        window.location.href = 'login.html';
    });
}

// ============================================================
// 🔥 UI HELPERS
// ============================================================
function updateVerificationStatus(type, message) {
    const statusDiv = document.getElementById('verificationStatus');
    if (!statusDiv) return;
    statusDiv.className = `verification-status show ${type}`;
    statusDiv.innerHTML = message;
}

function updateBalance(newBalance) {
    const balanceDisplay = document.getElementById('depositBalance');
    if (balanceDisplay) {
        balanceDisplay.textContent = '$' + (Number(newBalance) || 0).toFixed(2);
    }
}

// ============================================================
// 🔥 RENDER DEPOSIT UI
// ============================================================
function renderDepositUI(depositWallet) {
    const container = document.getElementById('depositContent');
    if (!container) return;

    const depositAddress = WALLET_CONFIG.DEPOSIT_WALLET || '';
    const usdtContract = WALLET_CONFIG.USDT_CONTRACT || '';
    const minConfirmations = WALLET_CONFIG.MIN_CONFIRMATIONS || 3;

    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(depositAddress)}&color=2ecc71&bgcolor=080e1a`;

    container.innerHTML = `
        <div class="page-header">
            <div>
                <h4>
                    <span class="header-icon"><i class="bi bi-arrow-down-circle"></i></span>
                    Deposit USDT
                </h4>
                <p>Send USDT (BEP20) to your deposit address & verify on blockchain</p>
            </div>
        </div>

        <div class="row g-4">
            <!-- Balance Card -->
            <div class="col-12 col-lg-6">
                <div class="card-glass">
                    <div class="card-title">
                        <i class="bi bi-wallet2"></i>
                        Deposit Wallet Balance
                    </div>
                    <div class="deposit-balance" id="depositBalance">$${(Number(depositWallet) || 0).toFixed(2)}</div>
                    <div class="deposit-balance-label">USDT Balance</div>
                    <div class="balance-badge">
                        <i class="bi bi-shield-check"></i>
                        Blockchain Verified
                    </div>
                </div>
            </div>

            <!-- Deposit Address Card -->
            <div class="col-12 col-lg-6">
                <div class="card-glass">
                    <div class="card-title">
                        <i class="bi bi-qr-code"></i>
                        Send USDT (BEP20)
                    </div>

                    <div class="qr-wrapper">
                        <img src="${qrUrl}" alt="Deposit QR Code" id="qrCodeImg">
                    </div>

                    <div class="wallet-address-box">
                        <span class="address" id="depositAddress">${depositAddress}</span>
                        <button class="copy-btn" id="copyAddressBtn" type="button">
                            <i class="bi bi-copy"></i> Copy
                        </button>
                    </div>

                    <div class="address-note">
                        <i class="bi bi-info-circle"></i>
                        Only send <strong>USDT (BEP20)</strong> to this address.
                        <br>
                        Contract: <span class="contract">${usdtContract}</span>
                    </div>
                </div>
            </div>

            <!-- Verify Form Card -->
            <div class="col-12">
                <div class="card-glass">
                    <div class="card-title">
                        <i class="bi bi-shield-check"></i>
                        🔒 Verify Deposit (Blockchain)
                    </div>

                    <div class="info-alert">
                        <i class="bi bi-info-circle"></i>
                        <strong>Real Blockchain Verification:</strong> Transaction is verified directly on BSC blockchain.
                        <br>
                        Minimum confirmations required: <strong>${minConfirmations}</strong>
                        <br>
                        ✅ <strong>Amount tolerance ±0.5%</strong> — आप थोड़ा-बहुत अलग amount डालें तो भी accept होगा
                        <br>
                        💡 <strong>Tip:</strong> Enter exact amount with decimals (e.g. 5.012) for fastest verification
                        <br>
                        ❌ <strong>Cannot fake or bypass verification!</strong>
                    </div>

                    <form id="depositForm">
                        <div class="row g-3">
                            <div class="col-12 col-md-4">
                                <label class="form-label" for="depositAmount">
                                    Amount You Sent (USDT) <span class="required">*</span>
                                </label>
                                <input type="number" id="depositAmount" class="form-control form-control-custom"
                                       placeholder="e.g. 5.012" min="0.01" step="any" required>
                                <span class="form-hint">Exact amount you sent (decimals OK)</span>
                            </div>
                            <div class="col-12 col-md-5">
                                <label class="form-label" for="txHash">
                                    Transaction Hash (TXID) <span class="required">*</span>
                                </label>
                                <input type="text" id="txHash" class="form-control form-control-custom"
                                       placeholder="0x..." required>
                                <span class="form-hint">Real BSC transaction hash from your wallet</span>
                            </div>
                            <div class="col-12 col-md-3 d-flex align-items-start">
                                <button type="submit" class="btn-primary-custom" id="verifyBtn" style="margin-top: 26px;">
                                    <i class="bi bi-check-circle"></i>
                                    <span>Verify</span>
                                </button>
                            </div>
                        </div>
                    </form>

                    <div id="verificationStatus" class="verification-status"></div>
                    <div id="pendingVerifications" class="mt-3"></div>
                </div>
            </div>

            <!-- Recent Deposits Card -->
            <div class="col-12">
                <div class="card-glass">
                    <div class="card-title">
                        <i class="bi bi-clock-history"></i>
                        Recent Deposits
                    </div>
                    <div id="recentDeposits">
                        <div class="empty-state">
                            <i class="bi bi-inbox"></i>
                            <p>Loading deposits...</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    const copyBtn = document.getElementById('copyAddressBtn');
    if (copyBtn) {
        copyBtn.addEventListener('click', function () {
            copyToClipboard(depositAddress);
            this.classList.add('copied');
            this.innerHTML = '<i class="bi bi-check"></i> Copied!';
            setTimeout(() => {
                this.classList.remove('copied');
                this.innerHTML = '<i class="bi bi-copy"></i> Copy';
            }, 2000);
        });
    }
}

// ============================================================
// 🔥 RESUME PENDING VERIFICATIONS
// ============================================================
async function resumePendingVerifications(userId) {
    try {
        const pendingTxs = await realCheckPendingVerifications(userId);
        const container = document.getElementById('pendingVerifications');

        if (!container || !pendingTxs || pendingTxs.length === 0) {
            if (container) container.innerHTML = '';
            return;
        }

        const minConfirmations = WALLET_CONFIG.MIN_CONFIRMATIONS || 3;
        const pollingInterval = (WALLET_CONFIG.POLLING_INTERVAL || 15000) / 1000;

        let html = `
            <div class="verification-status show polling">
                <i class="bi bi-arrow-repeat me-2"></i>
                <strong>⏳ Resuming pending verifications...</strong>
                <div class="mt-2">
        `;

        for (const pending of pendingTxs) {
            html += `
                <div class="d-flex align-items-center gap-2 mb-1">
                    <span class="polling-indicator"></span>
                    <span style="font-family:monospace;font-size:0.8rem;">${(pending.txHash || '').substring(0, 20)}...</span>
                    <span class="badge-mini badge-confirm">Pending</span>
                </div>
            `;
        }

        html += `</div></div>`;
        container.innerHTML = html;

        for (const pending of pendingTxs) {
            try {
                await realCompleteDeposit(
                    userId,
                    pending.txHash,
                    (pending.lockData && pending.lockData.amount) || 0,
                    (confirmations, currentBlock, blockNumber) => {
                        updateVerificationStatus(
                            'polling',
                            `<span class="polling-indicator"></span>
                             ⏳ Waiting for confirmations... (${confirmations}/${minConfirmations})<br>
                             <small>Block: ${blockNumber || 'pending'} | Auto-checking every ${pollingInterval} seconds...</small>`
                        );
                    },
                    (newBalance) => {
                        updateVerificationStatus(
                            'success',
                            `✅ Deposit resumed and verified successfully!<br>
                             <small>New Balance: $${Number(newBalance).toFixed(2)}</small>`
                        );
                        updateBalance(newBalance);
                        showToast('✅ Pending deposit completed successfully!', 'success');
                    },
                    (error) => {
                        updateVerificationStatus('error', `❌ ${error}`);
                        showToast(`❌ ${error}`, 'error');
                    }
                );
            } catch (error) {
                console.error('Error resuming pending verification:', error);
            }
        }
    } catch (err) {
        console.error('Error in resumePendingVerifications:', err);
    }
}

// ============================================================
// 🔥 LOAD RECENT DEPOSITS (REAL-TIME)
// ============================================================
function loadRecentDeposits(userId) {
    const depositsRef = ref(db, `users/${userId}/transactions`);

    onValue(depositsRef, (snapshot) => {
        const container = document.getElementById('recentDeposits');
        if (!container) return;

        if (!snapshot.exists()) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="bi bi-inbox"></i>
                    <p>No deposits yet. Send USDT to your deposit address.</p>
                </div>
            `;
            return;
        }

        const transactions = snapshot.val();
        const deposits = Object.values(transactions)
            .filter(tx => tx && tx.type === 'deposit' && tx.status === 'success')
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
            .slice(0, 10);

        if (deposits.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="bi bi-inbox"></i>
                    <p>No deposits yet. Send USDT to your deposit address.</p>
                </div>
            `;
            return;
        }

        container.innerHTML = deposits.map(tx => {
            const amount = Number(tx.amount || 0).toFixed(2);
            const dateStr = tx.timestamp ? new Date(tx.timestamp).toLocaleString('en-IN') : 'N/A';
            const shortHash = tx.txHash ? tx.txHash.substring(0, 16) + '...' : '';

            return `
                <div class="deposit-item">
                    <div>
                        <div class="amount">$${amount} USDT</div>
                        <div class="date">${dateStr}</div>
                    </div>
                    <div style="text-align:right;">
                        <span class="status-active">
                            <i class="bi bi-check-circle-fill"></i>
                            Verified (Blockchain)
                        </span>
                        <div class="badges">
                            ${tx.blockNumber ? `<span class="badge-mini badge-block">Block: ${tx.blockNumber}</span>` : ''}
                            ${tx.confirmations ? `<span class="badge-mini badge-confirm">${tx.confirmations} Confirmations</span>` : ''}
                            ${shortHash ? `<span class="badge-mini badge-hash">${shortHash}</span>` : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }, (error) => {
        console.error('Error loading deposits:', error);
        const container = document.getElementById('recentDeposits');
        if (container) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="bi bi-exclamation-triangle" style="color:var(--red);opacity:0.6;"></i>
                    <p style="color:var(--red);">Error loading deposits. Please refresh.</p>
                </div>
            `;
        }
    });
}

// ============================================================
// 🔥 BALANCE REAL-TIME LISTENER
// ============================================================
function listenToBalance(userId) {
    const balanceRef = ref(db, `users/${userId}/depositWallet`);
    onValue(balanceRef, (snapshot) => {
        if (snapshot.exists()) {
            updateBalance(snapshot.val());
        }
    });
}

// ============================================================
// 🔥 FORMAT VERIFICATION ERROR (with tolerance hint)
// ============================================================
function formatVerificationError(error, userAmount) {
    const msg = String(error || '');

    if (/amount\s*mismatch/i.test(msg)) {
        const match = msg.match(/blockchain\s*shows\s*([\d.]+)/i)
                  || msg.match(/shows\s*([\d.]+)\s*USDT/i);
        const chainAmount = match ? match[1] : null;

        if (chainAmount) {
            return `
                <i class="bi bi-exclamation-triangle me-2"></i>
                ❌ <strong>Amount mismatch</strong>
                <br><small>You entered: <strong>${userAmount} USDT</strong></small>
                <br><small>Blockchain shows: <strong>${chainAmount} USDT</strong></small>
                <br><small>💡 <strong>Tip:</strong> Enter the exact amount from your wallet (decimals included)</small>
                <br>
                <button type="button" class="btn-refresh mt-2" id="autoFillBtn" style="max-width:320px;padding:8px 16px;font-size:0.8rem;">
                    <i class="bi bi-magic"></i>
                    Auto-fill ${chainAmount} USDT
                </button>
            `;
        }
        return `
            <i class="bi bi-exclamation-triangle me-2"></i>
            ❌ <strong>Amount mismatch</strong>
            <br><small>You entered ${userAmount} USDT but blockchain amount is different.</small>
            <br><small>💡 Enter the exact amount from your wallet, including decimals.</small>
        `;
    }

    return `<i class="bi bi-exclamation-triangle me-2"></i> ❌ ${msg}`;
}

// ============================================================
// 🔥 AUTO-FILL BUTTON HANDLER
// ============================================================
document.addEventListener('click', function (e) {
    const btn = e.target.closest('#autoFillBtn');
    if (!btn) return;

    const match = btn.textContent.match(/([\d.]+)/);
    if (!match) return;

    const amountInput = document.getElementById('depositAmount');
    if (amountInput) {
        amountInput.value = match[1];
        showToast(`✅ Auto-filled ${match[1]} USDT. Click Verify again.`, 'success');
        btn.remove();
    }
});

// ============================================================
// 🔥 HANDLE DEPOSIT FORM SUBMIT
// ============================================================
function attachFormHandler(user) {
    const form = document.getElementById('depositForm');
    if (!form) return;

    form.addEventListener('submit', async function (e) {
        e.preventDefault();

        const amountInput = document.getElementById('depositAmount');
        const txHashInput = document.getElementById('txHash');
        const verifyBtn = document.getElementById('verifyBtn');

        const amount = parseFloat(amountInput.value);
        const txHash = txHashInput.value.trim();

        const minConfirmations = WALLET_CONFIG.MIN_CONFIRMATIONS || 3;
        const pollingInterval = (WALLET_CONFIG.POLLING_INTERVAL || 15000) / 1000;

        if (!amount || amount <= 0) {
            showToast('❌ Please enter a valid amount.', 'error');
            return;
        }

        if (!txHash || txHash.length < 10) {
            showToast('❌ Please enter a valid transaction hash.', 'error');
            return;
        }

        if (!txHash.startsWith('0x')) {
            showToast('❌ Transaction hash must start with 0x.', 'error');
            return;
        }

        if (verifyBtn.disabled) {
            showToast('⏳ Please wait, verification in progress...', 'info');
            return;
        }

        updateVerificationStatus(
            'pending',
            `<i class="bi bi-hourglass-split me-2"></i>
             🔒 Verifying on BSC blockchain...
             <span class="spinner-border spinner-border-sm ms-2" role="status"></span>
             <br><small>This may take a few moments...</small>`
        );

        verifyBtn.disabled = true;
        const originalBtnHTML = verifyBtn.innerHTML;
        verifyBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span>Verifying...';

        try {
            const result = await realCompleteDeposit(
                user.uid,
                txHash,
                amount,
                (confirmations, currentBlock, blockNumber) => {
                    updateVerificationStatus(
                        'polling',
                        `<span class="polling-indicator"></span>
                         ⏳ Waiting for confirmations... (${confirmations}/${minConfirmations})<br>
                         <small>Block: ${blockNumber || 'pending'} | Auto-checking every ${pollingInterval} seconds...</small>
                         <br><small>⚠️ Transaction must have ${minConfirmations} confirmations</small>`
                    );
                    showToast(`⏳ Waiting for confirmations... (${confirmations}/${minConfirmations})`, 'info');
                },
                (newBalance) => {
                    const creditedAmount = (result && result.amountCredited) ? result.amountCredited : amount;
                    updateVerificationStatus(
                        'success',
                        `<i class="bi bi-check-circle me-2"></i>
                         ✅ Deposit verified successfully on blockchain!
                         <br><small>Credited: $${Number(creditedAmount).toFixed(6)} USDT</small>
                         <br><small>New Balance: $${Number(newBalance).toFixed(2)}</small>
                         <br><small>🔒 Verified on BSC block: ${(result && result.receipt && result.receipt.blockNumber) || 'confirmed'}</small>`
                    );
                    showToast(`✅ Deposit of $${Number(creditedAmount).toFixed(4)} USDT verified! (Blockchain)`, 'success');
                    updateBalance(newBalance);

                    amountInput.value = '';
                    txHashInput.value = '';
                },
                (error) => {
                    const friendlyError = formatVerificationError(error, amount);
                    updateVerificationStatus('error', friendlyError);
                    showToast('❌ Verification failed. Check the details below.', 'error');
                }
            );

            if (result && result.error) {
                const friendlyError = formatVerificationError(result.error, amount);
                updateVerificationStatus('error', friendlyError);
                showToast('❌ Verification failed. Check the details below.', 'error');
            }
        } catch (error) {
            console.error('Deposit error:', error);
            const friendlyError = formatVerificationError(error.message, amount);
            updateVerificationStatus('error', friendlyError);
            showToast('❌ Error processing deposit. Please try again.', 'error');
        }

        verifyBtn.disabled = false;
        verifyBtn.innerHTML = originalBtnHTML;
    });
}

// ============================================================
// 🔥 MAIN AUTH FLOW
// ============================================================
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'login.html';
        return;
    }

    try {
        try {
            await realCleanupStaleLocks();
        } catch (err) {
            console.warn('cleanupStaleLocks warning:', err);
        }

        const userSnap = await get(ref(db, 'users/' + user.uid));
        if (!userSnap.exists()) {
            window.location.href = 'dashboard.html';
            return;
        }

        const userData = userSnap.val();

        const name = userData.name || 'User';
        const username = userData.username || userData.referralCode || 'USER';
        const sidebarName = document.getElementById('sidebarName');
        const sidebarUserId = document.getElementById('sidebarUserId');
        const sidebarAvatar = document.getElementById('sidebarAvatar');
        const referralBadge = document.getElementById('referralBadge');

        if (sidebarName) sidebarName.textContent = name;
        if (sidebarUserId) sidebarUserId.textContent = 'ID: ' + username.substring(0, 20) + (username.length > 20 ? '...' : '');
        if (sidebarAvatar) sidebarAvatar.textContent = name.charAt(0).toUpperCase();
        if (referralBadge) referralBadge.textContent = userData.totalReferrals || 0;

        const depositWallet = userData.depositWallet || 0;

        renderDepositUI(depositWallet);
        await resumePendingVerifications(user.uid);
        loadRecentDeposits(user.uid);
        listenToBalance(user.uid);
        attachFormHandler(user);

    } catch (error) {
        console.error('Error loading deposit page:', error);
        const container = document.getElementById('depositContent');
        if (container) {
            container.innerHTML = `
                <div class="empty-state" style="padding: 60px 20px;">
                    <i class="bi bi-exclamation-triangle" style="color:var(--red);opacity:0.8;"></i>
                    <h4 style="color:#fff;margin-bottom:8px;">Error Loading Page</h4>
                    <p style="color:var(--text-muted);margin-bottom:20px;">
                        ${error.message || 'Please check your internet connection.'}
                    </p>
                    <button class="btn-refresh" onclick="location.reload()" style="max-width:200px;margin:0 auto;">
                        <i class="bi bi-arrow-clockwise"></i>
                        Refresh Page
                    </button>
                </div>
            `;
        }
    }
});
