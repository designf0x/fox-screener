# Fox Screener Bot 🦊📈

A Telegram bot that delivers daily market summaries — stocks and crypto.

## 🚀 Commands

- `/start` — welcome message and instructions
- `/settime HH:MM` — set daily briefing time (24h format)
- `/now` — get the market summary immediately

## 🔧 Environment Variables

Set these in your Railway project or in a `.env` file:

- `BOT_TOKEN` — your Telegram bot token
- `TIMEZONE` — desired timezone (e.g., Europe/Moscow)

## 💻 Run Locally

```bash
pip install -r requirements.txt
python bot.py
```

## 🌐 Deploy to Railway

1. Go to [railway.app](https://railway.app) and create a new project
2. Link your GitHub repo with this code
3. In the **Variables** section, add:
   - `BOT_TOKEN`
   - `TIMEZONE`
4. Click **Deploy** — the bot will start automatically!
