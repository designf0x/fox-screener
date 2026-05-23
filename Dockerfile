FROM python:3.11-slim

WORKDIR /code

# Copy and install requirements
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY . .

# Run the Telegram bot
CMD ["python", "bot.py"]
