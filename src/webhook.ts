import { Env } from "./types";
import { routeWebhookUpdate } from "./telegram";

// Compare fixed-length hashes to avoid exposing a secret prefix through timing.
export async function matchesSecret(actual: string | null, expected: string): Promise<boolean> {
  if (!actual) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([actual, expected].map(value =>
    crypto.subtle.digest("SHA-256", encoder.encode(value))));
  const left = new Uint8Array(a), right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

export async function processWebhook(request: Request, env: Env): Promise<Response> {
  let update: any;
  try { update = await request.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) {
    return new Response("Invalid update ID", { status: 400 });
  }
  const token = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    const claim = await env.DB.prepare(`
      INSERT INTO telegram_updates (update_id, status, lease_token, lease_until)
      VALUES (?, 'PROCESSING', ?, ?)
      ON CONFLICT(update_id) DO UPDATE SET lease_token = excluded.lease_token, lease_until = excluded.lease_until
      WHERE telegram_updates.status = 'PROCESSING' AND telegram_updates.lease_until <= ?
      RETURNING update_id
    `).bind(update.update_id, token, now + 600, now).first();
    if (!claim) {
      const existing = await env.DB.prepare("SELECT status FROM telegram_updates WHERE update_id = ?")
        .bind(update.update_id).first<{ status: string }>();
      return existing?.status === "DONE" ? new Response("OK") : new Response("Processing", { status: 503 });
    }
    await routeWebhookUpdate(update, env);
    await env.DB.prepare("UPDATE telegram_updates SET status = 'DONE', lease_until = 0 WHERE update_id = ? AND lease_token = ?")
      .bind(update.update_id, token).run();
    return new Response("OK");
  } catch (error) {
    console.error("Error routing webhook update:", error);
    // Release only our claim. A committed trade keeps its unique source_key on retry.
    try {
      await env.DB.prepare("DELETE FROM telegram_updates WHERE update_id = ? AND lease_token = ? AND status = 'PROCESSING'")
        .bind(update.update_id, token).run();
    } catch (releaseError) { console.error("Webhook claim will expire:", releaseError); }
    return new Response("Processing failed", { status: 503 });
  }
}
