export const WALLET_CONFIG = {
    // Official USDT (BEP20) Contract Address
    USDT_CONTRACT: "0x55d398326f99059fF775485246999027B3197955",
    
    // Company Deposit Wallet Address - UPDATED
    DEPOSIT_WALLET: "0x088adFEad63589CAeb8b4d6C3F545e247288C71D",
    
    // Minimum confirmations required
    MIN_CONFIRMATIONS: 3,
    
    // RPC timeout in milliseconds
    RPC_TIMEOUT: 10000,
    
    // Auto-polling interval in milliseconds
    POLLING_INTERVAL: 15000, // 15 seconds
    
    // Maximum polling attempts
    MAX_POLLING_ATTEMPTS: 60, // 15 minutes
    
    // Stale lock cleanup timeout (10 minutes)
    STALE_LOCK_TIMEOUT: 10 * 60 * 1000,
    
    // BSC RPC Endpoints with Failover
    RPC_ENDPOINTS: [
        "https://bsc-dataseed.binance.org",
        "https://bsc.publicnode.com",
        "https://rpc.ankr.com/bsc",
        "https://bsc-dataseed1.defibit.io",
        "https://bsc-dataseed1.ninicoin.io"
    ]
};