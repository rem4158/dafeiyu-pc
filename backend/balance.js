// The card, HTTP API and native model tool share this same quota snapshot.
const crypto = require('node:crypto');
const { loadSettings } = require('./electron/brain/settings');
const { getUsageSummary, getBudgetStatus } = require('./usage-ledger');
const balanceCache = new Map();
const LABELS = { openai: 'OpenAI', deepseek: 'DeepSeek', ollama: 'Ollama 本地', compatible: '兼容模型服务' };

function providerInfo(config) {
  let host = '';
  try {
    const url = new URL(config.cloud?.baseUrl || '');
    if (url.protocol === 'https:') host = url.hostname;
  } catch { /* no remote balance query */ }
  const provider = config.provider === 'ollama' ? 'ollama' : host === 'api.openai.com' ? 'openai'
    : host === 'api.deepseek.com' ? 'deepseek' : 'compatible';
  const model = String((config.provider === 'ollama' ? config.ollama?.model : config.cloud?.model) || '').slice(0, 160);
  return { provider, label: LABELS[provider], model };
}

async function accountBalance(config, fetchImpl) {
  const info = providerInfo(config);
  const unavailable = { status: 'unsupported', available: null, amount: null, currency: null,
    updated_at: null, detail: info.provider === 'openai' ? 'OpenAI 账户余额未接入' : '当前服务暂不支持账户余额查询' };
  if (info.provider !== 'deepseek') return unavailable;
  if (!config.cloud?.apiKey?.trim()) return { ...unavailable, status: 'error', detail: '尚未配置模型密钥' };
  // Cache only the official remote balance. Local usage is read afresh every time.
  const key = crypto.createHash('sha256').update(config.cloud.apiKey).digest('hex');
  const previous = balanceCache.get(key);
  if (previous && previous.fetcher === fetchImpl && Date.now() - previous.at < 60000) return previous.value;
  const query = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetchImpl('https://api.deepseek.com/user/balance', {
        headers: { Authorization: 'Bearer ' + config.cloud.apiKey },
        redirect: 'error', signal: controller.signal });
      if (!response.ok || !response.body) throw new Error();
      const reader = response.body.getReader();
      let size = 0;
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65536) { await reader.cancel(); throw new Error(); }
        chunks.push(Buffer.from(value));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const row = body.balance_infos?.find(item => item.currency === 'CNY') || body.balance_infos?.[0];
      if (!row || !['CNY', 'USD'].includes(row.currency) || typeof body.is_available !== 'boolean' ||
          !['number', 'string'].includes(typeof row.total_balance) || String(row.total_balance).trim() === '' ||
          !Number.isFinite(Number(row.total_balance))) throw new Error();
      const money = value => ['number', 'string'].includes(typeof value) && String(value).trim() !== '' &&
        Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '未知';
      return { status: 'known', available: body.is_available, amount: Number(row.total_balance), currency: row.currency,
        updated_at: Date.now(), detail: `充值 ${money(row.topped_up_balance)} / 赠送 ${money(row.granted_balance)}` };
    } catch {
      return { ...unavailable, status: 'error', updated_at: Date.now(), detail: '官方余额查询失败，请稍后重试' };
    } finally { clearTimeout(timer); }
  })();
  if (balanceCache.size >= 8) balanceCache.delete(balanceCache.keys().next().value);
  balanceCache.set(key, { at: Date.now(), value: query, fetcher: fetchImpl });
  return query;
}

function tokens(value) { return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : '未知'; }
function costText(summary) {
  const cost = summary?.estimated_cost;
  if (!summary?.known_calls && summary?.unknown_calls) return '费用未知';
  if (!summary?.known_calls && summary?.pending_calls) return '费用待结算';
  if (summary?.known_calls > 0 && summary.unpriced_calls >= summary.known_calls) return '费用未计价';
  if (typeof cost !== 'number' || !Number.isFinite(cost) || !['USD', 'CNY'].includes(summary.currency)) return '费用未计价';
  const symbol = summary.currency === 'CNY' ? '¥' : '$';
  const partial = summary.unpriced_calls || summary.unknown_calls || summary.pending_calls;
  return `预估 ${symbol}${cost > 0 && cost < .0001 ? '<0.0001' : cost.toFixed(4)}${partial ? '（部分）' : ''}`;
}

async function getBalance(fetchImpl = fetch, usageOptions = {}) {
  const config = loadSettings(), info = providerInfo(config);
  const account = await accountBalance(config, fetchImpl);
  const usage = getUsageSummary(config, usageOptions);
  const budget = getBudgetStatus(config, { taskId: usageOptions.taskId });
  const today = usage.today || {};
  const faults = [];
  if (today.unknown_calls) faults.push(`${today.unknown_calls} 次用量未知`);
  if (today.pending_calls) faults.push(`${today.pending_calls} 次待结算`);
  const healthy = usage.available !== false;
  let text = !healthy ? '用量记录暂不可用' : faults.length && !today.known_calls
    ? today.unknown_calls ? '今日用量未知' : '今日用量待结算'
    : `今日${faults.length ? '已知' : ''} ${tokens(today.total_tokens)} tokens`;
  const symbol = account.currency === 'CNY' ? '¥' : '$';
  if (account.status === 'known') text = `余额 ${symbol}${account.amount.toFixed(2)}`;
  const accountHint = account.status === 'known' ? account.available ? '账户可用' : '账户余额不足'
    : account.status === 'unsupported' ? '账户余额未接入' : '账户余额查询失败';
  const budgetHint = budget.enforced ? budget.status === 'exhausted' ? '限额已拦截' : '限额生效' :
    budget.status === 'unavailable' ? '限额状态异常' : '';
  const hint = `${info.label} · ${accountHint} · ${healthy ? costText(today) : '用量记录异常'}${budgetHint ? ' · ' + budgetHint : ''}${faults.length ? ' · ' + faults.join(' / ') : ''}`;
  const budgetDetails = [];
  if (budget.enforced && budget.daily && budget.task) {
    for (const [scope, title] of [['daily', '今日'], ['task', '本任务']]) {
      const remaining = budget[scope];
      if (remaining.remaining_tokens !== null) budgetDetails.push(`${title}剩余 ${tokens(remaining.remaining_tokens)} tokens（含预留约束）`);
      if (remaining.remaining_usd !== null) budgetDetails.push(`${title}剩余美元预算 $${remaining.remaining_usd.toFixed(6)}（按核价，含预留约束）`);
    }
    if (budget.unresolved_calls) budgetDetails.push('存在未确定的用量或费用，已停止新增调用，不会按零放行');
  }
  const detail = [info.model, account.detail,
    healthy ? `今日输入 ${tokens(today.input_tokens)} / 输出 ${tokens(today.output_tokens)} tokens；${costText(today)}` : '无法读取完整本地用量，不能据此判断消耗为零',
    ...faults, '仅统计本程序当前连接开始记录后的模型调用；不含其他软件和独立语音服务；费用为估算',
    budget.enforced ? '限额已启用，每次模型调用前检查并预留；未知用量不按零释放' :
      budget.status === 'unavailable' ? '预算账本不可用，停止模型调用以保护限额' : '尚未在聊天中交代限额，当前不限',
    ...budgetDetails].filter(Boolean).join('\n');
  return { text, hint, detail, provider: info.provider, provider_label: info.label, model: info.model,
    balance_status: account.status, account_available: account.available, available: account.available,
    account_balance: account, usage,
    budget,
    updated_at: Date.now() };
}

module.exports = { getBalance, providerInfo };
