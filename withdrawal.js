// ============================================================
// RND STAKING — WITHDRAWAL PAGE LOGIC v9.0
// Security / reliability fixes:
//   • Server-fresh balance check before submit
//   • Transaction-based balance deduction
//   • Transaction/request idempotency
//   • Transaction-based activeWithdrawal lock (multi-tab safe)
//   • 30-minute lock expiry
//   • Lock/request cleanup on every known failure path
//   • Network/unknown state is NOT auto-failed
//   • Reconciliation repairs admin-missing requests when possible
//   • Withdrawal password with SHA-256 Web Crypto hashing
//   • Account-password re-auth for forgotten withdrawal password
//   • Saved BEP20 address + password-protected change
//   • 8 decimal max amount validation
//
// IMPORTANT:
// This browser code is NOT a replacement for Firebase Realtime Database
// Security Rules + trusted backend enforcement. The rules/backend MUST
// prevent users from writing their own balances or admin withdrawal records.
// See README.md in this package.
// ============================================================

import { initializeApp } from "firebase/app";
import {
    getAuth,
    onAuthStateChanged,
    signOut,
    EmailAuthProvider,
    reauthenticateWithCredential
} from "firebase/auth";
import {
    getDatabase,
    ref,
    get,
    set,
    update,
    push,
    runTransaction,
    remove
} from "firebase/database";

// ============================================================
// FIREBASE
// ============================================================
const firebaseConfig = {
    apiKey: "AIzaSyDsuqsmiwIG3Ey57MR19tr8_8wJQRQ3_W64",
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
// CONFIG
// ============================================================
const WITHDRAW_CONFIG = {
    referralWallet: { min: 20, currency: "USDT", label: "Referral Wallet" },
    rndWallet: { min: 5, currency: "RND", label: "RND Wallet" }
};

const BEP20_REGEX = /^0x[a-fA-F0-9]{40}$/;
const PASSWORD_MIN_LEN = 6;
const MAX_DECIMALS = 8;
const LOCK_MS = 30 * 60 * 1000;
const UNKNOWN_RECONCILE_MS = 24 * 60 * 60 * 1000;

// ============================================================
// GLOBAL STATE
// ============================================================
window.__currentUid = null;
window.currentSavedWithdrawalAddress = "";
window.addressChangeMode = false;
window.previousWithdrawalAddress = "";

// ============================================================
// HELPERS
// ============================================================
function roundTo8(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round((n + Number.EPSILON) * 1e8) / 1e8;
}

function generateRequestId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return "wd_req_" + Date.now() + "_" + Math.random().toString(36).slice(2, 12);
}

function generateWithdrawalId() {
    return "wd_" + Date.now() + "_" + Math.random().toString(36).slice(2, 12);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function showToast(message, type = "success", durationOverride = null) {
    const container = document.getElementById("toastContainer");
    if (!container) {
        console.log(`[${type}] ${message}`);
        return;
    }

    const toast = document.createElement("div");
    toast.className = `toast-custom ${type}`;

    const icons = {
        success: "bi-check-circle-fill",
        error: "bi-x-octagon-fill",
        info: "bi-info-circle-fill",
        warning: "bi-exclamation-triangle-fill"
    };

    const colors = {
        success: "#2ecc71",
        error: "#f87171",
        info: "#60a5fa",
        warning: "#fbbf24"
    };

    const icon = icons[type] || icons.info;
    const color = colors[type] || colors.info;

    toast.innerHTML = `
        <i class="bi ${icon}" style="color:${color};"></i>
        <span class="toast-msg">${escapeHtml(message)}</span>
    `;

    container.appendChild(toast);

    const duration =
        Number.isFinite(durationOverride) ? durationOverride :
        type === "error" ? 8000 :
        type === "warning" ? 7000 : 5000;

    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateX(100%)";
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

function isNetworkLikeError(err) {
    const code = String(err?.code || "").toLowerCase();
    const msg = String(err?.message || "").toLowerCase();

    return (
        code.includes("network") ||
        code.includes("unavailable") ||
        code.includes("disconnected") ||
        code.includes("timeout") ||
        msg.includes("network") ||
        msg.includes("offline") ||
        msg.includes("timeout") ||
        msg.includes("disconnected") ||
        msg.includes("unavailable")
    );
}

function validateAmount(raw, cfg) {
    const value = String(raw ?? "").trim();

    if (!value) return { ok: false, error: "Please enter an amount." };

    const decimalPart = value.includes(".") ? value.split(".")[1] : "";
    if (decimalPart.length > MAX_DECIMALS) {
        return { ok: false, error: `Maximum ${MAX_DECIMALS} decimal places are allowed.` };
    }

    const amount = Number(value);

    if (!Number.isFinite(amount) || amount <= 0) {
        return { ok: false, error: "Please enter a valid amount greater than 0." };
    }

    if (amount < cfg.min) {
        return {
            ok: false,
            error: `Minimum withdrawal for ${cfg.label} is ${cfg.min} ${cfg.currency} (BEP20).`
        };
    }

    return { ok: true, amount: roundTo8(amount) };
}

// ============================================================
// WITHDRAWAL PASSWORD — SHA-256
// ============================================================
async function hashWithdrawalPassword(uid, password) {
    const input = `rnd_withdraw_v9|${uid}|${password}|stake`;
    const bytes = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = [...new Uint8Array(digest)]
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
    return `wd_sha256_${hex}`;
}

async function getUserData(uid) {
    const snap = await get(ref(db, `users/${uid}`));
    return snap.exists() ? snap.val() : null;
}

async function getWithdrawalSettings(uid) {
    const fallback = {
        savedAddress: "",
        addressUpdatedAt: 0,
        passwordHash: "",
        passwordUpdatedAt: 0,
        passwordAttempts: { count: 0, lockUntil: 0 }
    };

    try {
        const snap = await get(ref(db, `users/${uid}/withdrawalSettings`));
        if (!snap.exists()) return fallback;
        return { ...fallback, ...(snap.val() || {}) };
    } catch (err) {
        console.error("Withdrawal settings read error:", err);
        return fallback;
    }
}

async function saveWithdrawalAddress(uid, address) {
    const clean = String(address || "").trim();

    if (!BEP20_REGEX.test(clean)) {
        throw new Error("Invalid BEP20 wallet address.");
    }

    await update(ref(db, `users/${uid}/withdrawalSettings`), {
        savedAddress: clean,
        addressUpdatedAt: Date.now()
    });
}

async function saveWithdrawalPasswordHash(uid, passwordHash) {
    await update(ref(db, `users/${uid}/withdrawalSettings`), {
        passwordHash,
        passwordUpdatedAt: Date.now(),
        passwordAttempts: null
    });
}

async function verifyWithdrawalPasswordFromDB(uid, password) {
    if (!password || String(password).length < PASSWORD_MIN_LEN) {
        return {
            ok: false,
            error: `Password must be at least ${PASSWORD_MIN_LEN} characters.`
        };
    }

    const attemptsRef = ref(db, `users/${uid}/withdrawalSettings/passwordAttempts`);
    const attemptsSnap = await get(attemptsRef);

    const attemptsData = attemptsSnap.exists()
        ? (attemptsSnap.val() || {})
        : { count: 0, lockUntil: 0 };

    const lockUntil = Number(attemptsData.lockUntil || 0);

    if (Date.now() < lockUntil) {
        const mins = Math.max(1, Math.ceil((lockUntil - Date.now()) / 60000));
        return {
            ok: false,
            error: `Too many incorrect attempts. Try again in about ${mins} minute(s).`
        };
    }

    const settings = await getWithdrawalSettings(uid);
    const storedHash = String(settings.passwordHash || "").trim();

    if (!storedHash) {
        return { ok: false, error: "NO_PASSWORD_SET" };
    }

    const inputHash = await hashWithdrawalPassword(uid, String(password));

    if (inputHash !== storedHash) {
        const nextCount = Number(attemptsData.count || 0) + 1;

        if (nextCount >= 5) {
            await set(attemptsRef, {
                count: 0,
                lockUntil: Date.now() + 10 * 60 * 1000
            });

            return {
                ok: false,
                error: "Too many incorrect attempts. Try again in 10 minutes."
            };
        }

        await set(attemptsRef, {
            count: nextCount,
            lockUntil: 0
        });

        return {
            ok: false,
            error: `Incorrect withdrawal password. ${5 - nextCount} attempt(s) remaining.`
        };
    }

    await remove(attemptsRef);
    return { ok: true };
}

// ============================================================
// ACCOUNT PASSWORD RE-AUTH
// ============================================================
async function verifyAccountPassword(user, password) {
    if (!user) throw new Error("Session expired. Please login again.");
    if (!user.email) throw new Error("Your account does not have an email address.");
    if (!password) throw new Error("Please enter your account password.");

    try {
        const credential = EmailAuthProvider.credential(user.email, password);
        await reauthenticateWithCredential(user, credential);
        return true;
    } catch (err) {
        console.error("Account re-auth failed:", err);

        if (
            err.code === "auth/wrong-password" ||
            err.code === "auth/invalid-credential" ||
            err.code === "auth/invalid-login-credentials"
        ) {
            throw new Error("Incorrect account password.");
        }

        if (err.code === "auth/too-many-requests") {
            throw new Error("Too many failed attempts. Please try again later.");
        }

        throw new Error("Account verification failed. Please try again.");
    }
}

// ============================================================
// PASSWORD EYE TOGGLES
// ============================================================
function attachPasswordEyeToggles() {
    const pairs = [
        ["withdrawPasswordInput", "toggleWdPwd1"],
        ["withdrawPasswordConfirm", "toggleWdPwd2"],
        ["fpAccountPassword", "toggleFpAcc"],
        ["fpNewPassword", "toggleFpNew"],
        ["fpConfirmPassword", "toggleFpConfirm"]
    ];

    pairs.forEach(([inputId, btnId]) => {
        const input = document.getElementById(inputId);
        const btn = document.getElementById(btnId);

        if (!input || !btn || btn.dataset.eyeBound === "1") return;

        btn.dataset.eyeBound = "1";

        btn.addEventListener("click", e => {
            e.preventDefault();

            const show = input.type === "password";
            input.type = show ? "text" : "password";

            const icon = btn.querySelector("i");
            if (icon) icon.className = show ? "bi bi-eye-slash" : "bi bi-eye";

            btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
            input.focus();
        });
    });
}

// ============================================================
// SIDEBAR
// ============================================================
function attachSidebar() {
    const panel = document.getElementById("sidebarPanel");
    const overlay = document.getElementById("sidebarOverlay");
    const toggle = document.getElementById("sidebarToggle");
    const close = document.getElementById("sidebarClose");
    const logout = document.getElementById("logoutBtnSidebar");

    const open = () => {
        if (!panel || !overlay) return;
        panel.classList.add("open");
        overlay.classList.add("active");
        document.body.style.overflow = "hidden";
    };

    const hide = () => {
        if (!panel || !overlay) return;
        panel.classList.remove("open");
        overlay.classList.remove("active");
        document.body.style.overflow = "";
    };

    toggle?.addEventListener("click", open);
    close?.addEventListener("click", hide);
    overlay?.addEventListener("click", hide);

    document.addEventListener("keydown", e => {
        if (e.key === "Escape") hide();
    });

    logout?.addEventListener("click", async e => {
        e.preventDefault();
        try {
            await signOut(auth);
        } catch (err) {
            console.error("Logout error:", err);
        }
        window.location.href = "login.html";
    });
}

// ============================================================
// HISTORY
// ============================================================
async function getWithdrawalHistory(uid) {
    const user = await getUserData(uid);
    if (!user) return [];

    const transactions = user.transactions || {};
    return Object.entries(transactions)
        .filter(([, tx]) => tx?.type === "withdrawal")
        .map(([id, tx]) => ({ id, ...tx }))
        .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
}

// ============================================================
// REQUEST SLOT
// ============================================================
async function reserveRequestSlot(uid, requestId, payload) {
    const slotRef = ref(db, `users/${uid}/withdrawalRequests/${requestId}`);

    try {
        const result = await runTransaction(slotRef, current => {
            if (current !== null) return;

            return {
                requestId,
                uid,
                walletType: payload.walletType,
                amount: payload.amount,
                currency: payload.currency,
                address: payload.address,
                status: "processing",
                createdAt: Date.now()
            };
        });

        return result.committed;
    } catch (err) {
        console.error("Reserve request slot error:", err);
        if (isNetworkLikeError(err)) throw err;
        return false;
    }
}

async function updateRequestSlot(uid, requestId, updates) {
    try {
        await update(ref(db, `users/${uid}/withdrawalRequests/${requestId}`), updates);
        return true;
    } catch (err) {
        console.warn("Request slot update failed:", err);
        return false;
    }
}

// ============================================================
// ACTIVE WITHDRAWAL LOCK
// Multi-tab safe: transaction decides who owns the lock.
// ============================================================
async function acquireWithdrawalLock(uid, requestId) {
    const lockRef = ref(db, `users/${uid}/activeWithdrawal`);

    try {
        const result = await runTransaction(lockRef, current => {
            if (current && current.requestId) {
                const createdAt = Number(current.createdAt || 0);

                // Existing active lock
                if (createdAt && Date.now() - createdAt < LOCK_MS) {
                    return;
                }
            }

            return {
                requestId,
                createdAt: Date.now()
            };
        });

        return {
            acquired: result.committed,
            current: result.snapshot.exists() ? result.snapshot.val() : null
        };
    } catch (err) {
        console.error("Acquire lock error:", err);
        throw err;
    }
}

async function releaseWithdrawalLock(uid, requestId = null) {
    const lockRef = ref(db, `users/${uid}/activeWithdrawal`);

    try {
        const result = await runTransaction(lockRef, current => {
            if (!current) return null;

            // If requestId is supplied, don't delete another request's lock.
            if (requestId && current.requestId && current.requestId !== requestId) {
                return;
            }

            return null;
        });

        return result.committed;
    } catch (err) {
        console.warn("Release lock failed:", err);
        return false;
    }
}

async function getActiveLock(uid) {
    const snap = await get(ref(db, `users/${uid}/activeWithdrawal`));
    return snap.exists() ? snap.val() : null;
}

// ============================================================
// ATOMIC USER BALANCE + USER TRANSACTION
// ============================================================
async function processAtomicWithdrawal(
    uid,
    walletType,
    amount,
    address,
    currency,
    withdrawalId,
    requestId
) {
    const userRef = ref(db, `users/${uid}`);
    const now = Date.now();

    try {
        const result = await runTransaction(userRef, currentData => {
            if (!currentData) return;

            const transactions = { ...(currentData.transactions || {}) };

            // Idempotency by requestId / withdrawalId
            for (const tx of Object.values(transactions)) {
                if (
                    tx?.type === "withdrawal" &&
                    (tx.requestId === requestId || tx.withdrawalId === withdrawalId)
                ) {
                    return;
                }
            }

            const balance = roundTo8(currentData[walletType] ?? 0);
            const amt = roundTo8(amount);

            if (!Number.isFinite(balance) || balance < 0) return;
            if (!Number.isFinite(amt) || amt <= 0) return;
            if (balance < amt) return;

            const newBalance = roundTo8(balance - amt);
            if (!Number.isFinite(newBalance) || newBalance < 0) return;

            const txId = `wd_${now}_${Math.random().toString(36).slice(2, 10)}`;

            transactions[txId] = {
                type: "withdrawal",
                withdrawalId,
                requestId,
                amount: amt,
                currency,
                walletType,
                walletAddress: address,
                timestamp: now,
                date: new Date(now).toDateString(),
                status: "pending",
                description: `Withdrawal of ${amt} ${currency} to ${address.slice(0, 15)}...`
            };

            return {
                ...currentData,
                [walletType]: newBalance,
                transactions
            };
        });

        if (!result.committed || !result.snapshot?.exists()) {
            return {
                success: false,
                error: "Insufficient balance, duplicate request, or transaction was not committed."
            };
        }

        const updated = result.snapshot.val();
        return {
            success: true,
            withdrawalId,
            newBalance: roundTo8(updated[walletType] || 0)
        };
    } catch (err) {
        console.error("Atomic withdrawal error:", err);
        return {
            success: false,
            networkUnknown: isNetworkLikeError(err),
            error: err.message || "Transaction failed."
        };
    }
}

// ============================================================
// ADMIN WITHDRAWAL RECORD
// ============================================================
async function createAdminWithdrawal(uid, requestId, withdrawalId, amount, currency, walletType, address) {
    const adminRef = push(ref(db, "withdrawals"));

    await set(adminRef, {
        uid,
        withdrawalId,
        requestId,
        amount,
        currency,
        walletType,
        wallet: address,
        status: "pending",
        timestamp: Date.now()
    });

    return adminRef.key;
}

// ============================================================
// RECONCILIATION
// Important: "admin_received" is terminal for client-side submission.
// If user transaction exists but admin record is missing, try to repair it.
// ============================================================
async function reconcilePendingRequests(uid) {
    const results = [];

    try {
        const reqSnap = await get(ref(db, `users/${uid}/withdrawalRequests`));
        if (!reqSnap.exists()) return results;

        const requests = reqSnap.val() || {};
        const userData = await getUserData(uid);
        if (!userData) return results;

        const transactions = userData.transactions || {};

        for (const [requestId, req] of Object.entries(requests)) {
            if (!req || !["processing", "unknown"].includes(req.status)) continue;

            const matching = Object.entries(transactions).find(([, tx]) =>
                tx?.type === "withdrawal" &&
                tx?.requestId === requestId
            );

            if (matching) {
                const tx = matching[1];

                if (req.adminWithdrawalKey) {
                    await updateRequestSlot(uid, requestId, {
                        status: "admin_received",
                        withdrawalId: tx.withdrawalId,
                        adminReceivedAt: req.adminReceivedAt || Date.now(),
                        completedAt: req.completedAt || Date.now()
                    });

                    await releaseWithdrawalLock(uid, requestId);
                    results.push({ requestId, status: "admin_received" });
                    continue;
                }

                // Try to restore missing admin record.
                try {
                    const adminKey = await createAdminWithdrawal(
                        uid,
                        requestId,
                        tx.withdrawalId,
                        tx.amount,
                        tx.currency,
                        tx.walletType,
                        tx.walletAddress
                    );

                    await updateRequestSlot(uid, requestId, {
                        status: "admin_received",
                        withdrawalId: tx.withdrawalId,
                        adminWithdrawalKey: adminKey,
                        adminReceivedAt: Date.now(),
                        completedAt: Date.now()
                    });

                    await releaseWithdrawalLock(uid, requestId);

                    results.push({
                        requestId,
                        status: "admin_received_repaired"
                    });
                } catch (repairErr) {
                    console.warn("Admin repair pending:", repairErr);
                    results.push({
                        requestId,
                        status: "transaction_found_admin_repair_pending"
                    });
                }

                continue;
            }

            // No user transaction exists.
            // Do NOT immediately fail a fresh processing request because
            // a network failure may have happened between writes.
            const createdAt = Number(req.createdAt || 0);
            const age = Date.now() - createdAt;

            if (createdAt && age > UNKNOWN_RECONCILE_MS) {
                await updateRequestSlot(uid, requestId, {
                    status: "failed",
                    failedAt: Date.now(),
                    reason: "Expired processing request with no balance transaction"
                });

                await releaseWithdrawalLock(uid, requestId);
                results.push({ requestId, status: "failed_expired" });
            }
        }

        // Expired global lock cleanup, only if it still belongs to an old request.
        const lock = await getActiveLock(uid);
        if (lock?.createdAt && Date.now() - Number(lock.createdAt) >= LOCK_MS) {
            await releaseWithdrawalLock(uid, lock.requestId || null);
        }

        return results;
    } catch (err) {
        console.warn("Reconciliation error:", err);
        return results;
    }
}

// ============================================================
// RENDER UI
// ============================================================
function renderWithdrawalUI(userData, withdrawals) {
    const container = document.getElementById("withdrawalContent");
    if (!container) return;

    const depositWallet = Number(userData.depositWallet) || 0;
    const referralWallet = Number(userData.referralWallet) || 0;
    const rndWallet = Number(userData.rndWallet) || 0;
    const lockedRND = Number(userData.lockedRND) || 0;

    let historyHtml = "";

    if (!withdrawals.length) {
        historyHtml = `
            <div class="empty-state">
                <i class="bi bi-inbox"></i>
                <p>No withdrawal requests yet.</p>
            </div>
        `;
    } else {
        historyHtml = `
            <div class="withdrawal-history">
                ${withdrawals.map(w => {
                    let statusHtml = `
                        <span class="status-pending">
                            <i class="bi bi-clock"></i> Pending
                        </span>
                    `;

                    if (w.status === "approved") {
                        statusHtml = `
                            <span class="status-approved">
                                <i class="bi bi-check-circle-fill"></i> Approved
                            </span>
                        `;
                    } else if (w.status === "rejected") {
                        statusHtml = `
                            <span class="status-rejected">
                                <i class="bi bi-x-circle-fill"></i> Rejected
                            </span>
                        `;
                    } else if (w.status === "admin_received") {
                        statusHtml = `
                            <span class="status-approved">
                                <i class="bi bi-check-circle-fill"></i> Received
                            </span>
                        `;
                    }

                    const currency = w.currency || "RND";
                    const walletLabel =
                        w.walletType === "referralWallet"
                            ? "💳 Referral Wallet"
                            : "📊 RND Wallet";

                    const dateStr = w.timestamp
                        ? new Date(w.timestamp).toLocaleString("en-IN")
                        : "N/A";

                    const address = w.walletAddress || "";

                    return `
                        <div class="transaction-item">
                            <div>
                                <div class="amount">
                                    ${Number(w.amount || 0).toFixed(4)} ${escapeHtml(currency)}
                                </div>
                                <div style="font-size:.72rem;color:var(--text-secondary);margin-top:2px;">
                                    ${walletLabel}
                                </div>
                                <div class="date">${escapeHtml(dateStr)}</div>
                                ${
                                    address
                                        ? `<div style="font-size:.62rem;color:var(--text-muted);font-family:'Courier New',monospace;margin-top:2px;">
                                            ${escapeHtml(address.slice(0, 24))}...
                                           </div>`
                                        : ""
                                }
                            </div>
                            <div>${statusHtml}</div>
                        </div>
                    `;
                }).join("")}
            </div>
        `;
    }

    container.innerHTML = `
        <div class="row g-4">
            <div class="col-12">
                <div class="page-header-section">
                    <h4><i class="bi bi-arrow-up-circle"></i> Withdraw Funds</h4>
                    <span class="badge-mini-pill pill-green">
                        <i class="bi bi-shield-check"></i> Secure Withdrawal
                    </span>
                </div>
            </div>

            <div class="col-12">
                <div class="row g-3">
                    <div class="col-6 col-lg-3">
                        <div class="wallet-card-new deposit">
                            <div class="wallet-card-header">
                                <span class="wallet-card-label">Deposit Wallet</span>
                                <div class="wallet-card-icon"><i class="bi bi-wallet2"></i></div>
                            </div>
                            <div class="wallet-card-value">
                                $${depositWallet.toFixed(2)}
                                <span class="wallet-card-currency">USDT</span>
                            </div>
                            <div class="wallet-card-footer">
                                <i class="bi bi-lock-fill"></i>
                                <span class="badge-mini-pill pill-red">🔒 Not for Withdrawal</span>
                            </div>
                        </div>
                    </div>

                    <div class="col-6 col-lg-3">
                        <div class="wallet-card-new referral">
                            <div class="wallet-card-header">
                                <span class="wallet-card-label">Referral Wallet</span>
                                <div class="wallet-card-icon"><i class="bi bi-people-fill"></i></div>
                            </div>
                            <div class="wallet-card-value">
                                ${referralWallet.toFixed(2)}
                                <span class="wallet-card-currency">USDT</span>
                            </div>
                            <div class="wallet-card-footer">
                                <i class="bi bi-check-circle-fill"></i>
                                <span class="badge-mini-pill pill-green">✅ Min: 20 USDT</span>
                            </div>
                        </div>
                    </div>

                    <div class="col-6 col-lg-3">
                        <div class="wallet-card-new rnd">
                            <div class="wallet-card-header">
                                <span class="wallet-card-label">RND Wallet</span>
                                <div class="wallet-card-icon"><i class="bi bi-database"></i></div>
                            </div>
                            <div class="wallet-card-value">
                                ${rndWallet.toFixed(4)}
                                <span class="wallet-card-currency">RND</span>
                            </div>
                            <div class="wallet-card-footer">
                                <i class="bi bi-check-circle-fill"></i>
                                <span class="badge-mini-pill pill-green">✅ Min: 5 RND</span>
                            </div>
                        </div>
                    </div>

                    <div class="col-6 col-lg-3">
                        <div class="wallet-card-new locked">
                            <div class="wallet-card-header">
                                <span class="wallet-card-label">Locked RND</span>
                                <div class="wallet-card-icon"><i class="bi bi-lock"></i></div>
                            </div>
                            <div class="wallet-card-value">
                                ${lockedRND.toFixed(2)}
                                <span class="wallet-card-currency">RND</span>
                            </div>
                            <div class="wallet-card-footer">
                                <i class="bi bi-lock-fill"></i>
                                <span class="badge-mini-pill pill-red">🔒 Locked</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="col-lg-7 mx-auto">
                <div class="card-glass">
                    <div class="card-title">
                        <i class="bi bi-arrow-up-circle"></i> Request Withdrawal
                    </div>

                    <div class="info-alert">
                        <i class="bi bi-info-circle"></i>
                        <strong>Withdrawal Limits:</strong>
                        <br>💳 <strong>Referral Wallet:</strong> Min <strong>20 USDT</strong> (BEP20)
                        <br>📊 <strong>RND Wallet:</strong> Min <strong>5 RND</strong> (BEP20)
                        <br>🔒 Deposit & Locked wallets cannot be withdrawn.
                    </div>

                    <div class="row g-2 mb-3">
                        <div class="col-6">
                            <div class="withdraw-option-card selected"
                                 id="optionReferral"
                                 data-wallet="referralWallet">
                                <div class="option-icon">💳</div>
                                <div class="option-label">Referral Wallet</div>
                                <div class="option-balance">${referralWallet.toFixed(2)} USDT</div>
                                <div class="min-label referral-min">Min: 20 USDT (BEP20)</div>
                            </div>
                        </div>

                        <div class="col-6">
                            <div class="withdraw-option-card"
                                 id="optionRND"
                                 data-wallet="rndWallet">
                                <div class="option-icon">📊</div>
                                <div class="option-label">RND Wallet</div>
                                <div class="option-balance">${rndWallet.toFixed(4)} RND</div>
                                <div class="min-label rnd-min">Min: 5 RND (BEP20)</div>
                            </div>
                        </div>
                    </div>

                    <form id="withdrawForm" autocomplete="off">
                        <div class="mb-3">
                            <label class="form-label" for="selectedWalletDisplay">
                                Selected Wallet <span class="required">*</span>
                            </label>
                            <input type="text"
                                   id="selectedWalletDisplay"
                                   class="form-control form-control-custom"
                                   value="Referral Wallet (USDT - BEP20)"
                                   readonly>
                            <input type="hidden" id="selectedWallet" value="referralWallet">
                        </div>

                        <div class="mb-3">
                            <label class="form-label" for="withAmount">
                                Amount <span class="required">*</span>
                            </label>
                            <input type="number"
                                   id="withAmount"
                                   class="form-control form-control-custom"
                                   placeholder="Enter amount"
                                   min="0.00000001"
                                   step="any"
                                   inputmode="decimal"
                                   required>
                            <small class="form-hint" id="minAmountHint">
                                Minimum: 20 USDT (BEP20) for Referral Wallet
                            </small>
                        </div>

                        <div class="mb-3">
                            <label class="form-label">
                                Wallet Address (BEP20) <span class="required">*</span>
                            </label>

                            <div id="savedAddressBox"></div>

                            <div id="addressInputBox" style="display:none;">
                                <input type="text"
                                       id="withAddr"
                                       class="form-control form-control-custom"
                                       placeholder="0x..."
                                       autocomplete="off"
                                       spellcheck="false">

                                <small class="form-hint">
                                    Enter your BEP20 wallet address (0x + 40 hexadecimal characters)
                                </small>

                                <div id="saveAddressOption"
                                     style="display:none;margin-top:10px;padding:10px 12px;
                                            border-radius:10px;background:rgba(96,165,250,.06);
                                            border:1px solid rgba(96,165,250,.18);">
                                    <label style="display:flex;align-items:flex-start;gap:9px;
                                                  cursor:pointer;font-size:.82rem;margin:0;">
                                        <input type="checkbox"
                                               id="saveWithdrawalAddress"
                                               style="margin-top:3px;">
                                        <span>
                                            <strong style="color:var(--text-primary);">
                                                Save this wallet address
                                            </strong>
                                            <br>
                                            <small style="color:var(--text-secondary);">
                                                You won't need to enter it again next time.
                                            </small>
                                        </span>
                                    </label>
                                </div>
                            </div>
                        </div>

                        <button type="submit"
                                class="btn-primary-custom"
                                id="withdrawBtn">
                            <i class="bi bi-arrow-up-circle"></i>
                            <span>Submit Withdrawal</span>
                        </button>
                    </form>

                    <div class="mt-3">
                        <a href="dashboard.html" class="btn-outline-custom">
                            <i class="bi bi-arrow-left"></i> Back to Dashboard
                        </a>
                    </div>
                </div>
            </div>

            <div class="col-lg-7 mx-auto">
                <div class="card-glass">
                    <div class="card-title">
                        <i class="bi bi-clock-history"></i> Withdrawal History
                    </div>
                    ${historyHtml}
                </div>
            </div>
        </div>
    `;
}

// ============================================================
// WALLET OPTION SWITCHER
// ============================================================
function attachOptionHandlers() {
    const referral = document.getElementById("optionReferral");
    const rnd = document.getElementById("optionRND");
    const display = document.getElementById("selectedWalletDisplay");
    const selected = document.getElementById("selectedWallet");
    const hint = document.getElementById("minAmountHint");

    function select(walletType) {
        document.querySelectorAll(".withdraw-option-card")
            .forEach(el => el.classList.remove("selected"));

        if (walletType === "referralWallet") {
            referral?.classList.add("selected");
            if (display) display.value = "Referral Wallet (USDT - BEP20)";
            if (selected) selected.value = "referralWallet";
            if (hint) hint.textContent = "Minimum: 20 USDT (BEP20) for Referral Wallet";
        } else {
            rnd?.classList.add("selected");
            if (display) display.value = "RND Wallet (RND - BEP20)";
            if (selected) selected.value = "rndWallet";
            if (hint) hint.textContent = "Minimum: 5 RND (BEP20) for RND Wallet";
        }
    }

    referral?.addEventListener("click", () => select("referralWallet"));
    rnd?.addEventListener("click", () => select("rndWallet"));
}

// ============================================================
// PASSWORD MODAL
// ============================================================
function openWithdrawPasswordModal(uid, { mode, onSuccess }) {
    const modalEl = document.getElementById("withdrawPasswordModal");

    if (!modalEl) {
        showToast("Password UI unavailable.", "error");
        return;
    }

    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);

    const title = document.getElementById("wdPwdModalTitle");
    const info = document.getElementById("wdPwdInfo");
    const input = document.getElementById("withdrawPasswordInput");
    const confirmWrap = document.getElementById("wdPwdConfirmWrap");
    const confirm = document.getElementById("withdrawPasswordConfirm");
    const error = document.getElementById("withdrawPasswordError");
    const button = document.getElementById("confirmWithdrawPasswordBtn");
    const buttonText = document.getElementById("wdPwdBtnText");
    const forgot = document.getElementById("forgotWithdrawPasswordBtn");

    if (!input || !confirm || !error || !button) {
        showToast("Password form is incomplete.", "error");
        return;
    }

    input.value = "";
    confirm.value = "";
    error.textContent = "";
    error.style.display = "none";

    input.type = "password";
    confirm.type = "password";

    document.querySelectorAll("#withdrawPasswordModal .pwd-eye-btn i")
        .forEach(i => i.className = "bi bi-eye");

    if (mode === "set") {
        if (title) title.innerHTML =
            `<i class="bi bi-shield-lock-fill" style="color:var(--primary);"></i> Set Withdrawal Password`;

        if (info) info.innerHTML =
            `Set a <strong style="color:#2ecc71;">strong withdrawal password</strong> ` +
            `(min ${PASSWORD_MIN_LEN} characters). You will need it for withdrawals and address changes.`;

        if (buttonText) buttonText.textContent = "Set Password";
        if (forgot) forgot.style.display = "none";
        if (confirmWrap) confirmWrap.style.display = "block";
    } else {
        if (title) title.innerHTML =
            `<i class="bi bi-shield-lock-fill" style="color:var(--primary);"></i> Withdrawal Password`;

        if (info) info.innerHTML =
            `Enter your <strong style="color:#2ecc71;">withdrawal password</strong> to continue.`;

        if (buttonText) buttonText.textContent = "Verify";
        if (forgot) forgot.style.display = "inline-block";
        if (confirmWrap) confirmWrap.style.display = "none";
    }

    button.onclick = async () => {
        const pwd = String(input.value || "");
        const confirmPwd = String(confirm.value || "");

        if (pwd.length < PASSWORD_MIN_LEN) {
            error.textContent = `Password must be at least ${PASSWORD_MIN_LEN} characters.`;
            error.style.display = "block";
            return;
        }

        if (mode === "set" && pwd !== confirmPwd) {
            error.textContent = "Password and confirm password do not match.";
            error.style.display = "block";
            return;
        }

        button.disabled = true;
        const original = button.innerHTML;
        button.innerHTML =
            `<span class="spinner-border spinner-border-sm me-2"></span>Please wait...`;
        error.style.display = "none";

        try {
            if (mode === "set") {
                const hash = await hashWithdrawalPassword(uid, pwd);
                await saveWithdrawalPasswordHash(uid, hash);

                showToast(
                    'Withdrawal password set successfully. Click "Submit Withdrawal" again to continue.',
                    "success",
                    7000
                );

                modal.hide();
                return;
            }

            const result = await verifyWithdrawalPasswordFromDB(uid, pwd);

            if (!result.ok) {
                if (result.error === "NO_PASSWORD_SET") {
                    error.textContent = "No withdrawal password set yet. Please set one now.";
                    error.style.display = "block";

                    setTimeout(() => {
                        modal.hide();
                        openWithdrawPasswordModal(uid, {
                            mode: "set",
                            onSuccess
                        });
                    }, 700);
                    return;
                }

                error.textContent = result.error || "Incorrect password.";
                error.style.display = "block";
                return;
            }

            modal.hide();
            await onSuccess?.();

        } catch (err) {
            console.error("Withdrawal password error:", err);
            error.textContent = err.message || "Something went wrong. Please try again.";
            error.style.display = "block";
        } finally {
            button.disabled = false;
            button.innerHTML = original;
        }
    };

    if (forgot) {
        forgot.onclick = () => {
            modal.hide();
            setTimeout(() => openForgotPasswordModal(uid, onSuccess), 300);
        };
    }

    modal.show();
    setTimeout(() => input.focus(), 300);
}

// ============================================================
// FORGOT WITHDRAWAL PASSWORD
// ============================================================
function openForgotPasswordModal(uid, onSuccess) {
    const modalEl = document.getElementById("forgotPasswordModal");

    if (!modalEl) {
        showToast("Forgot-password UI unavailable.", "error");
        return;
    }

    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    const accountInput = document.getElementById("fpAccountPassword");
    const newInput = document.getElementById("fpNewPassword");
    const confirmInput = document.getElementById("fpConfirmPassword");
    const error = document.getElementById("fpError");
    const button = document.getElementById("confirmForgotPasswordBtn");

    if (!accountInput || !newInput || !confirmInput || !error || !button) {
        showToast("Forgot-password form is incomplete.", "error");
        return;
    }

    accountInput.value = "";
    newInput.value = "";
    confirmInput.value = "";
    error.textContent = "";
    error.style.display = "none";

    [accountInput, newInput, confirmInput].forEach(el => el.type = "password");

    document.querySelectorAll("#forgotPasswordModal .pwd-eye-btn i")
        .forEach(i => i.className = "bi bi-eye");

    button.onclick = async () => {
        const accountPwd = String(accountInput.value || "");
        const newPwd = String(newInput.value || "");
        const confirmPwd = String(confirmInput.value || "");

        if (!accountPwd) {
            error.textContent = "Please enter your account password.";
            error.style.display = "block";
            return;
        }

        if (newPwd.length < PASSWORD_MIN_LEN) {
            error.textContent =
                `New withdrawal password must be at least ${PASSWORD_MIN_LEN} characters.`;
            error.style.display = "block";
            return;
        }

        if (newPwd !== confirmPwd) {
            error.textContent = "New password and confirm password do not match.";
            error.style.display = "block";
            return;
        }

        if (newPwd === accountPwd) {
            error.textContent =
                "Withdrawal password should be different from your account password.";
            error.style.display = "block";
            return;
        }

        button.disabled = true;
        const original = button.innerHTML;
        button.innerHTML =
            `<span class="spinner-border spinner-border-sm me-2"></span>Please wait...`;
        error.style.display = "none";

        try {
            await verifyAccountPassword(auth.currentUser, accountPwd);

            const hash = await hashWithdrawalPassword(uid, newPwd);
            await saveWithdrawalPasswordHash(uid, hash);

            showToast("Withdrawal password reset successfully.", "success");
            modal.hide();

            setTimeout(() => onSuccess?.(), 400);
        } catch (err) {
            console.error("Forgot password error:", err);
            error.textContent = err.message || "Something went wrong. Please try again.";
            error.style.display = "block";
        } finally {
            button.disabled = false;
            button.innerHTML = original;
        }
    };

    modal.show();
    setTimeout(() => accountInput.focus(), 300);
}

// ============================================================
// SAVED ADDRESS UI
// ============================================================
async function initializeWithdrawalAddressUI(uid) {
    window.__currentUid = uid;

    const savedBox = document.getElementById("savedAddressBox");
    const inputBox = document.getElementById("addressInputBox");

    if (!savedBox || !inputBox) return;

    const settings = await getWithdrawalSettings(uid);
    const savedAddress = String(settings.savedAddress || "").trim();

    window.addressChangeMode = false;

    document.getElementById("changeAddressActionRow")?.remove();

    if (!savedAddress) {
        savedBox.style.display = "block";
        savedBox.innerHTML = `
            <div style="border:1px dashed rgba(96,165,250,.35);
                        background:rgba(96,165,250,.04);
                        border-radius:12px;padding:14px;">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
                    <i class="bi bi-wallet2" style="font-size:1.2rem;color:#60a5fa;"></i>
                    <strong style="color:#fff;font-size:.88rem;">
                        Add your BEP20 wallet address
                    </strong>
                </div>
                <div style="font-size:.78rem;color:var(--text-secondary);margin-bottom:12px;">
                    You can save this address for future withdrawals.
                </div>
                <button type="button"
                        class="btn-outline-custom"
                        id="enterAddressBtn"
                        style="width:auto;padding:10px 18px;font-size:.82rem;">
                    <i class="bi bi-plus-circle"></i> Add Wallet Address
                </button>
            </div>
        `;

        inputBox.style.display = "none";
        window.currentSavedWithdrawalAddress = "";

        document.getElementById("enterAddressBtn")?.addEventListener("click", () => {
            inputBox.style.display = "block";
            savedBox.style.display = "none";

            const saveOpt = document.getElementById("saveAddressOption");
            if (saveOpt) saveOpt.style.display = "block";

            document.getElementById("withAddr")?.focus();
        });

        return;
    }

    const shortAddress = `${savedAddress.slice(0, 10)}...${savedAddress.slice(-8)}`;

    savedBox.style.display = "block";
    savedBox.innerHTML = `
        <div style="border:1px solid rgba(46,204,113,.30);
                    background:rgba(46,204,113,.06);
                    border-radius:12px;padding:14px;">
            <div style="display:flex;justify-content:space-between;
                        align-items:center;gap:10px;flex-wrap:wrap;">
                <div style="min-width:0;flex:1;">
                    <div style="color:#2ecc71;font-size:.78rem;
                                font-weight:700;margin-bottom:5px;">
                        <i class="bi bi-shield-check"></i> SAVED BEP20 ADDRESS
                    </div>
                    <div style="font-family:'Courier New',monospace;
                                font-size:.82rem;color:#e2e8f0;
                                word-break:break-all;"
                         title="${escapeHtml(savedAddress)}">
                        ${escapeHtml(shortAddress)}
                    </div>
                </div>

                <button type="button"
                        class="btn-outline-custom"
                        id="changeAddressBtn"
                        style="width:auto;padding:8px 14px;font-size:.78rem;white-space:nowrap;">
                    <i class="bi bi-pencil"></i> Change
                </button>
            </div>
        </div>
    `;

    inputBox.style.display = "none";
    window.currentSavedWithdrawalAddress = savedAddress;

    document.getElementById("changeAddressBtn")?.addEventListener("click", async () => {
        const current = await getWithdrawalSettings(uid);
        const hasPassword = !!String(current.passwordHash || "").trim();

        if (!hasPassword) {
            showToast("Please set a withdrawal password first.", "warning");

            openWithdrawPasswordModal(uid, {
                mode: "set",
                onSuccess: () => showChangeAddressUI(savedAddress)
            });

            return;
        }

        openWithdrawPasswordModal(uid, {
            mode: "verify",
            onSuccess: () => showChangeAddressUI(savedAddress)
        });
    });
}

function showChangeAddressUI(oldAddress) {
    const savedBox = document.getElementById("savedAddressBox");
    const inputBox = document.getElementById("addressInputBox");
    const input = document.getElementById("withAddr");
    const saveOpt = document.getElementById("saveAddressOption");

    if (!savedBox || !inputBox || !input) return;

    savedBox.style.display = "block";
    savedBox.innerHTML = `
        <div style="border:1px solid rgba(251,191,36,.30);
                    background:rgba(251,191,36,.06);
                    border-radius:12px;padding:14px;">
            <div style="color:#fbbf24;font-weight:700;font-size:.85rem;margin-bottom:6px;">
                <i class="bi bi-exclamation-triangle"></i> Change Wallet Address
            </div>
            <div style="font-size:.78rem;color:var(--text-secondary);">
                Enter your new BEP20 address below and click <strong>Save Address</strong>.
            </div>
        </div>
    `;

    inputBox.style.display = "block";
    input.value = "";
    input.focus();

    if (saveOpt) saveOpt.style.display = "none";

    let actionRow = document.getElementById("changeAddressActionRow");

    if (!actionRow) {
        actionRow = document.createElement("div");
        actionRow.id = "changeAddressActionRow";
        actionRow.style.cssText =
            "display:flex;gap:8px;margin-top:10px;";

        actionRow.innerHTML = `
            <button type="button"
                    class="btn-primary-custom"
                    id="saveNewAddressBtn"
                    style="flex:1;padding:10px 16px;font-size:.85rem;">
                <i class="bi bi-check-circle"></i> Save Address
            </button>

            <button type="button"
                    class="btn-outline-custom"
                    id="cancelChangeAddressBtn"
                    style="flex:1;padding:10px 16px;font-size:.85rem;">
                <i class="bi bi-x-circle"></i> Cancel
            </button>
        `;

        inputBox.appendChild(actionRow);
    }

    actionRow.style.display = "flex";

    document.getElementById("cancelChangeAddressBtn").onclick = async () => {
        actionRow.style.display = "none";
        input.value = "";
        window.addressChangeMode = false;
        await initializeWithdrawalAddressUI(window.__currentUid);
    };

    document.getElementById("saveNewAddressBtn").onclick = async () => {
        const newAddress = input.value.trim();

        if (!BEP20_REGEX.test(newAddress)) {
            showToast(
                "Please enter a valid BEP20 wallet address (0x + 40 hex characters).",
                "error"
            );
            return;
        }

        if (newAddress.toLowerCase() === String(oldAddress).toLowerCase()) {
            showToast("This is already your saved address.", "warning");
            return;
        }

        const btn = document.getElementById("saveNewAddressBtn");
        const original = btn.innerHTML;

        btn.disabled = true;
        btn.innerHTML =
            `<span class="spinner-border spinner-border-sm me-2"></span>Saving...`;

        try {
            const uid = window.__currentUid;
            if (!uid) throw new Error("Session issue. Please refresh the page.");

            await saveWithdrawalAddress(uid, newAddress);

            window.currentSavedWithdrawalAddress = newAddress;
            window.addressChangeMode = false;

            showToast("Wallet address updated successfully.", "success");

            actionRow.style.display = "none";
            await initializeWithdrawalAddressUI(uid);
        } catch (err) {
            console.error("Save address error:", err);
            showToast(err.message || "Could not save address.", "error");
        } finally {
            btn.disabled = false;
            btn.innerHTML = original;
        }
    };

    window.addressChangeMode = true;
    window.previousWithdrawalAddress = oldAddress;
}

// ============================================================
// MAIN WITHDRAW HANDLER
// ============================================================
function attachWithdrawHandler(user) {
    const form = document.getElementById("withdrawForm");
    if (!form) return;

    let isSubmitting = false;

    form.addEventListener("submit", async e => {
        e.preventDefault();

        if (isSubmitting) {
            showToast("Your request is already being processed. Please wait.", "warning");
            return;
        }

        const walletType = document.getElementById("selectedWallet")?.value;
        const amountRaw = document.getElementById("withAmount")?.value;
        const btn = document.getElementById("withdrawBtn");
        const cfg = WITHDRAW_CONFIG[walletType];

        if (!cfg) {
            showToast("Invalid wallet selected.", "error");
            return;
        }

        const amountResult = validateAmount(amountRaw, cfg);

        if (!amountResult.ok) {
            showToast(amountResult.error, "error");
            return;
        }

        const amount = amountResult.amount;

        let address = "";
        const savedAddress = String(window.currentSavedWithdrawalAddress || "").trim();

        if (savedAddress && !window.addressChangeMode) {
            address = savedAddress;
        } else {
            address = String(document.getElementById("withAddr")?.value || "").trim();
        }

        if (!BEP20_REGEX.test(address)) {
            showToast("Please enter a valid BEP20 wallet address.", "error");
            return;
        }

        // Fresh balance before opening password modal.
        let freshUser;

        try {
            freshUser = await getUserData(user.uid);
        } catch (err) {
            console.error("Fresh user read failed:", err);
            showToast("Unable to verify your balance. Please try again.", "error");
            return;
        }

        if (!freshUser) {
            showToast("Unable to verify your account. Please login again.", "error");
            return;
        }

        // Check existing lock.
        const existingLock = freshUser.activeWithdrawal;

        if (existingLock?.requestId) {
            const createdAt = Number(existingLock.createdAt || 0);

            if (createdAt && Date.now() - createdAt < LOCK_MS) {
                showToast("Another withdrawal is already processing. Please wait.", "warning");
                return;
            }

            // Expired lock is cleaned transactionally.
            await releaseWithdrawalLock(user.uid, existingLock.requestId);
        }

        const freshBalance = Number(freshUser[walletType]);

        if (!Number.isFinite(freshBalance) || freshBalance < 0) {
            showToast("Unable to verify your balance. Please try again.", "error");
            return;
        }

        if (freshBalance < amount) {
            showToast(
                `Insufficient balance. You have ${freshBalance.toFixed(8)} ${cfg.currency}.`,
                "error"
            );
            return;
        }

        isSubmitting = true;

        if (btn) {
            btn.disabled = true;
            btn.innerHTML =
                `<span class="spinner-border spinner-border-sm me-2"></span>Processing...`;
        }

        const settings = await getWithdrawalSettings(user.uid);
        const hasPassword = !!String(settings.passwordHash || "").trim();

        // The password modal does not reserve/lock funds.
        // If user cancels, nothing has changed in the database.
        openWithdrawPasswordModal(user.uid, {
            mode: hasPassword ? "verify" : "set",

            onSuccess: async () => {
                let requestId = null;
                let requestReserved = false;
                let lockAcquired = false;
                let terminal = false;
                let unknown = false;

                try {
                    requestId = generateRequestId();
                    const withdrawalId = generateWithdrawalId();

                    // 1) Reserve idempotency slot.
                    requestReserved = await reserveRequestSlot(
                        user.uid,
                        requestId,
                        {
                            walletType,
                            amount,
                            currency: cfg.currency,
                            address
                        }
                    );

                    if (!requestReserved) {
                        showToast(
                            "This request could not be reserved because another request is processing.",
                            "warning"
                        );
                        return;
                    }

                    // 2) Acquire multi-tab lock AFTER reservation.
                    const lockResult = await acquireWithdrawalLock(user.uid, requestId);

                    if (!lockResult.acquired) {
                        await updateRequestSlot(user.uid, requestId, {
                            status: "failed",
                            failedAt: Date.now(),
                            reason: "Another withdrawal is already active"
                        });

                        await remove(
                            ref(db, `users/${user.uid}/withdrawalRequests/${requestId}`)
                        );

                        showToast(
                            "Another withdrawal is already processing. Please wait.",
                            "warning"
                        );
                        return;
                    }

                    lockAcquired = true;

                    // 3) Atomic user balance deduction + user transaction.
                    const atomic = await processAtomicWithdrawal(
                        user.uid,
                        walletType,
                        amount,
                        address,
                        cfg.currency,
                        withdrawalId,
                        requestId
                    );

                    if (!atomic.success) {
                        if (atomic.networkUnknown) {
                            unknown = true;
                            showToast(
                                "Network issue: the withdrawal state is unknown. Do NOT submit again. Refresh the page and wait for reconciliation.",
                                "warning",
                                10000
                            );
                            return;
                        }

                        await updateRequestSlot(user.uid, requestId, {
                            status: "failed",
                            failedAt: Date.now(),
                            reason: atomic.error || "Atomic transaction failed"
                        });

                        showToast(
                            atomic.error || "Withdrawal failed. Please try again.",
                            "error"
                        );

                        terminal = true;
                        return;
                    }

                    // 4) Save admin queue record.
                    // If this fails, DO NOT pretend success and DO NOT refund automatically.
                    // Reconciliation will attempt to repair the admin record.
                    let adminKey;

                    try {
                        adminKey = await createAdminWithdrawal(
                            user.uid,
                            requestId,
                            withdrawalId,
                            amount,
                            cfg.currency,
                            walletType,
                            address
                        );
                    } catch (adminErr) {
                        console.error("Admin withdrawal write failed:", adminErr);

                        await updateRequestSlot(user.uid, requestId, {
                            status: "unknown",
                            withdrawalId,
                            adminWriteState: "pending",
                            adminWriteError: String(adminErr?.message || adminErr),
                            updatedAt: Date.now()
                        });

                        unknown = true;

                        showToast(
                            "Withdrawal amount was reserved, but admin confirmation is still pending. Do NOT submit again. The system will reconcile it.",
                            "warning",
                            10000
                        );

                        return;
                    }

                    // 5) Terminal request state.
                    await updateRequestSlot(user.uid, requestId, {
                        status: "admin_received",
                        withdrawalId,
                        adminReceivedAt: Date.now(),
                        adminWithdrawalKey: adminKey,
                        completedAt: Date.now()
                    });

                    terminal = true;

                    // 6) Save address only after successful request creation.
                    const saveChecked =
                        !!document.getElementById("saveWithdrawalAddress")?.checked;

                    if (window.addressChangeMode || saveChecked) {
                        try {
                            await saveWithdrawalAddress(user.uid, address);
                        } catch (addressErr) {
                            console.warn("Address save failed:", addressErr);
                            // Non-critical. Withdrawal itself is already recorded.
                        }
                    }

                    showToast(
                        `Withdrawal request submitted: ${amount} ${cfg.currency}. It is now pending admin processing.`,
                        "success",
                        7000
                    );

                    const amountInput = document.getElementById("withAmount");
                    if (amountInput) amountInput.value = "";

                    const saveCheckbox = document.getElementById("saveWithdrawalAddress");
                    if (saveCheckbox) saveCheckbox.checked = false;

                    window.addressChangeMode = false;
                    window.currentSavedWithdrawalAddress = address;

                    setTimeout(() => window.location.reload(), 1800);

                } catch (err) {
                    console.error("Withdrawal submission error:", err);

                    if (isNetworkLikeError(err)) {
                        unknown = true;

                        if (requestId) {
                            await updateRequestSlot(user.uid, requestId, {
                                status: "unknown",
                                updatedAt: Date.now(),
                                error: String(err?.message || "Network error")
                            });
                        }

                        showToast(
                            "Network issue: your request may already be processing. DO NOT submit again. Refresh and check the withdrawal history.",
                            "warning",
                            10000
                        );
                    } else {
                        if (requestId) {
                            await updateRequestSlot(user.uid, requestId, {
                                status: "failed",
                                failedAt: Date.now(),
                                reason: String(err?.message || "Unknown client error")
                            });
                        }

                        showToast(
                            "Error submitting withdrawal. Please try again.",
                            "error"
                        );

                        terminal = true;
                    }
                } finally {
                    // Never remove a lock belonging to a different request.
                    if (lockAcquired && requestId && (terminal || !unknown)) {
                        await releaseWithdrawalLock(user.uid, requestId);
                    }

                    // If reservation exists but lock was never acquired,
                    // clean the reservation because no balance was touched.
                    if (requestReserved && !lockAcquired && requestId) {
                        try {
                            await remove(
                                ref(db, `users/${user.uid}/withdrawalRequests/${requestId}`)
                            );
                        } catch (cleanupErr) {
                            console.warn("Reservation cleanup failed:", cleanupErr);
                        }
                    }

                    isSubmitting = false;

                    if (btn) {
                        btn.disabled = false;
                        btn.innerHTML =
                            `<i class="bi bi-arrow-up-circle"></i> <span>Submit Withdrawal</span>`;
                    }

                    if (unknown) {
                        console.warn(
                            "Withdrawal state remains recoverable through reconciliation:",
                            requestId
                        );
                    }
                }
            }
        });
    });
}

// ============================================================
// MAIN
// ============================================================
onAuthStateChanged(auth, async user => {
    if (!user) {
        window.location.href = "login.html";
        return;
    }

    try {
        await reconcilePendingRequests(user.uid);

        const userData = await getUserData(user.uid);

        if (!userData) {
            window.location.href = "dashboard.html";
            return;
        }

        const username = String(
            userData.username || userData.referralCode || "USER"
        );

        const name = String(userData.name || "User");

        const sidebarName = document.getElementById("sidebarName");
        const sidebarUserId = document.getElementById("sidebarUserId");
        const sidebarAvatar = document.getElementById("sidebarAvatar");
        const referralBadge = document.getElementById("referralBadge");

        if (sidebarName) sidebarName.textContent = name;

        if (sidebarUserId) {
            sidebarUserId.textContent =
                "ID: " +
                username.slice(0, 20) +
                (username.length > 20 ? "..." : "");
        }

        if (sidebarAvatar) {
            sidebarAvatar.textContent = name.charAt(0).toUpperCase() || "U";
        }

        if (referralBadge) {
            referralBadge.textContent = String(userData.totalReferrals || 0);
        }

        const withdrawals = await getWithdrawalHistory(user.uid);

        renderWithdrawalUI(userData, withdrawals);
        attachOptionHandlers();
        attachWithdrawHandler(user);
        attachPasswordEyeToggles();
        attachSidebar();

        await initializeWithdrawalAddressUI(user.uid);

    } catch (error) {
        console.error("Error loading withdrawal page:", error);

        const container = document.getElementById("withdrawalContent");

        if (container) {
            container.innerHTML = `
                <div class="empty-state" style="padding:60px 20px;">
                    <i class="bi bi-exclamation-triangle"
                       style="color:var(--red);opacity:.8;"></i>
                    <h4 style="color:#fff;margin-bottom:8px;">
                        Error Loading Page
                    </h4>
                    <p style="color:var(--text-muted);margin-bottom:20px;">
                        ${escapeHtml(error?.message || "Please check your internet connection.")}
                    </p>
                    <button class="btn-primary-custom"
                            onclick="location.reload()"
                            style="max-width:200px;margin:0 auto;">
                        <i class="bi bi-arrow-clockwise"></i> Refresh Page
                    </button>
                </div>
            `;
        }
    }
});
