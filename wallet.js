// ============================================================
// 🔥 WALLET CONFIG — RND STAKING (BSC / USDT BEP20)
// ============================================================
// Is file me sirf settings + chhote helper functions hain.
// Koi bhi value badalne se pehle dhyan rakhein: yeh LIVE site hai.
// ============================================================

export const WALLET_CONFIG = Object.freeze({

    // ---------- Network ----------
    CHAIN_ID: 56,                         // BNB Smart Chain mainnet
    EXPLORER_TX_URL: "https://bscscan.com/tx/",

    // ---------- Token (Official USDT BEP20) ----------
    USDT_CONTRACT: "0x55d398326f99059fF775485246999027B3197955",
    USDT_DECIMALS: 18,

    // ---------- Company deposit wallet ----------
    DEPOSIT_WALLET: "0x088adFEad63589CAeb8b4d6C3F545e247288C71D",

    // ---------- Verification rules ----------
    MIN_CONFIRMATIONS: 12,                // Safe side par rakha hai (BSC par ~10 second)
    MIN_DEPOSIT_USDT: 0.01,               // Isse kam deposit accept nahi hoga
    RELATIVE_TOLERANCE: 0.005,            // User ke amount me ±0.5% tak ka farq chalega
    ABSOLUTE_TOLERANCE: 0.01,             // ya kam se kam 0.01 USDT

    // ---------- Anti-fraud switches (optional) ----------
    MAX_TX_AGE_HOURS: 0,
    REQUIRE_SENDER_MATCH: false,
    USER_WALLET_FIELD: "walletAddress",

    // ---------- Polling ----------
    POLLING_INTERVAL: 5000,               // har 5 second me check
    MAX_POLLING_ATTEMPTS: 120,            // 120 x 5s = 10 minute
    MAX_NETWORK_RETRIES: 6,               // lagatar network error par itni baar retry

    // ---------- Locks ----------
    LOCK_HEARTBEAT_INTERVAL: 15000,       // active verification har 15s me "zinda hoon" likhti hai
    LOCK_HEARTBEAT_TIMEOUT: 120000,       // 2 minute heartbeat nahi aaya => lock dead maana jayega
    STALE_LOCK_TIMEOUT: 10 * 60 * 1000,   // 10 minute purane dead locks cleanup me hat jayenge

    // ---------- RPC ----------
    RPC_TIMEOUT: 20000,                   // थोड़ा बढ़ाया ताकि नोड को रिस्पॉन्ड करने का समय मिले
    RPC_ENDPOINTS: Object.freeze([
        // 🔥 सबसे भरोसेमंद पब्लिक नोड सबसे पहले
        "https://bsc-rpc.publicnode.com",
        "https://bsc-dataseed1.defibit.io",
        "https://bsc-dataseed2.defibit.io",
        "https://bsc-dataseed.bnbchain.org",
        "https://bsc-dataseed1.bnbchain.org",
        "https://bsc-dataseed2.bnbchain.org",
        "https://bsc-dataseed.binance.org"
    ])
});

// ============================================================
// 🔧 HELPERS
// ============================================================
const TX_HASH_REGEX = /^0x[0-9a-f]{64}$/;

/** Hash ko trim + lowercase karta hai (0xABC aur 0xabc ek hi mane jayenge). */
export function normalizeTxHash(hash) {
    return String(hash == null ? "" : hash).trim().toLowerCase();
}

/** Valid BSC transaction hash: 0x + 64 hex characters. */
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
// ✅ CONFIG SELF-CHECK (galat address ho to console me turant dikhega)
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
