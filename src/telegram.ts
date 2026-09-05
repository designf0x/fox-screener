import { Env } from "./types";
import { getMarketSummary, fetchSymbolChart } from "./yahoo";
import { fetchSearchContext } from "./search";
import { queryDeepSeek } from "./deepseek";
import { sendTelegramMessage, escapeMarkdown } from "./messaging";
export { sendTelegramMessage, broadcastToTradingChannel } from "./messaging";
import { flushTradeNotifications } from "./notifications";
import { 
  getTradingStats, 
  getOpenTrades,
  getTradeBySourceKey,
  formatTradingStatsCard, 
  analyzeMarketAndDecide, 
  formatTradeOpenedCard,
  ASSET_NAMES
} from "./trader";

const PREDEFINED_TIMEZONES = [
  ["UTC", "Europe/Kyiv"],
  ["Europe/Moscow", "Europe/London"],
  ["Asia/Bangkok", "Asia/Singapore"],
  ["Asia/Tokyo", "America/New_York"]
];

export async function handleStartCommand(chatId: number, env: Env) {
  const keyboard = {
    inline_keyboard: PREDEFINED_TIMEZONES.map(row => 
      row.map(tz => ({
        text: tz,
        callback_data: `tz_${tz}`
      }))
    )
  };

  const text = "Hi! I’m the Fox Market Screener Bot. 🦊📈\n" +
               "I will deliver high-performance daily summaries of global markets directly to you.\n\n" +
               "Please choose your timezone to begin:";

  await sendTelegramMessage(chatId, text, env, keyboard);
}

export async function handleSetTimezoneCommand(chatId: number, tzName: string, env: Env) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tzName });
  } catch {
    await sendTelegramMessage(chatId, escapeMarkdown("Invalid timezone string. E.g. Europe/Moscow, Asia/Bangkok, America/New_York."), env);
    return;
  }
  const existing = await env.DB.prepare("SELECT * FROM user_settings WHERE chat_id = ?")
    .bind(chatId).first<any>();
  await env.DB.prepare(`INSERT INTO user_settings (chat_id, timezone) VALUES (?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET timezone = excluded.timezone, updated_at = CURRENT_TIMESTAMP`)
    .bind(chatId, tzName).run();
  const schedule = existing?.hour != null && existing?.minute != null
    ? `Daily briefing rescheduled to ${String(existing.hour).padStart(2, "0")}:${String(existing.minute).padStart(2, "0")}!`
    : "Use /settime HH:MM (e.g., /settime 09:30) to choose your delivery time.";
  await sendTelegramMessage(chatId, escapeMarkdown(`🌍 Timezone saved: ${tzName}\n🕒 ${schedule}`), env);
}

export async function handleSetTimeCommand(chatId: number, timeStr: string, env: Env) {
  const existing = await env.DB.prepare("SELECT * FROM user_settings WHERE chat_id = ?")
    .bind(chatId)
    .first<any>();

  if (!existing) {
    await sendTelegramMessage(chatId, "Set your timezone first using `/start` or `/settimezone`!", env);
    return;
  }

  const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
  if (!timeRegex.test(timeStr)) {
    await sendTelegramMessage(chatId, "Invalid time format. Use HH:MM, e.g., `/settime 09:30`", env);
    return;
  }

  const [hour, minute] = timeStr.split(":").map(Number);

  await env.DB.prepare("UPDATE user_settings SET hour = ?, minute = ?, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?")
    .bind(hour, minute, chatId)
    .run();

  await sendTelegramMessage(
    chatId,
    `🕒 Setup complete! I'll message you a daily market briefing at ${timeStr} in your timezone (${escapeMarkdown(existing.timezone)}).`,
    env
  );
}

export async function handleNowCommand(chatId: number, env: Env) {
  const existing = await env.DB.prepare("SELECT * FROM user_settings WHERE chat_id = ?")
    .bind(chatId)
    .first<any>();

  const tzName = existing?.timezone || "UTC";
  const watchlist = existing?.watchlist || "^GSPC,^IXIC,BTC-USD,ETH-USD,GC=F,CL=F";

  const summary = await getMarketSummary(watchlist, tzName, env.TRADING_CHANNEL_ID, env.TRADING_CHANNEL_URL);
  await sendTelegramMessage(chatId, summary, env);
}

export async function handleCallbackQuery(callbackQuery: any, env: Env) {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  const callbackQueryId = callbackQuery.id;

  // Answer callback query first to resolve Telegram loading UI
  try {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
      signal: AbortSignal.timeout(15000),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId })
    });
  } catch (err) {
    console.error("Failed to answer callback query:", err);
  }

  if (typeof data === "string" && data.startsWith("tz_")) {
    await handleSetTimezoneCommand(chatId, data.slice(3), env);
  }
}

export async function checkRateLimit(chatId: number | string, env: Env): Promise<boolean> {
  const limit = Number(env.RATE_LIMIT_MAX_REQUESTS ?? "5");
  const windowSecs = Number(env.RATE_LIMIT_WINDOW_SECONDS ?? "60");
  if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(windowSecs) || windowSecs <= 0) return false;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSecs);
  await env.DB.prepare("DELETE FROM chat_rate_limits WHERE window_start < ?").bind(now - windowSecs).run();
  const admitted = await env.DB.prepare(`
    INSERT INTO chat_rate_limits (chat_id, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT(chat_id, window_start) DO UPDATE SET count = chat_rate_limits.count + 1
    WHERE chat_rate_limits.count < ? RETURNING count
  `).bind(chatId, windowStart, limit).first();
  return admitted !== null;
}

export async function checkDailyTokenLimit(chatId: number | string, env: Env): Promise<boolean> {
  const limit = Number(env.DAILY_TOKEN_LIMIT ?? "25000");
  if (!Number.isFinite(limit) || limit <= 0) return false;
  const todayStart = Math.floor(Date.now() / 86400000) * 86400;
  const record = await env.DB.prepare("SELECT tokens_used FROM chat_daily_usage WHERE chat_id = ? AND day_start = ?")
    .bind(chatId, todayStart).first<{ tokens_used: number }>();
  return (record?.tokens_used || 0) < limit;
}

export async function updateDailyTokenUsage(chatId: number | string, tokensUsed: number, env: Env): Promise<void> {
  if (!Number.isFinite(tokensUsed) || tokensUsed <= 0) return;
  const todayStart = Math.floor(Date.now() / 86400000) * 86400;
  await env.DB.prepare(`
    INSERT INTO chat_daily_usage (chat_id, day_start, tokens_used) VALUES (?, ?, ?)
    ON CONFLICT(chat_id, day_start) DO UPDATE SET tokens_used = tokens_used + excluded.tokens_used
  `).bind(chatId, todayStart, tokensUsed).run();
}

export function extractAssetTicker(text: string): string | null {
  const aliases: [string, string][] = [
    ["bitcoin|btc|биткоин[а-яё]*", "BTC-USD"],
    ["ethereum|eth|эфириум[а-яё]*", "ETH-USD"],
    ["gold|gc(?:=f)?|золот[а-яё]*", "GC=F"],
    ["oil|cl(?:=f)?|нефт[а-яё]*", "CL=F"],
    ["s&p|sp500|снп", "^GSPC"],
    ["nasdaq|насдак[а-яё]*", "^IXIC"],
    ["chainlink|чейнлинк[а-яё]*", "LINK-USD"],
    ["solana|солан[а-яё]*", "SOL-USD"]
  ];
  for (const [alias, symbol] of aliases) {
    if (new RegExp(`(?:^|[^\\p{L}\\p{N}_])(?:${alias})(?=$|[^\\p{L}\\p{N}_])`, "iu").test(text)) return symbol;
  }
  const commonWords = new Set(["I", "ME", "MY", "WE", "US", "YOU", "HE", "SHE", "IT", "THEY", "THE", "AND", "BUT", "OR", "AS", "IF", "BY", "AT", "IN", "OF", "ON", "TO", "FOR", "WHAT", "HOW", "WHY", "PRICE"]);
  const cryptos = new Set(["BTC", "ETH", "SOL", "LINK", "ADA", "DOGE", "XRP", "LTC", "DOT", "UNI", "BCH", "AVAX", "NEAR", "MATIC", "TON"]);
  for (const word of text.split(/\s+/)) {
    const token = word.replace(/^[^$A-Za-z^]+|[^A-Za-z0-9]+$/g, "");
    // Ordinary lowercase words are not tickers; a cashtag explicitly opts in.
    if (!/^\$?[A-Z]{1,5}(?:[.-][A-Z]{1,5})?$/.test(token) && !/^\$[a-z]{1,5}$/.test(token)) continue;
    const upper = token.replace(/^\$/, "").toUpperCase();
    if (commonWords.has(upper)) continue;
    return cryptos.has(upper) ? `${upper}-USD` : upper;
  }
  return null;
}

export async function handleStatsCommand(chatId: number | string, env: Env) {
  const stats = await getTradingStats(env);
  const openTrades = await getOpenTrades(env);
  const text = formatTradingStatsCard(stats, openTrades);
  await sendTelegramMessage(chatId, text, env);
}

export async function handleTradesCommand(chatId: number | string, env: Env) {
  const openTrades = await getOpenTrades(env);
  const { results: recentClosed } = await env.DB.prepare(
    "SELECT * FROM paper_trades WHERE status != 'OPEN' ORDER BY closed_at DESC LIMIT 5"
  ).all<any>();

  let text = "📋 *ЖУРНАЛ СДЕЛОК FOX TRADER* 🦊\n\n";
  if (openTrades.length > 0) {
    text += "🔓 *АКТИВНЫЕ ПОЗИЦИИ:*\n";
    for (const t of openTrades) {
      const name = ASSET_NAMES[t.symbol] || t.symbol;
      text += `• *${name}* (${t.direction})\n  Вход: $${t.entry_price} | TP: $${t.take_profit} | SL: $${t.stop_loss}\n  Стратегия: #${escapeMarkdown(t.strategy_tag || "Manual")}\n`;
    }
    text += "\n";
  } else {
    text += "🔓 *АКТИВНЫЕ ПОЗИЦИИ:* Нет\n\n";
  }

  if (recentClosed && recentClosed.length > 0) {
    text += "📜 *ПОСЛЕДНИЕ ЗАКРЫТЫЕ СДЕЛКИ:*\n";
    for (const t of recentClosed) {
      const name = ASSET_NAMES[t.symbol] || t.symbol;
      const icon = t.status === "CLOSED_TP" ? "🎯" : "🛑";
      const sign = (t.pnl_percent || 0) >= 0 ? "+" : "";
      text += `${icon} *${name}* (${t.direction}): *${sign}${t.pnl_percent}%* (${sign}${t.r_multiple}R)\n  Выход: $${t.exit_price}\n`;
    }
  }

  await sendTelegramMessage(chatId, text, env);
}

export async function handleManualScanCommand(chatId: number | string, env: Env, sourceKey?: string) {
  // A retry after the trade committed must reuse it, even if the quota is now exhausted.
  const previous = sourceKey ? await getTradeBySourceKey(env, sourceKey) : null;
  if (previous) {
    await sendTelegramMessage(chatId, formatTradeOpenedCard(previous), env);
    return;
  }
  if (!await checkRateLimit(chatId, env)) {
    await sendTelegramMessage(chatId, "⚠️ Лимит запросов исчерпан. Повторите позже.", env);
    return;
  }
  if (!await checkDailyTokenLimit(chatId, env)) {
    await sendTelegramMessage(chatId, "⚠️ Суточный лимит ИИ исчерпан. Лимит обновится в 00:00 UTC.", env);
    return;
  }
  await sendTelegramMessage(chatId, "🔍 *Запуск анализа рынка и поиска торговых сетапов...*", env);
  const { trade, rationale } = await analyzeMarketAndDecide(env, {
    sourceKey, onTokenUsage: tokens => updateDailyTokenUsage(chatId, tokens, env)
  });
  if (trade) {
    await sendTelegramMessage(chatId, formatTradeOpenedCard(trade), env);
  } else {
    await sendTelegramMessage(chatId, `⏸️ *Решение ИИ:* ${escapeMarkdown(rationale)}`, env);
  }
  // The durable queue also gets drained by cron if this request fails after commit.
  await flushTradeNotifications(env);
}

export async function routeWebhookUpdate(update: any, env: Env) {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return;
  }

  const message = update.message;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();
  const commandToken = text.split(/\s+/, 1)[0];
  const [command, recipient] = commandToken.split("@");
  if (command.startsWith("/") && recipient && recipient.toLowerCase() !== (env.BOT_USERNAME || "FoxScreenerBot").toLowerCase()) return;

  if (command === "/start") {
    await handleStartCommand(chatId, env);
  } else if (command === "/stats" || command === "/trader") {
    await handleStatsCommand(chatId, env);
  } else if (command === "/trades" || command === "/journal") {
    await handleTradesCommand(chatId, env);
  } else if (command === "/scan" || command === "/tradescan") {
    await handleManualScanCommand(chatId, env, Number.isSafeInteger(update.update_id) ? `telegram:${update.update_id}` : undefined);
  } else if (command === "/settimezone") {
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      await sendTelegramMessage(chatId, "Please provide your timezone, e.g., `/settimezone Europe/Moscow`", env);
    } else {
      await handleSetTimezoneCommand(chatId, parts[1], env);
    }
  } else if (command === "/settime") {
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      await sendTelegramMessage(chatId, "Please use HH:MM format, e.g., `/settime 09:30`", env);
    } else {
      await handleSetTimeCommand(chatId, parts[1], env);
    }
  } else if (command === "/now") {
    await handleNowCommand(chatId, env);
  } else {
    // Free-form user request or dynamic support
    const chatType = message.chat?.type;
    const isPrivate = chatType === "private";
    
    // In group/supergroup chats, respond only when the bot's name is mentioned or when replying to the bot
    const botUsername = env.BOT_USERNAME || "FoxScreenerBot";
    const isBotMentioned = text.toLowerCase().includes("@" + botUsername.toLowerCase()) || 
                           text.toLowerCase().includes(botUsername.toLowerCase());
    
    const replyToMessage = message.reply_to_message;
    const isReplyToBot = replyToMessage && 
                         replyToMessage.from?.username?.toLowerCase() === botUsername.toLowerCase();

    if (isPrivate || isBotMentioned || isReplyToBot) {
      console.log(`Processing free-form query in chat ${chatId} (${chatType})...`);

      // 1. Rate limiting check (minute rate limit)
      const withinLimit = await checkRateLimit(chatId, env);
      if (!withinLimit) {
        await sendTelegramMessage(chatId, "⚠️ Вы превысили лимит запросов. Пожалуйста, подождите минуту перед следующим запросом.", env);
        return;
      }

      // 1.5. Daily token usage limit check
      const withinDailyLimit = await checkDailyTokenLimit(chatId, env);
      if (!withinDailyLimit) {
        await sendTelegramMessage(chatId, "⚠️ Превышен суточный лимит использования ИИ для этого чата (25 000 токенов). Лимит обновится завтра в 00:00 UTC.", env);
        return;
      }

      // 2. Show typing indicator
      try {
        await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendChatAction`, {
          signal: AbortSignal.timeout(15000),
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, action: "typing" })
        });
      } catch (err) {
        console.error("Failed to send typing indicator:", err);
      }

      // 3. Extract asset ticker & fetch market data
      let context = "";
      
      // Inject the context of the message that the user is replying to for rich conversation history
      if (isReplyToBot && replyToMessage.text) {
        context += `Previous Bot Message (user is replying directly to this message):\n"${replyToMessage.text}"\n\n`;
      }
      
      const ticker = extractAssetTicker(text) || (isReplyToBot && replyToMessage.text ? extractAssetTicker(replyToMessage.text) : null);
      if (ticker) {
        try {
          const res = await fetchSymbolChart(ticker);
          if (!res.error && res.price !== undefined && res.previousClose !== undefined) {
            const change = ((res.price - res.previousClose) / res.previousClose) * 100;
            context += `Market Data for ${ticker}:\n- Current Price: ${res.price}\n- Previous Close: ${res.previousClose}\n- Today's Change: ${change.toFixed(2)}%\n\n`;
          } else {
            context += `Market Data for ${ticker} is currently unavailable or returned error: ${res.error || "Unknown Error"}\n\n`;
          }
        } catch (err: any) {
          console.error(`Error fetching dynamic ticker ${ticker}:`, err);
        }
      }

      // 4. Fetch Tavily web search results (if key is set)
      if (env.TAVILY_API_KEY) {
        try {
          // Construct a focused financial search query to avoid generic search noise
          let searchQuery = text;
          if (ticker) {
            searchQuery = `${ticker} price news today ${text}`;
          } else {
            searchQuery = `${text} market price news`;
          }
          const searchContext = await fetchSearchContext(searchQuery, env.TAVILY_API_KEY);
          if (searchContext) {
            context += `${searchContext}\n\n`;
          }
        } catch (err) {
          console.error("Error fetching search context:", err);
        }
      }

      if (!ticker) {
        // Fallback standard watch list prices for general context
        context += `General Watchlist Data:\n`;
        const defaultWatchlist = ["^GSPC", "^IXIC", "BTC-USD", "ETH-USD", "GC=F", "CL=F"];
        const quotes = await Promise.all(defaultWatchlist.map(fetchSymbolChart));
        for (const q of quotes) {
          if (!q.error && q.price !== undefined) {
            context += `- ${q.symbol}: ${q.price}\n`;
          }
        }
      }

      // 5. Query DeepSeek with context
      const result = await queryDeepSeek(text, context, env);

      // 5.5. Track and persist the token usage in SQLite D1
      await updateDailyTokenUsage(chatId, result.totalTokens, env);

      // 6. Deliver the Russian response
      await sendTelegramMessage(chatId, result.answer, env);
    }
  }
}
