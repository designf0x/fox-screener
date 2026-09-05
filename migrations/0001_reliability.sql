-- Apply after schema.sql. Existing trade history is preserved.
ALTER TABLE paper_trades ADD COLUMN source_key TEXT;
CREATE UNIQUE INDEX idx_paper_trades_source ON paper_trades(source_key);

CREATE TABLE telegram_updates (
    update_id INTEGER PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('PROCESSING', 'DONE')),
    lease_token TEXT NOT NULL,
    lease_until INTEGER NOT NULL
);

CREATE TABLE trade_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id INTEGER NOT NULL REFERENCES paper_trades(id),
    event_type TEXT NOT NULL CHECK (event_type IN ('OPEN', 'CLOSED')),
    delivered_at INTEGER,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    UNIQUE (trade_id, event_type)
);
CREATE INDEX idx_trade_notifications_pending ON trade_notifications(delivered_at, next_attempt_at);

-- Enqueue in the same transaction as the trade change, including on Worker failure.
CREATE TRIGGER notify_trade_opened AFTER INSERT ON paper_trades
WHEN NEW.status = 'OPEN'
BEGIN
    INSERT INTO trade_notifications (trade_id, event_type) VALUES (NEW.id, 'OPEN');
END;

CREATE TRIGGER notify_trade_closed AFTER UPDATE OF status ON paper_trades
WHEN OLD.status = 'OPEN' AND NEW.status IN ('CLOSED_TP', 'CLOSED_SL', 'CLOSED_MANUAL')
BEGIN
    INSERT INTO trade_notifications (trade_id, event_type) VALUES (NEW.id, 'CLOSED');
END;
