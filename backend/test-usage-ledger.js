const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const temp = path.resolve(__dirname, '../temp'); fs.mkdirSync(temp, { recursive: true });
const dir = fs.mkdtempSync(path.join(temp, 'usage-ledger-'));
const originalRoot = process.env.DAFEIYU_DATA_DIR; process.env.DAFEIYU_DATA_DIR = dir;
const ledger = require('./usage-ledger');
const cfg = { provider: 'cloud', cloud: { baseUrl: 'https://api.openai.com/v1', apiKey: 'PRIVATE_API_KEY', model: 'gpt-6.1-terra' } };
const reported = { usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120,
  input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 10 } },
  content: 'PRIVATE_CHAT_BODY', url: 'PRIVATE_URL' };
function call(requestId, purpose = 'chat', settings = cfg) {
  return ledger.withUsageContext({ requestId, taskId: requestId, sessionId: 'main', channel: 'pc', purpose },
    () => ledger.beginCall(settings, { kind: 'responses' }));
}
async function main() {
  try {
    call('disabled').observe(reported);
    assert.equal(fs.existsSync(path.join(dir, 'usage-ledger.db')), false, 'module import/direct calls do not enable writes');
    assert.equal(ledger.getUsageSummary(cfg).status, 'disabled');
    assert.equal(ledger.enableUsageLedger(), true);
    const first = call('first'); first.observe(reported); first.observe(reported); first.finish('completed'); first.finish('cancelled');
    let summary = ledger.getUsageSummary(cfg, { requestId: 'first', taskId: 'first' });
    assert.equal(summary.today.calls, 1); assert.equal(summary.today.total_tokens, 120);
    assert.equal(summary.today.cached_tokens, 20); assert.equal(summary.today.reasoning_tokens, 10);
    assert.equal(summary.current_request.calls, 1); assert.equal(summary.current_task.calls, 1);
    assert.equal(summary.today.estimated_cost, (80 + 20 * .05 + 20 * 5) / 1e6);
    call('unknown').finish('cancelled');
    const writes = call('writes', 'memory_extract');
    writes.observe({ usage: { input_tokens: 200, output_tokens: 50, total_tokens: 250,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 80,
        cache_write_tokens_details: { ttl_30m_tokens: 60, ttl_12h_tokens: 20 } },
      output_tokens_details: { reasoning_tokens: 40 } } }); writes.finish('failed');
    summary = ledger.getUsageSummary(cfg);
    assert.equal(summary.today.calls, 3); assert.equal(summary.today.known_calls, 2);
    assert.equal(summary.today.unknown_calls, 1); assert.equal(summary.today.total_tokens, 370);
    assert.equal(summary.today.reasoning_tokens, 50); assert.equal(summary.today.cache_write_tokens, 80);
    assert.equal(summary.today.by_purpose.memory_extract.total_tokens, 250);
    assert.equal(summary.today.failed_calls, 1);
    const exact = summary.today.estimated_cost;
    const changedKey = { ...cfg, cloud: { ...cfg.cloud, apiKey: 'SECOND_KEY' } };
    assert.equal(ledger.getUsageSummary(changedKey).today.calls, 0);
    const changedModel = { ...cfg, cloud: { ...cfg.cloud, model: 'unverified-model' } };
    assert.equal(ledger.getUsageSummary(changedModel).today.calls, 3, 'same account across models');
    const unpriced = call('unpriced', 'chat', changedModel); unpriced.observe(reported); unpriced.finish('completed');
    assert.equal(ledger.getUsageSummary(cfg).today.unpriced_calls, 1);
    assert.equal(ledger.getUsageSummary(cfg).today.estimated_cost, exact);
    await Promise.all(['async-a', 'async-b'].map((requestId, index) => ledger.withUsageContext({ requestId, taskId: requestId }, async () => {
      await new Promise(resolve => setTimeout(resolve, index ? 0 : 5));
      const record = ledger.beginCall(cfg, { kind: 'responses' }); record.observe(reported); record.finish('completed');
    })));
    assert.equal(ledger.getUsageSummary(cfg, { requestId: 'async-a' }).current_request.calls, 1);
    assert.equal(ledger.getUsageSummary(cfg, { requestId: 'async-b' }).current_request.calls, 1);
    const deepseek = { provider: 'cloud', cloud: { baseUrl: 'https://api.deepseek.com', apiKey: 'OTHER_PRIVATE_KEY', model: 'deepseek-flash' } };
    const mismatch = call('mismatch', 'chat', deepseek);
    mismatch.observe({ usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25,
      prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 99 } }); mismatch.finish('completed');
    assert.equal(ledger.getUsageSummary(deepseek).today.cached_tokens, null);
    assert.equal(ledger.getUsageSummary(deepseek).today.total_tokens, 25);
    const pending = call('pending');
    assert.equal(ledger.getUsageSummary(cfg).today.pending_calls, 1);
    ledger.closeUsageLedger();
    const inspect = new DatabaseSync(path.join(dir, 'usage-ledger.db'));
    try {
      const rows = JSON.stringify(inspect.prepare('SELECT * FROM model_usage').all());
      for (const secret of ['PRIVATE_API_KEY', 'PRIVATE_CHAT_BODY', 'PRIVATE_URL', 'OTHER_PRIVATE_KEY', 'https://'])
        assert.ok(!rows.includes(secret), 'numeric-only privacy: ' + secret);
      inspect.prepare("UPDATE model_usage SET state='pending',finished_at=NULL WHERE request_id='pending'").run();
    } finally { inspect.close(); }
    assert.equal(ledger.enableUsageLedger(), true);
    summary = ledger.getUsageSummary(cfg);
    assert.equal(summary.today.pending_calls, 0); assert.equal(summary.today.interrupted_calls, 1);
    assert.equal(summary.today.unknown_calls, 2); assert.equal(summary.today.calls, 7);
    pending.observe(reported); pending.finish('completed');
    assert.equal(ledger.getUsageSummary(cfg).today.unknown_calls, 2, 'late old recorder cannot edit reopened store');
    const savedTotal = summary.all_time.total_tokens;
    ledger.closeUsageLedger();
    const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const midnight = Date.parse(day + 'T00:00:00+08:00');
    const dates = new DatabaseSync(path.join(dir, 'usage-ledger.db'));
    dates.prepare("UPDATE model_usage SET created_at=? WHERE request_id='first'").run(midnight - 1); dates.close();
    ledger.enableUsageLedger();
    summary = ledger.getUsageSummary(cfg, { now: midnight + 1000 });
    assert.equal(summary.all_time.total_tokens, savedTotal); assert.equal(summary.today.total_tokens, savedTotal - 120);
    assert.equal(summary.timezone, 'Asia/Shanghai'); assert.equal(summary.price_versions.length, 1);
    const secondDir = path.join(dir, 'second-root'); process.env.DAFEIYU_DATA_DIR = secondDir;
    ledger.enableUsageLedger(); assert.equal(ledger.getUsageSummary(cfg).all_time.calls, 0);
    ledger.closeUsageLedger();
    const blocked = path.join(dir, 'not-a-directory'); fs.writeFileSync(blocked, 'fixture');
    process.env.DAFEIYU_DATA_DIR = blocked;
    assert.equal(ledger.enableUsageLedger(), false);
    const safe = ledger.beginCall(cfg, { kind: 'responses' }); safe.observe(reported); safe.finish('failed');
    assert.equal(ledger.getUsageSummary(cfg).available, false, 'I/O failure is explicit, never zero-spend success');
    console.log('usage-ledger: PASS (idempotent snapshots, contexts, cache/write/reasoning subsets, unknown/cancel/recovery, scopes, privacy, Shanghai day, I/O health)');
  } finally {
    ledger.closeUsageLedger();
    if (originalRoot === undefined) delete process.env.DAFEIYU_DATA_DIR; else process.env.DAFEIYU_DATA_DIR = originalRoot;
    assert.ok(path.resolve(dir).startsWith(temp + path.sep)); fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
