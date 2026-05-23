export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
}

export interface UserSettings {
  chat_id: number;
  timezone: string;
  hour: number | null;
  minute: number | null;
  watchlist: string;
  updated_at: string;
}
