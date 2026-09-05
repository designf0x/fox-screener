# Fox Screener Bot 🦊📈

A high-performance, serverless Telegram bot that delivers daily global market summaries (stocks, crypto, and commodities). Built with **TypeScript**, running globally at the edge on **Cloudflare Workers**, and persisting user preferences natively on **Cloudflare D1 (SQLite)**.

---

## ⚡ Key Features

- **Edge Performance**: Powered by Cloudflare Workers for near-instant response times and 100% free hosting.
- **SQLite Persistence**: Uses Cloudflare D1 for storing per-user preferences, timezones, and schedules.
- **Dynamic Scheduler**: Leverages Cloudflare Cron Triggers to query and deliver daily briefings right on time.
- **Resilient Quote Scraper**: Uses Yahoo Finance's crumb-free `/v8/finance/chart` API to perform parallel market data fetches under 100ms.
- **Aesthetic Formatting**: Outputs numbers in French-style spacing (e.g. `7 473.47`) with precise emoji indicators and local timezones.

---

## 🚀 Commands

- `/start` — Interactively select your timezone via inline keyboard buttons.
- `/settime HH:MM` — Set your daily briefing delivery time (e.g., `/settime 09:30`).
- `/settimezone <zone>` — Manually set your timezone (e.g., `/settimezone Europe/Kyiv`).
- `/now` — Delivers a markets snapshot.
- `/scan` or `/tradescan` — Runs a paper-trade scan within the chat's request and daily token limits.
- `/stats` or `/trader` — Shows paper-trading performance.
- `/trades` or `/journal` — Shows open positions and recent exits.

---

## 🔧 Project Structure

- `src/index.ts` — Handles webhook HTTP requests and Cron scheduled events.
- `src/telegram.ts` — Command router, callback query handler, and Telegram messaging logic.
- `src/yahoo.ts` — High-speed concurrent market data fetcher and summary formatter.
- `src/types.ts` — Type definitions and Cloudflare environment bindings.
- `schema.sql` — Baseline database schema.
- `migrations/` — Versioned, additive database upgrades.
- `src/webhook.ts` — Authenticated update processing and duplicate protection.
- `src/messaging.ts` — Telegram delivery and Markdown fallback.
- `src/notifications.ts` — Persistent trade notification retries.

---

## 💻 Local Setup & Development

### 1. Install Dependencies
Use Node.js 22.13 or newer (the tests use built-in SQLite), and install `pnpm`:
```bash
pnpm install
```

### 2. Run Local Dev Server
Copy `.dev.vars.example` to `.dev.vars` and fill in local credentials. The secrets file is ignored by Git. Initialize a local database before starting:
```bash
pnpm exec wrangler d1 execute screener_settings --local --file=schema.sql
pnpm exec wrangler d1 migrations apply screener_settings --local
pnpm run dev
```

Run verification:
```bash
pnpm run typecheck
pnpm test
pnpm run test:worker
```
The regression suite uses the actual Worker modules with an in-memory SQLite database. The runtime smoke test bundles the Worker and runs it against local workerd/D1; it needs loopback networking. All external provider requests in both suites are mocked.

---

## 🌐 Deploy to Cloudflare Workers

Follow these steps to deploy the bot to Cloudflare for free:

### Step 1: Create a D1 Database
Create your SQLite database instance:
```bash
npx wrangler d1 create screener_settings
```
Copy the generated `database_id` and paste it into [wrangler.json](wrangler.json):
```json
"database_id": "YOUR-DATABASE-ID"
```

### Step 2: Initialize Database Schema
Apply the database schema to both local and remote environments:
```bash
# Production (Cloudflare Edge)
npx wrangler d1 execute screener_settings --remote --file=schema.sql
npx wrangler d1 migrations apply screener_settings --remote

# Local Development
npx wrangler d1 execute screener_settings --local --file=schema.sql
npx wrangler d1 migrations apply screener_settings --local
```

### Step 3: Configure secrets
Store distinct random secrets for webhook delivery and administrative diagnostics, along with provider credentials:
```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put DIAGNOSTICS_TOKEN
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put TRADING_CHANNEL_ID
```
Use 32 or more random URL-safe characters for each authentication secret. Optional settings include `TAVILY_API_KEY`, `BOT_USERNAME`, and `TRADING_CHANNEL_URL` (a public or invite `https://t.me/...` link). A numeric channel ID needs a separate URL for the briefing link; otherwise the link is omitted. A configured `@username` generates its own link.

Requests fail closed if the corresponding authentication secret is missing. Scheduled work uses the provider credentials independently of the HTTP secrets.

### Step 4: Register the authenticated Telegram webhook
With `BOT_TOKEN`, `WORKER_URL`, and `WEBHOOK_SECRET` set in your shell, register the same webhook secret configured on the Worker:
```bash
curl --fail --silent --show-error -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WORKER_URL}/" \
  --data-urlencode "secret_token=${WEBHOOK_SECRET}"
```
Telegram sends `X-Telegram-Bot-Api-Secret-Token` on subsequent updates. See [Telegram's webhook documentation](https://core.telegram.org/bots/api#setwebhook).

### Step 5: Deploy
```bash
pnpm run deploy
```

### Upgrading an existing deployment
Apply `0001_reliability.sql` through `wrangler d1 migrations apply` before deploying this code. The migration adds a nullable trade source key, update claims, and notification tables/triggers; existing trades and user settings remain intact. It does not rebroadcast historical trades or repair previously corrupted statistics. Existing duplicate positions are preserved and consume the open-position limit until they close.

Configure the new secrets and register the authenticated webhook before deploying. Wrangler records migration application, so subsequent `migrations apply` runs skip it. Do not execute the migration file manually a second time. See [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).

### Trading and delivery behavior
- New positions require a fresh quote (at most `MAX_QUOTE_AGE_SECONDS`, default 300 seconds) and an active regular session for non-crypto assets. Delayed index feeds can therefore be excluded. The entry quote is refreshed after AI inference.
- Position insertion enforces three open trades total and one per symbol in a single SQL statement. Minimum R:R is 1.5. Exits use conditional updates to prevent conflicting closures.
- Cron uses its scheduled timestamp for briefings and the 00:00, 08:00, and 14:00 UTC scans. Position checks finish before the scan.
- Trade changes enqueue notifications atomically. Pending notifications are retried each minute with backoff and in order per trade. If the channel is not configured, they remain pending. A lost Telegram response after successful acceptance can still cause a duplicate message on retry; the trade itself is not duplicated.
- Duplicate Telegram update IDs are claimed in D1. Failed processing returns 503 for retry; crashed claims expire after ten minutes. A unique trade source key preserves an already committed scan across retries.
- Manual scans charge the provider's reported token usage, including HOLD and rejected setups. The daily limit gates new requests; an already admitted request can cross the remaining token allowance. Trusted diagnostics and scheduled scans are separate administrative operations, outside per-chat quotas.
- Daily trading stats are automatically published to the configured trading channel once every day at 21:00 UTC (configurable via `DAILY_STATS_HOUR`).

---

## 🩺 Diagnostics & Health Check

Every diagnostic request requires `Authorization: Bearer <DIAGNOSTICS_TOKEN>`.

| Endpoint | Method | Action |
| --- | --- | --- |
| `/test` | GET | Compile market summary |
| `/test/trader/stats` | GET | Read trading statistics |
| `/test/trader/scan` | POST | Run a scan and persist any resulting trade |
| `/test/trader/check` | POST | Check exits and retry queued notifications |
| `/test/trader/ping` | POST | Send a test statistics card to the configured channel |

Example with `WORKER_URL` and `DIAGNOSTICS_TOKEN` set in your shell:
```bash
curl --fail --silent --show-error -X POST "${WORKER_URL}/test/trader/scan" \
  -H "Authorization: Bearer ${DIAGNOSTICS_TOKEN}"
```
Trade-changing diagnostics always enqueue channel notifications. The former `broadcast` query parameter is no longer used; requesting a scan changes the shared paper-trading ledger. GET requests cannot mutate it.
