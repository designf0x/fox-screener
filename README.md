---
title: Fox Screener Bot
emoji: 🦊
colorFrom: yellow
colorTo: red
sdk: docker
pinned: false
---

# Fox Screener Bot 🦊📈

A Telegram bot that delivers daily market summaries — stocks and crypto.

## 🚀 Commands

- `/start` — welcome message and instructions
- `/settime HH:MM` — set daily briefing time (24h format)
- `/now` — get the market summary immediately

## 🔧 Environment Variables

Set these in your Hugging Face Space Secrets or in a `.env` file:

- `BOT_TOKEN` — your Telegram bot token

## 💻 Run Locally

```bash
pip install -r requirements.txt
python bot.py
```

## 🌐 Deploy to Hugging Face Spaces

1. Go to [huggingface.co](https://huggingface.co) and create a new **Space**
2. Choose **Docker** with the **Blank** template
3. Set visibility to **Private**
4. In the **Settings** tab under **Variables and secrets**, add a secret:
   - `BOT_TOKEN`
5. Push your code to the Hugging Face Space Git repository — the bot will compile and start automatically!
