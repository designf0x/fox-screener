export interface ChartResult {
  symbol: string;
  price?: number;
  previousClose?: number;
  quoteTime?: number;
  marketOpen?: boolean;
  error?: string;
}

export async function fetchSymbolChart(symbol: string): Promise<ChartResult> {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });

    if (!response.ok) {
      return { symbol, error: `HTTP ${response.status}` };
    }

    const data: any = await response.json();
    const meta = data.chart?.result?.[0]?.meta;
    
    if (!meta) {
      return { symbol, error: "Empty metadata" };
    }

    const regular = meta.currentTradingPeriod?.regular;
    const now = Math.floor(Date.now() / 1000);
    return {
      symbol,
      price: meta.regularMarketPrice,
      previousClose: meta.previousClose ?? meta.chartPreviousClose,
      quoteTime: meta.regularMarketTime,
      marketOpen: regular ? now >= regular.start && now < regular.end : undefined
    };
  } catch (err: any) {
    return { symbol, error: err.message || "Fetch Error" };
  }
}

export function isFreshQuote(quote: ChartResult, maxAgeSeconds = 300): quote is ChartResult & { price: number } {
  const now = Date.now() / 1000;
  return !quote.error && Number.isFinite(quote.price) && quote.price! > 0 &&
    Number.isFinite(quote.quoteTime) && quote.quoteTime! <= now + 60 &&
    now - quote.quoteTime! <= maxAgeSeconds;
}

export function isTradableQuote(quote: ChartResult, maxAgeSeconds = 300): quote is ChartResult & { price: number; previousClose: number } {
  return isFreshQuote(quote, maxAgeSeconds) && Number.isFinite(quote.previousClose) && quote.previousClose! > 0 &&
    (quote.symbol.endsWith("-USD") || quote.marketOpen === true);
}

export async function getMarketSummary(watchlistStr: string, tzName: string, channelId?: string, channelLink?: string): Promise<string> {
  const symbols = watchlistStr.split(",").map(s => s.trim());

  try {
    // Fetch all symbols concurrently in parallel using Cloudflare's edge Promise.all
    const results = await Promise.all(symbols.map(fetchSymbolChart));
    
    const quoteMap = new Map<string, ChartResult>();
    for (const res of results) {
      if (!res.error) {
        quoteMap.set(res.symbol, res);
      } else {
        console.error(`Error fetching ticker ${res.symbol}: ${res.error}`);
      }
    }

    const tickers: Record<string, string> = {
      "^GSPC": "S&P 500",
      "^IXIC": "NASDAQ",
      "BTC-USD": "BTC",
      "ETH-USD": "ETH",
      "GC=F": "GOLD",
      "CL=F": "OIL",
    };

    const groups = [
      ["^GSPC", "^IXIC"],
      ["BTC-USD", "ETH-USD"],
      ["GC=F", "CL=F"]
    ];

    const lines: string[] = [];

    for (const group of groups) {
      for (const symbol of group) {
        if (!symbols.includes(symbol)) continue;

        const name = tickers[symbol] || symbol;
        const quote = quoteMap.get(symbol);

        if (!quote) {
          lines.push(`⚠️ *${name}*: Data temporarily unavailable`);
          continue;
        }

        const price = quote.price;
        const prev = quote.previousClose;

        if (price === undefined || prev === undefined) {
          lines.push(`⚠️ *${name}*: Calculation error`);
          continue;
        }

        // Calculate change percent
        const change = ((price - prev) / prev) * 100;

        let emoji = "0️⃣";
        if (change > 0) emoji = "❇️";
        else if (change < 0) emoji = "🔻";

        // Formatted exactly like the Python version
        const formattedPrice = Number(price)
          .toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
          })
          .replace(/,/g, " "); // Narrow non-breaking space \u202F

        const formattedChange = `_${change >= 0 ? "+" : ""}${Number(change).toFixed(2)}%_`;
        lines.push(`${emoji} *${name}*: ${formattedPrice} (${formattedChange})`);
      }
      lines.push("");
    }

    // Format date in user's timezone
    let nowStr = "";
    try {
      const formatter = new Intl.DateTimeFormat("en-GB", {
        day: "2-digit",
        month: "long",
        year: "numeric",
        timeZone: tzName
      });
      nowStr = formatter.format(new Date());
    } catch {
      const formatter = new Intl.DateTimeFormat("en-GB", {
        day: "2-digit",
        month: "long",
        year: "numeric",
        timeZone: "UTC"
      });
      nowStr = formatter.format(new Date());
    }

    // CTA with link to the Virtual Trader Telegram channel
    const channelUrl = channelLink || (channelId?.startsWith("@") ? `https://t.me/${channelId.slice(1)}` : undefined);
    const validLink = channelUrl && /^https:\/\/t\.me\/[A-Za-z0-9_+/?=-]+$/.test(channelUrl);
    const cta = validLink ? `\n\n🎯 *Сделки и сигналы ИИ-трейдера:* [Открыть канал](${channelUrl})` : "";

    return `📈 *Markets on ${nowStr}:*\n\n` + lines.join("\n").trim() + cta;
  } catch (error: any) {
    console.error("Error creating market summary:", error);
    return `⚠️ *Markets*: Failed to compile summary. (${error.message || "Connection Error"})`;
  }
}
