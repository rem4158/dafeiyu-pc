const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const ledger = require('./usage-ledger');
const pricing = require('./usage-pricing');
const originalUpperCost = pricing.estimateUpperCost;
// Deterministic ledger unit tariff; production tariff is checked by pricing tests.
pricing.estimateUpperCost = usage => usage.provider === 'openai' && usage.model === 'gpt-6.1-terra'
  ? { amount: (usage.input_tokens * 2.5 + usage.output_tokens * 5) / 1e6, currency: 'USD', price_version: 'ledger-test' }
  : { amount: null, currency: null, price_version: null };
const cfg = { provider: 'cloud', cloud: { baseUrl: 'https://api.openai.com/v1', apiKey: 'BUDGET_PRIVATE_KEY', model: 'gpt-6.1-terra' } };
const unpriced = { ...cfg, cloud: { ...cfg.cloud, model: 'unpriced' } };
const record = (id, input = 2, output = 20, settings = cfg) => ledger.withUsageContext(
  { requestId: id, taskId: id, purpose: 'chat', channel: 'pc' },
  () => ledger.beginCall(settings, { kind: 'responses', reservation: { inputTokens: input, maxOutputTokens: output } }));
const report = (recorder, input, output, detailed = true) => recorder.observe({ usage: {
  input_tokens: input, output_tokens: output, total_tokens: input + output,
  ...(detailed ? { input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } : {}) } });
const errorCode = code => error => error?.code === code;

if (process.argv.includes('--admission-worker')) {
  process.on('message', message => {
    if (message !== 'go') return;
    try {
      assert.equal(ledger.enableUsageLedger(), true);
      const recorder = record('parallel_' + process.pid, 4, 2);
      recorder.finish('cancelled');
      process.send({ admitted: true });
    } catch (error) { process.send({ admitted: false, code: error.code }); }
    finally { ledger.closeUsageLedger(); process.disconnect(); }
  });
  process.send('ready');
} else main().catch(error => { console.error(error); process.exitCode = 1; });

async function main() {
  const temp = path.resolve(__dirname, '../temp'); fs.mkdirSync(temp, { recursive: true });
  const root = fs.mkdtempSync(path.join(temp, 'usage-budget-ledger-'));
  const originalRoot = process.env.DAFEIYU_DATA_DIR;
  let serial = 0;
  function fixture(name) {
    ledger.closeUsageLedger();
    process.env.DAFEIYU_DATA_DIR = path.join(root, name);
    assert.equal(ledger.enableUsageLedger(), true);
  }
  function set(scope, tokens, usd = null, extra = {}) {
    serial++;
    return ledger.setBudget(cfg, { scope, tokens, usd, requestId: 'owner_' + serial,
      originOrder: serial, operationId: 'op_' + serial, ...extra });
  }
  function inspect(operation) {
    const db = new DatabaseSync(path.join(process.env.DAFEIYU_DATA_DIR, 'usage-ledger.db'));
    try { return operation(db); } finally { db.close(); }
  }
  try {
    fixture('tiny');
    assert.equal(ledger.getBudgetStatus(cfg).status, 'not_configured');
    assert.equal(ledger.hasActiveBudget(cfg), false);
    set('daily', 10);
    assert.equal(ledger.hasActiveBudget(cfg), true);
    assert.throws(() => ledger.beginCall(cfg), errorCode('usage_budget_preflight_required'));
    assert.equal(ledger.getUsageSummary(cfg).today.calls, 0, 'preflight rejection creates no invocation');
    const first = record('tiny_1', 3, 100);
    assert.equal(first.maxOutputTokens, 7);
    let status = ledger.getBudgetStatus(cfg, { taskId: 'tiny_1' });
    assert.equal(status.daily.reserved_tokens, 10); assert.equal(status.daily.used_tokens, 0);
    assert.equal(status.daily.remaining_tokens, 0);
    assert.throws(() => record('tiny_2', 1, 1), errorCode('usage_budget_exceeded'));
    report(first, 3, 2); first.finish();
    status = ledger.getBudgetStatus(cfg);
    assert.equal(status.daily.used_tokens, 5); assert.equal(status.daily.reserved_tokens, 0);
    assert.equal(status.daily.remaining_tokens, 5);
    const second = record('tiny_2', 4, 50); assert.equal(second.maxOutputTokens, 1);
    second.finish('cancelled');
    status = ledger.getBudgetStatus(cfg); assert.equal(status.daily.used_tokens, 5); assert.equal(status.daily.reserved_tokens, 5);
    assert.equal(ledger.getUsageSummary(cfg).today.reserved_tokens, 5);
    assert.equal(ledger.getUsageSummary(cfg).today.budget_used_tokens, 5);

    fixture('holds'); set('daily', 20);
    const failed = record('failed', 2, 3); failed.finish('failed');
    const cancelled = record('cancelled', 2, 3); cancelled.finish('cancelled');
    const crash = record('crash', 2, 3); report(crash, 2, 1);
    assert.equal(ledger.getBudgetStatus(cfg).daily.reserved_tokens, 15);
    ledger.closeUsageLedger(); assert.equal(ledger.enableUsageLedger(), true);
    status = ledger.getBudgetStatus(cfg);
    assert.equal(status.daily.reserved_tokens, 15, 'crash retains full reservation including a last observed snapshot');
    assert.equal(status.daily.used_tokens, 0);
    crash.finish(); report(crash, 2, 1);
    assert.equal(ledger.getBudgetStatus(cfg).daily.reserved_tokens, 15, 'old recorder cannot alter reopened ledger');

    fixture('daily-rollover'); set('daily', 10);
    record('old_day', 3, 7).finish('cancelled');
    const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const midnight = Date.parse(day + 'T00:00:00+08:00');
    inspect(db => db.prepare("UPDATE model_usage SET created_at=? WHERE request_id='old_day'").run(midnight - 1));
    assert.equal(ledger.getBudgetStatus(cfg, { now: midnight + 1 }).daily.reserved_tokens, 0);
    assert.equal(record('new_day', 3, 20).maxOutputTokens, 7);

    fixture('tasks'); set('per_task', 8); set('task', 5, null, { taskId: 'a' });
    assert.throws(() => ledger.beginCall(cfg, { reservation: { inputTokens: 1, maxOutputTokens: 1 } }), errorCode('usage_budget_context_required'));
    assert.equal(record('a', 2, 100).maxOutputTokens, 3);
    assert.equal(record('b', 2, 100).maxOutputTokens, 6);
    assert.throws(() => record('a', 1, 1), errorCode('usage_budget_exceeded'));
    set('task', 50, null, { taskId: 'b' });
    assert.equal(ledger.getBudgetStatus(cfg, { taskId: 'b' }).task.remaining_tokens, 0,
      'an explicit task cap cannot bypass the persistent per-task ceiling');
    assert.equal(ledger.getBudgetStatus(cfg, { taskId: 'a' }).task.reserved_tokens, 5);
    const otherConnection = { ...cfg, cloud: { ...cfg.cloud, apiKey: 'OTHER_PRIVATE_KEY' } };
    assert.equal(ledger.getBudgetStatus(otherConnection).status, 'not_configured');

    fixture('money'); set('daily', null, .00004);
    const money = record('money', 2, 100); assert.equal(money.maxOutputTokens, 7);
    report(money, 2, 1); money.finish('failed');
    status = ledger.getBudgetStatus(cfg);
    assert.equal(status.daily.used_usd, .000007); assert.equal(status.daily.reserved_usd, 0);
    assert.equal(status.daily.used_tokens, 3);
    const unknownCost = record('money_unknown', 2, 100);
    report(unknownCost, 2, 1, false); unknownCost.finish('cancelled');
    status = ledger.getBudgetStatus(cfg);
    assert.equal(status.daily.used_usd, .000007);
    assert.equal(status.daily.reserved_usd, .00003, 'known tokens with unknown actual pricing retain upper USD hold');
    assert.equal(status.daily.used_tokens, 6); assert.equal(status.daily.reserved_tokens, 0);
    assert.throws(() => record('unsupported', 1, 1, unpriced), errorCode('usage_budget_unpriced'));

    fixture('historical-known');
    const historical = ledger.withUsageContext({ requestId: 'before', taskId: 'before' }, () => ledger.beginCall(cfg));
    report(historical, 3, 2); historical.finish(); set('daily', 7);
    assert.equal(record('after', 1, 50).maxOutputTokens, 1, 'spend before cap installation still counts');
    fixture('historical-unknown'); ledger.beginCall(cfg).finish('cancelled'); set('daily', 100);
    assert.equal(ledger.getBudgetStatus(cfg).unresolved_calls, 1);
    assert.throws(() => record('after', 1, 1), errorCode('usage_budget_unresolved'));
    fixture('historical-unpriced');
    const oldUnpriced = ledger.beginCall(unpriced); report(oldUnpriced, 1, 1); oldUnpriced.finish();
    set('daily', 100); assert.equal(record('tokens_only', 1, 1).maxOutputTokens, 1);
    set('daily', null, .01);
    assert.equal(ledger.getBudgetStatus(cfg).status, 'exhausted');
    assert.throws(() => record('money_after', 1, 1), errorCode('usage_budget_unresolved'));

    fixture('mutation');
    const operation = { scope: 'daily', tokens: 20, usd: null, originOrder: 500,
      requestId: 'owner_new', operationId: 'same_operation' };
    ledger.setBudget(cfg, operation); record('consumed', 2, 3).finish('cancelled');
    assert.equal(ledger.setBudget(cfg, operation).idempotent, true);
    assert.equal(ledger.getBudgetStatus(cfg).daily.reserved_tokens, 5);
    assert.throws(() => ledger.setBudget(cfg, { ...operation, tokens: 30 }), errorCode('usage_budget_operation_conflict'));
    assert.throws(() => ledger.setBudget(cfg, { ...operation, operationId: 'older', originOrder: 499 }), errorCode('usage_budget_stale'));
    assert.throws(() => ledger.setBudget(cfg, { ...operation, operationId: 'same_order', requestId: 'other' }), errorCode('usage_budget_stale'));
    ledger.setBudget(cfg, { ...operation, scope: 'per_task', tokens: 8, operationId: 'same_request_other_scope' });
    ledger.setBudget(cfg, { ...operation, tokens: 40, originOrder: 501, operationId: 'newer', requestId: 'later' });
    ledger.setBudget(cfg, operation);
    assert.equal(ledger.getBudgetStatus(cfg).policies.daily.tokens, 40, 'replayed old operation cannot restore an old ceiling');
    const clear = { originOrder: 501, operationId: 'clear' };
    ledger.clearBudgets(cfg, clear); assert.equal(ledger.getBudgetStatus(cfg).status, 'not_configured');
    assert.equal(ledger.clearBudgets(cfg, clear).idempotent, true);
    assert.throws(() => ledger.setBudget(cfg, { ...operation, originOrder: 501, operationId: 'revive' }), errorCode('usage_budget_stale'));
    assert.equal(ledger.getBudgetStatus(cfg).daily.reserved_tokens, 5, 'clear removes policy, never erases spend');
    for (const tokens of [0, -1, 1.5, 1e9 + 1, '20', undefined])
      assert.throws(() => ledger.setBudget(cfg, { ...operation, tokens }), errorCode('usage_budget_invalid'));
    for (const usd of [0, -.1, 1e6 + 1, .0000001, Infinity, NaN, '1', undefined])
      assert.throws(() => ledger.setBudget(cfg, { ...operation, usd }), errorCode('usage_budget_invalid'));
    inspect(db => {
      const stored = JSON.stringify(db.prepare('SELECT * FROM usage_budget_audit').all());
      assert.ok(!stored.includes('BUDGET_PRIVATE_KEY')); assert.ok(!stored.includes('https://'));
      assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_budget_audit').get().n, 4);
    });

    fixture('parallel'); set('daily', 6); ledger.closeUsageLedger();
    const admitted = await concurrentAdmissions();
    assert.equal(admitted.filter(result => result.admitted).length, 1);
    assert.equal(admitted.filter(result => result.code === 'usage_budget_exceeded').length, 1);
    assert.equal(ledger.enableUsageLedger(), true);
    assert.equal(ledger.getBudgetStatus(cfg).daily.reserved_tokens, 6);

    fixture('unavailable'); set('daily', 100); ledger.closeUsageLedger();
    const blocked = path.join(root, 'blocked'); fs.writeFileSync(blocked, 'not a directory');
    process.env.DAFEIYU_DATA_DIR = blocked;
    assert.equal(ledger.enableUsageLedger(), false);
    assert.throws(() => ledger.hasActiveBudget(cfg), errorCode('usage_budget_unavailable'));
    assert.throws(() => record('blocked', 1, 1), errorCode('usage_budget_unavailable'));
    assert.equal(ledger.getBudgetStatus(cfg).status, 'unavailable');
    console.log('usage-budget-ledger: PASS (tiny caps, atomic concurrency, settlement/holds/restart, Shanghai rollover, task intersection, USD/unpriced/unresolved, stale/idempotent/clear, privacy, I/O fail closed)');
  } finally {
    ledger.closeUsageLedger();
    if (originalUpperCost === undefined) delete pricing.estimateUpperCost; else pricing.estimateUpperCost = originalUpperCost;
    if (originalRoot === undefined) delete process.env.DAFEIYU_DATA_DIR; else process.env.DAFEIYU_DATA_DIR = originalRoot;
    assert.ok(path.resolve(root).startsWith(temp + path.sep)); fs.rmSync(root, { recursive: true, force: true });
  }
}

async function concurrentAdmissions() {
  const children = [0, 1].map(() => fork(__filename, ['--admission-worker'], {
    env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  const results = children.map(child => new Promise((resolve, reject) => {
    let output = '', answer;
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('message', message => { if (message !== 'ready') answer = message; });
    child.on('error', reject);
    child.on('exit', code => code === 0 && answer ? resolve(answer) : reject(new Error(output || 'worker exited ' + code)));
  }));
  await Promise.all(children.map(child => new Promise(resolve => child.once('message', resolve))));
  for (const child of children) child.send('go');
  return Promise.all(results);
}
