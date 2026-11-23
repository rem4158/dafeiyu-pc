// Adapted from the retained Nianan cognition modules for the local PC runtime.
const { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate } = require('./cognition-lifecycle');
/**
 * v7.5 Phase B：聊天态内驱力爆发
 * - curiosity：延迟第二条 grounded 追问
 * - comfort：低安全感库存 → 聊天内不安全感表达
 */

const { initMemory } = require('./memory');
const { chatCloud } = require('./cognition-transport');
const { chatOllama } = require('./cognition-transport');
const { withTimeout } = require('./request-timeout');
const {
  getDesireVector,
  saveDesireVector,
  assessUserEngagement,
} = require('./digital-life-desire');
const {
  getAttachmentState,
  getAttachmentQuadrant,
} = require('./digital-life-attachment');

const CURIOSITY_BURST_THRESHOLD = 0.58;
/** comfort 低 = 安全感库存不足 */
const COMFORT_INSECURITY_THRESHOLD = 0.38;
const CURIOSITY_REFRACTORY_MS = 45_000;
const COMFORT_REFRACTORY_MS = 90_000;

/** @type {{ lastCuriosityBurstAt: number, lastComfortBurstAt: number }} */
let sessionB = {
  lastCuriosityBurstAt: 0,
  lastComfortBurstAt: 0,
};

function resetPhaseBSession() {
  sessionB = { lastCuriosityBurstAt: 0, lastComfortBurstAt: 0 };
}

function getDb() {
  return initMemory();
}

function assessTopicDensity(userText = '') {
  const text = userText.trim();
  if (text.length >= 40) return 0.9;
  if (text.length >= 20) return 0.75;
  if (text.length >= 12) return 0.55;
  if (text.length >= 6) return 0.35;
  return 0.15;
}

/**
 * @param {object} params
 * @returns {{ shouldBurst: boolean, delayMs?: number, reason: string }}
 */
function checkPhaseBCuriosityBurst({ db, userText, recentUserMessages = [], personalityDims = {} }) {
  const vector = getDesireVector(db);
  const proactivity = personalityDims.proactivity ?? 0.5;
  const threshold = CURIOSITY_BURST_THRESHOLD - (proactivity - 0.5) * 0.08;

  if (vector.curiosity < threshold) {
    return { shouldBurst: false, reason: 'curiosity_below_threshold' };
  }
  if (Date.now() - sessionB.lastCuriosityBurstAt < CURIOSITY_REFRACTORY_MS) {
    return { shouldBurst: false, reason: 'curiosity_refractory' };
  }

  const density = assessTopicDensity(userText);
  const recentShare = (recentUserMessages || []).some((m) => String(m).trim().length >= 15);
  if (density < 0.45 && !recentShare) {
    return { shouldBurst: false, reason: 'low_topic_density' };
  }

  const trimmed = userText.trim();
  const isShortQuestion = trimmed.length <= 12 && /[？?]$/.test(trimmed);
  if (isShortQuestion && density < 0.5) {
    return { shouldBurst: false, reason: 'short_user_question' };
  }

  const delayMs = 2000 + Math.floor(Math.random() * 1000);
  return { shouldBurst: true, delayMs, reason: 'curiosity_burst' };
}

/**
 * @param {object} params
 * @returns {{ shouldBurst: boolean, delayMs?: number, reason: string }}
 */
function checkPhaseBComfortBurst({ db, userText, engagement = 0.5, personalityDims = {} }) {
  const vector = getDesireVector(db);
  const dependency = personalityDims.dependency ?? 0.5;
  const threshold = COMFORT_INSECURITY_THRESHOLD + (dependency - 0.5) * 0.06;

  if (vector.comfort > threshold) {
    return { shouldBurst: false, reason: 'comfort_stock_adequate' };
  }
  if (Date.now() - sessionB.lastComfortBurstAt < COMFORT_REFRACTORY_MS) {
    return { shouldBurst: false, reason: 'comfort_refractory' };
  }

  let perfunctory = false;
  try {
    const { isPerfunctoryReply } = require('../proactive/ignore-tracker');
    perfunctory = isPerfunctoryReply(userText);
  } catch {}

  if (!perfunctory && engagement > 0.38) {
    return { shouldBurst: false, reason: 'engagement_not_low' };
  }

  const delayMs = 2500 + Math.floor(Math.random() * 1500);
  return { shouldBurst: true, delayMs, reason: 'comfort_insecurity' };
}

function consumePhaseBBurst(db, dimension) {
  const vector = getDesireVector(db);
  if (dimension === 'curiosity') {
    vector.curiosity = Math.max(0.22, vector.curiosity * 0.42);
    sessionB.lastCuriosityBurstAt = Date.now();
  } else if (dimension === 'comfort') {
    vector.comfort = Math.min(0.52, vector.comfort + 0.12);
    sessionB.lastComfortBurstAt = Date.now();
  }
  saveDesireVector(db, vector);
}

function ruleBasedCuriosityFollowUp(userText) {
  const snippet = userText.trim().replace(/[？?！!。，,\s]+/g, '').slice(0, 12);
  if (snippet.length < 2) return null;
  const templates = [
    `诶，${snippet}…后来怎么样了？`,
    `等等，你刚说的${snippet.slice(0, 6)}是怎么回事呀？`,
    `我对这个有点好奇，${snippet.slice(0, 8)}呢？`,
  ];
  return templates[Math.floor(Math.random() * templates.length)];
}

function ruleBasedComfortLine(quadrant, personalityDims = {}) {
  const possessive = (personalityDims.possessiveness ?? 0.5) > 0.6;
  const lines = {
    anxious: possessive
      ? ['你回复好短…是不是不想理我了？', '你好像不太想聊，是我哪里说错了吗…']
      : ['你…是不是不太想聊？', '感觉你有点敷衍，是我话太多了吗…'],
    secure: ['感觉你好像有点忙？', '你还好吗，是不是不太方便聊？'],
    avoidant: ['嗯…你好像不太想说话。', '要是累了就说一声。'],
    disorganized: ['你…还在吗？', '是不是我话说太多了…'],
  };
  const pool = lines[quadrant] || lines.secure;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function generateCuriosityFollowUp({ settings, userText, mainReply }) {
  const topic = userText.trim().slice(0, 80);
  const replySnippet = mainReply.trim().slice(0, 150);
  const system = (settings.personality?.prompt || ('你是' + (require('./settings').loadSettings().characterName || '大肥鱼') + '，用户的 AI 伴侣。')).slice(0, 200);
  const messages = [
    { role: 'system', content: `${system}\n只输出一句口语化追问，15字以内，必须紧扣用户刚分享的内容，禁止换话题或重复你已说过的话。不要引号、不要 markdown。` },
    { role: 'user', content: `用户刚说：「${topic}」\n你已回复：「${replySnippet}」\n请追加一个自然的好奇追问：` },
  ];

  try {
    const llmCall = settings.provider === 'cloud'
      ? chatCloud(settings, messages, { max_tokens: 40, temperature: 0.75, timeoutMs: 30_000 })
      : chatOllama(settings, messages, { max_tokens: 40, timeoutMs: 30_000 });
    const raw = await withTimeout(llmCall, 32_000, '追问生成');
    const text = String(raw || '').trim().replace(/^["「]|["」]$/g, '');
    if (text.length >= 2 && text.length <= 40) return text;
  } catch (err) {
    console.warn('[DigitalLife:PhaseB] curiosity LLM failed:', err.message);
  }
  return ruleBasedCuriosityFollowUp(userText);
}

function generateComfortInsecurityLine({ userText, personalityDims = {} }) {
  const db = getDb();
  const attachment = getAttachmentState(db);
  const quadrant = getAttachmentQuadrant(attachment.anxiety, attachment.avoidance);
  return ruleBasedComfortLine(quadrant, personalityDims);
}

/**
 * Phase B 聊天爆发：追加延迟消息（不走 proactive）
 * @param {object} params
 * @returns {Promise<Array<{ text: string, delay: number, phaseB?: string, emotion?: string }>>}
 */
async function applyPhaseBChatBursts({
  settings,
  userText,
  mainReply,
  recentUserMessages = [],
  personalityDims = {},
}) {
  const db = getDb();
  const engagement = assessUserEngagement({
    userText,
    messageLength: userText.length,
    isQuestion: /[？?]/.test(userText),
  });

  const comfortCheck = checkPhaseBComfortBurst({ db, userText, engagement, personalityDims });
  const curiosityCheck = checkPhaseBCuriosityBurst({
    db,
    userText,
    recentUserMessages,
    personalityDims,
  });

  const extra = [];

  if (comfortCheck.shouldBurst) {
    const text = generateComfortInsecurityLine({ userText, personalityDims });
    extra.push({
      text,
      delay: comfortCheck.delayMs || 2800,
      phaseB: 'comfort',
      emotion: '疑问',
    });
    consumePhaseBBurst(db, 'comfort');
    console.log(`[DigitalLife:PhaseB] comfort burst: "${text}"`);
    return extra;
  }

  if (curiosityCheck.shouldBurst) {
    const text = await generateCuriosityFollowUp({ settings, userText, mainReply });
    if (text) {
      extra.push({
        text,
        delay: curiosityCheck.delayMs || 2500,
        phaseB: 'curiosity',
        emotion: '好奇',
      });
      consumePhaseBBurst(db, 'curiosity');
      console.log(`[DigitalLife:PhaseB] curiosity burst: "${text}"`);
    }
  }

  return extra;
}

module.exports = {
  resetPhaseBSession,
  checkPhaseBCuriosityBurst,
  checkPhaseBComfortBurst,
  applyPhaseBChatBursts,
  consumePhaseBBurst,
  assessTopicDensity,
  CURIOSITY_BURST_THRESHOLD,
  COMFORT_INSECURITY_THRESHOLD,
};
