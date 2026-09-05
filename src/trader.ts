import { Env, PaperTrade, TradeDecision, ClosedTradeEvent, TraderStats } from "./types";
import { fetchSymbolChart, isFreshQuote, isTradableQuote } from "./yahoo";
import { fetchSearchContext } from "./search";
import { escapeMarkdown } from "./messaging";

export const DEFAULT_SCREENER_PAIRS = ["BTC-USD", "ETH-USD", "GC=F", "CL=F", "^GSPC", "^IXIC"];

export const ASSET_NAMES: Record<string, string> = {
  "BTC-USD": "Bitcoin (BTC)",
  "ETH-USD": "Ethereum (ETH)",
  "GC=F": "Gold Futures (XAU)",
  "CL=F": "Crude Oil (WTI)",
  "^GSPC": "S&P 500 Index",
  "^IXIC": "NASDAQ Composite"
};

export async function getTradeBySourceKey(env: Env, sourceKey: string): Promise<PaperTrade | null> {
  return env.DB.prepare("SELECT * FROM paper_trades WHERE source_key = ?").bind(sourceKey).first<PaperTrade>();
}

/** Executes a market scan and atomically opens at most one valid paper trade. */
export async function analyzeMarketAndDecide(env: Env, options: {
  sourceKey?: string;
  onTokenUsage?: (tokens: number) => Promise<void>;
} = {}): Promise<{ trade: PaperTrade | null; rationale: string }> {
  if (options.sourceKey) {
    const previous = await getTradeBySourceKey(env, options.sourceKey);
    if (previous) return { trade: previous, rationale: previous.setup_reasoning || "Previously opened trade." };
  }
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return { trade: null, rationale: "DeepSeek API key not configured" };
  }

  // 1. Check current open positions limit (Max 3 concurrent open positions, max 1 per symbol)
  const openTrades = await getOpenTrades(env);
  if (openTrades.length >= 3) {
    return {
      trade: null,
      rationale: `⏸️ Пропуск: Достигнут лимит активных позиций (${openTrades.length}/3). Ожидаем закрытия текущих сделок.`
    };
  }

  const openSymbols = new Set(openTrades.map(t => t.symbol));
  const availablePairs = DEFAULT_SCREENER_PAIRS.filter(s => !openSymbols.has(s));

  if (availablePairs.length === 0) {
    return {
      trade: null,
      rationale: "⏸️ Пропуск: По всем парам из скринера уже открыты активные позиции."
    };
  }

  // 2. Fetch current prices & daily metrics for available screener pairs
  const marketQuotes = await Promise.all(availablePairs.map(fetchSymbolChart));
  const maxQuoteAge = Number(env.MAX_QUOTE_AGE_SECONDS || "300");
  let marketSummary = "Текущие рыночные котировки:\n";
  const validQuotes = new Map<string, number>();

  for (const q of marketQuotes) {
    if (isTradableQuote(q, maxQuoteAge)) {
      const change = ((q.price - q.previousClose) / q.previousClose) * 100;
      validQuotes.set(q.symbol, q.price);
      marketSummary += `- ${q.symbol} (${ASSET_NAMES[q.symbol] || q.symbol}): Текущая цена = ${q.price}, Изменение за день = ${change >= 0 ? "+" : ""}${change.toFixed(2)}%\n`;
    }
  }

  if (validQuotes.size === 0) {
    return { trade: null, rationale: "Не удалось получить рыночные котировки" };
  }

  // 3. Fetch search context for broader macro sentiment
  let searchContext = "";
  if (env.TAVILY_API_KEY) {
    try {
      searchContext = await fetchSearchContext("crypto stocks commodities market technical breakout momentum news today", env.TAVILY_API_KEY);
    } catch (e) {
      console.error("Failed to fetch search context for trader:", e);
    }
  }

  // 4. Prompt DeepSeek as a Quantitative Trader
  const systemPrompt = `You are "Fox Quantitative Trader", an autonomous algorithmic paper trading agent.
Your goal is to analyze market data, technical structure, and current news context, and decide whether to OPEN a new swing/intraday paper trade or HOLD.

Rules for Trade Setups:
1. Select at most ONE high-probability setup among the available symbols: ${Array.from(validQuotes.keys()).join(", ")}.
2. Direction must be either "LONG" or "SHORT".
3. Stop Loss (SL) and Take Profit (TP) must be realistic and reflect technical levels (Support/Resistance, ATR):
   - For LONG: Take Profit > Entry Price > Stop Loss. Minimum Risk-to-Reward Ratio (R:R) must be >= 1.5.
   - For SHORT: Stop Loss > Entry Price > Take Profit. Minimum Risk-to-Reward Ratio (R:R) must be >= 1.5.
4. If market conditions are choppy, overbought/oversold without confirmation, or unclear, choose action "HOLD".
5. Strategy tags: "Breakout", "TrendFollowing", "MeanReversion", "RangeTrading", "Momentum".
6. Reasoning must be 2-3 concise Russian sentences explaining the technical and macro rationale.

Output Format:
You MUST respond with pure JSON only (no markdown code blocks, no backticks, no text before or after).
{
  "action": "OPEN_TRADE" | "HOLD",
  "symbol": "BTC-USD",
  "direction": "LONG" | "SHORT",
  "entryPrice": 64500.0,
  "stopLoss": 63200.0,
  "takeProfit": 67800.0,
  "strategyTag": "TrendFollowing",
  "reasoning": "Краткое обоснование на русском языке...",
  "confidence": 0.85
}`;

  const userPrompt = `${marketSummary}\n${searchContext ? searchContext + "\n" : ""}Сделай объективный анализ и вынеси торговое решение.`;

  const modelName = env.DEEPSEEK_MODEL || "deepseek-chat";
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    signal: AbortSignal.timeout(60000),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      max_tokens: 600,
      temperature: 0.3
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`DeepSeek trader API error: ${errText}`);
    return { trade: null, rationale: `API Error: ${response.status}` };
  }

  const data: any = await response.json();
  if (options.onTokenUsage) await options.onTokenUsage(Number(data.usage?.total_tokens) || 0);
  const rawContent = data.choices?.[0]?.message?.content?.trim();
  if (!rawContent) {
    return { trade: null, rationale: "Empty AI response" };
  }

  // Parse JSON decision
  let decision: TradeDecision;
  try {
    const cleanJson = rawContent.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/\s*```$/, "").trim();
    decision = JSON.parse(cleanJson);
  } catch (err) {
    console.error("Failed to parse DeepSeek trade decision JSON:", rawContent);
    return { trade: null, rationale: `JSON parse error: ${rawContent.slice(0, 100)}` };
  }

  if (!decision || decision.action !== "OPEN_TRADE" || !decision.symbol || !decision.direction || !decision.stopLoss || !decision.takeProfit) {
    return {
      trade: null,
      rationale: typeof decision?.reasoning === "string" ? decision.reasoning : "AI decided to HOLD (no high-confidence setup found)."
    };
  }

  const livePrice = validQuotes.get(decision.symbol);
  if (!livePrice) {
    return { trade: null, rationale: `Symbol ${decision.symbol} is not valid or has no live price.` };
  }

  // Reprice after inference; the quote used in the prompt may already be stale.
  const entryQuote = await fetchSymbolChart(decision.symbol);
  if (!isTradableQuote(entryQuote, maxQuoteAge)) {
    return { trade: null, rationale: "Fresh tradable entry quote unavailable." };
  }
  const entryPrice = entryQuote.price;
  const sl = Number(decision.stopLoss);
  const tp = Number(decision.takeProfit);
  if (!Number.isFinite(sl) || !Number.isFinite(tp) || sl <= 0 || tp <= 0) {
    return { trade: null, rationale: "Invalid numeric trade levels." };
  }

  // Validate R:R and logical boundaries
  let rr = 0;
  if (decision.direction === "LONG") {
    if (sl >= entryPrice || tp <= entryPrice) {
      return { trade: null, rationale: `Invalid LONG price levels: Entry=${entryPrice}, SL=${sl}, TP=${tp}` };
    }
    const risk = entryPrice - sl;
    const reward = tp - entryPrice;
    rr = reward / risk;
  } else if (decision.direction === "SHORT") {
    if (sl <= entryPrice || tp >= entryPrice) {
      return { trade: null, rationale: `Invalid SHORT price levels: Entry=${entryPrice}, SL=${sl}, TP=${tp}` };
    }
    const risk = sl - entryPrice;
    const reward = entryPrice - tp;
    rr = reward / risk;
  } else {
    return { trade: null, rationale: `Unknown direction: ${decision.direction}` };
  }

  if (!Number.isFinite(rr) || rr < 1.5) {
    return { trade: null, rationale: `Risk/Reward ratio (${rr.toFixed(2)}) is below minimum threshold.` };
  }

  // 5. Insert trade into Cloudflare D1
  const createdTrade = await env.DB.prepare(
    `INSERT INTO paper_trades (
      symbol, direction, entry_price, stop_loss, take_profit, risk_reward_ratio, 
      status, setup_reasoning, strategy_tag, source_key, opened_at
    ) SELECT ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, CURRENT_TIMESTAMP
      WHERE (SELECT COUNT(*) FROM paper_trades WHERE status = 'OPEN') < 3
        AND NOT EXISTS (SELECT 1 FROM paper_trades WHERE status = 'OPEN' AND symbol = ?)
      ON CONFLICT(source_key) DO NOTHING
      RETURNING *`
  )
    .bind(
      decision.symbol,
      decision.direction,
      entryPrice,
      sl,
      tp,
      Number(rr.toFixed(2)),
      typeof decision.reasoning === "string" ? decision.reasoning : "Technical setup identified by DeepSeek",
      typeof decision.strategyTag === "string" ? decision.strategyTag : "TrendFollowing",
      options.sourceKey || null,
      decision.symbol
    )
    .first<PaperTrade>();

  if (!createdTrade) {
    const previous = options.sourceKey ? await getTradeBySourceKey(env, options.sourceKey) : null;
    return { trade: previous, rationale: previous?.setup_reasoning || "Position limit reached by another scan." };
  }

  return { trade: createdTrade, rationale: createdTrade.setup_reasoning || "Trade opened successfully." };
}

/**
 * Retrieves all currently active open trades.
 */
export async function getOpenTrades(env: Env): Promise<PaperTrade[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM paper_trades WHERE status = 'OPEN' ORDER BY opened_at ASC"
  ).all<PaperTrade>();
  return results || [];
}

/**
 * Checks all open positions against live market prices and executes Take Profit / Stop Loss exits.
 */
export async function checkOpenPositions(env: Env): Promise<ClosedTradeEvent[]> {
  const openTrades = await getOpenTrades(env);
  if (openTrades.length === 0) {
    return [];
  }

  const closedEvents: ClosedTradeEvent[] = [];

  for (const trade of openTrades) {
    try {
      const quote = await fetchSymbolChart(trade.symbol);
      if (!isFreshQuote(quote, Number(env.MAX_QUOTE_AGE_SECONDS || "300"))) {
        continue;
      }

      const currentPrice = quote.price;
      let isClosed = false;
      let exitPrice = 0;
      let reason: "TP" | "SL" = "TP";
      let pnlPercent = 0;
      let rMultiple = 0;

      if (trade.direction === "LONG") {
        if (currentPrice >= trade.take_profit) {
          isClosed = true;
          reason = "TP";
          exitPrice = currentPrice;
          pnlPercent = ((exitPrice - trade.entry_price) / trade.entry_price) * 100;
          rMultiple = (exitPrice - trade.entry_price) / (trade.entry_price - trade.stop_loss);
        } else if (currentPrice <= trade.stop_loss) {
          isClosed = true;
          reason = "SL";
          exitPrice = currentPrice;
          pnlPercent = ((exitPrice - trade.entry_price) / trade.entry_price) * 100;
          rMultiple = (exitPrice - trade.entry_price) / (trade.entry_price - trade.stop_loss);
        }
      } else if (trade.direction === "SHORT") {
        if (currentPrice <= trade.take_profit) {
          isClosed = true;
          reason = "TP";
          exitPrice = currentPrice;
          pnlPercent = ((trade.entry_price - exitPrice) / trade.entry_price) * 100;
          rMultiple = (trade.entry_price - exitPrice) / (trade.stop_loss - trade.entry_price);
        } else if (currentPrice >= trade.stop_loss) {
          isClosed = true;
          reason = "SL";
          exitPrice = currentPrice;
          pnlPercent = ((trade.entry_price - exitPrice) / trade.entry_price) * 100;
          rMultiple = (trade.entry_price - exitPrice) / (trade.stop_loss - trade.entry_price);
        }
      }

      if (isClosed) {
        const finalStatus = reason === "TP" ? "CLOSED_TP" : "CLOSED_SL";
        const updated = await env.DB.prepare(
          `UPDATE paper_trades 
           SET status = ?, exit_price = ?, pnl_percent = ?, r_multiple = ?, closed_at = CURRENT_TIMESTAMP 
           WHERE id = ? AND status = 'OPEN'`
        )
          .bind(finalStatus, exitPrice, Number(pnlPercent.toFixed(2)), Number(rMultiple.toFixed(2)), trade.id)
          .run();
        if (!updated.meta.changes) continue;

        const updatedTrade: PaperTrade = {
          ...trade,
          status: finalStatus,
          exit_price: exitPrice,
          pnl_percent: Number(pnlPercent.toFixed(2)),
          r_multiple: Number(rMultiple.toFixed(2)),
          closed_at: new Date().toISOString()
        };

        closedEvents.push({
          trade: updatedTrade,
          exitPrice,
          reason,
          pnlPercent: Number(pnlPercent.toFixed(2)),
          rMultiple: Number(rMultiple.toFixed(2))
        });
      }
    } catch (err) {
      console.error(`Error checking position ${trade.id} (${trade.symbol}):`, err);
    }
  }

  return closedEvents;
}

/**
 * Computes live win-rate, total PnL, profit factor, and trading performance metrics.
 */
export async function getTradingStats(env: Env): Promise<TraderStats> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM paper_trades ORDER BY opened_at ASC"
  ).all<PaperTrade>();

  const trades = results || [];
  const closedTrades = trades.filter(t => t.status === "CLOSED_TP" || t.status === "CLOSED_SL" || t.status === "CLOSED_MANUAL");
  const openTrades = trades.filter(t => t.status === "OPEN");

  let wins = 0;
  let losses = 0;
  let totalPnl = 0;
  let totalR = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let bestPnl = closedTrades[0]?.pnl_percent || 0;
  let worstPnl = closedTrades[0]?.pnl_percent || 0;

  for (const t of closedTrades) {
    const pnl = t.pnl_percent || 0;
    const r = t.r_multiple || 0;
    totalPnl += pnl;
    totalR += r;

    if (pnl > bestPnl) bestPnl = pnl;
    if (pnl < worstPnl) worstPnl = pnl;

    if (pnl > 0) {
      wins++;
      grossProfit += pnl;
    } else {
      losses++;
      grossLoss += Math.abs(pnl);
    }
  }

  const winRate = closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0;
  const averageR = closedTrades.length > 0 ? totalR / closedTrades.length : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99.9 : 0;

  return {
    totalTrades: trades.length,
    closedTrades: closedTrades.length,
    openTrades: openTrades.length,
    wins,
    losses,
    winRate: Number(winRate.toFixed(1)),
    totalPnlPercent: Number(totalPnl.toFixed(2)),
    averageR: Number(averageR.toFixed(2)),
    profitFactor: Number(profitFactor.toFixed(2)),
    bestTradePnl: Number(bestPnl.toFixed(2)),
    worstTradePnl: Number(worstPnl.toFixed(2))
  };
}

/**
 * Formats a Telegram Card when a new paper trade is opened.
 */
export function formatTradeOpenedCard(trade: PaperTrade): string {
  const assetName = ASSET_NAMES[trade.symbol] || trade.symbol;
  const dirEmoji = trade.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  
  const slPct = Math.abs(((trade.stop_loss - trade.entry_price) / trade.entry_price) * 100).toFixed(2);
  const tpPct = Math.abs(((trade.take_profit - trade.entry_price) / trade.entry_price) * 100).toFixed(2);

  return (
    `🚀 *FOX TRADER: НОВАЯ СДЕЛКА* 🦊\n\n` +
    `📊 *Актив:* ${assetName} (\`${trade.symbol}\`)\n` +
    `📈 *Направление:* ${dirEmoji}\n` +
    `💵 *Точка входа:* $${trade.entry_price.toLocaleString("en-US")}\n` +
    `🛑 *Stop Loss:* $${trade.stop_loss.toLocaleString("en-US")} (-${slPct}%)\n` +
    `🎯 *Take Profit:* $${trade.take_profit.toLocaleString("en-US")} (+${tpPct}%)\n` +
    `⚖️ *Риск / Прибыль (R:R):* 1 : ${trade.risk_reward_ratio}\n` +
    `🏷️ *Стратегия:* #${escapeMarkdown(trade.strategy_tag || "Technical")}\n\n` +
    `🧠 *Обоснование сделки (DeepSeek):*\n${escapeMarkdown(trade.setup_reasoning || "Сформирован сетап по стратегии.")}\n\n` +
    `_Позиция отслеживается автоматически в реальном времени._`
  );
}

/**
 * Formats a Telegram Card when a trade hits Take Profit or Stop Loss.
 */
export function formatTradeClosedCard(event: ClosedTradeEvent): string {
  const { trade, exitPrice, reason, pnlPercent, rMultiple } = event;
  const assetName = ASSET_NAMES[trade.symbol] || trade.symbol;
  const isWin = reason === "TP" || pnlPercent > 0;
  const titleEmoji = isWin ? "🎯 *TAKE PROFIT ДОСТИГНУТ!* 💰" : "🛑 *STOP LOSS СРАБОТАЛ* ⚠️";
  const pnlSign = pnlPercent >= 0 ? "+" : "";

  return (
    `${titleEmoji}\n\n` +
    `📊 *Актив:* ${assetName} (\`${trade.symbol}\`)\n` +
    `📈 *Позиция:* ${trade.direction}\n` +
    `💵 *Вход:* $${trade.entry_price.toLocaleString("en-US")} ➔ *Выход:* $${exitPrice.toLocaleString("en-US")}\n` +
    `📈 *Результат:* *${pnlSign}${pnlPercent}%* (${pnlSign}${rMultiple}R)\n` +
    `🏷️ *Стратегия:* #${escapeMarkdown(trade.strategy_tag || "Technical")}\n\n` +
    `_Сделка #${trade.id} закрыта и занесена в статистику журнала._`
  );
}

/**
 * Formats the comprehensive performance ledger card.
 */
export function formatTradingStatsCard(stats: TraderStats, openTrades: PaperTrade[]): string {
  const pnlSign = stats.totalPnlPercent >= 0 ? "+" : "";
  const pnlEmoji = stats.totalPnlPercent >= 0 ? "❇️" : "🔻";

  let msg = `📊 *СТАТИСТИКА FOX VIRTUAL TRADER* 🦊\n\n` +
            `🏆 *Винрейт:* *${stats.winRate}%* (${stats.wins}W / ${stats.losses}L)\n` +
            `${pnlEmoji} *Общий PnL:* *${pnlSign}${stats.totalPnlPercent}%*\n` +
            `📈 *Средний R-множитель:* ${stats.averageR}R\n` +
            `⚖️ *Профит-фактор:* ${stats.profitFactor}\n` +
            `🔝 *Лучшая сделка:* ${stats.bestTradePnl >= 0 ? "+" : ""}${stats.bestTradePnl}%\n` +
            `🔻 *Худшая сделка:* ${stats.worstTradePnl}%\n` +
            `📋 *Всего сделок:* ${stats.totalTrades} (Закрыто: ${stats.closedTrades})\n\n`;

  if (openTrades.length > 0) {
    msg += `🔓 *Открытые позиции (${openTrades.length}):*\n`;
    for (const t of openTrades) {
      const asset = ASSET_NAMES[t.symbol] || t.symbol;
      msg += `• *${asset}* (${t.direction}) | Вход: $${t.entry_price} | TP: $${t.take_profit} | SL: $${t.stop_loss}\n`;
    }
  } else {
    msg += `🔓 *Открытых позиций:* Нет (Ожидание новых сетапов)`;
  }

  return msg;
}
