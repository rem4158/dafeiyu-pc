'use strict';

// Actual authenticated loopback HTTP, native model tools and durable SQLite.
// Only local HTTP reaches a socket; every provider request is answered in memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tempRoot = path.resolve(__dirname, '../temp');
fs.mkdirSync(tempRoot, { recursive: true });
const dir = fs.mkdtempSync(path.join(tempRoot, 'usage-budget-service-'));
const originalDataDir = process.env.DAFEIYU_DATA_DIR;
process.env.DAFEIYU_DATA_DIR = dir;
const originalFetch = global.fetch;
const FAKE_KEY = 'budget-e2e-private-key-never-return';
const PROVIDER_BODY = 'private-upstream-body-never-return';
const MODEL = 'gpt-6.1-terra';
let backend, fixture, generations = 0, counts = 0, memoryCalls = 0;
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});
const usage = (input, output) => ({ input_tokens: input, output_tokens: output,
  total_tokens: input + output, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 0 } });
const call = (name, args, id) => ({ type: 'function_call', name,
  call_id: id || `fixture-${name}-${generations}`, arguments: JSON.stringify(args) });
const complete = (text = '已收到。', actual = usage(20, 5)) => json({ status: 'completed', usage: actual,
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text',
    text: JSON.stringify([{ text, delay: 0 }]) }] }] });
const command = (scope, tokens, evidence, tokenText = `${tokens} tokens`) => ({ scope, tokens,
  usd: null, token_text: tokenText, usd_text: null, evidence });
function scenario(name, respond, extra = {}) {
  fixture = { name, respond, calls: 0, countCalls: 0, results: [], counted: null, ...extra };
  return fixture;
}
function safe(value) {
  const encoded = JSON.stringify(value);
  assert.ok(!encoded.includes(FAKE_KEY), 'local results never expose credentials');
  assert.ok(!encoded.includes(PROVIDER_BODY), 'local results never expose provider bodies');
}
global.fetch = async (url, options = {}) => {
  const address = new URL(String(url));
  if (address.protocol === 'http:' && address.hostname === '127.0.0.1')
    return originalFetch(url, options);
  assert.equal(address.origin, 'https://api.openai.com', 'no real provider/account calls');
  assert.ok(['/v1/responses', '/v1/responses/input_tokens', '/v1/chat/completions'].includes(address.pathname));
  assert.ok(fixture, 'every upstream call belongs to a named isolated fixture');
  const body = JSON.parse(options.body);
  assert.equal(body.model, MODEL, 'budget never changes the configured model');
  if (address.pathname === '/v1/chat/completions') {
    memoryCalls++;
    assert.fail('disabled memory/cognition must not make background model calls');
  }
  assert.ok(Array.isArray(body.input));
  assert.ok(body.tools.some(tool => tool.name === 'usage_budget_set'), 'native setter survives memory-off');
  assert.ok(body.tools.some(tool => tool.name === 'usage_status'));
  assert.ok(!body.tools.some(tool => tool.name === 'memory_teach'), 'memory really is off');
  if (address.pathname === '/v1/responses/input_tokens') {
    counts++; fixture.countCalls++; fixture.counted = body;
    if (fixture.countFailure) return json({ error: { message: `${PROVIDER_BODY} ${FAKE_KEY}` } }, 503);
    return json({ input_tokens: 20 });
  }
  generations++; fixture.calls++;
  if (fixture.mustNotGenerate) assert.fail(`${fixture.name}: generation must be blocked before fetch`);
  if (fixture.counted) {
    for (const [key, value] of Object.entries(fixture.counted))
      assert.deepEqual(body[key], value, `official input count includes identical ${key}`);
    assert.equal(body.service_tier, 'default', 'budget price bound uses default service tier');
    assert.ok(Number.isInteger(body.max_output_tokens) && body.max_output_tokens > 0);
    fixture.counted = null;
  } else {
    assert.ok(!fixture.requirePreflight, 'budgeted generation needs successful official count');
    assert.equal(body.service_tier, undefined, 'unlimited path retains original request');
  }
  const results = body.input.filter(item => item.type === 'function_call_output')
    .map(item => ({ call_id: item.call_id, value: JSON.parse(item.output) }));
  for (const result of results) safe(result.value);
  fixture.results = results;
  return fixture.respond(body, results);
};

async function main() {
  const settings = require('./electron/brain/settings');
  settings.saveSettings({ provider: 'cloud', cloud: { baseUrl: 'https://api.openai.com/v1',
    apiKey: FAKE_KEY, model: MODEL }, memory: { enabled: false, autoExtract: false },
    cognition: { enabled: false }, proactive: { enabled: false }, voice: { enabled: false },
    stickers: { enabled: false } });
  const { createBackend } = require('./service');
  const api = async (method, route, body, expected = 200, authenticated = true) => {
    const response = await originalFetch(backend.descriptor.url + route, { method, headers: {
      ...(authenticated ? { Authorization: 'Bearer ' + backend.descriptor.token } : {}),
      'Content-Type': 'application/json',
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); safe(result);
    assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(result)}`);
    return result;
  };
  const chat = (requestId, text, expected = 200) => api('POST', '/chat', {
    session_id: 'main', request_id: requestId, text,
  }, expected);
  const live = async () => (await api('GET', '/usage')).budget;
  const unconfigured = async () => {
    const budget = await live(); assert.equal(budget.enforced, false);
    assert.deepEqual(budget.policies, { daily: null, per_task: null, current_task: null });
  };
  const clear = async () => {
    const before = generations;
    const result = await api('POST', '/usage/budget/clear', {});
    assert.equal(result.ok, true); assert.equal(result.budget.enforced, false);
    assert.equal(generations, before, 'local clear does not invoke a model');
    await unconfigured();
  };
  try {
    backend = await createBackend();
    await unconfigured();
    assert.equal(generations, 0); assert.equal(counts, 0);

    // A numeric natural message reaches the same model. Its tool choice owns intent.
    const dailyText = '每天最多100 tokens，到了就停。';
    scenario('daily-exhausted-at-setting', (body, results) => {
      assert.equal(results.length, 0);
      assert.ok(JSON.stringify(body.input).includes(dailyText));
      return json({ status: 'completed', usage: usage(80, 20),
        output: [call('usage_budget_set', command('daily', 100, dailyText))] });
    });
    const receipt = await chat('budget-daily', dailyText);
    assert.equal(fixture.calls, 1, 'decision settles 100; continuation is denied before generation');
    assert.equal(receipt.budget_blocked, true);
    assert.equal(receipt.budget_error, 'usage_budget_exceeded');
    assert.match(receipt.text, /100 tokens/);
    let budget = await live();
    assert.equal(budget.enforced, true); assert.equal(budget.policies.daily.tokens, 100);
    assert.equal(budget.daily.used_tokens, 100); assert.equal(budget.daily.reserved_tokens, 0);
    assert.equal(budget.daily.remaining_tokens, 0);
    const settled = generations;
    assert.deepEqual(await chat('budget-daily', dailyText), receipt);
    assert.equal(generations, settled, 'persisted local receipt replay makes no invocation');

    scenario('ordinary-exhausted', () => assert.fail('no model generation'), { mustNotGenerate: true });
    const denied = await chat('budget-denied', '再聊一句。', 429);
    assert.equal(denied.code, 'usage_budget_exceeded');
    assert.equal(generations, settled); assert.equal((await live()).policies.daily.tokens, 100);
    await backend.close(); backend = await createBackend();
    assert.equal((await live()).policies.daily.tokens, 100, 'daily policy persists across backend restart');
    assert.deepEqual(await chat('budget-daily', dailyText), receipt);
    assert.equal(generations, settled);
    const restartedDenied = await chat('budget-after-restart', '重开后继续。', 429);
    assert.equal(restartedDenied.code, 'usage_budget_exceeded');
    assert.equal(generations, settled);

    await api('POST', '/usage/budget/clear', {}, 401, false);
    assert.equal((await live()).policies.daily.tokens, 100, 'unauthenticated clear has no effect');
    for (const invalid of [{ tokens: null }, [], null, 'clear'])
      await api('POST', '/usage/budget/clear', invalid, 400);
    assert.equal((await live()).policies.daily.tokens, 100);
    await clear();
    assert.deepEqual(await chat('budget-daily', dailyText), receipt);
    assert.equal(generations, settled);
    await unconfigured(); // Replaying old successful setter result must not reapply it.

    const taskText = '以后每个任务最多150 tokens。';
    scenario('per-task-control', (body, results) => {
      if (!results.length) return json({ status: 'completed', usage: usage(80, 20),
        output: [call('usage_budget_set', command('per_task', 150, taskText))] });
      assert.equal(results.at(-1).value.ok, true);
      assert.equal(results.at(-1).value.result.applied, true);
      assert.equal(results.at(-1).value.result.budget.task.used_tokens, 100);
      assert.ok(body.max_output_tokens <= 30, '150 - settled100 - counted20 leaves at most30 output');
      return complete('以后每个任务的上限已设置。');
    });
    await chat('budget-per-task', taskText);
    assert.equal(fixture.calls, 2); assert.equal(fixture.countCalls, 1);
    let status = await api('GET', '/usage');
    assert.equal(status.budget.policies.per_task.tokens, 150);
    assert.equal(status.usage.previous_request.total_tokens, 125, 'actual25 releases unused reservation');
    assert.equal(status.budget.daily.reserved_tokens, 0);
    scenario('fresh-task', body => {
      assert.equal(body.max_output_tokens, 130, 'new request receives a fresh150 task cap');
      return complete();
    }, { requirePreflight: true });
    await chat('budget-task-fresh', '这个是新的任务。');
    assert.equal(fixture.countCalls, 1); assert.equal(fixture.calls, 1);
    assert.equal((await api('GET', '/usage')).usage.previous_request.total_tokens, 25);

    scenario('count-failed', () => assert.fail('failed counting must prevent generation'),
      { countFailure: true, mustNotGenerate: true });
    const beforeCountFailure = generations;
    const countError = await chat('budget-count-failed', '预先计数失败。', 429);
    assert.equal(countError.code, 'usage_budget_count_failed');
    assert.equal(generations, beforeCountFailure); assert.equal(fixture.countCalls, 1);
    assert.equal((await live()).policies.per_task.tokens, 150);
    // Malformed evidence, numeric invention and CNY must remain failed tool receipts.
    const unchangedPolicies = (await live()).policies;
    for (const [name, text, args, expected] of [
      ['stale-evidence', '我现在只想聊聊天。', command('daily', 1000, '每天1000 tokens'), 'usage_budget_evidence'],
      ['numeric-mismatch', '每天最多1000 tokens。', command('daily', 1001, '每天最多1000 tokens。', '1000 tokens'), 'usage_budget_evidence'],
      ['cny', '每天预算5元。', { scope: 'daily', tokens: null, usd: 5,
        usd_text: '5元', token_text: null, evidence: '每天预算5元。' }, 'usage_budget_currency'],
    ]) {
      scenario(name, (body, results) => {
        if (!results.length) return json({ status: 'completed', usage: usage(20, 5),
          output: [call('usage_budget_set', args)] });
        assert.equal(results.at(-1).value.ok, false);
        assert.equal(results.at(-1).value.error.code, expected);
        return complete('预算操作未完成。');
      }, { requirePreflight: true });
      await chat(`budget-${name}`, text);
      assert.equal(fixture.calls, 2); assert.equal(fixture.countCalls, 2);
      assert.deepEqual((await live()).policies, unchangedPolicies, 'failed mutation preserves active policy');
    }
    await clear();

    const lockedText = '看看后台浏览状态，每天最多1000 tokens。';
    scenario('other-tool-lock', (body, results) => {
      if (!results.length) return json({ status: 'completed', usage: usage(20, 5),
        output: [call('background_browse_status', {}, 'read-browse-status')] });
      if (results.length === 1) {
        assert.equal(results[0].value.ok, true);
        assert.equal(results[0].value.result.task, null);
        return json({ status: 'completed', usage: usage(20, 5), output: [
          call('usage_budget_set', command('daily', 1000, lockedText), 'locked-budget-change')] });
      }
      assert.equal(results.at(-1).value.ok, false);
      assert.equal(results.at(-1).value.error.code, 'usage_budget_evidence');
      return complete('读取其他工具后不能改预算。');
    });
    await chat('budget-after-tool', lockedText);
    assert.equal(fixture.calls, 3); assert.equal(fixture.countCalls, 0);
    await unconfigured();

    scenario('model-does-not-set-budget', () => complete('这只是讨论。'));
    await chat('budget-no-tool-choice', '如果以后每天最多1000 tokens会怎么样？');
    assert.equal(fixture.calls, 1); assert.equal(fixture.countCalls, 0);
    await unconfigured();

    const route = '/usage/budget/settings';
    await api('GET', route, undefined, 401, false);
    const initialView = await api('GET', route);
    const beforeSettings = generations;
    await api('PUT', route, { revision: initialView.revision, daily: 10_000_001, per_task: 30 }, 400);
    assert.equal((await api('GET', route)).budget.policies.per_task, null);
    const updated = await api('PUT', route, { revision: initialView.revision, daily: 10_000_000, per_task: 30 });
    assert.equal(updated.budget.policies.daily.tokens, 10_000_000);
    assert.equal(updated.budget.policies.per_task.tokens, 30);
    assert.equal(generations, beforeSettings, 'settings only writes local ledger');
    await api('PUT', route, { revision: initialView.revision, per_task: null }, 409);
    scenario('settings-per-task', body => {
      assert.equal(body.max_output_tokens, 10);
      return complete();
    }, { requirePreflight: true });
    await chat('budget-from-settings', '请在设置限额内回复。');
    const afterChat = await api('GET', route);
    assert.equal(afterChat.today.tokens, initialView.today.tokens + 25);
    assert.equal(afterChat.latest_task.tokens, 25);
    assert.equal(afterChat.budget.task.remaining_tokens, 5);
    await api('PUT', route, { revision: afterChat.revision, daily: afterChat.today.tokens + 10 });
    scenario('settings-daily', () => assert.fail('daily cap must prevent generation'), { mustNotGenerate: true });
    assert.equal((await chat('daily-cap-from-settings', '今天还能发吗？', 429)).code, 'usage_budget_exceeded');
    assert.equal(fixture.calls, 0);
    await clear();
    assert.equal(memoryCalls, 0);
    console.log('usage-budget-service-e2e: PASS (native numeric setting, pre-fetch admission, durable receipt/replay/restart, authenticated clear, per-task settlement, official count failure, evidence/tool boundaries; fake upstream only)');
  } finally {
    await backend?.close(); global.fetch = originalFetch;
    if (originalDataDir === undefined) delete process.env.DAFEIYU_DATA_DIR;
    else process.env.DAFEIYU_DATA_DIR = originalDataDir;
    assert.ok(path.resolve(dir).startsWith(tempRoot + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => {
  // Assertion details can contain upstream inputs. Keep failure output bounded and private.
  const message = String(error?.message || error).replaceAll(FAKE_KEY, '[redacted]')
    .replaceAll(PROVIDER_BODY, '[redacted]');
  console.error(`usage-budget-service-e2e: FAIL ${error?.name || 'Error'}: ${message.slice(0, 1500)}`);
  process.exitCode = 1;
});
