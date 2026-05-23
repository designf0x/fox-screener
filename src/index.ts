import { Env } from "./types";
import { routeWebhookUpdate, sendTelegramMessage } from "./telegram";
import { getMarketSummary } from "./yahoo";

export async function handleScheduledBriefings(env: Env) {
  // Query all users that have both timezone and delivery time set
  const { results } = await env.DB.prepare(
    "SELECT chat_id, timezone, hour, minute, watchlist FROM user_settings WHERE hour IS NOT NULL AND minute IS NOT NULL"
  ).all<any>();

  if (!results || results.length === 0) return;

  const now = new Date();

  for (const user of results) {
    const { chat_id, timezone, hour, minute, watchlist } = user;

    try {
      // Get the current hour and minute in the user's specific local timezone
      const formatter = new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: timezone
      });
      const timeStr = formatter.format(now); // formats as e.g., "09:30" or "09.30"
      
      // Standardize the time separator (Intl can output . or : depending on OS environment)
      const cleanTimeStr = timeStr.replace(".", ":");
      const [currentHour, currentMinute] = cleanTimeStr.split(":").map(Number);

      if (currentHour === hour && currentMinute === minute) {
        console.log(`Triggering scheduled daily briefing for user ${chat_id} at ${hour}:${minute} (${timezone}).`);
        const summary = await getMarketSummary(watchlist, timezone);
        await sendTelegramMessage(chat_id, summary, env);
      }
    } catch (e) {
      console.error(`Error processing scheduled briefing for user ${chat_id}:`, e);
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/test") {
      try {
        const summary = await getMarketSummary("^GSPC,^IXIC,BTC-USD,ETH-USD,GC=F,CL=F", "Asia/Singapore");
        return new Response(summary, {
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      } catch (err: any) {
        return new Response(`Error: ${err.message}`, { status: 500 });
      }
    }

    // Webhooks are exclusively POST requests
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const update: any = await request.json();
      await routeWebhookUpdate(update, env);
    } catch (error: any) {
      console.error("Error routing webhook update:", error);
    }

    return new Response("OK", { status: 200 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`Cron schedule triggered at: ${new Date().toISOString()}`);
    // Wait for the asynchronous scheduled briefings process to resolve cleanly
    ctx.waitUntil(handleScheduledBriefings(env));
  }
};
