const { readTextStreamLines } = require('./stream-utils');
const { createFetchController } = require('./request-timeout');
const { readProviderJson, normalizeToolCalls, assistantMessage } = require('./tool-protocol');
const usageLedger = require('../../usage-ledger');
const budget = require('../../usage-budget-preflight');
const { presetRequestOptions } = require('../../model-presets');
const normalizeVoiceBaseUrl = url => String(url || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');

const DEFAULT_CHAT_TIMEOUT_MS = 120_000;

// These families count reasoning in the completion budget and reject legacy
// sampling parameters at their default reasoning effort. Keep compatible
// providers such as DeepSeek and MiMo on their existing request format.
function usesModernOpenAIParameters(model) {
  return /^(?:gpt-[56](?:[.-]|$)|o[134](?:[.-]|$))/i.test(String(model || '').trim());
}

function getCloudTestOptions(settings) {
  if (settings.cloud?.preset === 'kimi') return { max_tokens: 2048, timeoutMs: 30000 };
  return usesModernOpenAIParameters(settings.cloud?.model)
    ? { max_tokens: 1024, temperature: 0, timeoutMs: 30000 }
    : { max_tokens: 16, temperature: 0, timeoutMs: 15000 };
}

function cloudError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function providerError(status, error) {
  // Retain only classification data. Upstream bodies can echo credentials,
  // request text or URLs and must never become an exception message.
  const allowedCodes = new Set(['invalid_api_key', 'insufficient_quota', 'Arrearage', 'rate_limit_exceeded',
    'model_not_found', 'unsupported_parameter', 'unsupported_value', 'invalid_request_error']);
  const providerCode = allowedCodes.has(error?.code) ? error.code : null;
  return cloudError('cloud_http_error', `云端 API 请求失败（HTTP ${status}）`, { httpStatus: status, providerCode });
}

/**
 * @param {unknown} data
 */
function extractStreamChunkText(data) {
  if (!data || typeof data !== 'object') return { content: '', reasoning: '' };

  if (data.error) {
    throw providerError(200, data.error);
  }

  const choice = data.choices?.[0];
  if (!choice) return { content: '', reasoning: '' };

  const delta = choice.delta;
  if (delta && typeof delta === 'object') {
    const content = typeof delta.content === 'string' ? delta.content : '';
    const reasoning = typeof delta.reasoning_content === 'string'
      ? delta.reasoning_content
      : (typeof delta.reasoning === 'string' ? delta.reasoning : '');
    if (content || reasoning) return { content, reasoning };
  }

  const message = choice.message;
  if (message && typeof message === 'object') {
    const content = typeof message.content === 'string' ? message.content : '';
    const reasoning = typeof message.reasoning_content === 'string'
      ? message.reasoning_content
      : '';
    if (content || reasoning) return { content, reasoning };
  }

  if (typeof data.output_text === 'string') {
    return { content: data.output_text, reasoning: '' };
  }

  return { content: '', reasoning: '' };
}

/**
 * @param {unknown} data
 */
function extractCompletionText(data) {
  const { content, reasoning } = extractStreamChunkText(data);
  if (content.trim()) return content.trim();
  if (reasoning.trim()) return reasoning.trim();
  return '';
}

/**
 * @param {string} baseUrl
 */
function isMimoCloudUrl(baseUrl) {
  return /xiaomimimo\.com|mimo\.mi\.com/i.test(baseUrl || '');
}

async function chatCloud(settings, messages, opts = {}) {
  let full = '';
  await chatCloudStream(settings, messages, (delta) => {
    full += delta;
  }, opts);
  return full;
}

async function chatCloudStream(settings, messages, onDelta, opts = {}) {
  const rawBaseUrl = settings.cloud?.baseUrl || '';
  const baseUrl = normalizeVoiceBaseUrl(rawBaseUrl) || rawBaseUrl.replace(/\/$/, '');
  const { apiKey, model } = settings.cloud;
  if (!apiKey?.trim()) {
    throw new Error('请先在聊天设置里填写云端 API Key');
  }
  if (!model?.trim()) {
    throw new Error('请先在聊天设置里填写云端模型名称');
  }

  if (budget.hasBudget(settings, opts) || settings.cloud.preset === 'openai') {
    if (!budget.official(baseUrl)) throw budget.budgetError('usage_budget_unsupported');
    const result = await chatCloudTurn(settings, messages, { ...opts, forceResponses: true, tools: [], toolChoice: 'none' });
    onDelta?.(result.content);
    return result.content;
  }

  const modernOpenAI = usesModernOpenAIParameters(model);
  const body = {
    model: model.trim(),
    messages,
    stream: true,
  };
  try {
    if (new URL(baseUrl).hostname === 'api.openai.com') body.stream_options = { include_usage: true };
  } catch { /* Compatible providers keep their existing request shape. */ }
  const presetOptions = presetRequestOptions(settings.cloud);
  if (!modernOpenAI && !presetOptions.reasoning_effort)
    body.temperature = typeof opts.temperature === 'number' ? opts.temperature : 0.85;
  if (typeof opts.max_tokens === 'number' && opts.max_tokens > 0) {
    body[modernOpenAI ? 'max_completion_tokens' : 'max_tokens'] = opts.max_tokens;
    if (isMimoCloudUrl(baseUrl)) {
      body.max_completion_tokens = opts.max_tokens;
    }
  }
  if (isMimoCloudUrl(baseUrl)) {
    body.thinking = { type: 'disabled' };
  }
  Object.assign(body, presetOptions);

  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey.trim()}`,
  };
  if (isMimoCloudUrl(baseUrl)) {
    headers['api-key'] = apiKey.trim();
  }

  const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
    ? opts.timeoutMs
    : DEFAULT_CHAT_TIMEOUT_MS;
  const { controller, clear } = createFetchController(timeoutMs);
  const encoded = JSON.stringify(body);
  const usage = usageLedger.withUsageContext(opts.usageContext || {},
    () => usageLedger.beginCall(settings, { kind: 'chat_completions' }));
  let usageState = 'failed';

  let res;
  try {
    res = await (opts.fetchImpl || fetch)(url, {
      method: 'POST',
      headers,
      body: encoded,
      redirect: 'error',
      signal: opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal,
    });
  } catch (err) {
    clear();
    usage.finish(opts.signal?.aborted ? 'cancelled' : 'failed');
    if (controller.signal.aborted || err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      throw cloudError('cloud_timeout', `云端 API 超时 (${Math.round(timeoutMs / 1000)}s)`);
    }
    throw cloudError('cloud_network', '无法连接云端 API，请检查网络和代理');
  }

  try {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let data;
    try { data = JSON.parse(text); } catch { /* HTML/plain-text errors stay private. */ }
    usage.observe(data);
    throw providerError(res.status, data?.error);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await res.json();
    usage.observe(data);
    const text = extractCompletionText(data);
    if (!text) {
      throw cloudError('cloud_empty', '云端 API 返回为空（请检查模型名称与 API 地址是否正确）');
    }
    onDelta?.(text);
    usageState = 'completed';
    return text;
  }

  if (!res.body) {
    throw cloudError('cloud_empty', '云端 API 未返回流式数据');
  }

  let full = '';
  let reasoningOnly = '';
  /** @type {string[]} */
  const rawChunks = [];

  await readTextStreamLines(res.body, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let payload = trimmed;
    if (payload.startsWith('data:')) {
      payload = payload.slice(5).trim();
    }
    if (!payload || payload === '[DONE]') return;

    rawChunks.push(payload);

    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      return;
    }

    usage.observe(data);
    const { content, reasoning } = extractStreamChunkText(data);
    if (content) {
      full += content;
      onDelta?.(content);
    }
    if (reasoning) {
      reasoningOnly += reasoning;
    }
  });

  if (!full.trim()) {
    if (reasoningOnly.trim()) {
      throw cloudError('cloud_empty', '模型只返回了思考过程、没有正文，请检查输出上限或模型设置');
    }
    const lastChunk = rawChunks[rawChunks.length - 1];
    if (lastChunk) {
      try {
        const fallback = extractCompletionText(JSON.parse(lastChunk));
        if (fallback.trim()) {
          onDelta?.(fallback);
          usageState = 'completed';
          return fallback.trim();
        }
      } catch {
        // ignore
      }
    }
    throw cloudError('cloud_empty', '云端 API 返回为空（请检查模型名称、API 地址与 Key 是否正确）');
  }

  usageState = 'completed';
  return full.trim();
  } finally { clear(); usage.finish(opts.signal?.aborted ? 'cancelled' : usageState); }
}

// Native non-streaming turn. Ordinary chat keeps its existing streaming path.
async function chatCloudTurn(settings, messages, opts = {}) {
  opts.signal?.throwIfAborted();
  const { apiKey, model } = settings.cloud || {};
  if (!apiKey?.trim()) throw new Error('请先在聊天设置里填写云端 API Key');
  if (!model?.trim()) throw new Error('请先在聊天设置里填写云端模型名称');
  const baseUrl = normalizeVoiceBaseUrl(settings.cloud.baseUrl).replace(/\/responses$/i, '');
  const modern = usesModernOpenAIParameters(model);
  let officialOpenAI = false;
  try { officialOpenAI = new URL(baseUrl).hostname === 'api.openai.com'; } catch { /* fetch will fail safely */ }
  // Official GPT-6 reasoning with tools uses Responses. Compatible endpoints
  // retain Chat Completions; neither path changes the configured model/effort.
  const limited = budget.hasBudget(settings, opts);
  if (limited && !budget.official(baseUrl)) throw budget.budgetError('usage_budget_unsupported');
  const responses = officialOpenAI && (limited || opts.forceResponses || settings.cloud.preset === 'openai' ||
    /^(?:gpt-6-(?:astra|sol|luna)|gpt-6\.1-(?:sol|terra))(?:-|$)/i.test(model.trim()));
  const body = { model: model.trim(), stream: false };
  if (responses) {
    body.store = false;
    body.include = ['reasoning.encrypted_content'];
    body.input = messages.flatMap(message => {
      if (Array.isArray(message._responsesOutput)) return message._responsesOutput;
      if (message.role === 'tool') return [{ type: 'function_call_output', call_id: message.tool_call_id, output: message.content }];
      if (message.role === 'user' && Array.isArray(message.content)) {
        return [{ role: 'user', content: message.content.map(part => {
          if (part.type === 'text') return { type: 'input_text', text: part.text };
          if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail };
          return part;
        }) }];
      }
      return [{ role: message.role, content: message.content }];
    });
    body.tools = (opts.tools || []).map(({ function: fn }) => ({ type: 'function', ...fn, strict: fn.strict ?? false }));
  } else {
    body.messages = messages.map(message => message.role === 'tool'
      ? { role: 'tool', tool_call_id: message.tool_call_id, content: message.content } : message);
    body.tools = opts.tools || [];
    if (!['deepseek', 'kimi'].includes(settings.cloud.preset)) body.parallel_tool_calls = false;
  }
  body.tool_choice = opts.toolChoice === 'none' ? 'none' : 'auto';
  const presetOptions = presetRequestOptions(settings.cloud);
  if (!modern && !presetOptions.reasoning_effort)
    body.temperature = typeof opts.temperature === 'number' ? opts.temperature : .85;
  if (typeof opts.max_tokens === 'number' && opts.max_tokens > 0) {
    body[responses ? 'max_output_tokens' : modern ? 'max_completion_tokens' : 'max_tokens'] = opts.max_tokens;
    if (isMimoCloudUrl(baseUrl)) body.max_completion_tokens = opts.max_tokens;
  }
  if (isMimoCloudUrl(baseUrl)) body.thinking = { type: 'disabled' };
  Object.assign(body, presetOptions);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey.trim()}` };
  if (isMimoCloudUrl(baseUrl)) headers['api-key'] = apiKey.trim();
  const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_CHAT_TIMEOUT_MS;
  const { controller, clear } = createFetchController(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal;
  let encoded;
  let usage;
  let reservation;
  try { if (limited) reservation = await budget.preflight(settings, baseUrl, body, opts, signal); }
  catch (error) { clear(); throw error; }
  try {
    if (opts.signal?.aborted) throw Object.assign(new Error('已取消模型请求'), { name: 'AbortError', code: 'model_aborted' });
    usage = usageLedger.withUsageContext(opts.usageContext || {},
      () => usageLedger.beginCall(settings, { kind: responses ? 'responses' : 'chat_completions', reservation }));
    if (usage.maxOutputTokens !== undefined) body.max_output_tokens = usage.maxOutputTokens;
    encoded = JSON.stringify(body);
  } catch (error) { clear(); usage?.finish('failed'); throw error; }
  let usageState = 'failed';
  try {
    const res = await (opts.fetchImpl || fetch)(`${baseUrl}/${responses ? 'responses' : 'chat/completions'}`, {
      method: 'POST', headers, body: encoded, signal, redirect: 'error',
    });
    if (!res.ok) {
      let data;
      try { data = await readProviderJson(res, signal); } catch { /* Non-JSON errors stay private. */ }
      throw providerError(res.status, data?.error);
    }
    const data = await readProviderJson(res, signal);
    usage.observe(data);
    if (data?.error) throw providerError(res.status, data.error);
    let message;
    let output;
    if (responses) {
      if (data.status && data.status !== 'completed') throw cloudError('cloud_incomplete', '云端模型回复未完整完成，本次未执行后续工具');
      if (!Array.isArray(data.output)) throw cloudError('cloud_invalid_response', '云端 API 未返回有效的模型回复');
      output = data.output;
      message = { content: output.filter(item => item.type === 'message').flatMap(item => item.content || [])
        .filter(item => item.type === 'output_text').map(item => item.text || '').join(''),
        tool_calls: output.filter(item => item.type === 'function_call').map(item => ({ id: item.call_id,
          type: 'function', function: { name: item.name, arguments: item.arguments } })) };
    } else {
      const choice = data?.choices?.[0];
      if (['length', 'content_filter'].includes(choice?.finish_reason)) {
        throw cloudError('cloud_incomplete', '云端模型回复被截断或中止，本次未执行后续工具');
      }
      message = choice?.message;
    }
    if (!message || typeof message !== 'object') throw cloudError('cloud_invalid_response', '云端 API 未返回有效的模型回复');
    if (message.function_call) throw cloudError('cloud_invalid_response', '模型返回了不支持的旧工具协议，请检查模型工具支持');
    const content = typeof message.content === 'string' ? message.content : '';
    const toolCalls = normalizeToolCalls(message.tool_calls);
    if (!content.trim() && !toolCalls.length) throw cloudError('cloud_empty', '模型没有返回正文或有效的工具调用');
    const assistant = assistantMessage(content, toolCalls, message);
    if (responses) assistant._responsesOutput = output;
    usageState = 'completed';
    return { content, toolCalls, assistantMessage: assistant };
  } catch (error) {
    if (opts.signal?.aborted) throw Object.assign(new Error('已取消模型请求'), { name: 'AbortError', code: 'model_aborted' });
    if (controller.signal.aborted) throw cloudError('cloud_timeout', `云端 API 超时 (${Math.round(timeoutMs / 1000)}s)`);
    if (/^(cloud_|model_|usage_budget_)/.test(error?.code || '')) throw error;
    throw cloudError('cloud_network', '无法完成云端工具调用，请检查网络、API 地址与模型工具支持');
  } finally { clear(); usage.finish(opts.signal?.aborted ? 'cancelled' : usageState); }
}

module.exports = { chatCloud, chatCloudStream, chatCloudTurn, getCloudTestOptions };
