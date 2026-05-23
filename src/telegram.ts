import { Env } from "./types";
import { getMarketSummary } from "./yahoo";

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
  }
}
