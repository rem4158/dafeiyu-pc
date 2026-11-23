// Actual authenticated local HTTP + model tool loop + SQLite; upstream is in-memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tempRoot = path.resolve(__dirname, '../temp');
fs.mkdirSync(tempRoot, { recursive: true });
const dir = fs.mkdtempSync(path.join(tempRoot, 'usage-service-'));
process.env.DAFEIYU_DATA_DIR = dir;
const realFetch = global.fetch;
let backend, mode = 'query', modelCalls = 0, memoryCalls = 0, toolSnapshot;
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
global.fetch = async (url, options) => {
  const address = String(url);
  if (address.startsWith('http://127.0.0.1:')) return realFetch(url, options);
  assert.ok(address.startsWith('https://api.openai.com/v1/'), 'no provider/account network calls');
  if (address.endsWith('/chat/completions')) {
    const body = JSON.parse(options.body);
    assert.ok(body.messages[0].content.includes('提取助手')); memoryCalls++;
    return json({ choices: [{ message: { content: '[]' } }], usage: { prompt_tokens: 40,
      completion_tokens: 10, total_tokens: 50, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 } } });
  }
  assert.equal(address, 'https://api.openai.com/v1/responses');
  const body = JSON.parse(options.body); modelCalls++;
  assert.equal(body.model, 'gpt-6.1-terra');
  assert.ok(body.tools.some(tool => tool.name === 'usage_status'), 'same model receives native usage tool');
  const result = body.input.findLast(item => item.type === 'function_call_output');
  const usage = mode === 'missing' ? undefined : { input_tokens: 100, output_tokens: 20, total_tokens: 120,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 10 } };
  if (mode === 'incomplete') return json({ status: 'incomplete', usage, output: [] });
  if (mode === 'query' && !result) return json({ status: 'completed', usage, output: [
    { type: 'function_call', call_id: 'usage-fixture-' + modelCalls, name: 'usage_status', arguments: '{}' },
  ] });
  if (result) {
    toolSnapshot = JSON.parse(result.output);
    assert.ok(toolSnapshot.ok);
  }
  return json({ status: 'completed', usage, output: [{ type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: JSON.stringify([{ text: result
      ? `本轮已结算 ${toolSnapshot.result.usage.current_request.total_tokens} tokens；余额尚未接入。` : '收到啦。', delay: 0 }]) }] }] });
};

async function main() {
  const settings = require('./electron/brain/settings');
  settings.saveSettings({ provider: 'cloud', cloud: { baseUrl: 'https://api.openai.com/v1', apiKey: 'fake-private-key', model: 'gpt-6.1-terra' },
    memory: { enabled: false, autoExtract: false }, cognition: { enabled: false }, proactive: { enabled: false },
    voice: { enabled: false }, stickers: { enabled: false } });
  const { createBackend } = require('./service');
  const api = async (method, route, body, expected = 200) => {
    const response = await realFetch(backend.descriptor.url + route, { method, headers: {
      Authorization: 'Bearer ' + backend.descriptor.token, 'Content-Type': 'application/json',
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  };
  try {
    backend = await createBackend();
    const before = await api('GET', '/balance');
    assert.equal(before.provider, 'openai'); assert.equal(before.balance_status, 'unsupported');
    assert.equal(before.account_available, null); assert.equal(before.budget.enforced, false);
    assert.ok(!before.hint.includes('不足') && !before.hint.includes('DeepSeek'));
    assert.equal(before.usage.today.calls, 0); assert.equal(modelCalls, 0, 'balance read never uses model');
    const payload = { session_id: 'main', request_id: 'usage-first', text: '帮我看看今天用掉多少了。' };
    const answer = await api('POST', '/chat', payload);
    assert.equal(modelCalls, 2); assert.ok(answer.text.includes('120 tokens'));
    assert.equal(toolSnapshot.result.usage.current_request.calls, 1, 'tool sees settled tool-decision invocation');
    assert.equal(toolSnapshot.result.account_available, null);
    let status = await api('GET', '/usage');
    assert.equal(status.usage.today.calls, 2); assert.equal(status.usage.today.total_tokens, 240);
    assert.equal(status.usage.today.reasoning_tokens, 20);
    assert.ok(Math.abs(status.usage.today.estimated_cost - .0004) < 1e-12);
    assert.equal(status.usage.today.unknown_calls, 0);
    assert.deepEqual(await api('POST', '/chat', payload), answer); assert.equal(modelCalls, 2);
    assert.equal((await api('GET', '/balance')).usage.today.calls, 2, 'replay does not invent a new provider invocation');
    mode = 'missing';
    await api('POST', '/chat', { ...payload, request_id: 'usage-missing', text: '缺少 usage 的假响应。' });
    status = await api('GET', '/balance');
    assert.equal(status.usage.today.unknown_calls, 1); assert.equal(status.usage.today.total_tokens, 240);
    assert.ok(status.detail.includes('用量未知'));
    mode = 'incomplete';
    await api('POST', '/chat', { ...payload, request_id: 'usage-failed', text: '返回用量后被截断的假响应。' }, 502);
    status = await api('GET', '/balance');
    assert.equal(status.usage.today.calls, 4); assert.equal(status.usage.today.total_tokens, 360, 'failed reply retains provider-reported spend');
    assert.equal(status.usage.today.unknown_calls, 1);
    assert.ok(!JSON.stringify(status).includes('fake-private-key'));
    const knownBeforeRestart = status.usage.today;
    await backend.close(); backend = await createBackend();
    status = await api('GET', '/balance');
    assert.equal(status.usage.today.calls, knownBeforeRestart.calls);
    assert.equal(status.usage.today.total_tokens, knownBeforeRestart.total_tokens);
    assert.deepEqual(await api('POST', '/chat', payload), answer); assert.equal(modelCalls, 4);
    settings.saveSettings({ cloud: { apiKey: 'fake-second-account' } });
    assert.equal((await api('GET', '/balance')).usage.today.calls, 0, 'different credentials do not inherit previous account spend');
    settings.saveSettings({ cloud: { apiKey: 'fake-private-key' } });
    assert.equal((await api('GET', '/balance')).usage.today.calls, 4);
    mode = 'memory';
    settings.saveSettings({ memory: { enabled: true, autoExtract: true } });
    await api('POST', '/chat', { ...payload, request_id: 'usage-memory', text: '我平时喜欢喝桂花乌龙茶。' });
    status = await api('GET', '/balance');
    assert.equal(memoryCalls, 2, 'both fact and people extraction use the shared transport');
    assert.equal(status.usage.today.by_purpose.memory_extract.total_tokens, 50);
    assert.equal(status.usage.today.by_purpose.memory_people.total_tokens, 50);
    assert.equal(status.usage.previous_request.total_tokens, 220, 'turn aggregate includes its memory work');
    console.log('usage-service-e2e: PASS (native tool, common card/API, actual usage/cost, replay, missing/incomplete, restart, account scopes; fake upstream only)');
  } finally {
    await backend?.close(); global.fetch = realFetch;
    assert.ok(path.resolve(dir).startsWith(tempRoot + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
