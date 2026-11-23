// Migrated from Nianan electron/brain/chat.js; desktop side effects stay outside this service.
const { chatOllama, chatOllamaTurn } = require('./ollama');
const { chatCloud, chatCloudTurn } = require('./cloud');
const { toolError } = require('./tool-protocol');
const { loadSettings, DEFAULTS } = require('./settings');
const { resolveExpression, getMoodLabel, stripEmotionTag, extractEmotionTag } = require('./emotion');
const { initMemory, getPromptHistory, buildMemoryContext, buildTimeContext, MAIN_SESSION_ID } = require('./memory');
const { resolveMemorySettings } = require('./memory-settings');
const { buildPersonalityPrompt } = require('./personality');
const MAX_STICKERS_IN_PROMPT = 40;
function roleNames(settings = {}) {
  return {
    character: typeof settings.characterName === 'string' && settings.characterName.trim()
      ? settings.characterName.trim() : DEFAULTS.characterName,
    owner: typeof settings.ownerName === 'string' && settings.ownerName.trim()
      ? settings.ownerName.trim() : DEFAULTS.ownerName,
  };
}
function defaultSystem(settings) {
  const { character, owner } = roleNames(settings);
  return `你是${character}，和${owner}相熟的桌面陪伴伙伴。说话自然、简短、口语化。诚实说明能力，不编造用户经历、记忆或已经执行的动作。可以使用实际接通的记忆、表情和语音能力；不编造联网或电脑操作结果。`;
}
const DEFAULT_SYSTEM = defaultSystem(DEFAULTS);
function resolveSystemPrompt(settings, override) {
  let base;
  if (typeof override === 'string' && override.trim()) {
    base = override;
  } else if (settings.systemPrompt?.trim()) {
    base = settings.systemPrompt;
  } else {
    base = defaultSystem(settings);
  }

  const personalityBlock =
    settings.personality?.prompt?.trim() ||
    buildPersonalityPrompt(settings.personality?.dimensions);
  if (personalityBlock) {
    base += `\n\n${personalityBlock}`;
  }
  return base;
}

function buildMessages(settings, history, userText, context) {
  const { character, owner } = roleNames(settings);
  const persona = resolveSystemPrompt(settings);
  const base = persona + `\n\n角色名：${character}。当前聊天对象：${owner}。` +
    '\n只输出消息的 JSON 数组。文字项为 {"text":"消息内容","delay":0}，delay 是相对上一条的毫秒数，第一项为 0。';
  const messages = [{ role: 'system', content: [base, ...context].filter(Boolean).join('\n\n') }];
  for (const item of history) {
    if (item.role === 'user' || item.role === 'assistant') {
      messages.push({ role: item.role, content: item.content });
    }
  }
  messages.push({ role: 'user', content: userText });
  return messages;
}

function parseReply(raw, userText = '') {
  const tag = extractEmotionTag(raw);
  const text = stripEmotionTag(raw);
  const emotion = resolveExpression({ tag, replyText: text, userText });
  return { text, emotion, mood: getMoodLabel(emotion) };
}

function buildStickerMap() {
  /** @type {Record<string, { name: string, url: string }>} */
  const map = {};
  for (const s of []) {
    map[s.name] = { name: s.name, url: s.url };
  }
  return map;
}

function resolveStickerName(name, stickerMap) {
  const key = String(name || '').trim();
  if (!key) return null;

  // 1. 精确匹配（如 LLM 输出了 "开心3"）
  if (stickerMap[key]) return stickerMap[key];

  const lower = key.toLowerCase();

  // 2. 大小写忽略精确匹配
  for (const [k, v] of Object.entries(stickerMap)) {
    if (k.toLowerCase() === lower) return v;
  }

  // 3. 编号变体随机选：LLM 输出 "开心" → 匹配 开心1~7 随机挑一个
  const candidates = [];
  for (const [k] of Object.entries(stickerMap)) {
    const base = k.replace(/\d+$/, '');
    if (base === key || base.toLowerCase() === lower) {
      candidates.push(k);
    }
  }
  if (candidates.length > 0) {
    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    return stickerMap[picked];
  }

  // 4. 模糊包含兜底
  for (const [k, v] of Object.entries(stickerMap)) {
    if (k.includes(key) || key.includes(k)) return v;
  }
  return null;
}

function getUniqueStickerNames(stickerMap) {
  const seen = new Set();
  const result = [];
  for (const name of Object.keys(stickerMap)) {
    const base = name.replace(/\d+$/, '');
    if (!seen.has(base)) {
      seen.add(base);
      result.push(base);
    }
  }
  return result;
}

function stickerProtocol(stickerMap) {
  const names = getUniqueStickerNames(stickerMap).slice(0, MAX_STICKERS_IN_PROMPT);
  if (!names.length) return '';
  return `可另发 {"sticker":"分类名","delay":0}。可用分类：${names.join('、')}。`;
}

/** LLM 常在 JSON 字符串里插入真实换行，导致 JSON.parse 失败 */
function repairJsonLiteralNewlines(str) {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && str[i + 1] === '\n') i += 1;
      result += ' ';
      continue;
    }
    result += ch;
  }
  return result;
}

function extractMultiReplyObjects(str) {
  const items = [];
  const objRe = /\{[^{}]*\}/g;
  for (const block of str.match(objRe) || []) {
    const stickerMatch = block.match(/"sticker"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const textMatch = block.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const delayMatch = block.match(/"delay"\s*:\s*(\d+)/);
    const delay = delayMatch ? Number(delayMatch[1]) || 0 : 0;
    if (stickerMatch) {
      const sticker = stickerMatch[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').trim();
      if (sticker) items.push({ sticker, delay });
      continue;
    }
    if (textMatch) {
      const text = textMatch[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').trim();
      if (text) items.push({ text, delay });
    }
  }
  return items.length > 0 ? items : null;
}

function looksLikeMultiReplyJson(text) {
  const t = String(text || '').trim();
  return t.startsWith('[') && /"(?:text|sticker)"\s*:/.test(t);
}

const STICKER_STORAGE_RE = /^\[表情包:(.+)\]$/;
const STICKER_INLINE_RE = /\[表情包:([^\]]+)\]/g;

function stripInlineStickerTag(text) {
  return String(text || '').replace(STICKER_INLINE_RE, '').trim();
}

function stickerItemFromName(name, stickerMap, delay) {
  const info = resolveStickerName(name, stickerMap);
  if (!info) return null;
  return {
    text: '',
    sticker: info.name,
    stickerUrl: info.url,
    delay,
  };
}

function tryParseMultiReplyArray(raw) {
  const trimmed = raw.trim();
  const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/) || trimmed.match(/(\[[\s\S]*\])/);
  const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]).trim() : trimmed;

  const attempts = [jsonStr, repairJsonLiteralNewlines(jsonStr)];
  for (const candidate of attempts) {
    try {
      const arr = JSON.parse(candidate);
      if (Array.isArray(arr) && arr.length > 0) return arr;
    } catch {
      // try next
    }
  }
  return extractMultiReplyObjects(repairJsonLiteralNewlines(jsonStr));
}

function splitIntoChatSegments(text) {
  if (looksLikeMultiReplyJson(text)) {
    return [{ text: String(text).trim(), delay: 0 }];
  }
  const cleaned = stripInlineStickerTag(stripEmotionTag(String(text || ''))).trim();
  if (!cleaned) return [];

  let parts = cleaned
    .split(/(?<=[。！？!?；;])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length <= 1 && cleaned.length >= 18 && /\s/.test(cleaned)) {
    const spaceParts = cleaned
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 6);
    if (spaceParts.length >= 2) {
      parts = spaceParts;
    }
  }

  if (parts.length <= 1) {
    return [{ text: cleaned, delay: 0 }];
  }

  return parts.map((part, i) => ({
    text: part,
    delay: i === 0 ? 0 : 1500,
  }));
}

function expandMultiReplyMessages(messages) {
  const expanded = [];
  for (const msg of messages) {
    if (msg.stickerUrl || !msg.text?.trim()) {
      expanded.push(msg);
      continue;
    }
    const segments = splitIntoChatSegments(msg.text);
    for (let i = 0; i < segments.length; i += 1) {
      expanded.push({
        ...msg,
        text: segments[i].text,
        delay: i === 0 ? msg.delay || 0 : segments[i].delay,
      });
    }
  }
  return expanded;
}

/**
 * 解析多条回复 JSON
 * @param {string} raw
 * @param {Record<string, { name: string, url: string }>} [stickerMap]
 * @returns {{ messages: Array<{ text: string, delay: number, sticker?: string, stickerUrl?: string }>, isMulti: boolean }}
 */
function mapMultiReplyItems(arr, stickerMap) {
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    const delay = i === 0 ? 0 : Math.max(0, Number(item.delay) || 1500);
    if (item.sticker) {
      const s = stickerItemFromName(String(item.sticker).trim(), stickerMap, delay);
      if (s) result.push(s);
      continue;
    }
    let text = String(item.text || '').trim();
    if (!text) continue;
    // 整段是表情包
    const storageMatch = text.match(STICKER_STORAGE_RE);
    if (storageMatch) {
      const s = stickerItemFromName(storageMatch[1].trim(), stickerMap, delay);
      if (s) result.push(s);
      continue;
    }
    // 嵌入式表情包：剥离标签，提取为独立表情包条目
    const inlineMatches = [...text.matchAll(STICKER_INLINE_RE)];
    if (inlineMatches.length > 0) {
      text = text.replace(STICKER_INLINE_RE, '').trim();
      for (const m of inlineMatches) {
        const s = stickerItemFromName(m[1].trim(), stickerMap, 0);
        if (s) result.push(s);
      }
    }
    if (text) {
      result.push({ text, delay });
    }
  }
  return result;
}

function parseMultiReply(raw, stickerMap = {}, { quietOnInvalid = false } = {}) {
  const trimmed = raw.trim();
  const arr = tryParseMultiReplyArray(trimmed);

  if (Array.isArray(arr) && arr.length > 0) {
    const messages = mapMultiReplyItems(arr, stickerMap);
    if (messages.length > 0) {
      return { messages, isMulti: messages.length > 1 };
    }
  }

  if (looksLikeMultiReplyJson(trimmed)) {
    if (quietOnInvalid) return { messages: [], isMulti: false };
    return { messages: [{ text: '（回复格式异常，请再说一次）', delay: 0 }], isMulti: false };
  }

  const fallback = expandMultiReplyMessages([{ text: trimmed, delay: 0 }]);
  const messages = mapMultiReplyItems(
    fallback.map((m) => ({ text: m.text, delay: m.delay })),
    stickerMap,
  );
  return { messages, isMulti: messages.length > 1 };
}

function formatMultiReplyForStorage(messages) {
  return messages
    .map((m) => (m.stickerUrl ? `[表情包:${m.sticker}]` : m.text))
    .filter(Boolean)
    .join('\n');
}


function toolFailure(code) {
  return { ok: false, error: { code, message: '工具未完成，请根据失败状态如实回应；不要声称已经执行成功。' } };
}

/** Same model and transient transcript for a bounded native tool conversation. */
async function chatWithTools(settings, initialMessages, { tools, executeTool, signal, maxToolRounds = 4, max_tokens, timeoutMs } = {}) {
  if (!Array.isArray(tools) || !tools.length || typeof executeTool !== 'function') {
    throw toolError('model_tools_unavailable', '模型工具尚未接通');
  }
  const names = new Set();
  for (const tool of tools) {
    const name = tool?.function?.name;
    if (tool?.type !== 'function' || typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)
      || names.has(name)) throw toolError('model_tools_invalid', '模型工具定义无效');
    names.add(name);
  }
  const roundsLimit = Number.isFinite(maxToolRounds) ? Math.min(8, Math.max(1, Math.floor(maxToolRounds))) : 4;
  const messages = [...initialMessages];
  const completedIds = new Set();
  const turn = settings.provider === 'cloud' ? chatCloudTurn : chatOllamaTurn;
  let totalCalls = 0;
  for (let round = 0; round <= roundsLimit; round += 1) {
    signal?.throwIfAborted();
    const mustFinish = round === roundsLimit || totalCalls >= 16;
    const result = await turn(settings, messages, { tools, signal, max_tokens, timeoutMs, toolChoice: mustFinish ? 'none' : 'auto' });
    signal?.throwIfAborted();
    if (!result.toolCalls.length) return result.content;
    if (mustFinish) throw toolError('model_tool_loop_limit', '模型在工具调用上限后仍继续调用工具，本次已停止');
    messages.push(result.assistantMessage);
    for (const call of result.toolCalls) {
      signal?.throwIfAborted();
      let output;
      if (completedIds.has(call.id)) output = toolFailure('duplicate_tool_call');
      else if (call.argumentError) output = toolFailure('invalid_tool_arguments');
      else if (!names.has(call.name)) output = toolFailure('unknown_tool');
      else if (totalCalls >= 16) output = toolFailure('tool_call_limit');
      else {
        totalCalls += 1;
        try { output = await executeTool({ id: call.id, name: call.name, arguments: call.arguments }); }
        catch (error) {
          if (error?.code?.startsWith('usage_budget_')) throw error;
          output = toolFailure('tool_execution_failed');
        }
      }
      signal?.throwIfAborted();
      completedIds.add(call.id);
      let content;
      try { content = JSON.stringify(output); } catch { /* Replace unserializable tool results below. */ }
      if (typeof content !== 'string') content = JSON.stringify(toolFailure('invalid_tool_result'));
      if (content.length > 65_536) content = JSON.stringify(toolFailure('tool_result_limit'));
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content });
    }
  }
  throw toolError('model_tool_loop_limit', '模型工具调用达到上限，本次已停止');
}

// Enrich only user rows already admitted by getPromptHistory. The exact source
// ID joins their committed PC snapshot; original words remain untouched in memory.
function withStickerHistory(db, history, sessionId) {
  let snapshot;
  try {
    snapshot = db.prepare(`SELECT r.input_json,m.parts_json FROM pc_requests r
      JOIN pc_messages m ON m.request_id=r.request_id AND m.role='user'
      WHERE r.source_message_id=? AND r.session_id=? AND m.session_id=? LIMIT 1`);
  } catch { /* Brain-only callers have no PC message tables. */ }
  return history.map(({id,role,content}) => {
    if (snapshot && role === 'user') {
      const row = snapshot.get(id,sessionId,sessionId);
      if (row) try {
        const input = JSON.parse(row.input_json), parts = JSON.parse(row.parts_json);
        const image = parts.find(part => part.type === 'image' && part.sticker_id === input.sticker_id);
        if (input.type === 'text_sticker' && input.text === content &&
            parts.filter(part => part.type === 'plain').map(part => part.text).join('\n') === content &&
            typeof image?.semantic_text === 'string' && image.semantic_text.startsWith('【用户表情消息】') && image.semantic_text.length <= 6000)
          content += '\n\n' + image.semantic_text;
      } catch { /* Invalid optional metadata must not hide the original words. */ }
    }
    return {role,content};
  });
}

/** Reuses Nianan prompt, history, memory and multi-reply parsing without window or cognition hooks. */
async function chatComplete({ userText, userPrompt = userText, sessionId = MAIN_SESSION_ID, signal, companionBlock = '', tools, executeTool, maxToolRounds }) {
  signal?.throwIfAborted();
  const settings = loadSettings();
  const db = initMemory();
  const mem = resolveMemorySettings(settings);
  const history = withStickerHistory(db, getPromptHistory(sessionId, mem.maxRecentMessages, {includeIds:true}), sessionId);
  const teachingLookup = Array.isArray(tools) && tools.some(tool => tool?.function?.name === 'memory_get_teaching');
  const memoryBlock = mem.enabled ? buildMemoryContext(userText, { ...mem, sessionId, teachingLookup }) : '';
  const stickerMap = settings.stickers?.enabled === false ? {} : require('../../stickers').getStickerMap(settings);
  const messages = buildMessages(settings, history, userPrompt, [
    stickerProtocol(stickerMap), buildTimeContext(sessionId), companionBlock, memoryBlock,
  ]);
  const raw = Array.isArray(tools) && tools.length
    ? await chatWithTools(settings, messages, { tools, executeTool, maxToolRounds, signal })
    : settings.provider === 'cloud'
    ? await chatCloud(settings, messages, { signal })
    : await chatOllama(settings, messages, { signal });
  signal?.throwIfAborted();
  const parsed = parseMultiReply(raw, stickerMap);
  const emotionalText = parsed.messages.map(m => m.text).filter(Boolean).join('\n');
  const emotionResult = parseReply(emotionalText, userText);
  const replyMessages = parsed.messages.map(m => ({ text: stripEmotionTag(m.text || ''),
    ...(m.stickerUrl ? { stickerUrl: m.stickerUrl, sticker: m.sticker } : {}),
    delay: Math.min(10000, Math.max(0, Number(m.delay) || 0)) })).filter(m => m.text.trim() || m.stickerUrl);
  if (!replyMessages.length) throw new Error('模型未返回可显示的文字');
  replyMessages[0].delay = 0;
  return { ...emotionResult, text: formatMultiReplyForStorage(replyMessages), messages: replyMessages };
}
module.exports = { chatComplete, chatWithTools, parseMultiReply, parseReply, resolveSystemPrompt, DEFAULT_SYSTEM };
