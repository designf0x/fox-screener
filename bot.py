import os
import logging
from telegram import Update
from telegram.ext import Updater, CommandHandler, CallbackContext
import yfinance as yf
from apscheduler.schedulers.background import BackgroundScheduler
from datetime import datetime
import pytz

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BOT_TOKEN = os.getenv("BOT_TOKEN")
TIMEZONE = os.getenv("TIMEZONE", "UTC")
USER_TIME = {}

def start(update: Update, context: CallbackContext):
    update.message.reply_text(
        "Привет! Я пришлю сводку по рынку. Установи время командой /settime например `/settime 10:00`."
    )

def set_time(update: Update, context: CallbackContext):
    text = update.message.text.split(maxsplit=1)
    if len(text) < 2:
        return update.message.reply_text("Укажи время в формате ЧЧ:ММ, например: /settime 09:30")
    try:
        t = datetime.strptime(text[1], "%H:%M").time()
        tz = pytz.timezone(TIMEZONE)
        USER_TIME[update.effective_user.id] = (t.hour, t.minute, tz)
        update.message.reply_text(f"🕒 Окей, буду присылать каждый день в {text[1]} {TIMEZONE}")
    except ValueError:
        update.message.reply_text("Неверный формат — используй ЧЧ:ММ")

def now(update: Update, context: CallbackContext):
    text = get_market_summary()
    update.message.reply_text(text, parse_mode="Markdown")

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
        lines.append(f"— *{name}*: {price:.2f} ({change:+.2f} %)")
    now_date = datetime.now().strftime("%Y-%m-%d")
    return f"📈 *Рынки на {now_date}:*
" + "\n".join(lines)

def schedule_jobs(updater: Updater):
    scheduler = BackgroundScheduler(timezone=pytz.utc)
    scheduler.start()
    def job():
        for user_id, (h, m, tz) in USER_TIME.items():
            now_ = datetime.now(tz)
            if now_.hour == h and now_.minute == m:
                text = get_market_summary()
                updater.bot.send_message(chat_id=user_id, text=text, parse_mode="Markdown")
    scheduler.add_job(job, 'interval', minutes=1)

def main():
    updater = Updater(BOT_TOKEN)
    dp = updater.dispatcher
    dp.add_handler(CommandHandler("start", start))
    dp.add_handler(CommandHandler("settime", set_time))
    dp.add_handler(CommandHandler("now", now))
    schedule_jobs(updater)
    updater.start_polling()
    updater.idle()

if __name__ == "__main__":
    main()
