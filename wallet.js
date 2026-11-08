// ============================================================
// 🔥 WALLET CONFIG — RND STAKING (BSC / USDT BEP20)
// ============================================================

export const WALLET_CONFIG = Object.freeze({

    // ---------- Network ----------
    CHAIN_ID: 56,
    EXPLORER_TX_URL: "https://bscscan.com/tx/",

    // ---------- Token (Official USDT BEP20) ----------
    USDT_CONTRACT: "0x55d398326f99059fF775485246999027B3197955",
    USDT_DECIMALS: 18,

    // ---------- Company deposit wallet ----------
    DEPOSIT_WALLET: "0x088adFEad63589CAeb8b4d6C3F545e247288C71D",

    // ---------- Verification rules ----------
    MIN_CONFIRMATIONS: 12,
    MIN_DEPOSIT_USDT: 0.01,
    RELATIVE_TOLERANCE: 0.005,
    ABSOLUTE_TOLERANCE: 0.01,

    // ---------- Anti-fraud switches (optional) ----------
    MAX_TX_AGE_HOURS: 0,
    REQUIRE_SENDER_MATCH: false,
    USER_WALLET_FIELD: "walletAddress",

    // ---------- Polling ----------
    POLLING_INTERVAL: 5000,
    MAX_POLLING_ATTEMPTS: 120,
    MAX_NETWORK_RETRIES: 6,

    // ---------- Locks ----------
    LOCK_HEARTBEAT_INTERVAL: 15000,
    LOCK_HEARTBEAT_TIMEOUT: 120000,
    STALE_LOCK_TIMEOUT: 10 * 60 * 1000,

    // ---------- RPC ----------
    RPC_TIMEOUT: 15000,   // थोड़ा बढ़ाया ताकि धीमे नोड पर टाइमआउट न हो
    RPC_ENDPOINTS: Object.freeze([
        "https://bsc-dataseed.bnbchain.org",
        "https://bsc-dataseed1.bnbchain.org",
        "https://bsc-dataseed2.bnbchain.org",
        "https://bsc-dataseed1.defibit.io",
        "https://bsc-dataseed2.defibit.io",
        "https://bsc-rpc.publicnode.com",
        "https://bsc-dataseed.binance.org"
    ])
});

// ============================================================
// 🔧 HELPERS
// ============================================================
const TX_HASH_REGEX = /^0x[0-9a-f]{64}$/;

export function normalizeTxHash(hash) {
    return String(hash == null ? "" : hash).trim().toLowerCase();
}

export function isValidTxHash(hash) {
    return TX_HASH_REGEX.test(normalizeTxHash(hash));
}

export function shortHash(hash, head = 10, tail = 8) {
    const h = String(hash || "");
    return h.length > head + tail + 3 ? `${h.slice(0, head)}...${h.slice(-tail)}` : h;
}

export function getExplorerTxUrl(hash) {
    return WALLET_CONFIG.EXPLORER_TX_URL + normalizeTxHash(hash);
}

// ============================================================
// ✅ CONFIG SELF-CHECK
// ============================================================
(function validateConfig() {
    const addr = /^0x[0-9a-fA-F]{40}$/;
    ["USDT_CONTRACT", "DEPOSIT_WALLET"].forEach((key) => {
        if (!addr.test(WALLET_CONFIG[key])) {
            console.error(`[wallet.js] ${key} valid address nahi hai: ${WALLET_CONFIG[key]}`);
        }
    });
    if (!WALLET_CONFIG.RPC_ENDPOINTS.length) {
        console.error("[wallet.js] RPC_ENDPOINTS khali hai");
    }
})();
