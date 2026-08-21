CREATE TABLE IF NOT EXISTS user_settings (
    chat_id INTEGER PRIMARY KEY,
    timezone TEXT NOT NULL,
    hour INTEGER,
    minute INTEGER,
    watchlist TEXT DEFAULT '^GSPC,^IXIC,BTC-USD,ETH-USD,GC=F,CL=F',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_rate_limits (
    chat_id INTEGER,
    window_start INTEGER,
    count INTEGER,
    PRIMARY KEY (chat_id, window_start)
);

CREATE TABLE IF NOT EXISTS chat_daily_usage (
    chat_id INTEGER,
    day_start INTEGER,
    tokens_used INTEGER,
    PRIMARY KEY (chat_id, day_start)
);

CREATE TABLE IF NOT EXISTS paper_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL, -- 'LONG' or 'SHORT'
    entry_price REAL NOT NULL,
    stop_loss REAL NOT NULL,
    take_profit REAL NOT NULL,
    risk_reward_ratio REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN', -- 'OPEN', 'CLOSED_TP', 'CLOSED_SL', 'CLOSED_MANUAL', 'CANCELLED'
    exit_price REAL,
    pnl_percent REAL,
    r_multiple REAL,
    setup_reasoning TEXT,
    strategy_tag TEXT,
    opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    closed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON paper_trades(status);
