const { readTextStreamLines } = require('./stream-utils');
const { createFetchController } = require('./request-timeout');
const { toolError, readProviderJson, normalizeToolCalls, assistantMessage } = require('./tool-protocol');
const usageLedger = require('../../usage-ledger');
const budget = require('../../usage-budget-preflight');

const DEFAULT_CHAT_TIMEOUT_MS = 120_000;

async function chatOllama(settings, messages, opts = {}) {
  let full = '';
  await chatOllamaStream(settings, messages, (delta) => {
    full += delta;
  }, opts);
  return full;
}

async function chatOllamaStream(settings, messages, onDelta, opts = {}) {
  const { baseUrl, model } = settings.ollama;
  if (budget.hasBudget(settings, opts)) throw budget.budgetError('usage_budget_unsupported');
  const url = `${baseUrl.replace(/\/$/, '')}/api/chat`;

  const body = {
    model,
    messages,
    stream: true,
  };
  if (typeof opts.max_tokens === 'number' && opts.max_tokens > 0) {
    body.options = { num_predict: opts.max_tokens };
  }

  const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
    ? opts.timeoutMs
    : DEFAULT_CHAT_TIMEOUT_MS;
  const { controller, clear } = createFetchController(timeoutMs);
  const encoded = JSON.stringify(body);
  const usage = usageLedger.withUsageContext(opts.usageContext || {},
    () => usageLedger.beginCall(settings, { kind: 'ollama' }));
  let usageState = 'failed';

  let res;
  try {
    res = await (opts.fetchImpl || fetch)(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: encoded,
      signal: opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal,
    });
  } catch (err) {
    clear();
    usage.finish(opts.signal?.aborted ? 'cancelled' : 'failed');
    if (err?.name === 'AbortError') {
      throw new Error(`Ollama 请求超时 (${Math.round(timeoutMs / 1000)}s)`);
    }
    throw err;
  }

  try {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama 请求失败 (${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
  }

  if (!res.body) {
    throw new Error('Ollama 未返回流式数据');
  }

  let full = '';

  await readTextStreamLines(res.body, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let data;
    try {
      data = JSON.parse(trimmed);
    } catch {
      return;
    }

    usage.observe(data);
    const delta = data.message?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      full += delta;
      onDelta(delta);
    }
  });

  if (!full.trim()) {
    throw new Error('Ollama 返回为空，请确认模型已安装：ollama list');
  }

  usageState = 'completed';
  return full.trim();
  } finally { clear(); usage.finish(opts.signal?.aborted ? 'cancelled' : usageState); }
}

async function listOllamaModels(settings) {
  const { baseUrl } = settings.ollama;
  const url = `${baseUrl.replace(/\/$/, '')}/api/tags`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('无法连接 Ollama，请确认 ollama serve 正在运行');
  const data = await res.json();
  return (data.models || []).map((m) => m.name);
}

async function chatOllamaTurn(settings, messages, opts = {}) {
  opts.signal?.throwIfAborted();
  const { baseUrl, model } = settings.ollama;
  if (budget.hasBudget(settings, opts)) throw budget.budgetError('usage_budget_unsupported');
  const body = { model, stream: false, tools: opts.toolChoice === 'none' ? [] : opts.tools || [], messages: messages.map(message => {
    if (message.role === 'tool') return { role: 'tool', tool_name: message.name, content: message.content };
    const native = { role: message.role, content: message.content || '' };
    if (message.role === 'user' && Array.isArray(message.images)) native.images = message.images;
    if (message.tool_calls?.length) native.tool_calls = message.tool_calls.map(call => ({ type: 'function',
      function: { name: call.function.name, arguments: (() => {
        try { return JSON.parse(call.function.arguments); } catch { return {}; }
      })() } }));
    if (typeof message.thinking === 'string') native.thinking = message.thinking;
    return native;
  }) };
  if (typeof opts.max_tokens === 'number' && opts.max_tokens > 0) body.options = { num_predict: opts.max_tokens };
  const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_CHAT_TIMEOUT_MS;
  const { controller, clear } = createFetchController(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal;
  const encoded = JSON.stringify(body);
  const usage = usageLedger.withUsageContext(opts.usageContext || {},
    () => usageLedger.beginCall(settings, { kind: 'ollama' }));
  let usageState = 'failed';
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: encoded, signal,
    });
    if (!res.ok) throw toolError('ollama_http_error', `Ollama 工具请求失败（HTTP ${res.status}），请确认模型支持工具调用`);
    const data = await readProviderJson(res, signal);
    usage.observe(data);
    if (data?.error) throw toolError('ollama_provider_error', 'Ollama 未能完成工具请求，请确认模型支持工具调用');
    if (data.done === false || data.done_reason === 'length') {
      throw toolError('ollama_incomplete', 'Ollama 回复未完整完成，本次未执行后续工具');
    }
    const message = data?.message;
    if (!message || typeof message !== 'object') throw toolError('model_invalid_response', 'Ollama 未返回有效的模型回复');
    if (message.function_call) throw toolError('model_invalid_response', '模型返回了不支持的旧工具协议，请检查模型工具支持');
    const content = typeof message.content === 'string' ? message.content : '';
    const toolCalls = normalizeToolCalls(message.tool_calls, { allowMissingId: true });
    if (!content.trim() && !toolCalls.length) throw toolError('model_empty', '模型没有返回正文或有效的工具调用');
    const assistant = assistantMessage(content, toolCalls);
    if (typeof message.thinking === 'string') assistant.thinking = message.thinking;
    usageState = 'completed';
    return { content, toolCalls, assistantMessage: assistant };
  } catch (error) {
    if (opts.signal?.aborted) throw Object.assign(new Error('已取消模型请求'), { name: 'AbortError', code: 'model_aborted' });
    if (controller.signal.aborted) throw toolError('ollama_timeout', `Ollama 请求超时 (${Math.round(timeoutMs / 1000)}s)`);
    if (/^(ollama_|model_)/.test(error?.code || '')) throw error;
    throw toolError('ollama_network', '无法完成 Ollama 工具请求，请检查连接和模型工具支持');
  } finally { clear(); usage.finish(opts.signal?.aborted ? 'cancelled' : usageState); }
}

module.exports = { chatOllama, chatOllamaStream, chatOllamaTurn, listOllamaModels };
