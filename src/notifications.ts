import { Env, PaperTrade } from "./types";
import { formatTradeOpenedCard, formatTradeClosedCard } from "./trader";
import { sendTelegramMessage, TelegramApiError } from "./messaging";

interface PendingNotification extends PaperTrade {
  notification_id: number;
  event_type: "OPEN" | "CLOSED";
  attempts: number;
}

export async function flushTradeNotifications(env: Env): Promise<void> {
  if (!env.TRADING_CHANNEL_ID) return;
  const now = Math.floor(Date.now() / 1000);
  const { results } = await env.DB.prepare(`
    SELECT p.*, n.id AS notification_id, n.event_type, n.attempts
    FROM trade_notifications n JOIN paper_trades p ON p.id = n.trade_id
    WHERE n.delivered_at IS NULL AND n.next_attempt_at <= ? AND n.lease_until <= ?
      AND NOT EXISTS (SELECT 1 FROM trade_notifications earlier
        WHERE earlier.trade_id = n.trade_id AND earlier.id < n.id AND earlier.delivered_at IS NULL)
    ORDER BY n.id LIMIT 5
  `).bind(now, now).all<PendingNotification>();

  for (const item of results || []) {
    const token = crypto.randomUUID();
    const claimNow = Math.floor(Date.now() / 1000);
    const claimed = await env.DB.prepare(`
      UPDATE trade_notifications SET lease_token = ?, lease_until = ?, attempts = attempts + 1
      WHERE id = ? AND delivered_at IS NULL AND lease_until <= ? AND next_attempt_at <= ?
        AND NOT EXISTS (SELECT 1 FROM trade_notifications earlier
          WHERE earlier.trade_id = trade_notifications.trade_id AND earlier.id < trade_notifications.id
            AND earlier.delivered_at IS NULL)
      RETURNING id
    `).bind(token, claimNow + 120, item.notification_id, claimNow, claimNow).first();
    if (!claimed) continue;
    try {
      const text = item.event_type === "OPEN" ? formatTradeOpenedCard(item) : formatTradeClosedCard({
        trade: item, exitPrice: item.exit_price!, reason: item.status === "CLOSED_TP" ? "TP" : "SL",
        pnlPercent: item.pnl_percent!, rMultiple: item.r_multiple!
      });
      await sendTelegramMessage(env.TRADING_CHANNEL_ID, text, env);
      await env.DB.prepare(`
        UPDATE trade_notifications SET delivered_at = ?, lease_until = 0, lease_token = NULL
        WHERE id = ? AND lease_token = ?
      `).bind(Math.floor(Date.now() / 1000), item.notification_id, token).run();
    } catch (error) {
      const delay = Math.max(error instanceof TelegramApiError ? error.retryAfter : 60,
        Math.min(3600, 60 * 2 ** Math.min(item.attempts, 6)));
      await env.DB.prepare(`
        UPDATE trade_notifications SET next_attempt_at = ?, lease_until = 0, lease_token = NULL
        WHERE id = ? AND lease_token = ?
      `).bind(Math.floor(Date.now() / 1000) + delay, item.notification_id, token).run();
      console.error(`Trade notification ${item.notification_id} deferred:`, error);
    }
  }
}
