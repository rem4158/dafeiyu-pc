const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const root = path.resolve(__dirname, '../temp'); fs.mkdirSync(root, { recursive: true });
const dir = fs.mkdtempSync(path.join(root, 'budget-transport-')); process.env.DAFEIYU_DATA_DIR = dir;
const ledger = require('./usage-ledger');
const { chatCloud, chatCloudTurn } = require('./electron/brain/cloud');
const { chatOllama } = require('./electron/brain/ollama');
const { estimateUpperCost, estimateCost } = require('./usage-pricing');
const originalFetch = global.fetch;
const config = (key, model = 'gpt-6.1-terra') => ({ provider: 'cloud', cloud: {
  baseUrl: 'https://api.openai.com/v1', apiKey: 'fake-' + key, model } });
const messages = [{ role: 'user', content: 'private-input-fixture' }];
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const policy = (cfg, scope, tokens, usd) => ledger.setBudget(cfg, { scope, tokens, usd,
  requestId: 'owner-command', originOrder: 1, operationId: 'owner-' + scope, taskId: 'owner-command' });
const run = (id, fn) => ledger.withUsageContext({ taskId: id, requestId: id, purpose: 'chat' }, fn);
const response = (body, usage = true) => ({ status: 'completed', output: [{ type: 'message', role: 'assistant',
  content: [{ type: 'output_text', text: '预算内回复' }] }], ...(usage ? { usage: { input_tokens: 30,
    output_tokens: Math.min(5, body.max_output_tokens), total_tokens: 30 + Math.min(5, body.max_output_tokens),
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } : {}) });

async function main() {
  let countCalls = 0, paidCalls = 0, bodies = [], mode = 'normal', heldResolve;
  try {
    ledger.enableUsageLedger();
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      if (String(url).endsWith('/responses/input_tokens')) {
        countCalls++;
        assert.deepEqual(body.input, messages); assert.ok(body.model);
        if (mode === 'bad-count') return json({ secret: 'PRIVATE_PROVIDER_BODY' }, 503);
        return json({ object: 'response.input_tokens', input_tokens: 30 });
      }
      assert.equal(String(url), 'https://api.openai.com/v1/responses');
      assert.equal(body.service_tier, 'default');
      assert.ok(Number.isInteger(body.max_output_tokens) && body.max_output_tokens >= 1 && body.max_output_tokens <= 4096);
      paidCalls++; bodies.push(body);
      if (mode === 'hold') return new Promise(resolve => { heldResolve = () => resolve(json(response(body))); });
      if (mode === 'cancel') return new Promise((resolve, reject) => options.signal.addEventListener('abort',
        () => reject(Object.assign(new Error('private abort'), { name: 'AbortError' })), { once: true }));
      return json(response(body, mode !== 'missing'));
    };
    const tokens = config('tokens'); policy(tokens, 'daily', 100, null);
    assert.equal(await run('a', () => chatCloud(tokens, messages, { max_tokens: 80 })), '预算内回复');
    assert.equal(bodies.at(-1).max_output_tokens, 70);
    await run('b', () => chatCloudTurn(tokens, messages, { tools: [], max_tokens: 80 }));
    assert.equal(bodies.at(-1).max_output_tokens, 35);
    const before = paidCalls;
    await assert.rejects(run('c', () => chatCloudTurn(tokens, messages)), { code: 'usage_budget_exceeded' });
    assert.equal(paidCalls, before, 'no inference fetch beyond input+minimum-output room');
    assert.equal(ledger.getBudgetStatus(tokens).daily.used_tokens, 70);
    const dollars = config('usd'); policy(dollars, 'daily', null, .0002);
    await run('usd-a', () => chatCloudTurn(dollars, messages));
    assert.equal(bodies.at(-1).max_output_tokens, 25, 'USD upper bound reserves worst input/cache writes, not optimistic discounts');
    assert.ok(estimateUpperCost({ provider: 'openai', model: 'gpt-6.1-terra', input_tokens: 30, output_tokens: 25 }).amount <= .0002);
    const unknownPrice = config('unpriced', 'unknown-tariff'); policy(unknownPrice, 'daily', null, 1);
    await assert.rejects(run('usd-unknown', () => chatCloudTurn(unknownPrice, messages)), { code: 'usage_budget_unpriced' });
    const unknownUsage = config('missing'); policy(unknownUsage, 'daily', 100, null); mode = 'missing';
    await run('missing-a', () => chatCloudTurn(unknownUsage, messages));
    assert.equal(ledger.getBudgetStatus(unknownUsage).daily.reserved_tokens, 100);
    const beforeMissing = paidCalls;
    await assert.rejects(run('missing-b', () => chatCloudTurn(unknownUsage, messages)), { code: 'usage_budget_exceeded' });
    assert.equal(paidCalls, beforeMissing, 'missing usage retains entire hold');
    const badCount = config('count'); policy(badCount, 'daily', 100, null); mode = 'bad-count';
    const beforeCount = paidCalls;
    await assert.rejects(run('bad-count', () => chatCloudTurn(badCount, messages)), { code: 'usage_budget_count_failed' });
    assert.equal(paidCalls, beforeCount);
    assert.equal(ledger.getUsageSummary(badCount).all_time.calls, 0, 'failed counting is not a fabricated generation invocation');
    const cancelling = config('cancel'); policy(cancelling, 'daily', 100, null); mode = 'cancel';
    const abort = new AbortController();
    const cancelled = run('cancel-a', () => chatCloudTurn(cancelling, messages, { signal: abort.signal }));
    await new Promise(resolve => setTimeout(resolve, 5)); abort.abort();
    await assert.rejects(cancelled, { code: 'model_aborted' });
    assert.equal(ledger.getBudgetStatus(cancelling).daily.reserved_tokens, 100);
    const concurrent = config('concurrent'); policy(concurrent, 'daily', 100, null); mode = 'hold';
    const beforeConcurrent = paidCalls;
    const outcomes = Promise.allSettled([
      run('parallel-a', () => chatCloudTurn(concurrent, messages)),
      run('parallel-b', () => chatCloudTurn(concurrent, messages)),
    ]);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(paidCalls, beforeConcurrent + 1, 'parallel preflight cannot spend the same remaining budget twice');
    heldResolve();
    const settled = await outcomes;
    assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(settled.find(item => item.status === 'rejected').reason.code, 'usage_budget_exceeded');
    const local = { provider: 'ollama', ollama: { baseUrl: 'http://local.invalid', model: 'fixture' } };
    policy(local, 'daily', 100, null);
    const beforeLocal = countCalls + paidCalls;
    await assert.rejects(run('local', () => chatOllama(local, messages)), { code: 'usage_budget_unsupported' });
    assert.equal(countCalls + paidCalls, beforeLocal, 'unsupported provider fails closed without network/model switch');
    for (const size of [100, 272000, 272001]) {
      const upper = estimateUpperCost({ provider: 'openai', model: 'gpt-6.1-terra', input_tokens: size, output_tokens: 40 }).amount;
      const actual = estimateCost({ provider: 'openai', model: 'gpt-6.1-terra', input_tokens: size, output_tokens: 40,
        cached_tokens: 0, cache_write_tokens: size, cache_write_30m_tokens: 0, cache_write_12h_tokens: size, service_tier: 'default' }).amount;
      assert.ok(upper >= actual, 'verified tariff bound includes longest cache retention and long context');
    }
    console.log('usage-budget-transport: PASS (official count, output clamp, USD upper reserve, unknown/cancel holds, no paid overrun, atomic concurrent calls, unsupported fail closed)');
  } finally {
    ledger.closeUsageLedger(); global.fetch = originalFetch;
    assert.ok(path.resolve(dir).startsWith(root + path.sep)); fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
