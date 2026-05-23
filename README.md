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
- `/now` — Delivers a real-time markets snapshot instantly.

---

## 🔧 Project Structure

- `src/index.ts` — Handles webhook HTTP requests and Cron scheduled events.
- `src/telegram.ts` — Command router, callback query handler, and Telegram messaging logic.
- `src/yahoo.ts` — High-speed concurrent market data fetcher and summary formatter.
- `src/types.ts` — Type definitions and Cloudflare environment bindings.
- `schema.sql` — Database schema for the Cloudflare D1 SQLite database.

---

## 💻 Local Setup & Development

### 1. Install Dependencies
Make sure you have Node.js and `pnpm` installed:
```bash
pnpm install
```

### 2. Run Local Dev Server
Start Wrangler's local emulation server:
```bash
pnpm run dev
```

---

## 🌐 Deploy to Cloudflare Workers

Follow these steps to deploy the bot to Cloudflare for free:

### Step 1: Create a D1 Database
Create your SQLite database instance:
```bash
npx wrangler d1 create screener_settings
```
Copy the generated `database_id` and paste it into [wrangler.json](file:///Users/ilasbikbulatov/Documents/Gemini/PyBot/fox-screener-main/wrangler.json):
```json
"database_id": "YOUR-DATABASE-ID"
```

### Step 2: Initialize Database Schema
Apply the database schema to both local and remote environments:
```bash
# Production (Cloudflare Edge)
npx wrangler d1 execute screener_settings --remote --file=schema.sql

# Local Development
npx wrangler d1 execute screener_settings --local --file=schema.sql
```

### Step 3: Configure Telegram Bot Token
Bind your Telegram `BOT_TOKEN` securely to the Worker:
```bash
npx wrangler secret put BOT_TOKEN
```
*When prompted, paste your active Telegram Bot Token.*

### Step 4: Deploy the Worker
Deploy the code to Cloudflare's edge network:
```bash
pnpm run deploy
```

### Step 5: Register the Telegram Webhook
To link your Telegram bot to the newly deployed Worker, replace `<YOUR_BOT_TOKEN>` and `<YOUR_WORKER_URL>` in the URL below and load it in your browser:
```text
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://<YOUR_WORKER_URL>
```
*Example response:*
```json
{ "ok": true, "result": true, "description": "Webhook was set" }
```

---

## 🩺 Diagnostics & Health Check

The worker exposes a secure endpoint to verify that the Yahoo Finance API is fetching and formatting correctly from Cloudflare's IP range:

- **Endpoint**: `https://<YOUR_WORKER_URL>/test`
- **Method**: `GET`
- **Response**: Real-time compiled markdown summary of market indices.
