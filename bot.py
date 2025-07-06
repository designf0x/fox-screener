import os
import logging
from telegram import Update
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes
import yfinance as yf
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from datetime import datetime
import pytz
import asyncio

# Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BOT_TOKEN = os.getenv("BOT_TOKEN")
TIMEZONE = os.getenv("TIMEZONE", "UTC")
ADMIN_ID = os.getenv("ADMIN_ID")  # добавь свой Telegram user_id в Railway
USER_TIME = {}

# Send error message to admin
async def safe_send_error(app, msg):
    if ADMIN_ID:
        try:
            await app.bot.send_message(chat_id=int(ADMIN_ID), text=f"❗️Error:
{msg}")
        except Exception as e:
            logger.error(f"Failed to send error to admin: {e}")

# Commands
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "Hi! I’ll send you a daily market summary. Set your time with /settime, e.g., /settime 10:00"
    )

async def set_time(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if len(context.args) != 1:
        return await update.message.reply_text("Please use HH:MM format, e.g., /settime 09:30")
    try:
        t = datetime.strptime(context.args[0], "%H:%M").time()
        tz = pytz.timezone(TIMEZONE)
        USER_TIME[update.effective_user.id] = (t.hour, t.minute, tz)
        await update.message.reply_text(f"🕒 Got it! I’ll message you every day at {context.args[0]} {TIMEZONE}")
    except ValueError:
        await update.message.reply_text("Invalid time format. Use HH:MM")

async def now(update: Update, context: ContextTypes.DEFAULT_TYPE):
    summary = get_market_summary()
    await update.message.reply_text(summary, parse_mode="Markdown")

# Market summary
def get_market_summary():
    tickers = {
        "^GSPC": "S&P 500",
        "^IXIC": "NASDAQ",
        "BTC-USD": "BTC",
        "ETH-USD": "ETH",
    }
    lines = []
    for symbol, name in tickers.items():
        data = yf.Ticker(symbol).history(period="1d")
        if data.empty:
            continue
        today = data.iloc[-1]
        change = (today["Close"] - today["Open"]) / today["Open"] * 100
        price = today["Close"]
        lines.append(f"— *{name}*: {price:.2f} ({change:+.2f}%)")
    now_date = datetime.now().strftime("%Y-%m-%d")
    return f"📈 *Markets on {now_date}:*\n" + "\n".join(lines)

# Scheduled job
async def scheduled_job(app):
    try:
        for user_id, (h, m, tz) in USER_TIME.items():
            now_ = datetime.now(tz)
            if now_.hour == h and now_.minute == m:
                text = get_market_summary()
                await app.bot.send_message(chat_id=user_id, text=text, parse_mode="Markdown")
    except Exception as e:
        await safe_send_error(app, str(e))

# Main app logic
async def main():
    app = ApplicationBuilder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("settime", set_time))
    app.add_handler(CommandHandler("now", now))

    scheduler = AsyncIOScheduler(timezone=pytz.utc)
    scheduler.add_job(lambda: asyncio.create_task(scheduled_job(app)), trigger="interval", minutes=1)
    scheduler.start()
    logger.info("Scheduler started")

    await app.run_polling()

# Entry point
if __name__ == "__main__":
    try:
        loop = asyncio.get_event_loop()
        loop.run_until_complete(main())
    except RuntimeError:
        asyncio.ensure_future(main())
