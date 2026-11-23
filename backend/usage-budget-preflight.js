const ledger = require('./usage-ledger');
const { readProviderJson } = require('./electron/brain/tool-protocol');
const { createFetchController } = require('./electron/brain/request-timeout');

function budgetError(code) { return Object.assign(new Error(code), { code }); }
function hasBudget(settings, opts = {}) {
  return ledger.withUsageContext(opts.usageContext || {}, () => ledger.hasActiveBudget(settings));
}
function official(baseUrl) {
  try { const url = new URL(baseUrl); return url.protocol === 'https:' && url.hostname === 'api.openai.com'; }
  catch { return false; }
}

async function preflight(settings, baseUrl, body, opts = {}, signal) {
  if (!hasBudget(settings, opts)) return undefined;
  if (!official(baseUrl) || !Array.isArray(body.input)) throw budgetError('usage_budget_unsupported');
  const { controller, clear } = createFetchController(15000);
  const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  // Same model, input and function schemas as the subsequent Responses request.
  const counting = {};
  for (const key of ['model', 'input', 'instructions', 'tools', 'tool_choice', 'text', 'reasoning', 'truncation'])
    if (body[key] !== undefined) counting[key] = body[key];
  try {
    combined.throwIfAborted();
    const response = await (opts.fetchImpl || fetch)(baseUrl + '/responses/input_tokens', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.cloud.apiKey.trim() },
      body: JSON.stringify(counting), signal: combined, redirect: 'error' });
    if (!response.ok) throw budgetError('usage_budget_count_failed');
    const data = await readProviderJson(response, combined);
    if (!Number.isSafeInteger(data.input_tokens) || data.input_tokens < 0) throw budgetError('usage_budget_count_failed');
    body.service_tier = 'default';
    return { inputTokens: data.input_tokens,
      maxOutputTokens: Number.isSafeInteger(body.max_output_tokens) && body.max_output_tokens > 0 ? body.max_output_tokens : 4096 };
  } catch (error) {
    if (signal?.aborted) throw Object.assign(new Error('已取消模型请求'), { code: 'model_aborted', name: 'AbortError' });
    if (error.code?.startsWith('usage_budget_')) throw error;
    throw budgetError('usage_budget_count_failed');
  } finally { clear(); }
}

module.exports = { hasBudget, official, preflight, budgetError };
