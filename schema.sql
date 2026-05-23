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
