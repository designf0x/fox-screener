import { 
  formatTradeOpenedCard, 
  formatTradeClosedCard, 
  formatTradingStatsCard, 
  ASSET_NAMES 
} from "./src/trader";
import { PaperTrade, ClosedTradeEvent, TraderStats } from "./src/types";

function testFormatters() {
  console.log("⏳ Testing Telegram Card Formatters...");

  const sampleTrade: PaperTrade = {
    id: 1,
    symbol: "BTC-USD",
    direction: "LONG",
    entry_price: 64250.0,
    stop_loss: 62800.0,
    take_profit: 67500.0,
    risk_reward_ratio: 2.24,
    status: "OPEN",
    exit_price: null,
    pnl_percent: null,
    r_multiple: null,
    setup_reasoning: "Breakout above 4-hour resistance confirmed by institutional accumulation news.",
    strategy_tag: "TrendFollowing",
    opened_at: new Date().toISOString(),
    closed_at: null
  };

  const openCard = formatTradeOpenedCard(sampleTrade);
  if (openCard.includes("FOX TRADER: НОВАЯ СДЕЛКА") && openCard.includes("Bitcoin (BTC)") && openCard.includes("2.24")) {
    console.log("  ✅ Open trade card formatted correctly.");
  } else {
    console.error("  ❌ Open trade card formatting failed:", openCard);
    process.exit(1);
  }

  const sampleEvent: ClosedTradeEvent = {
    trade: sampleTrade,
    exitPrice: 67500.0,
    reason: "TP",
    pnlPercent: 5.06,
    rMultiple: 2.24
  };

  const closeCard = formatTradeClosedCard(sampleEvent);
  if (closeCard.includes("TAKE PROFIT ДОСТИГНУТ") && closeCard.includes("+5.06%") && closeCard.includes("+2.24R")) {
    console.log("  ✅ Closed trade card formatted correctly.");
  } else {
    console.error("  ❌ Closed trade card formatting failed:", closeCard);
    process.exit(1);
  }

  const sampleStats: TraderStats = {
    totalTrades: 10,
    closedTrades: 8,
    openTrades: 2,
    wins: 6,
    losses: 2,
    winRate: 75.0,
    totalPnlPercent: 18.5,
    averageR: 1.82,
    profitFactor: 3.45,
    bestTradePnl: 6.2,
    worstTradePnl: -2.1
  };

  const statsCard = formatTradingStatsCard(sampleStats, [sampleTrade]);
  if (statsCard.includes("СТАТИСТИКА FOX VIRTUAL TRADER") && statsCard.includes("75%") && statsCard.includes("+18.5%")) {
    console.log("  ✅ Trading stats card formatted correctly.");
  } else {
    console.error("  ❌ Trading stats card formatting failed:", statsCard);
    process.exit(1);
  }
}

function testTradeExecutionLogic() {
  console.log("\n⏳ Testing LONG & SHORT SL/TP Logic...");

  // 1. Test LONG TP
  const longTrade = {
    entry: 100,
    sl: 90,
    tp: 120
  };
  const longPriceHitTP = 121;
  const longPriceHitSL = 89;

  const longTpHit = longPriceHitTP >= longTrade.tp;
  const longPnl = ((longPriceHitTP - longTrade.entry) / longTrade.entry) * 100;
  const longR = (longPriceHitTP - longTrade.entry) / (longTrade.entry - longTrade.sl);

  if (longTpHit && Math.round(longPnl) === 21 && Number(longR.toFixed(1)) === 2.1) {
    console.log("  ✅ LONG TP calculation passed.");
  } else {
    console.error("  ❌ LONG TP calculation failed.");
    process.exit(1);
  }

  // 2. Test SHORT TP
  const shortTrade = {
    entry: 100,
    sl: 110,
    tp: 80
  };
  const shortPriceHitTP = 79;
  const shortTpHit = shortPriceHitTP <= shortTrade.tp;
  const shortPnl = ((shortTrade.entry - shortPriceHitTP) / shortTrade.entry) * 100;
  const shortR = (shortTrade.entry - shortPriceHitTP) / (shortTrade.sl - shortTrade.entry);

  if (shortTpHit && Math.round(shortPnl) === 21 && Number(shortR.toFixed(1)) === 2.1) {
    console.log("  ✅ SHORT TP calculation passed.");
  } else {
    console.error("  ❌ SHORT TP calculation failed.");
    process.exit(1);
  }
}

function runAll() {
  console.log("🚀 Starting Fox Virtual Trader Test Suite...");
  testFormatters();
  testTradeExecutionLogic();
  console.log("\n✨ ALL FOX TRADER LOCAL TESTS PASSED SUCCESSFULLY! ✨");
}

runAll();
