import os
import logging
import asyncio
from datetime import datetime
import pytz
import yfinance as yf
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes, CallbackQueryHandler
from apscheduler.schedulers.asyncio import AsyncIOScheduler

# Import database storage layer
from storage import storage

# Configure Logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger(__name__)

# Load config
BOT_TOKEN = os.getenv("BOT_TOKEN")
USER_TIME = {}  # {chat_id: (hour, minute)}
USER_TZ = {}    # {chat_id: timezone object}

# Predefined timezones for keyboard
PREDEFINED_TIMEZONES = [
    ["UTC", "Europe/Kyiv"],
    ["Europe/Moscow", "Europe/London"],
    ["Asia/Bangkok", "Asia/Singapore"],
    ["Asia/Tokyo", "America/New_York"]
]

# === APScheduler Helpers / Dynamic Scheduling ===
def schedule_user_job(scheduler, app, chat_id: int, tz, hour: int, minute: int):
    """Schedules or updates a user's specific daily cron job."""
    job_id = f"reminder_{chat_id}"
    
    # Remove existing job if already scheduled
    if scheduler.get_job(job_id):
        scheduler.remove_job(job_id)
    
    # Add new cron job
    scheduler.add_job(
        send_daily_summary,
        trigger="cron",
        hour=hour,
        minute=minute,
        timezone=tz,
        id=job_id,
        args=[app, chat_id]
    )
    logger.info(f"Successfully scheduled event-driven cron job '{job_id}' for {hour:02d}:{minute:02d} in timezone {tz}")

async def send_daily_summary(app, chat_id: int):
    """Job execution function triggered at user's local time."""
    try:
        tz = USER_TZ.get(chat_id, pytz.utc)
        summary = await get_market_summary(tz)
        await app.bot.send_message(chat_id=chat_id, text=summary, parse_mode="Markdown")
        logger.info(f"Delivered scheduled daily briefing to user {chat_id}")
    except Exception as e:
        logger.error(f"Failed to deliver scheduled briefing to user {chat_id}: {e}")

# === Ticker Data Scraper (Concurrent & Thread-Safe) ===
def fetch_symbol_data(symbol: str):
    """Synchronous ticker fetch executed inside background threads."""
    try:
        ticker = yf.Ticker(symbol)
        data = ticker.history(period="1d")
        if data.empty:
            logger.warning(f"Ticker history for {symbol} returned empty.")
            return None
        return data.iloc[-1]
    except Exception as e:
        logger.error(f"Error fetching data for symbol {symbol}: {e}")
        return None

async def get_market_summary(tz=pytz.utc) -> str:
    """Fetches market tickers concurrently and formats a stunning summary."""
    tickers = {
        "^GSPC": "S&P 500",
        "^IXIC": "NASDAQ",
        "BTC-USD": "BTC",
        "ETH-USD": "ETH",
        "GC=F": "GOLD",
        "CL=F": "OIL",
    }

    groups = [
        ["^GSPC", "^IXIC"],
        ["BTC-USD", "ETH-USD"],
        ["GC=F", "CL=F"]
    ]

    symbols = list(tickers.keys())

    # Run yfinance fetches concurrently in separate threads to avoid blocking the event loop
    logger.info("Fetching ticker histories concurrently in threadpool...")
    tasks = [asyncio.to_thread(fetch_symbol_data, symbol) for symbol in symbols]
    results = await asyncio.gather(*tasks)
    
    symbol_results = dict(zip(symbols, results))
    lines = []

    for group in groups:
        for symbol in group:
            name = tickers[symbol]
            today = symbol_results.get(symbol)
            
            if today is None:
                lines.append(f"⚠️ *{name}*: Data temporarily unavailable")
                continue

            try:
                change = (today["Close"] - today["Open"]) / today["Open"] * 100
                price = today["Close"]

                if change > 0:
                    emoji = "❇️"
                elif change < 0:
                    emoji = "🔻"
                else:
                    emoji = "0️⃣"

                # Thousands spacing formatting matching locale style
                formatted_price = f"{price:,.2f}".replace(",", " ")
                formatted_change = f"_{change:+.2f}%_"
                lines.append(f"{emoji} *{name}*: {formatted_price} ({formatted_change})")
            except Exception as e:
                logger.error(f"Error formatting data for {name}: {e}")
                lines.append(f"⚠️ *{name}*: Formatting error")
        lines.append("")

    now_date = datetime.now(tz).strftime("%d %B %Y")
    return f"📈 *Markets on {now_date}:*\n\n" + "\n".join(lines).strip()

# === Bot Commands ===
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Greets the user and presents timezone selection buttons."""
    logger.info(f"📥 Received /start command from chat_id {update.effective_chat.id}")
    keyboard = [[InlineKeyboardButton(tz, callback_data=f"tz_{tz}") for tz in row] for row in PREDEFINED_TIMEZONES]
    reply_markup = InlineKeyboardMarkup(keyboard)
    await update.message.reply_text(
        "Hi! I’m the Fox Market Screener Bot. 🦊📈\n"
        "I will deliver high-performance daily summaries of global markets directly to you.\n\n"
        "Please choose your timezone to begin:",
        reply_markup=reply_markup
    )

async def button_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Processes interactive timezone selection clicks."""
    query = update.callback_query
    logger.info(f"📥 Received callback query from chat_id {query.message.chat_id}: {query.data}")
    await query.answer()
    data = query.data
    chat_id = query.message.chat_id

    if data.startswith("tz_"):
        tz_name = data[3:]
        try:
            tz = pytz.timezone(tz_name)
            USER_TZ[chat_id] = tz
            
            # Save or update in database if time was already set
            if chat_id in USER_TIME:
                h, m = USER_TIME[chat_id]
                storage.save_user_settings(chat_id, tz_name, h, m)
                scheduler = context.application.bot_data["scheduler"]
                schedule_user_job(scheduler, context.application, chat_id, tz, h, m)
                await query.edit_message_text(
                    f"🌍 Timezone successfully saved: {tz_name}\n"
                    f"🕒 Daily briefing rescheduled to {h:02d}:{m:02d}!"
                )
            else:
                await query.edit_message_text(
                    f"🌍 Timezone successfully set to: {tz_name}\n"
                    f"👉 Use the command `/settime HH:MM` (e.g., `/settime 09:30`) to choose your delivery time."
                )
        except pytz.UnknownTimeZoneError:
            await query.edit_message_text("Invalid timezone selection.")

async def set_timezone(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Allows manual timezone settings via CLI arguments."""
    chat_id = update.effective_chat.id
    logger.info(f"📥 Received /settimezone command from chat_id {chat_id} with args {context.args}")
    if len(context.args) != 1:
        return await update.message.reply_text("Please provide your timezone, e.g., `/settimezone Europe/Moscow`")
    
    tz_name = context.args[0]
    try:
        tz = pytz.timezone(tz_name)
        USER_TZ[chat_id] = tz
        
        if chat_id in USER_TIME:
            h, m = USER_TIME[chat_id]
            storage.save_user_settings(chat_id, tz_name, h, m)
            scheduler = context.application.bot_data["scheduler"]
            schedule_user_job(scheduler, context.application, chat_id, tz, h, m)
            await update.message.reply_text(
                f"🌍 Timezone set manually to: {tz_name}\n"
                f"🕒 Daily briefing rescheduled to {h:02d}:{m:02d}!"
            )
        else:
            await update.message.reply_text(
                f"🌍 Timezone set manually to: {tz_name}\n"
                f"👉 Use the command `/settime HH:MM` (e.g., `/settime 09:30`) to choose your delivery time."
            )
    except pytz.UnknownTimeZoneError:
        await update.message.reply_text("Invalid timezone string. E.g. Europe/Moscow, Asia/Bangkok, America/New_York.")

async def set_time(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Configures daily briefing time and persists state to SQLite."""
    chat_id = update.effective_chat.id
    logger.info(f"📥 Received /settime command from chat_id {chat_id} with args {context.args}")
    if len(context.args) != 1:
        return await update.message.reply_text("Please use HH:MM format, e.g., `/settime 09:30`")
    if chat_id not in USER_TZ:
        return await update.message.reply_text("Set your timezone first using `/start` or `/settimezone`!")
    
    try:
        t = datetime.strptime(context.args[0], "%H:%M").time()
        USER_TIME[chat_id] = (t.hour, t.minute)
        tz = USER_TZ[chat_id]
        
        # Save to SQLite database
        storage.save_user_settings(chat_id, tz.zone, t.hour, t.minute)
        
        # Add event-driven Cron Job to Scheduler
        scheduler = context.application.bot_data["scheduler"]
        schedule_user_job(scheduler, context.application, chat_id, tz, t.hour, t.minute)
        
        await update.message.reply_text(
            f"🕒 Setup complete! I'll message you a daily market briefing at {context.args[0]} "
            f"in your timezone ({tz.zone})."
        )
    except ValueError:
        await update.message.reply_text("Invalid time format. Use HH:MM")

async def now(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Instantly delivers the concurrent market summary without blocking."""
    chat_id = update.effective_chat.id
    logger.info(f"📥 Received /now command from chat_id {chat_id}")
    tz = USER_TZ.get(chat_id, pytz.utc)
    
    # Notify user that bot is loading to keep UX excellent
    await context.bot.send_chat_action(chat_id=chat_id, action="typing")
    
    summary = await get_market_summary(tz)
    await update.message.reply_text(summary, parse_mode="Markdown")

# === Application Lifecycle Callbacks ===
async def post_init(app):
    """Lifecycle callback executed by python-telegram-bot on startup."""
    logger.info("Executing post-initialization database and scheduler setup...")
    
    # Initialize Async Scheduler
    scheduler = AsyncIOScheduler(timezone=pytz.utc)
    app.bot_data["scheduler"] = scheduler

    # Load stored user configurations from SQLite
    try:
        stored_configs = storage.get_all_user_settings()
        for conf in stored_configs:
            chat_id = conf["chat_id"]
            tz_name = conf["timezone"]
            hour = conf["hour"]
            minute = conf["minute"]
            try:
                tz = pytz.timezone(tz_name)
                USER_TZ[chat_id] = tz
                USER_TIME[chat_id] = (hour, minute)
                
                # Schedule job on startup
                schedule_user_job(scheduler, app, chat_id, tz, hour, minute)
            except Exception as e:
                logger.error(f"Failed to schedule user {chat_id} on startup: {e}")
        logger.info(f"Successfully loaded and scheduled {len(USER_TIME)} active user briefings.")
    except Exception as e:
        logger.error(f"Failed to load configurations from database: {e}")

    # Start Scheduler
    scheduler.start()
    logger.info("Scheduler successfully started.")

async def post_shutdown(app):
    """Lifecycle callback executed by python-telegram-bot on shutdown."""
    logger.info("Executing post-shutdown cleanup...")
    scheduler = app.bot_data.get("scheduler")
    if scheduler:
        scheduler.shutdown()
        logger.info("Scheduler successfully stopped.")

# === Main Entry ===
def main():
    if not BOT_TOKEN:
        logger.error("Environment variable 'BOT_TOKEN' is missing! Please configure it in your environment.")
        return

    # Initialize Telegram Application with robust timeouts and official lifecycle hooks
    app = (
        ApplicationBuilder()
        .token(BOT_TOKEN)
        .connect_timeout(30.0)
        .read_timeout(30.0)
        .post_init(post_init)
        .post_shutdown(post_shutdown)
        .build()
    )

    # Register Handlers
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("settimezone", set_timezone))
    app.add_handler(CommandHandler("settime", set_time))
    app.add_handler(CommandHandler("now", now))
    app.add_handler(CallbackQueryHandler(button_handler))

    # Run polling synchronously (it internally sets up and manages its own event loop lifecycle)
    logger.info("Starting bot polling synchronously...")
    app.run_polling(allowed_updates=Update.ALL_TYPES)

if __name__ == "__main__":
    main()
