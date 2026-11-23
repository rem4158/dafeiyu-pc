const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const temp = path.resolve(__dirname, '../temp'); fs.mkdirSync(temp, { recursive: true });
const dir = fs.mkdtempSync(path.join(temp, 'usage-transport-')); process.env.DAFEIYU_DATA_DIR = dir;
const ledger = require('./usage-ledger');
const { chatCloud, chatCloudTurn } = require('./electron/brain/cloud');
const { chatOllama, chatOllamaTurn } = require('./electron/brain/ollama');
const originalFetch = global.fetch;
const cfg = { provider: 'cloud', cloud: { model: 'gpt-6.1-terra', apiKey: 'fake-secret', baseUrl: 'https://api.openai.com/v1' } };
const messages = [{ role: 'user', content: 'fixture-private-input' }];
const usage = { input_tokens: 45, output_tokens: 5, total_tokens: 50,
  input_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 2 } };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const totals = (settings, id) => ledger.getUsageSummary(settings, { requestId: id }).current_request;
const run = (id, operation) => ledger.withUsageContext({ requestId: id, taskId: id, purpose: 'chat' }, operation);
async function main() {
  try {
    ledger.enableUsageLedger();
    global.fetch = async (url, options) => {
      assert.equal(JSON.parse(options.body).stream_options.include_usage, true);
      return new Response('data: '+JSON.stringify({ choices: [{ delta: { content: '你好' } }], usage: null })+'\n\n'+
        'data: '+JSON.stringify({ choices: [], usage })+'\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    };
    assert.equal(await run('stream', () => chatCloud(cfg, messages)), '你好');
    assert.equal(totals(cfg, 'stream').total_tokens, 50); assert.equal(totals(cfg, 'stream').calls, 1);
    global.fetch = async () => json({ choices: [{ message: { content: 'JSON回退' } }], usage });
    assert.equal(await run('fallback', () => chatCloud(cfg, messages, { usageContext: { purpose: 'memory_extract' } })), 'JSON回退');
    assert.equal(ledger.getUsageSummary(cfg).today.by_purpose.memory_extract.calls, 1);
    assert.equal(totals(cfg, 'fallback').calls, 1, 'purpose override preserves parent request/task');
    const compatible = { ...cfg, cloud: { ...cfg.cloud, baseUrl: 'https://compatible.invalid/v1' } };
    global.fetch = async (url, options) => {
      assert.equal(Object.hasOwn(JSON.parse(options.body), 'stream_options'), false);
      return json({ choices: [{ message: { content: '未报告用量' } }] });
    };
    await run('missing', () => chatCloud(compatible, messages));
    assert.equal(totals(compatible, 'missing').unknown_calls, 1);
    global.fetch = async () => json({ status: 'incomplete', usage, output: [] });
    await assert.rejects(run('incomplete', () => chatCloudTurn(cfg, messages, { tools: [] })), error => error.code === 'cloud_incomplete');
    assert.equal(totals(cfg, 'incomplete').failed_calls, 1); assert.equal(totals(cfg, 'incomplete').total_tokens, 50);
    const controller = new AbortController();
    global.fetch = async () => new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new TextEncoder().encode('data: '+JSON.stringify({ choices: [], usage })+'\n\n'));
      setTimeout(() => { controller.abort(); stream.error(Object.assign(new Error('fixture stop'), { name: 'AbortError' })); }, 0);
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
    await assert.rejects(run('cancel', () => chatCloud(cfg, messages, { signal: controller.signal })));
    assert.equal(totals(cfg, 'cancel').cancelled_calls, 1); assert.equal(totals(cfg, 'cancel').total_tokens, 50);
    global.fetch = async () => { throw new Error('PRIVATE_TRANSPORT_ERROR'); };
    await assert.rejects(run('network', () => chatCloudTurn(cfg, messages)), error => error.code === 'cloud_network' && !error.message.includes('PRIVATE'));
    assert.equal(totals(cfg, 'network').unknown_calls, 1);
    const local = { provider: 'ollama', ollama: { baseUrl: 'http://local.invalid:11434', model: 'fixture' } };
    global.fetch = async () => new Response(JSON.stringify({ message: { content: '好' }, done: false })+'\n'+
      JSON.stringify({ message: { content: '' }, done: true, prompt_eval_count: 7, eval_count: 24 })+'\n');
    assert.equal(await run('ollama-stream', () => chatOllama(local, messages)), '好');
    assert.equal(totals(local, 'ollama-stream').total_tokens, 31);
    global.fetch = async () => json({ done: false, message: { content: '未完成' }, prompt_eval_count: 7, eval_count: 24 });
    await assert.rejects(run('ollama-incomplete', () => chatOllamaTurn(local, messages)), error => error.code === 'ollama_incomplete');
    assert.equal(totals(local, 'ollama-incomplete').total_tokens, 31);
    assert.equal(totals(local, 'ollama-incomplete').failed_calls, 1);
    const before = ledger.getUsageSummary(cfg).all_time.calls;
    await assert.rejects(chatCloud({ ...cfg, cloud: { ...cfg.cloud, apiKey: '' } }, messages));
    assert.equal(ledger.getUsageSummary(cfg).all_time.calls, before, 'no row before model input validation');
    ledger.closeUsageLedger();
    global.fetch = async () => json({ choices: [{ message: { content: '未启用记录' } }], usage });
    assert.equal(await chatCloud(cfg, messages), '未启用记录');
    assert.equal(ledger.getUsageSummary(cfg).status, 'disabled');
    console.log('usage-transport: PASS (SSE usage-only final chunk, JSON fallback, compatible shape, purpose context, incomplete/cancel/network, Ollama, disabled ledger)');
  } finally {
    ledger.closeUsageLedger(); global.fetch = originalFetch;
    assert.ok(path.resolve(dir).startsWith(temp + path.sep)); fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
