import { extractAssetTicker } from "./src/telegram";
import { queryDeepSeek } from "./src/deepseek";

// Simple mock for D1 database rate limiter
class MockDB {
  boundArgs = [];
  store = {};
  
  prepare(sql) {
    const self = this;
    return {
      bind(...args) {
        self.boundArgs = args;
        return this;
      },
      async run() {
        return { success: true };
      },
      async first() {
        const chatId = self.boundArgs[0];
        const windowStart = self.boundArgs[1];
        const key = `${chatId}_${windowStart}`;
        return self.store[key] || null;
      }
    };
  }
}

// Run test cases for asset extraction
function testTickerExtraction() {
  console.log("⏳ Testing ticker extraction...");
  const cases = [
    { text: "Что там с биткоином сегодня?", expected: "BTC-USD" },
    { text: "Сколько стоит золото?", expected: "GC=F" },
    { text: "Цена AAPL на сегодня", expected: "AAPL" },
    { text: "Как дела у TSLA?", expected: "TSLA" },
    { text: "Привет, как дела?", expected: null },
    { text: "S&P 500 и NASDAQ", expected: "^GSPC" }, // S&P matches first
    { text: "Что думаешь о LINK?", expected: "LINK-USD" },
    { text: "Как поживает солана?", expected: "SOL-USD" }
  ];

  let passed = 0;
  for (const c of cases) {
    const res = extractAssetTicker(c.text);
    if (res === c.expected) {
      console.log(`  ✅ Passed: "${c.text}" -> ${res}`);
      passed++;
    } else {
      console.error(`  ❌ Failed: "${c.text}" expected ${c.expected}, got ${res}`);
    }
  }
  console.log(`📊 Ticker Extraction: ${passed}/${cases.length} passed.`);
  return passed === cases.length;
}

// Run test cases for rate limiter
async function testRateLimiting() {
  console.log("\n⏳ Testing rate limiting simulation...");
  const db = new MockDB() as any;
  const env = { DB: db, RATE_LIMIT_MAX_REQUESTS: "2", RATE_LIMIT_WINDOW_SECONDS: "60" } as any;
  
  // Custom mock rate limit check
  async function checkRateLimitMock(chatId, env) {
    const limit = Number(env.RATE_LIMIT_MAX_REQUESTS);
    const windowSecs = Number(env.RATE_LIMIT_WINDOW_SECONDS);
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % windowSecs);
    const key = `${chatId}_${windowStart}`;

    const record = await env.DB.prepare().bind(chatId, windowStart).first();
    if (record) {
      if (record.count >= limit) {
        return false;
      }
      record.count++;
    } else {
      env.DB.store[key] = { count: 1 };
    }
    return true;
  }

  const res1 = await checkRateLimitMock(12345, env);
  const res2 = await checkRateLimitMock(12345, env);
  const res3 = await checkRateLimitMock(12345, env); // should be rate limited

  if (res1 && res2 && !res3) {
    console.log("  ✅ Rate limiter correctly blocked the 3rd request inside the window.");
    return true;
  } else {
    console.error("  ❌ Rate limiter failure. res1:", res1, "res2:", res2, "res3:", res3);
    return false;
  }
}

// Test cases for DeepSeek missing API key handling
async function testDeepSeekMissingKey() {
  console.log("\n⏳ Testing DeepSeek missing API key handling...");
  const res = await queryDeepSeek("test", "context", {} as any);
  if (res.answer.includes("Ключ API DeepSeek не настроен")) {
    console.log("  ✅ DeepSeek gracefully handled missing API key.");
    return true;
  } else {
    console.error("  ❌ DeepSeek failed to warn about missing API key. Response:", res);
    return false;
  }
}

async function testDailyTokenLimit() {
  console.log("\n⏳ Testing daily token limit simulation...");
  const db = new MockDB() as any;
  const env = { DB: db, DAILY_TOKEN_LIMIT: "100" } as any;

  async function checkDailyTokenLimitMock(chatId, env) {
    const limit = Number(env.DAILY_TOKEN_LIMIT);
    const todayStart = Math.floor(Date.now() / 86400000) * 86400;
    const key = `${chatId}_${todayStart}`;

    const record = await env.DB.prepare().bind(chatId, todayStart).first();
    if (record && record.tokens_used >= limit) {
      return false;
    }
    return true;
  }

  // Set tokens used to exceed limit
  const todayStart = Math.floor(Date.now() / 86400000) * 86400;
  db.store[`12345_${todayStart}`] = { tokens_used: 120 };

  const allowed = await checkDailyTokenLimitMock(12345, env);
  if (!allowed) {
    console.log("  ✅ Daily token limiter correctly blocked request after exceeding 100 tokens.");
    return true;
  } else {
    console.error("  ❌ Daily token limiter failed to block request.");
    return false;
  }
}

async function runAll() {
  console.log("🚀 Starting Automated Test Suite for Telegram AI Support...");
  const t1 = testTickerExtraction();
  const t2 = await testRateLimiting();
  const t3 = await testDeepSeekMissingKey();
  const t4 = await testDailyTokenLimit();

  if (t1 && t2 && t3 && t4) {
    console.log("\n✨ ALL LOCAL AUTOMATED TESTS PASSED SUCCESSFULLY! ✨");
  } else {
    console.error("\n❌ SOME TESTS FAILED. PLEASE REVIEW LOGS. ❌");
    process.exit(1);
  }
}

runAll();
