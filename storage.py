import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "screener_settings.db"

class ScreenerStorage:
    def __init__(self):
        self.db_path = DB_PATH
        self.init_db()

    def get_connection(self):
        return sqlite3.connect(self.db_path)

    def init_db(self):
        """Creates the necessary table if it does not exist."""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS user_settings (
                    chat_id INTEGER PRIMARY KEY,
                    timezone TEXT NOT NULL,
                    hour INTEGER NOT NULL,
                    minute INTEGER NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.commit()

    def save_user_settings(self, chat_id: int, timezone: str, hour: int, minute: int):
        """Saves or updates user timezone and briefing time schedule."""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT OR REPLACE INTO user_settings (chat_id, timezone, hour, minute, updated_at)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            """, (chat_id, timezone, hour, minute))
            conn.commit()

    def get_all_user_settings(self) -> list:
        """Retrieves all stored user schedules from the database."""
        with self.get_connection() as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("""
                SELECT chat_id, timezone, hour, minute, updated_at
                FROM user_settings
            """)
            return [dict(row) for row in cursor.fetchall()]

    def delete_user_settings(self, chat_id: int):
        """Deletes a user's schedule from the database."""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM user_settings WHERE chat_id = ?", (chat_id,))
            conn.commit()

storage = ScreenerStorage()
