const BRAIN_EXPRESSIONS = ['开心', '害羞', '生气', '哭哭', '记笔记', '看手机'];

const EMOTION_TAG_RE = /(?:^|\n)\s*\[表情[:：]\s*([^\]\s]+)\s*\]\s*$|\s*\[表情[:：]\s*([^\]\s]+)\s*\]\s*$/;

function stripEmotionTag(raw) {
  return String(raw || '').replace(/\s*\[表情[:：]\s*[^\]\s]+\s*\]/g, '').trim();
}

function extractEmotionTag(raw) {
  const text = String(raw || '');
  const match = text.match(EMOTION_TAG_RE);
  if (!match) return null;
  return match[1] || match[2] || null;
}

const LONG_MESSAGE_CHARS = 80;
const LOOKUP_KEYWORDS = [
  '查', '搜索', '找一下', '帮我看', '资料', '什么是', '为什么', '怎么',
  '如何', '哪里', '介绍', '解释', '百科', '定义',
];

const LEGACY_ALIASES = {
  星星眼: '开心',
  脸红: '害羞',
  黑脸: '生气',
};

/** @type {{ expr: string, words: string[], anti?: string[] }[]} */
const KEYWORD_RULES = [
  {
    expr: '哭哭',
    words: ['哭', '难过', '伤心', '心疼', '对不起', '抱歉', '委屈', '好想哭', '不开心', '悲伤'],
    anti: ['不想哭', '没哭', '别哭'],
  },
  {
    expr: '开心',
    words: ['棒', '厉害', '喜欢', '爱', '开心', '哈哈', '太好了', '耶', '赞', '优秀', '可爱', '高兴', '快乐', '幸福', '嘿嘿', '嘻嘻'],
    anti: ['不开心', '不太开心', '别开心', '不高兴'],
  },
  { expr: '害羞', words: ['羞', '尴尬', '脸红', '漂亮', '好看', '心动', '害羞'] },
  { expr: '生气', words: ['生气', '讨厌', '烦', '气死', '哼', '不理你', '愤怒', '火大'] },
  { expr: '记笔记', words: ['记住', '笔记', '学习', '考试', '作业', '复习', '记一下', '别忘了'] },
  { expr: '看手机', words: ['手机', '消息', '回我', '在线吗', '查', '搜索', '资料'] },
];

const MOOD_LABELS = {
  记笔记: '在想…',
  开心: '开心喵',
  害羞: '有点羞',
  哭哭: '委屈了',
  生气: '气鼓鼓',
  看手机: '在看资料',
  晕晕眼: '有点晕',
};

const LINGER_MS = {
  哭哭: 14000,
  开心: 10000,
  害羞: 10000,
  生气: 8000,
  看手机: 6000,
  记笔记: 6000,
};

const EMOTED_WHILE_SPEAKING = new Set(['开心', '害羞', '哭哭', '生气', '晕晕眼']);

const DEFAULT_LINGER_MS = 9000;
const ERROR_LINGER_MS = 6000;

/**
 * @param {string | null | undefined} name
 */
function normalizeExpression(name) {
  if (!name) return null;
  return LEGACY_ALIASES[name] || name;
}

/**
 * @param {string} text
 */
function hasMemoryIntent(text) {
  if (!text) return false;
  return /记(?:一下|住)|我叫|我的名字|我喜欢|我讨厌|别忘了|记住/.test(text);
}

/**
 * @param {{ userText?: string, slow?: boolean, memoryHint?: boolean }} [ctx]
 */
function resolveThinkingExpression(ctx = {}) {
  const userText = ctx.userText || '';
  if (ctx.slow) return '看手机';
  if (ctx.memoryHint || hasMemoryIntent(userText)) return '记笔记';
  if (userText.length >= LONG_MESSAGE_CHARS) return '记笔记';
  if (LOOKUP_KEYWORDS.some((w) => userText.includes(w))) return '看手机';
  return '记笔记';
}

/**
 * @param {string | null | undefined} text
 */
function inferFromText(text) {
  if (!text?.trim()) return null;
  for (const rule of KEYWORD_RULES) {
    if (rule.anti?.some((w) => text.includes(w))) continue;
    if (rule.words.some((w) => text.includes(w))) {
      return rule.expr;
    }
  }
  return null;
}

/**
 * @param {object} opts
 * @param {string | null | undefined} [opts.tag]
 * @param {string} [opts.replyText]
 * @param {string} [opts.userText]
 * @param {boolean} [opts.isError]
 * @returns {string | null}
 */
function resolveExpression({ tag, replyText, userText, isError = false }) {
  if (isError) return '晕晕眼';
  const normalizedTag = normalizeExpression(tag);
  if (normalizedTag && BRAIN_EXPRESSIONS.includes(normalizedTag)) return normalizedTag;
  const fromReply = inferFromText(replyText);
  if (fromReply) return fromReply;
  return inferFromText(userText) || null;
}

/**
 * @param {string | null | undefined} emotion
 */
function getSpeakingExpression(emotion) {
  const normalized = normalizeExpression(emotion);
  if (normalized && EMOTED_WHILE_SPEAKING.has(normalized)) return normalized;
  return '开心';
}

/**
 * @param {string | null | undefined} expression
 */
function getLingerMs(expression) {
  if (!expression) return 0;
  const normalized = normalizeExpression(expression);
  return LINGER_MS[normalized] ?? DEFAULT_LINGER_MS;
}

/**
 * @param {string | null | undefined} expression
 */
function shouldPlayLingerMotion(expression) {
  const normalized = normalizeExpression(expression);
  return Boolean(normalized && ['哭哭', '开心', '生气'].includes(normalized));
}

function getMoodLabel(expression) {
  if (!expression) return '在线陪伴中';
  const normalized = normalizeExpression(expression);
  return MOOD_LABELS[normalized] || '在线陪伴中';
}

module.exports = {
  BRAIN_EXPRESSIONS,
  stripEmotionTag,
  extractEmotionTag,
  resolveExpression,
  resolveThinkingExpression,
  normalizeExpression,
  getSpeakingExpression,
  getLingerMs,
  shouldPlayLingerMotion,
  getMoodLabel,
  THINKING_EXPRESSION: '记笔记',
  SPEAKING_EXPRESSION: '开心',
  ERROR_EXPRESSION: '晕晕眼',
  ERROR_LINGER_MS,
  THINKING_SLOW_MS: 2500,
};
