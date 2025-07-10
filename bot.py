import os
import logging
from telegram import Update
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes
import yfinance as yf
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from datetime import datetime
import pytz
import asyncio
import nest_asyncio

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BOT_TOKEN = os.getenv("BOT_TOKEN")
TIMEZONE = os.getenv("TIMEZONE", "UTC")
USER_TIME = {}

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
        await update.message.reply_text(f"🕒 Got it! I’ll message you daily at {context.args[0]} {TIMEZONE}")
    except ValueError:
        await update.message.reply_text("Invalid time format. Use HH:MM")

async def now(update: Update, context: ContextTypes.DEFAULT_TYPE):
    summary = get_market_summary()
    await update.message.reply_text(summary, parse_mode="Markdown")

def get_market_summary():
    tickers = {
        "^GSPC": "S&P 500",
        "^IXIC": "NASDAQ",
        "BTC-USD": "BTC",
        "ETH-USD": "ETH",
        "GC=F": "GOLD",  # золото
    }

    lines = []
    for symbol, name in tickers.items():
        data = yf.Ticker(symbol).history(period="1d")
        if data.empty:
            continue
        today = data.iloc[-1]
        change = (today["Close"] - today["Open"]) / today["Open"] * 100
        price = today["Close"]

        if change > 0:
            emoji = "❇️"
        elif change < 0:
            emoji = "🔻"
        else:
            emoji = "0️⃣"

        formatted_price = f"{price:,.2f}".replace(",", " ")  # неразрывный пробел между разрядами
        formatted_change = f"{change:+.2f}%"
        lines.append(f"{emoji} {name}: {formatted_price} ({formatted_change})")

    now_date = datetime.now().strftime("%d %B %Y")
    return f"📈 *Markets on {now_date}:*\n\n" + "\n".join(lines)


async def scheduled_job(app):
    for user_id, (h, m, tz) in USER_TIME.items():
        now_ = datetime.now(tz)
        if now_.hour == h and now_.minute == m:
            text = get_market_summary()
            await app.bot.send_message(chat_id=user_id, text=text, parse_mode="Markdown")

async def main():
    app = ApplicationBuilder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("settime", set_time))
    app.add_handler(CommandHandler("now", now))

    scheduler = AsyncIOScheduler(timezone=pytz.utc)

    # Используем async-обертку, чтобы гарантировать выполнение в loop
    async def job_wrapper():
        await scheduled_job(app)

    scheduler.add_job(job_wrapper, "interval", minutes=1)
    scheduler.start()

    await app.run_polling()

if __name__ == "__main__":
    nest_asyncio.apply()
    asyncio.run(main())
