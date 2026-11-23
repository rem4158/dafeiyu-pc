const { chatCloud } = require('./cloud');
const { chatOllama } = require('./ollama');
const { directMemoryPassages, personalClauses, allowsModelFact } = require('./extract');

/**
 * @typedef {Object} ExtractedFact
 * @property {string} category
 * @property {string} factKey
 * @property {string} factValue
 * @property {number} importance
 * @property {'permanent' | 'temporary' | 'fleeting'} factType
 * @property {string} keywords — JSON 数组字符串，如 '["考试","成绩"]'
 * @property {number | null} expiresAt — 毫秒时间戳，仅 temporary
 */

/**
 * @typedef {Object} ExtractedEvent
 * @property {string} title
 * @property {string} body
 */

const VALID_FACT_TYPES = new Set(['permanent', 'temporary', 'fleeting']);

/**
 * @param {string} userText
 * @param {string} assistantReply
 */
function buildExtractPrompt(userText, sourceAt) {
  const sourceDay = new Date(sourceAt).toLocaleDateString('zh-CN');
  return `分析以下对话，提取值得长期记住的用户信息。

规则：
- 只提取用户本人明确陈述的具体信息；忽略假设、引用、玩笑、角色扮演、助手建议。每条必须带 evidence，逐字复制用户原话；value 必须是 evidence 中的原文。只记录当前状态，不把过去偏好当作当前事实。
- 不提取闲聊、寒暄、纯问答类内容
- 不提取通用知识或 AI 自己的信息
- 如果没有值得记住的信息，返回空数组 []
- 对本人明确承诺、改期、取消或确已发生的经历，可另外提供 episode 对象。topic 从 evidence 逐字选取能区分事项的短主题，status 只用 planned/rescheduled/cancelled/completed。事先打算和报名本身都不能证明参加过。无法判断请省略 episode。

类别(category)：
- profile：身份信息（姓名、职业、城市、年龄等）
- preference：偏好（喜欢/不喜欢什么）
- habit：习惯（作息、日常等）
- event：发生的事（经历、见闻）
- relationship：人物关系（朋友、家人、同事）
- plan：计划/安排（会议、出行、考试）
- opinion：观点/态度

时效类型(type)：
- permanent：不会随时间变化的事实
- temporary：有明确时间范围的事项（明天、下周、本月等）
- fleeting：一次性事件、随口提到的小事

这是用户在本地日期 ${sourceDay} 发的消息。临时安排的 evidence 必须包含用户实际说出的日期/时间词和事项，保留原词，不推断未说出的期限。

每条输出格式：
{"category":"...","key":"...","value":"...","importance":1-5,"type":"...","keywords":["..."],"evidence":"用户原话中的连续片段"}

返回纯 JSON 数组，不要 markdown。

用户: ${userText}
助手信息不参与事实提取。`;
}

/**
 * @param {string} raw
 * @returns {unknown[]}
 */
function parseJsonArrayFromLlm(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || text;

  const arrayMatch = candidate.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return [];

  const parsed = JSON.parse(arrayMatch[0]);
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeImportance(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, Math.round(n)));
}

/**
 * @param {unknown} value
 * @returns {'permanent' | 'temporary' | 'fleeting'}
 */
function normalizeFactType(value) {
  const t = String(value || 'permanent').trim().toLowerCase();
  return VALID_FACT_TYPES.has(t) ? /** @type {'permanent' | 'temporary' | 'fleeting'} */ (t) : 'permanent';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeKeywords(value) {
  let words = Array.isArray(value) ? value : [];
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) words=parsed;
    } catch {
      words=[value];
    }
  }
  // Only a local rule that sees the literal action can issue this metadata.
  return JSON.stringify(words.map(k=>String(k).trim()).filter(k=>k && !k.startsWith('@source-action:')));
}

/**
 * @param {Record<string, unknown>} item
 * @returns {{ fact: ExtractedFact | null, event: ExtractedEvent | null }}
 */
function mapExtractedItem(item) {
  const category = String(item.category || 'other').trim();
  const factKey = String(item.key || item.factKey || '').trim();
  const factValue = String(item.value || item.factValue || '').trim();

  if (!factKey || !factValue) {
    return { fact: null, event: null };
  }

  const factType = normalizeFactType(item.type || item.factType);
  /** @type {ExtractedFact} */
  const fact = {
    category,
    factKey,
    factValue,
    importance: normalizeImportance(item.importance),
    factType,
    keywords: normalizeKeywords(item.keywords),
    expiresAt: null, // Only the committed source can establish a deadline.
  };

  if (category === 'event' && fact.factType === 'permanent') {
    fact.factType = 'fleeting';
  }

  return { fact, event: null };
}

/**
 * 使用 LLM 从一轮对话中提取结构化记忆（不写库）。
 *
 * @param {string} userText — 用户消息
 * @param {string} assistantReply — 助手回复
 * @param {object} settings — 完整 settings，需含 cloud 配置
 * @returns {Promise<{ facts: ExtractedFact[] }>}
 */
async function extractMemoriesWithLLM(userText, assistantReply, settings, sourceAt = Date.now()) {
  try {
    const user = String(userText || '').trim();
    const passages = directMemoryPassages(user);
    if (!passages.length) return { facts: [] };
    const clauses = passages.flatMap(personalClauses);

    const prompt = buildExtractPrompt(user, sourceAt);
    const messages = [
      { role: 'system', content: '你是记忆提取助手。只输出合法 JSON 数组，不要 markdown 或其它说明。' },
      { role: 'user', content: prompt },
    ];

    const complete = settings.provider === 'ollama' ? chatOllama : chatCloud;
    const raw = await complete(settings, messages, { temperature: 0.1, timeoutMs: 20000,
      usageContext: { purpose: 'memory_extract' } });
    const items = parseJsonArrayFromLlm(raw);

    /** @type {ExtractedFact[]} */
    const facts = [];

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const { fact } = mapExtractedItem(/** @type {Record<string, unknown>} */ (item));
      const evidence = String(item.evidence || '');
      if (!fact || !evidence || !passages.some(p => p.includes(evidence)) || !evidence.includes(fact.factValue) ||
          !allowsModelFact(fact,evidence,clauses)) continue;
      const hint = item.episode;
      if (['event','plan'].includes(fact.category) && typeof hint?.topic === 'string' &&
          hint.topic.trim().length >= 2 && hint.topic.length <= 40 && evidence.includes(hint.topic) &&
          ['planned','rescheduled','cancelled','completed'].includes(hint.status)) {
        fact.episode = {topic:hint.topic.trim(),status:hint.status};
      }
      facts.push({...fact,evidence});
    }

    return { facts };
  } catch {
    return { facts: [], failed: true };
  }
}

module.exports = { extractMemoriesWithLLM };
