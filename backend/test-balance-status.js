const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const temp = path.resolve(__dirname, '../temp');
fs.mkdirSync(temp, { recursive: true });
const dir = fs.mkdtempSync(path.join(temp, 'balance-status-'));
process.env.DAFEIYU_DATA_DIR = dir;
const settings = require('./electron/brain/settings');
const ledger = require('./usage-ledger');
const { getBalance } = require('./balance');
const body = (available = true) => ({ is_available: available, balance_infos: [{ currency: 'CNY',
  total_balance: available ? '12.34' : '0', topped_up_balance: '10', granted_balance: '2.34' }] });
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
async function main() {
  try {
    ledger.enableUsageLedger();
    settings.saveSettings({ provider: 'cloud', cloud: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-terra', apiKey: 'fake-do-not-expose' } });
    const never = () => { throw new Error('unexpected network call'); };
    let status = await getBalance(never);
    assert.equal(status.balance_status, 'unsupported'); assert.equal(status.account_available, null);
    assert.ok(status.hint.includes('OpenAI') && !status.hint.includes('DeepSeek') && !status.hint.includes('不足'));
    assert.equal(status.usage.today.calls, 0); assert.equal(status.budget.status, 'not_configured');
    const unknown = ledger.beginCall(settings.loadSettings(), { kind: 'responses' }); unknown.finish('cancelled');
    status = await getBalance(never);
    assert.equal(status.usage.today.unknown_calls, 1);
    assert.ok(status.text.includes('未知') && !status.text.includes('0 tokens'));
    assert.ok(status.hint.includes('用量未知') && status.hint.includes('费用未知'));
    settings.saveSettings({ cloud: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' } });
    let queries = 0;
    const known = async (url, options) => {
      assert.equal(url, 'https://api.deepseek.com/user/balance'); assert.equal(options.redirect, 'error');
      queries++; return json(body());
    };
    status = await getBalance(known); assert.equal(status.account_available, true);
    assert.equal(status.text, '余额 ¥12.34'); assert.equal(status.account_balance.currency, 'CNY');
    assert.equal(status.usage.today.calls, 0, 'provider switch changes local account scope');
    const call = ledger.beginCall(settings.loadSettings(), { kind: 'chat_completions' });
    call.observe({ usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }); call.finish('completed');
    status = await getBalance(known);
    assert.equal(queries, 1, 'remote account cache is shared');
    assert.equal(status.usage.today.total_tokens, 25, 'cached balance never freezes local usage');
    status = await getBalance(async () => json(body(false)));
    assert.equal(status.balance_status, 'known'); assert.equal(status.account_available, false);
    assert.ok(status.hint.includes('余额不足'));
    for (const fetcher of [
      async () => { throw new Error('PRIVATE secret body'); },
      async () => json({ ...body(), is_available: 'false' }),
      async () => json({ is_available: false, balance_infos: [{ currency: 'USD', total_balance: '' }] }),
      async () => json({ is_available: false, balance_infos: [{ currency: 'USD', total_balance: '   ' }] }),
    ]) {
      status = await getBalance(fetcher); assert.equal(status.balance_status, 'error');
      assert.equal(status.account_available, null); assert.ok(!status.hint.includes('不足'));
      assert.ok(!JSON.stringify(status).includes('PRIVATE') && !JSON.stringify(status).includes('fake-do-not-expose'));
    }
    console.log('balance-status: PASS (provider-aware unknown/insufficient, no OpenAI balance call, shared remote cache/fresh usage, safe errors)');
  } finally {
    ledger.closeUsageLedger();
    assert.ok(path.resolve(dir).startsWith(temp + path.sep)); fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
