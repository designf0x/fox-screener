export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  TRADING_CHANNEL_ID?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  DEEPSEEK_MAX_TOKENS?: string;
  TAVILY_API_KEY?: string;
  BOT_USERNAME?: string;
  RATE_LIMIT_MAX_REQUESTS?: string;
  RATE_LIMIT_WINDOW_SECONDS?: string;
  DAILY_TOKEN_LIMIT?: string;
}

export interface UserSettings {
  chat_id: number;
  timezone: string;
  hour: number | null;
  minute: number | null;
  watchlist: string;
  updated_at: string;
}

export interface PaperTrade {
  id: number;
  symbol: string;
  direction: "LONG" | "SHORT";
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  risk_reward_ratio: number;
  status: "OPEN" | "CLOSED_TP" | "CLOSED_SL" | "CLOSED_MANUAL" | "CANCELLED";
  exit_price: number | null;
  pnl_percent: number | null;
  r_multiple: number | null;
  setup_reasoning: string | null;
  strategy_tag: string | null;
  opened_at: string;
  closed_at: string | null;
}

export interface TradeDecision {
  action: "OPEN_TRADE" | "HOLD";
  symbol?: string;
  direction?: "LONG" | "SHORT";
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  strategyTag?: string;
  reasoning?: string;
  confidence?: number;
}

export interface ClosedTradeEvent {
  trade: PaperTrade;
  exitPrice: number;
  reason: "TP" | "SL";
  pnlPercent: number;
  rMultiple: number;
}

export interface TraderStats {
  totalTrades: number;
  closedTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlPercent: number;
  averageR: number;
  profitFactor: number;
  bestTradePnl: number;
  worstTradePnl: number;
}
