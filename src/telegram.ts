import { Env } from "./types";
import { getMarketSummary, fetchSymbolChart } from "./yahoo";
import { fetchSearchContext } from "./search";
import { queryDeepSeek } from "./deepseek";

const PREDEFINED_TIMEZONES = [
  ["UTC", "Europe/Kyiv"],
  ["Europe/Moscow", "Europe/London"],
  ["Asia/Bangkok", "Asia/Singapore"],
  ["Asia/Tokyo", "America/New_York"]
];

export async function sendTelegramMessage(chatId: number, text: string, env: Env, keyboard?: any) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
  const payload: any = {
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown"
  };
  if (keyboard) {
    payload.reply_markup = keyboard;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Telegram API error (${response.status}): ${errText}`);
    }
  } catch (error) {
    console.error("Failed to send Telegram message:", error);
  }
}

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
    // Validate timezone string
    Intl.DateTimeFormat(undefined, { timeZone: tzName });

    const existing = await env.DB.prepare("SELECT * FROM user_settings WHERE chat_id = ?")
      .bind(chatId)
      .first<any>();

    if (existing) {
      await env.DB.prepare("UPDATE user_settings SET timezone = ?, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?")
        .bind(tzName, chatId)
        .run();

      if (existing.hour !== null && existing.minute !== null) {
        const hStr = String(existing.hour).padStart(2, "0");
        const mStr = String(existing.minute).padStart(2, "0");
        await sendTelegramMessage(
          chatId,
          `🌍 Timezone set manually to: ${tzName}\n🕒 Daily briefing rescheduled to ${hStr}:${mStr}!`,
          env
        );
      } else {
        await sendTelegramMessage(
          chatId,
          `🌍 Timezone set manually to: ${tzName}\n👉 Use the command \`/settime HH:MM\` (e.g., \`/settime 09:30\`) to choose your delivery time.`,
          env
        );
      }
    } else {
      await env.DB.prepare("INSERT INTO user_settings (chat_id, timezone) VALUES (?, ?)")
        .bind(chatId, tzName)
        .run();
      await sendTelegramMessage(
        chatId,
        `🌍 Timezone set manually to: ${tzName}\n👉 Use the command \`/settime HH:MM\` (e.g., \`/settime 09:30\`) to choose your delivery time.`,
        env
      );
    }
  } catch (e) {
    await sendTelegramMessage(chatId, "Invalid timezone string. E.g. Europe/Moscow, Asia/Bangkok, America/New_York.", env);
  }
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
    `🕒 Setup complete! I'll message you a daily market briefing at ${timeStr} in your timezone (${existing.timezone}).`,
    env
  );
}

export async function handleNowCommand(chatId: number, env: Env) {
  const existing = await env.DB.prepare("SELECT * FROM user_settings WHERE chat_id = ?")
    .bind(chatId)
    .first<any>();

  const tzName = existing?.timezone || "UTC";
  const watchlist = existing?.watchlist || "^GSPC,^IXIC,BTC-USD,ETH-USD,GC=F,CL=F";

  const summary = await getMarketSummary(watchlist, tzName);
  await sendTelegramMessage(chatId, summary, env);
}

export async function handleCallbackQuery(callbackQuery: any, env: Env) {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  const callbackQueryId = callbackQuery.id;

  // Answer callback query first to resolve Telegram loading UI
  try {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId })
    });
  } catch (err) {
    console.error("Failed to answer callback query:", err);
  }

  if (data.startsWith("tz_")) {
    const tzName = data.slice(3);
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tzName });

      const existing = await env.DB.prepare("SELECT * FROM user_settings WHERE chat_id = ?")
        .bind(chatId)
        .first<any>();

      if (existing) {
        await env.DB.prepare("UPDATE user_settings SET timezone = ?, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?")
          .bind(tzName, chatId)
          .run();

        if (existing.hour !== null && existing.minute !== null) {
          const hStr = String(existing.hour).padStart(2, "0");
          const mStr = String(existing.minute).padStart(2, "0");
          await sendTelegramMessage(
            chatId,
            `🌍 Timezone successfully saved: ${tzName}\n🕒 Daily briefing rescheduled to ${hStr}:${mStr}!`,
            env
          );
        } else {
          await sendTelegramMessage(
            chatId,
            `🌍 Timezone successfully set to: ${tzName}\n👉 Use the command \`/settime HH:MM\` (e.g., \`/settime 09:30\`) to choose your delivery time.`,
            env
          );
        }
      } else {
        await env.DB.prepare("INSERT INTO user_settings (chat_id, timezone) VALUES (?, ?)")
          .bind(chatId, tzName)
          .run();
        await sendTelegramMessage(
          chatId,
          `🌍 Timezone successfully set to: ${tzName}\n👉 Use the command \`/settime HH:MM\` (e.g., \`/settime 09:30\`) to choose your delivery time.`,
          env
        );
      }
    } catch (e) {
      await sendTelegramMessage(chatId, "Invalid timezone selection.", env);
    }
  }
}

export async function checkRateLimit(chatId: number, env: Env): Promise<boolean> {
  const limit = Number(env.RATE_LIMIT_MAX_REQUESTS || "5");
  const windowSecs = Number(env.RATE_LIMIT_WINDOW_SECONDS || "60");
  
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSecs);

  try {
    // Clean up old rate limits to save space
    await env.DB.prepare("DELETE FROM chat_rate_limits WHERE window_start < ?")
      .bind(now - windowSecs)
      .run();

    const record = await env.DB.prepare("SELECT count FROM chat_rate_limits WHERE chat_id = ? AND window_start = ?")
      .bind(chatId, windowStart)
      .first<any>();

    if (record) {
      if (record.count >= limit) {
        return false;
      }
      await env.DB.prepare("UPDATE chat_rate_limits SET count = count + 1 WHERE chat_id = ? AND window_start = ?")
        .bind(chatId, windowStart)
        .run();
    } else {
      await env.DB.prepare("INSERT INTO chat_rate_limits (chat_id, window_start, count) VALUES (?, ?, 1)")
        .bind(chatId, windowStart)
        .run();
    }
    return true;
  } catch (err) {
    console.error("D1 Rate limit database error:", err);
    return true; // Fail-safe: allow requests if database is down
  }
}

export async function checkDailyTokenLimit(chatId: number, env: Env): Promise<boolean> {
  const limit = Number(env.DAILY_TOKEN_LIMIT || "25000");
  const todayStart = Math.floor(Date.now() / 86400000) * 86400;

  try {
    const record = await env.DB.prepare("SELECT tokens_used FROM chat_daily_usage WHERE chat_id = ? AND day_start = ?")
      .bind(chatId, todayStart)
      .first<any>();

    if (record && record.tokens_used >= limit) {
      return false; // Limit exceeded
    }
    return true;
  } catch (err) {
    console.error("D1 Daily token limit database error:", err);
    return true; // Fail-safe: allow requests if database is down
  }
}

export async function updateDailyTokenUsage(chatId: number, tokensUsed: number, env: Env): Promise<void> {
  if (tokensUsed <= 0) return;
  const todayStart = Math.floor(Date.now() / 86400000) * 86400;

  try {
    await env.DB.prepare(`
      INSERT INTO chat_daily_usage (chat_id, day_start, tokens_used)
      VALUES (?, ?, ?)
      ON CONFLICT(chat_id, day_start)
      DO UPDATE SET tokens_used = tokens_used + excluded.tokens_used
    `)
      .bind(chatId, todayStart, tokensUsed)
      .run();
  } catch (err) {
    console.error("Failed to update daily token usage:", err);
  }
}

export function extractAssetTicker(text: string): string | null {
  const lower = text.toLowerCase();
  
  // Known keyword mappings
  if (lower.includes("bitcoin") || lower.includes("биткоин") || lower.includes("btc")) {
    return "BTC-USD";
  }
  if (lower.includes("ethereum") || lower.includes("эфириум") || lower.includes("eth")) {
    return "ETH-USD";
  }
  if (lower.includes("gold") || lower.includes("золото") || lower.includes("gc")) {
    return "GC=F";
  }
  if (lower.includes("oil") || lower.includes("нефть") || lower.includes("cl")) {
    return "CL=F";
  }
  if (lower.includes("s&p") || lower.includes("sp500") || lower.includes("снп")) {
    return "^GSPC";
  }
  if (lower.includes("nasdaq") || lower.includes("насдак")) {
    return "^IXIC";
  }

  // Regex to find 1 to 5 uppercase letters (standard tickers like TSLA, AAPL, MSFT)
  const words = text.split(/\s+/);
  for (const word of words) {
    const cleanWord = word.replace(/[^a-zA-Z]/g, "");
    if (cleanWord.length >= 1 && cleanWord.length <= 5) {
      const upper = cleanWord.toUpperCase();
      const commonWords = ["I", "ME", "MY", "WE", "US", "YOU", "HE", "SHE", "IT", "THEY", "THE", "AND", "BUT", "OR", "AS", "IF", "BY", "AT", "IN", "OF", "ON", "TO", "FOR"];
      if (!commonWords.includes(upper)) {
        return upper;
      }
    }
  }

  return null;
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

  if (text.startsWith("/start")) {
    await handleStartCommand(chatId, env);
  } else if (text.startsWith("/settimezone")) {
    const parts = text.split(" ");
    if (parts.length < 2) {
      await sendTelegramMessage(chatId, "Please provide your timezone, e.g., `/settimezone Europe/Moscow`", env);
    } else {
      await handleSetTimezoneCommand(chatId, parts[1], env);
    }
  } else if (text.startsWith("/settime")) {
    const parts = text.split(" ");
    if (parts.length < 2) {
      await sendTelegramMessage(chatId, "Please use HH:MM format, e.g., `/settime 09:30`", env);
    } else {
      await handleSetTimeCommand(chatId, parts[1], env);
    }
  } else if (text.startsWith("/now")) {
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
          const searchContext = await fetchSearchContext(text, env.TAVILY_API_KEY);
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
