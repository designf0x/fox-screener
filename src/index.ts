import { Env } from "./types";
import { routeWebhookUpdate, sendTelegramMessage, broadcastToTradingChannel } from "./telegram";
import { getMarketSummary } from "./yahoo";
import { 
  analyzeMarketAndDecide, 
  checkOpenPositions, 
  getTradingStats, 
  getOpenTrades,
  formatTradeOpenedCard, 
  formatTradeClosedCard, 
  formatTradingStatsCard 
} from "./trader";

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

/**
 * Checks all active open paper positions against real-time market prices for TP/SL triggers.
 */
export async function handleScheduledTradingChecks(env: Env) {
  try {
    const closedEvents = await checkOpenPositions(env);
    for (const event of closedEvents) {
      console.log(`Position ${event.trade.id} (${event.trade.symbol}) closed via ${event.reason}. PnL: ${event.pnlPercent}%`);
      const card = formatTradeClosedCard(event);
      await broadcastToTradingChannel(card, env);
    }
  } catch (err) {
    console.error("Error during scheduled position check:", err);
  }
}

/**
 * 3x Daily Quantitative Scan (00:00 Asian Open, 08:00 London Open, 14:00 NY Open UTC).
 */
export async function handleScheduledTradingScans(env: Env) {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();

  // Scan at minute 0 of 00:00, 08:00, and 14:00 UTC
  const scanHours = [0, 8, 14];
  if (scanHours.includes(utcHour) && utcMinute === 0) {
    console.log(`Executing 3x daily quantitative trading scan at ${utcHour}:00 UTC...`);
    try {
      const { trade, rationale } = await analyzeMarketAndDecide(env);
      if (trade) {
        console.log(`New trade opened by DeepSeek: #${trade.id} ${trade.symbol} ${trade.direction}`);
        const card = formatTradeOpenedCard(trade);
        await broadcastToTradingChannel(card, env);
      } else {
        console.log(`Market scan completed with no trade opened: ${rationale}`);
      }
    } catch (err) {
      console.error("Error during scheduled trading scan:", err);
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Diagnostics: Screener market summary test
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

    // Diagnostics: Paper Trader manual scan trigger
    if (request.method === "GET" && url.pathname === "/test/trader/scan") {
      try {
        const result = await analyzeMarketAndDecide(env);
        if (result.trade) {
          const card = formatTradeOpenedCard(result.trade);
          if (url.searchParams.get("broadcast") === "true") {
            await broadcastToTradingChannel(card, env);
          }
          return new Response(JSON.stringify({ success: true, trade: result.trade, card }, null, 2), {
            headers: { "Content-Type": "application/json" }
          });
        } else {
          return new Response(JSON.stringify({ success: false, rationale: result.rationale }, null, 2), {
            headers: { "Content-Type": "application/json" }
          });
        }
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    // Diagnostics: Paper Trader position check trigger
    if (request.method === "GET" && url.pathname === "/test/trader/check") {
      try {
        const closedEvents = await checkOpenPositions(env);
        for (const event of closedEvents) {
          const card = formatTradeClosedCard(event);
          if (url.searchParams.get("broadcast") === "true") {
            await broadcastToTradingChannel(card, env);
          }
        }
        return new Response(JSON.stringify({ success: true, closedEvents }, null, 2), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    // Diagnostics: Paper Trader stats ledger
    if (request.method === "GET" && url.pathname === "/test/trader/stats") {
      try {
        const stats = await getTradingStats(env);
        const openTrades = await getOpenTrades(env);
        const card = formatTradingStatsCard(stats, openTrades);
        return new Response(JSON.stringify({ stats, openTrades, card }, null, 2), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
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
    ctx.waitUntil(
      Promise.all([
        handleScheduledBriefings(env),
        handleScheduledTradingChecks(env),
        handleScheduledTradingScans(env)
      ])
    );
  }
};

