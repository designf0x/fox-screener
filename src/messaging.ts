import { Env } from "./types";

export function escapeMarkdown(text: string): string {
  return text.replace(/([_*`\[])/g, "\\$1");
}

export class TelegramApiError extends Error {
  constructor(message: string, public retryAfter = 60) {
    super(message);
  }
}

export async function sendTelegramMessage(chatId: number | string, text: string, env: Env, keyboard?: any) {
  const payload: any = { chat_id: chatId, text, parse_mode: "Markdown" };
  if (keyboard) payload.reply_markup = keyboard;

  // Retry malformed generated Markdown as plain text; propagate all delivery failures.
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
    const result: any = await response.json();
    if (response.ok && result.ok === true) return;
    const description = String(result.description || `HTTP ${response.status}`);
    if (attempt === 0 && response.status === 400 && /parse entities|end of (the )?entity/i.test(description)) {
      delete payload.parse_mode;
      continue;
    }
    throw new TelegramApiError(description, Number(result.parameters?.retry_after) || 60);
  }
}

export async function broadcastToTradingChannel(text: string, env: Env) {
  if (env.TRADING_CHANNEL_ID) await sendTelegramMessage(env.TRADING_CHANNEL_ID, text, env);
}
