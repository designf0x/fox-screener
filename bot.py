import os
import logging
from telegram import Update
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes
import yfinance as yf
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from datetime import datetime
import pytz

# Логирование
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BOT_TOKEN = os.getenv("BOT_TOKEN")
TIMEZONE = os.getenv("TIMEZONE", "UTC")
USER_TIME = {}

# Команда /start
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "Привет! Я пришлю сводку по рынку. Установи время командой /settime, например: /settime 10:00"
    )

# Команда /settime
async def set_time(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if len(context.args) != 1:
        return await update.message.reply_text("Укажи время в формате ЧЧ:ММ, например: /settime 09:30")
    try:
        t = datetime.strptime(context.args[0], "%H:%M").time()
        tz = pytz.timezone(TIMEZONE)
        USER_TIME[update.effective_user.id] = (t.hour, t.minute, tz)
        await update.message.reply_text(f"🕒 Окей, буду присылать каждый день в {context.args[0]} {TIMEZONE}")
    except ValueError:
        await update.message.reply_text("Неверный формат — используй ЧЧ:ММ")

# Команда /now
async def now(update: Update, context: ContextTypes.DEFAULT_TYPE):
    summary = get_market_summary()
    await update.message.reply_text(summary, parse_mode="Markdown")

# Генерация текста рыночной сводки
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
    return f"📈 *Рынки на {now_date}:*\n" + "\n".join(lines)

# Планировщик
async def scheduled_job(app):
    for user_id, (h, m, tz) in USER_TIME.items():
        now_ = datetime.now(tz)
        if now_.hour == h and now_.minute == m:
            text = get_market_summary()
            try:
                await app.bot.send_message(chat_id=user_id, text=text, parse_mode="Markdown")
            except Exception as e:
                logger.warning(f"Ошибка при отправке: {e}")

# Главная функция
async def main():
    app = ApplicationBuilder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("settime", set_time))
    app.add_handler(CommandHandler("now", now))

    # Планировщик
    scheduler = AsyncIOScheduler(timezone=pytz.utc)
    scheduler.add_job(lambda: scheduled_job(app), trigger="interval", minutes=1)
    scheduler.start()

    await app.run_polling()

# Запуск
if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
