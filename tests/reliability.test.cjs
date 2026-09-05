const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const ts = require('typescript');

// Exercise the Worker modules directly without writing build artifacts.
require.extensions['.ts'] = (module, filename) => module._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, filename);
const trader = require('../src/trader.ts');
const telegram = require('../src/telegram.ts');
const index = require('../src/index.ts');
const yahoo = require('../src/yahoo.ts');
const realFetch = global.fetch;
const RealDate = global.Date;
const databases = [];
afterEach(() => {
  global.fetch = realFetch;
  global.Date = RealDate;
  databases.splice(0).forEach(db => db.close());
});

function fixture() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  db.exec(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
  const migration = path.join(__dirname, '../migrations/0001_reliability.sql');
  if (fs.existsSync(migration)) db.exec(fs.readFileSync(migration, 'utf8'));
  const env = {
    BOT_TOKEN: 'test-token', DEEPSEEK_API_KEY: 'test-key',
    WEBHOOK_SECRET: 'test-webhook-secret', DIAGNOSTICS_TOKEN: 'test-admin-secret',
    TRADING_CHANNEL_ID: '@test_channel',
    DB: { prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async first() { return db.prepare(sql).get(...args) ?? null; },
        async run() {
          const result = db.prepare(sql).run(...args);
          return { success: true, meta: { last_row_id: Number(result.lastInsertRowid), changes: Number(result.changes) } };
        }
      };
    } }
  };
  const state = {
    ai: 0, sent: [], telegramStatus: 200, parseError: false, prices: [100],
    quoteTime: Math.floor(Date.now() / 1000), marketOpen: true,
    decision: { action: 'OPEN_TRADE', symbol: 'BTC-USD', direction: 'LONG', stopLoss: 90, takeProfit: 120, reasoning: 'Test setup', strategyTag: 'Momentum' }
  };
  global.fetch = async (url, init = {}) => {
    if (url.includes('finance.yahoo.com')) {
      const price = state.prices.length > 1 ? state.prices.shift() : state.prices[0];
      const now = Math.floor(Date.now() / 1000);
      return Response.json({ chart: { result: [{ meta: {
        regularMarketPrice: price, previousClose: 95, regularMarketTime: state.quoteTime,
        currentTradingPeriod: { regular: { start: now - 3600, end: state.marketOpen ? now + 3600 : now - 60 } }
      } }] } });
    }
    if (url.includes('api.deepseek.com')) {
      state.ai++;
      return Response.json({ choices: [{ message: { content: JSON.stringify(state.decision) } }], usage: { total_tokens: 1000 } });
    }
    if (url.includes('api.telegram.org')) {
      const payload = JSON.parse(init.body);
      state.sent.push(payload);
      if (state.parseError && payload.parse_mode) {
        return Response.json({ ok: false, description: "Bad Request: can't parse entities" }, { status: 400 });
      }
      return Response.json({ ok: state.telegramStatus === 200, description: 'Simulated error', parameters: { retry_after: 1 } }, { status: state.telegramStatus });
    }
    throw new Error('Unexpected network request: ' + url);
  };
  function addTrade(symbol = 'BTC-USD', status = 'OPEN', pnl = null) {
    db.prepare(`INSERT INTO paper_trades
      (symbol,direction,entry_price,stop_loss,take_profit,risk_reward_ratio,status,pnl_percent)
      VALUES (?, 'LONG', 100, 90, 120, 2, ?, ?)`).run(symbol, status, pnl);
  }
  const update = (text, id = 1) => ({ update_id: id, message: { chat: { id: 123, type: 'private' }, text } });
  const webhook = (body, authenticated = true) => index.default.fetch(new Request('https://worker.test/', {
    method: 'POST', headers: authenticated ? { 'X-Telegram-Bot-Api-Secret-Token': env.WEBHOOK_SECRET } : {}, body: JSON.stringify(body)
  }), env, {});
  const diagnostic = (route, method = 'GET', authenticated = true) => index.default.fetch(new Request('https://worker.test' + route, {
    method, headers: authenticated ? { Authorization: 'Bearer ' + env.DIAGNOSTICS_TOKEN } : {}
  }), env, {});
  return { db, env, state, addTrade, update, webhook, diagnostic };
}

test('HTTP authentication fails closed before any effects', async () => {
  const f = fixture();
  assert.equal((await f.webhook(f.update('/settimezone UTC'), false)).status, 401);
  for (const route of ['/test', '/test/trader/scan', '/test/trader/check', '/test/trader/ping', '/test/trader/stats']) {
    assert.equal((await f.diagnostic(route, 'GET', false)).status, 401);
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM user_settings').get().n, 0);
  assert.equal(f.state.ai, 0);
  assert.equal(f.state.sent.length, 0);
  delete f.env.WEBHOOK_SECRET;
  assert.equal((await f.webhook(f.update('/now'), false)).status, 503);
});

test('Diagnostics require POST for mutations', async () => {
  const f = fixture();
  assert.equal((await f.diagnostic('/test/trader/scan')).status, 405);
  assert.equal((await f.diagnostic('/test/trader/scan', 'POST')).status, 200);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM paper_trades').get().n, 1);
});

test('Manual scans respect request and daily quotas and charge HOLD decisions', async () => {
  const f = fixture();
  f.env.RATE_LIMIT_MAX_REQUESTS = '1';
  f.state.decision = { action: 'HOLD', reasoning: 'No setup' };
  await telegram.routeWebhookUpdate(f.update('/scan'), f.env);
  await telegram.routeWebhookUpdate(f.update('/scan', 2), f.env);
  assert.equal(f.state.ai, 1);
  assert.equal(f.db.prepare('SELECT tokens_used FROM chat_daily_usage').get().tokens_used, 1000);
  f.env.RATE_LIMIT_MAX_REQUESTS = '5';
  f.env.DAILY_TOKEN_LIMIT = '1000';
  await telegram.routeWebhookUpdate(f.update('/scan', 3), f.env);
  assert.equal(f.state.ai, 1);
});

test('Concurrent rate-limit admissions cannot exceed the configured count', async () => {
  const f = fixture();
  f.env.RATE_LIMIT_MAX_REQUESTS = '1';
  const allowed = await Promise.all(Array.from({ length: 5 }, () => telegram.checkRateLimit(123, f.env)));
  assert.equal(allowed.filter(Boolean).length, 1);
  assert.equal(f.db.prepare('SELECT count FROM chat_rate_limits').get().count, 1);
});

test('Concurrent scans preserve total and per-symbol position limits', async () => {
  const f = fixture();
  f.addTrade('ETH-USD'); f.addTrade('GC=F');
  const results = await Promise.all([trader.analyzeMarketAndDecide(f.env), trader.analyzeMarketAndDecide(f.env)]);
  assert.equal(results.filter(result => result.trade).length, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM paper_trades WHERE status='OPEN'").get().n, 3);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM paper_trades WHERE symbol='BTC-USD'").get().n, 1);
});

test('Concurrent checks cannot overwrite or duplicate a closed trade', async () => {
  const f = fixture(); f.addTrade(); f.state.prices = [121, 89];
  const results = (await Promise.all([trader.checkOpenPositions(f.env), trader.checkOpenPositions(f.env)])).flat();
  assert.equal(results.length, 1);
  assert.equal(f.db.prepare('SELECT status FROM paper_trades').get().status, 'CLOSED_TP');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM trade_notifications WHERE event_type='CLOSED'").get().n, 1);
});

test('Actual SHORT exit path computes and persists TP correctly', async () => {
  const f = fixture(); f.addTrade();
  f.db.exec("UPDATE paper_trades SET direction='SHORT', stop_loss=110, take_profit=80");
  f.state.prices = [79];
  const [event] = await trader.checkOpenPositions(f.env);
  assert.equal(event.reason, 'TP'); assert.equal(event.pnlPercent, 21); assert.equal(event.rMultiple, 2.1);
});

test('A fresh final-session quote can close a position after market close', async () => {
  const f = fixture(); f.addTrade('^GSPC'); f.state.prices = [121]; f.state.marketOpen = false;
  const [event] = await trader.checkOpenPositions(f.env);
  assert.equal(event.reason, 'TP');
});

test('Expired quotes and closed sessions cannot open trades', async () => {
  const f = fixture(); f.state.quoteTime -= 3 * 86400;
  assert.equal((await trader.analyzeMarketAndDecide(f.env)).trade, null);
  assert.equal(f.state.ai, 0);
  f.state.quoteTime = Math.floor(Date.now() / 1000); f.state.marketOpen = false; f.state.decision.symbol = '^GSPC';
  assert.equal((await trader.analyzeMarketAndDecide(f.env)).trade, null);
});

test('Risk/reward threshold and numeric validation reject invalid decisions', async () => {
  const f = fixture(); f.state.decision.takeProfit = 112;
  assert.equal((await trader.analyzeMarketAndDecide(f.env)).trade, null);
  f.state.decision.stopLoss = 'not a number';
  assert.equal((await trader.analyzeMarketAndDecide(f.env)).trade, null);
});

test('Duplicate webhook updates do not rerun trading', async () => {
  const f = fixture(); const update = f.update('/scan', 777);
  assert.equal((await f.webhook(update)).status, 200);
  f.state.decision.symbol = 'ETH-USD';
  assert.equal((await f.webhook(update)).status, 200);
  assert.equal(f.state.ai, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM paper_trades').get().n, 1);
});

test('Simultaneous duplicate webhooks acquire only one processing claim', async () => {
  const f = fixture();
  const responses = await Promise.all([f.webhook(f.update('/scan')), f.webhook(f.update('/scan'))]);
  assert.ok(responses.some(response => response.status === 200));
  assert.ok(responses.every(response => [200, 503].includes(response.status)));
  assert.equal(f.state.ai, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM paper_trades').get().n, 1);
});

test('Concurrent notification workers send one event and preserve trade event order', async () => {
  const f = fixture(); f.addTrade(); f.state.prices = [121];
  await trader.checkOpenPositions(f.env);
  const { flushTradeNotifications } = require('../src/notifications.ts');
  await Promise.all([flushTradeNotifications(f.env), flushTradeNotifications(f.env)]);
  assert.equal(f.state.sent.length, 1);
  assert.ok(f.state.sent[0].text.includes('НОВАЯ СДЕЛКА'));
  await flushTradeNotifications(f.env);
  assert.equal(f.state.sent.length, 2);
  assert.ok(f.state.sent[1].text.includes('TAKE PROFIT'));
});

test('Trade mutation rolls back if atomic notification insertion fails', async () => {
  const f = fixture();
  f.db.exec("CREATE TRIGGER fail_notification BEFORE INSERT ON trade_notifications BEGIN SELECT RAISE(ABORT, 'Simulated queue failure'); END;");
  await assert.rejects(trader.analyzeMarketAndDecide(f.env), /Simulated queue failure/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM paper_trades').get().n, 0);
});

test('Migration preserves existing trades and settings without replaying old alerts', () => {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  db.exec(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
  db.exec("INSERT INTO user_settings (chat_id, timezone) VALUES (123, 'UTC'); INSERT INTO paper_trades (symbol,direction,entry_price,stop_loss,take_profit,risk_reward_ratio) VALUES ('BTC-USD','LONG',100,90,120,2);");
  db.exec(fs.readFileSync(path.join(__dirname, '../migrations/0001_reliability.sql'), 'utf8'));
  assert.equal(db.prepare('SELECT entry_price FROM paper_trades').get().entry_price, 100);
  assert.equal(db.prepare('SELECT timezone FROM user_settings').get().timezone, 'UTC');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trade_notifications').get().n, 0);
});

test('Failed webhook commands remain retryable', async () => {
  const f = fixture();
  f.db.exec("INSERT INTO user_settings (chat_id,timezone) VALUES (123,'UTC')");
  const prepare = f.env.DB.prepare;
  f.env.DB.prepare = sql => {
    if (sql.startsWith('UPDATE user_settings')) throw new Error('Simulated D1 failure');
    return prepare(sql);
  };
  assert.equal((await f.webhook(f.update('/settime 09:30'))).status, 503);
  f.env.DB.prepare = prepare;
  assert.equal((await f.webhook(f.update('/settime 09:30'))).status, 200);
  assert.equal(f.db.prepare('SELECT hour FROM user_settings').get().hour, 9);
});

test('Retry after a committed scan reuses the original trade', async () => {
  const f = fixture();
  const prepare = f.env.DB.prepare;
  let failCompletion = true;
  f.env.DB.prepare = sql => {
    if (failCompletion && sql.includes("SET status = 'DONE'")) throw new Error('Simulated crash before acknowledgement');
    return prepare(sql);
  };
  assert.equal((await f.webhook(f.update('/scan'))).status, 503);
  failCompletion = false; f.state.decision.symbol = 'ETH-USD';
  assert.equal((await f.webhook(f.update('/scan'))).status, 200);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM paper_trades').get().n, 1);
  assert.equal(f.state.ai, 1);
});

test('Failed closure notifications survive and retry without closing twice', async () => {
  const f = fixture(); f.addTrade();
  f.db.exec("UPDATE trade_notifications SET delivered_at=1 WHERE event_type='OPEN'");
  f.state.prices = [121]; f.state.telegramStatus = 429;
  await index.handleScheduledTradingChecks(f.env);
  assert.equal(f.db.prepare('SELECT status FROM paper_trades').get().status, 'CLOSED_TP');
  assert.equal(f.db.prepare("SELECT delivered_at FROM trade_notifications WHERE event_type='CLOSED'").get().delivered_at, null);
  f.state.telegramStatus = 200; f.db.exec('UPDATE trade_notifications SET next_attempt_at=0');
  await index.handleScheduledTradingChecks(f.env);
  assert.equal(f.state.sent.length, 2);
  assert.ok(f.db.prepare("SELECT delivered_at FROM trade_notifications WHERE event_type='CLOSED'").get().delivered_at);
  await index.handleScheduledTradingChecks(f.env);
  assert.equal(f.state.sent.length, 2);
});

test('Delayed cron uses scheduled time and closes positions before scanning', async () => {
  const f = fixture(); f.addTrade('BTC-USD'); f.addTrade('ETH-USD'); f.addTrade('GC=F');
  global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2026-09-05T08:01:00Z'])); } static now() { return RealDate.parse('2026-09-05T08:01:00Z'); } };
  f.state.quoteTime = Math.floor(Date.now() / 1000); f.state.prices = [121];
  f.state.decision.stopLoss = 110; f.state.decision.takeProfit = 145;
  f.db.exec("INSERT INTO user_settings (chat_id,timezone,hour,minute) VALUES (456,'UTC',8,0)");
  const pending = [];
  await index.default.scheduled({ scheduledTime: RealDate.parse('2026-09-05T08:00:00Z'), cron: '* * * * *' }, f.env, { waitUntil(p) { pending.push(p); } });
  await Promise.all(pending);
  assert.equal(f.state.ai, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM paper_trades WHERE status='OPEN'").get().n, 1);
  assert.ok(f.state.sent.some(message => message.chat_id === 456));
});

test('/tradescan reaches scan handler and commands for other bots are ignored', async () => {
  const f = fixture(); f.state.decision = { action: 'HOLD' };
  await telegram.routeWebhookUpdate(f.update('/tradescan'), f.env);
  assert.equal(f.state.ai, 1);
  await telegram.routeWebhookUpdate(f.update('/scan@AnotherBot'), f.env);
  assert.equal(f.state.ai, 1);
});

test('Ticker extraction respects word boundaries and explicit symbols', () => {
  for (const [text, expected] of [
    ['What about AAPL?', 'AAPL'], ['Price of TSLA?', 'TSLA'], ['ORCL', 'ORCL'],
    ['Tell me something about AAPL', 'AAPL'], ['Что думаешь о LINK?', 'LINK-USD'],
    ['Что там с биткоином сегодня?', 'BTC-USD'], ['Сколько стоит золото?', 'GC=F'],
    ['Как поживает солана?', 'SOL-USD'], ['S&P 500 и NASDAQ', '^GSPC'], ['Привет, как дела?', null]
  ]) assert.equal(telegram.extractAssetTicker(text), expected, text);
});

test('Timezone fields are escaped and malformed AI Markdown falls back to plain text', async () => {
  const f = fixture();
  await telegram.handleSetTimezoneCommand(123, 'America/New_York', f.env);
  assert.ok(f.state.sent[0].text.includes('America/New\\_York'));
  f.state.parseError = true;
  await telegram.sendTelegramMessage(123, 'Unmatched *', f.env);
  assert.equal(f.state.sent.at(-1).parse_mode, undefined);
});

test('Database timezone errors propagate instead of being reported as invalid input', async () => {
  const f = fixture(); f.env.DB.prepare = () => { throw new Error('D1 unavailable'); };
  await assert.rejects(telegram.handleSetTimezoneCommand(123, 'UTC', f.env), /D1 unavailable/);
});

test('Numeric channel IDs never link to an unrelated default channel', async () => {
  const f = fixture();
  const summary = await yahoo.getMarketSummary('BTC-USD', 'UTC', '-100123456789');
  assert.ok(!summary.includes('https://t.me/foxintraday'));
  const configured = await yahoo.getMarketSummary('BTC-USD', 'UTC', '-100123456789', 'https://t.me/correct_channel');
  assert.ok(configured.includes('https://t.me/correct_channel'));
});

test('Performance extremes come from real closed trades', async () => {
  const f = fixture(); f.addTrade('BTC-USD', 'CLOSED_SL', -5); f.addTrade('ETH-USD', 'CLOSED_SL', -2);
  assert.equal((await trader.getTradingStats(f.env)).bestTradePnl, -2);
  f.db.exec('UPDATE paper_trades SET pnl_percent=-pnl_percent');
  assert.equal((await trader.getTradingStats(f.env)).worstTradePnl, 2);
});

test('Daily trading stats broadcast publishes to channel at configured hour', async () => {
  const f = fixture();
  f.env.DAILY_STATS_HOUR = '21';
  f.env.TRADING_CHANNEL_ID = '@test_channel';
  f.addTrade('BTC-USD', 'CLOSED_TP', 10);

  // Does not send at 20:00
  await index.handleScheduledDailyStats(f.env, new Date('2026-09-05T20:00:00Z'));
  assert.equal(f.state.sent.length, 0);

  // Sends at 21:00 to channel
  await index.handleScheduledDailyStats(f.env, new Date('2026-09-05T21:00:00Z'));
  assert.equal(f.state.sent.length, 1);
  assert.equal(f.state.sent[0].chat_id, '@test_channel');
  assert.ok(f.state.sent[0].text.includes('СТАТИСТИКА FOX VIRTUAL TRADER'));
});

