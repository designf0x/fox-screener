import os
import logging
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes, CallbackQueryHandler
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
USER_TIME = {}  # {chat_id: (hour, minute)}
USER_TZ = {}    # {chat_id: timezone object}

# Predefined timezones for keyboard
PREDEFINED_TIMEZONES = [
    ["Europe/Moscow", "Asia/Bangkok"],
    ["Asia/Tokyo", "America/New_York"],
    ["Europe/London", "UTC"]
]

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    keyboard = [[InlineKeyboardButton(tz, callback_data=f"tz_{tz}") for tz in row] for row in PREDEFINED_TIMEZONES]
    reply_markup = InlineKeyboardMarkup(keyboard)
    await update.message.reply_text(
        "Hi! I’ll send you a daily market summary.\nChoose your timezone:",
        reply_markup=reply_markup
    )

async def button_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data

    if data.startswith("tz_"):
        tz_name = data[3:]
        try:
            tz = pytz.timezone(tz_name)
            USER_TZ[query.message.chat_id] = tz
            await query.edit_message_text(f"\U0001F30D Timezone set to {tz_name}\nNow use /settime HH:MM to set delivery time.")
        except pytz.UnknownTimeZoneError:
            await query.edit_message_text("Invalid timezone.")

async def set_timezone(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if len(context.args) != 1:
        return await update.message.reply_text("Please provide timezone like /settimezone Europe/Moscow")
    try:
        tz = pytz.timezone(context.args[0])
        USER_TZ[update.effective_chat.id] = tz
        await update.message.reply_text(f"\U0001F30D Timezone set to {context.args[0]}")
    except pytz.UnknownTimeZoneError:
        await update.message.reply_text("Invalid timezone. Use names like Europe/Moscow or Asia/Bangkok")

async def set_time(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if len(context.args) != 1:
        return await update.message.reply_text("Please use HH:MM format, e.g., /settime 09:30")
    if update.effective_chat.id not in USER_TZ:
        return await update.message.reply_text("Set your timezone first with /settimezone")
    try:
        t = datetime.strptime(context.args[0], "%H:%M").time()
        USER_TIME[update.effective_chat.id] = (t.hour, t.minute)
        await update.message.reply_text(f"\U0001F552 Got it! I’ll message you daily at {context.args[0]} in your timezone")
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

        formatted_price = f"{price:,.2f}".replace(",", " ")
        formatted_change = f"{change:+.2f}%"
        lines.append(f"{emoji} {name}: {formatted_price} ({formatted_change})")

    now_date = datetime.now().strftime("%d %B %Y")
    return f"📈 *Markets on {now_date}:*\n\n" + "\n".join(lines)


async def scheduled_job(app):
    for chat_id, (h, m) in USER_TIME.items():
        tz = USER_TZ.get(chat_id, pytz.utc)
        now_ = datetime.now(tz)
        if now_.hour == h and now_.minute == m:
            text = get_market_summary()
            await app.bot.send_message(chat_id=chat_id, text=text, parse_mode="Markdown")

async def main():
    app = ApplicationBuilder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("settimezone", set_timezone))
    app.add_handler(CommandHandler("settime", set_time))
    app.add_handler(CommandHandler("now", now))
    app.add_handler(CallbackQueryHandler(button_handler))

    scheduler = AsyncIOScheduler(timezone=pytz.utc)

    async def job_wrapper():
        await scheduled_job(app)

    scheduler.add_job(job_wrapper, "interval", minutes=1)
    scheduler.start()

    await app.run_polling(allowed_updates=Update.ALL_TYPES)

if __name__ == "__main__":
    nest_asyncio.apply()
    asyncio.run(main())
