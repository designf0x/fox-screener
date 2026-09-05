// Local workerd/D1 smoke test. All provider traffic is mocked; no real messages are sent.
const { createRequire } = require('node:module');
const dependencies = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, createFetchMock } = dependencies('miniflare');
const esbuild = dependencies('esbuild');
const fs = require('node:fs');
const assert = require('node:assert/strict');

(async () => {
  const built = await esbuild.build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', target: 'es2022', write: false });
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  let price = 100;
  fetchMock.get('https://query2.finance.yahoo.com').intercept({ path: () => true }).reply(200, () => JSON.stringify({
    chart: { result: [{ meta: {
      regularMarketPrice: price, previousClose: 95, regularMarketTime: Math.floor(Date.now() / 1000),
      currentTradingPeriod: { regular: { start: Math.floor(Date.now() / 1000) - 3600, end: Math.floor(Date.now() / 1000) + 3600 } }
    } }] }
  })).persist();
  fetchMock.get('https://api.deepseek.com').intercept({ path: '/chat/completions', method: 'POST' }).reply(200, {
    choices: [{ message: { content: JSON.stringify({ action: 'OPEN_TRADE', symbol: 'BTC-USD', direction: 'LONG', stopLoss: 90, takeProfit: 120, reasoning: 'Test', strategyTag: 'Momentum' }) } }],
    usage: { total_tokens: 1000 }
  }).persist();
  fetchMock.get('https://api.telegram.org').intercept({ path: () => true, method: 'POST' }).reply(200, { ok: true }).persist();
  const mf = new Miniflare({
    modules: true, script: built.outputFiles[0].text, compatibilityDate: '2024-05-02',
    d1Databases: ['DB'], fetchMock,
    bindings: { BOT_TOKEN: 'mock-token', WEBHOOK_SECRET: 'mock-secret', DIAGNOSTICS_TOKEN: 'mock-admin', DEEPSEEK_API_KEY: 'mock-key', TRADING_CHANNEL_ID: '@mock_channel' }
  });
  try {
    const db = await mf.getD1Database('DB');
    for (const file of ['schema.sql', 'migrations/0001_reliability.sql']) {
      const sql = fs.readFileSync(file, 'utf8').replace(/--[^\n]*/g, '');
      // Keep trigger bodies together while splitting this migration's statements.
      for (const match of sql.matchAll(/\s*(CREATE TRIGGER[\s\S]*?END;|[^;]+;)/g)) await db.prepare(match[1]).run();
    }
    const request = () => mf.dispatchFetch('https://worker.test/', {
      method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'mock-secret' },
      body: JSON.stringify({ update_id: 1, message: { chat: { id: 123, type: 'private' }, text: '/scan' } })
    });
    assert.equal((await mf.dispatchFetch('https://worker.test/test/trader/scan')).status, 401);
    const responses = await Promise.all([request(), request()]);
    assert.ok(responses.some(response => response.status === 200));
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM paper_trades').first()).n, 1);
    assert.equal((await db.prepare('SELECT tokens_used FROM chat_daily_usage').first()).tokens_used, 1000);
    price = 121;
    const check = () => mf.dispatchFetch('https://worker.test/test/trader/check', { method: 'POST', headers: { Authorization: 'Bearer mock-admin' } });
    const bodies = await Promise.all((await Promise.all([check(), check()])).map(response => response.json()));
    assert.equal(bodies.flatMap(body => body.closedEvents || []).length, 1);
    const rows = await db.prepare('SELECT * FROM trade_notifications ORDER BY id').all();
    assert.equal(rows.results.length, 2);
    assert.ok(rows.results.every(row => row.delivered_at));
    console.log('PASS: Worker bundle, local D1 migration, authentication, concurrent update deduplication, conditional exits, token accounting, and notification delivery.');
  } finally {
    await mf.dispose();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
