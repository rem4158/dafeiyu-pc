// Shared wire limits and parsing for native provider tool calls. No intent routing.
const MAX_TOOL_CALLS = 8;
const MAX_TOOL_ARGUMENT_CHARS = 32_768;
const MAX_PROVIDER_CHARS = 2_000_000;

function toolError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function readProviderJson(response, signal) {
  signal?.throwIfAborted();
  if (!response.body) throw toolError('model_invalid_response', '模型未返回有效数据');
  const reader = response.body.getReader();
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > MAX_PROVIDER_CHARS) {
        await reader.cancel().catch(() => {});
        throw toolError('model_response_limit', '模型返回数据过大');
      }
    }
    text += decoder.decode();
    signal?.throwIfAborted();
    try { return JSON.parse(text); }
    catch { throw toolError('model_invalid_response', '模型未返回有效的 JSON 数据'); }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function normalizeToolCalls(calls, { allowMissingId = false } = {}) {
  if (calls == null) return [];
  if (!Array.isArray(calls) || calls.length > MAX_TOOL_CALLS) {
    throw toolError('model_tool_limit', '模型返回的工具调用数量异常');
  }
  const ids = new Set();
  const syntheticPrefix = allowMissingId ? `ollama_${require('node:crypto').randomUUID()}` : '';
  return calls.map((item, index) => {
    const fn = item?.function;
    const name = fn?.name;
    const id = item?.id || (allowMissingId ? `${syntheticPrefix}_${index}` : '');
    if ((item?.type && item.type !== 'function') || typeof name !== 'string'
      || !/^[a-zA-Z0-9_-]{1,64}$/.test(name) || typeof id !== 'string'
      || !id || id.length > 256 || ids.has(id)) {
      throw toolError('model_invalid_tool_call', '模型返回了无效的工具调用');
    }
    ids.add(id);
    let args = fn.arguments;
    let argumentError = false;
    if (typeof args === 'string') {
      if (args.length > MAX_TOOL_ARGUMENT_CHARS) argumentError = true;
      else { try { args = JSON.parse(args); } catch { argumentError = true; } }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) argumentError = true;
    if (!argumentError && JSON.stringify(args).length > MAX_TOOL_ARGUMENT_CHARS) argumentError = true;
    return { id, name, arguments: argumentError ? {} : args,
      ...(argumentError ? { argumentError: true } : {}) };
  });
}

function assistantMessage(content, calls, original = {}) {
  const message = { role: 'assistant', content: content || null };
  // Some compatible reasoning models require this field with their tool transcript.
  if (typeof original.reasoning_content === 'string') message.reasoning_content = original.reasoning_content;
  if (calls.length) message.tool_calls = calls.map((call, index) => ({
    id: call.id, type: 'function', function: { name: call.name,
      arguments: typeof original.tool_calls?.[index]?.function?.arguments === 'string'
        ? original.tool_calls[index].function.arguments : JSON.stringify(call.arguments) },
  }));
  return message;
}

module.exports = { MAX_TOOL_CALLS, toolError, readProviderJson, normalizeToolCalls, assistantMessage };
