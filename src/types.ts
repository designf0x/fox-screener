export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
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
