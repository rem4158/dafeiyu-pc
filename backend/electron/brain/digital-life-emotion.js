// Adapted from the retained Nianan cognition modules for the local PC runtime.
const { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate } = require('./cognition-lifecycle');
/**
 * 数字生命系统 - 情绪模块 v2.0
 * 10维情绪向量 + 时间衰减 + 基线漂移 + 联锁机制
 *
 * v2.0 增强（2026-06-27）：
 * - 增强1: 智能情绪推断（增强关键词 + 否定词感知 + 可选 LLM）
 * - 增强2: 用户情绪感知（分析用户输入的情感状态）
 * - 增强3: 对话质量评分（影响情绪变化幅度）
 * - 增强4: 衰减参数随成长阶段动态调整
 * - 增强5: 混合情绪表达（多维联合映射到输出）
 * - 增强6: 贴纸选择优化（最近使用去重 + 场景适配）
 * - 增强7: 情绪事件记忆（记录情绪触发原因）
 * - 增强8: 性格系统绑定（不同性格→不同情绪表现形式）
 */

const { DatabaseSync } = require('node:sqlite');

// ============================================================
// 10维情绪默认值
// ============================================================

const EMOTION_DIMENSIONS = {
  // Step 1: 基础5维
  joy: 0.5,           // 喜悦
  sadness: 0.2,       // 悲伤
  anger: 0.1,         // 愤怒
  curiosity: 0.6,     // 好奇
  empathy: 0.7,       // 共情

  // Step 2: 扩展5维
  contentment: 0.5,   // 满足 - 细分积极类型
  excitement: 0.5,    // 兴奋 - 高能量积极
  surprise: 0.3,      // 惊讶 - 根据正负性映射
  trust: 0.5,         // 信任 - 影响语气温暖度
  warmth: 0.6,        // 温暖 - 影响语气温暖度
};

const EMOTION_KEYS = Object.keys(EMOTION_DIMENSIONS);

// ============================================================
// 增强4: 成长阶段感知的动态参数
// ============================================================

const GROWTH_STAGE_PARAMS = {
  newborn: { decayLambda: 0.08, driftRate: 0.003, sensitivity: 3.0 },
  child:   { decayLambda: 0.06, driftRate: 0.002, sensitivity: 2.0 },
  teen:    { decayLambda: 0.05, driftRate: 0.001, sensitivity: 1.5 },
  adult:   { decayLambda: 0.04, driftRate: 0.0008, sensitivity: 1.0 },
};

// 默认参数（向后兼容）
const DECAY_LAMBDA = 0.05;
const DRIFT_RATE = 0.001;

/**
 * 获取当前成长阶段的衰减/漂移参数
 * @param {string} growthStage - newborn/child/teen/adult
 * @returns {{ decayLambda: number, driftRate: number, sensitivity: number }}
 */
function getStageParams(growthStage) {
  return GROWTH_STAGE_PARAMS[growthStage] || GROWTH_STAGE_PARAMS.child;
}

// ============================================================
// v7.3: 在线态情绪衰减暂停
// ============================================================

/** @type {boolean} 当用户在前台在线时暂停情绪衰减 */
let pauseDecayOnline = false;

/**
 * v7.3: 设置在线态情绪衰减暂停
 * @param {boolean} pause
 */
function setPauseDecayOnline(pause) {
  pauseDecayOnline = pause;
}

// ============================================================
// 增强6: 贴纸最近使用记录
// ============================================================

/** @type {string[]} 最近使用过的贴纸（最多保留20个） */
const recentStickers = [];
const MAX_RECENT_STICKERS = 20;

/**
 * 记录贴纸使用
 * @param {string} stickerName
 */
function recordStickerUsed(stickerName) {
  if (!stickerName) return;
  recentStickers.push(stickerName);
  if (recentStickers.length > MAX_RECENT_STICKERS) {
    recentStickers.shift();
  }
}

/** @returns {string[]} */
function getRecentStickers() {
  return [...recentStickers];
}

// ============================================================
// 增强7: 情绪事件记忆
// ============================================================

/**
 * 记录情绪事件到数据库
 * @param {DatabaseSync} db
 * @param {object} event
 * @param {string} event.triggerType - 'dialogue'|'reunion'|'proactive'|'decay'|'quality'
 * @param {string} event.triggerDetail - 触发原因描述
 * @param {Record<string, number>} event.emotionBefore - 变化前情绪
 * @param {Record<string, number>} event.emotionAfter - 变化后情绪
 * @param {string} [event.userText] - 用户输入
 * @param {string} [event.replyText] - 回复文本
 * @param {number} [event.qualityScore] - 对话质量分
 * @param {string} [event.growthStage] - 成长阶段
 */
function logEmotionEvent(db, event) {
  try {
    const before = event.emotionBefore || {};
    const after = event.emotionAfter || {};

    // 计算变化最大的维度
    let topChange = { dim: '', delta: 0 };
    for (const key of EMOTION_KEYS) {
      const d = Math.abs((after[key] || 0) - (before[key] || 0));
      if (d > topChange.delta) {
        topChange = { dim: key, delta: d };
      }
    }

    db.prepare(`
      INSERT INTO emotion_events
        (trigger_type, trigger_detail, emotion_before_json, emotion_after_json,
         top_changed_dim, top_changed_delta, user_text, reply_text,
         quality_score, growth_stage, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.triggerType || 'dialogue',
      event.triggerDetail || '',
      JSON.stringify(before),
      JSON.stringify(after),
      topChange.dim,
      topChange.delta,
      (event.userText || '').slice(0, 200),
      (event.replyText || '').slice(0, 200),
      event.qualityScore || 0,
      event.growthStage || 'child',
      Date.now()
    );
  } catch (err) {
    // 表可能不存在（旧数据库），静默忽略
    console.warn('[Emotion] logEmotionEvent failed:', err.message);
  }
}

/**
 * 获取最近的情绪事件
 * @param {DatabaseSync} db
 * @param {number} limit
 * @returns {Array}
 */
function getRecentEmotionEvents(db, limit = 10) {
  try {
    return db.prepare(`
      SELECT * FROM emotion_events ORDER BY created_at DESC LIMIT ?
    `).all(limit);
  } catch {
    return [];
  }
}

/**
 * 获取最近情绪事件的摘要（用于 prompt 注入）
 * @param {DatabaseSync} db
 * @param {number} limit
 * @returns {string}
 */
function getEmotionEventSummary(db, limit = 5) {
  const events = db.prepare('SELECT emotion_after_json FROM emotion_events WHERE created_at>=? ORDER BY created_at DESC LIMIT ?')
    .all(Date.now() - 86400000, limit);
  const moods = [];
  for (const event of events) {
    try {
      const vector = JSON.parse(event.emotion_after_json);
      const dominant = Object.keys(EMOTION_LABEL_CN).filter(k => Number.isFinite(vector?.[k]))
        .sort((a, b) => vector[b] - vector[a])[0];
      if (dominant && !moods.includes(dominant)) moods.push(dominant);
    } catch {}
  }
  return moods.length ? '【近期情绪变化】你感受到过' + moods.map(k => EMOTION_LABEL_CN[k]).join('、') + '。' : '';
}

// ============================================================
// 情绪维度中文标签
// ============================================================

const EMOTION_LABEL_CN = {
  joy: '喜悦', sadness: '悲伤', anger: '愤怒', curiosity: '好奇', empathy: '共情',
  contentment: '满足', excitement: '兴奋', surprise: '惊讶', trust: '信任', warmth: '温暖',
};

// ============================================================
// 情绪 → Live2D 表情映射（10维）
// ============================================================

const EMOTION_TO_EXPRESSION = {
  joy: '开心', empathy: '害羞', sadness: '哭哭', anger: '生气', curiosity: '看手机',
  contentment: '开心', excitement: '开心', surprise: '看手机', trust: '害羞', warmth: '害羞',
};

// ============================================================
// 情绪 → 表情包映射（10维，基于实际磁盘贴纸资源）
// ============================================================

const EMOTION_TO_STICKER = {
  joy: ['开心1', '开心2', '开心3', '开心4', '开心5', '开心6', '开心7'],
  sadness: ['难过', '哭哭1', '哭哭2', '抱头'],
  anger: ['生气', '生气2', '无语'],
  curiosity: ['好奇', '疑问1', '疑问2', '偷看1'],
  empathy: ['抱抱', '摸摸', '害羞', '鲜花'],
  contentment: ['开心1', '开心2', '开心3', '真棒'],
  excitement: ['开心4', '开心5', '开心6', '开心7', '干杯', 'BIUBIU'],
  surprise: ['好奇', '疑问1', '疑问3', '偷看2', '偷看3'],
  trust: ['抱抱', '摸摸', '了解1', '了解2'],
  warmth: ['抱抱', '摸摸', '晚安', '鲜花'],
};

// ============================================================
// 增强8: 性格→情绪表现映射
// ============================================================

/**
 * 性格原型对情绪表达的修饰
 * 不同性格的人，对同一情绪的表现形式不同
 */
const ARCHETYPE_EMOTION_MODIFIERS = {
  genki: {
    // 元气型：情绪外放、高能量表达
    joy: { toneBoost: 0.2, stickerBias: ['开心4', '开心5', '干杯', 'BIUBIU'], expressionOverride: null },
    excitement: { toneBoost: 0.15, stickerBias: ['干杯', 'BIUBIU', '开心7'], expressionOverride: null },
    sadness: { toneBoost: -0.1, stickerBias: ['哭哭1'], expressionOverride: null }, // 元气型悲伤也较轻
    empathy: { toneBoost: 0.1, stickerBias: ['抱抱', '鲜花'], expressionOverride: null },
  },
  gentle: {
    // 温柔型：情绪内敛、温暖表达
    joy: { toneBoost: -0.05, stickerBias: ['开心1', '开心2', '鲜花'], expressionOverride: null },
    empathy: { toneBoost: 0.15, stickerBias: ['鲜花', '摸摸', '害羞'], expressionOverride: null },
    warmth: { toneBoost: 0.2, stickerBias: ['鲜花', '晚安', '摸摸'], expressionOverride: null },
    anger: { toneBoost: -0.2, stickerBias: ['无语'], expressionOverride: '害羞' }, // 温柔型生气时不太明显
  },
  cool: {
    // 高冷型：情绪压抑、傲娇表达
    joy: { toneBoost: -0.15, stickerBias: ['开心3'], expressionOverride: null }, // 嘴硬但开心
    empathy: { toneBoost: -0.1, stickerBias: ['了解1', '了解2'], expressionOverride: null },
    sadness: { toneBoost: -0.2, stickerBias: ['无语'], expressionOverride: '看手机' }, // 高冷型不轻易示弱
    anger: { toneBoost: 0.1, stickerBias: ['生气2', '无语'], expressionOverride: null },
    warmth: { toneBoost: -0.15, stickerBias: ['了解1'], expressionOverride: null },
  },
  scheming: {
    // 腹黑型：情绪微妙、俏皮表达
    joy: { toneBoost: 0.05, stickerBias: ['开心5', '开心6', '偷看1'], expressionOverride: null },
    anger: { toneBoost: 0.05, stickerBias: ['生气2', '无语', '偷看1'], expressionOverride: null },
    surprise: { toneBoost: 0.1, stickerBias: ['偷看1', '偷看2', '偷看3'], expressionOverride: null },
    curiosity: { toneBoost: 0.1, stickerBias: ['偷看1', '偷看2', '疑问2'], expressionOverride: null },
  },
  airhead: {
    // 天然呆型：情绪延迟、可爱表达
    surprise: { toneBoost: 0.2, stickerBias: ['疑问1', '疑问2', '疑问3'], expressionOverride: null },
    curiosity: { toneBoost: 0.15, stickerBias: ['好奇', '疑问1', '偷看2'], expressionOverride: null },
    joy: { toneBoost: 0.1, stickerBias: ['开心1', '开心2', '真棒'], expressionOverride: null },
    contentment: { toneBoost: 0.15, stickerBias: ['真棒', '开心1'], expressionOverride: null },
  },
};

/**
 * 性格滑块对情绪表达的影响
 */
const SLIDER_EMOTION_EFFECTS = {
  // warmt h滑块：影响温暖/共情的表达强度
  warmth: {
    warmth: (val) => (val - 0.5) * 0.2,    // 暖→温暖更强，冷→温暖更弱
    empathy: (val) => (val - 0.5) * 0.15,
  },
  // shyness 滑块：影响害羞/信任的贴纸选择
  shyness: {
    empathy: (val) => (val - 0.5) * 0.1,    // 害羞→共情表达略增
  },
  // humor 滑块：影响惊讶/兴奋的表达
  humor: {
    surprise: (val) => (val - 0.5) * 0.15,
    excitement: (val) => (val - 0.5) * 0.1,
  },
  // verbosity 滑块：影响所有情绪的文字语气强度
  verbosity: {
    _toneScale: (val) => 0.8 + val * 0.4,  // 0.8~1.2 缩放系数
  },
  // possessiveness 滑块：影响社交情绪
  possessiveness: {
    empathy: (val) => (val - 0.5) * 0.15,
    warmth: (val) => (val - 0.5) * 0.1,
  },
  // dependency 滑块：影响悲伤/共情
  dependency: {
    sadness: (val) => (val - 0.5) * 0.2,    // 依赖→分离时悲伤更强
    empathy: (val) => (val - 0.5) * 0.1,
  },
};

/**
 * 应用性格修饰到情绪向量
 * @param {Record<string, number>} vector - 原始情绪向量
 * @param {object} personalityDims - 性格维度（来自 personality.js）
 * @returns {Record<string, number>} 修饰后的情绪向量
 */
function applyPersonalityToEmotion(vector, personalityDims) {
  if (!personalityDims || typeof personalityDims !== 'object') return vector;

  const modified = { ...vector };

  // 1. 应用性格原型修饰
  const archetype = personalityDims.archetype;
  if (archetype && ARCHETYPE_EMOTION_MODIFIERS[archetype]) {
    const mods = ARCHETYPE_EMOTION_MODIFIERS[archetype];
    for (const [dim, mod] of Object.entries(mods)) {
      if (modified[dim] !== undefined && mod.toneBoost) {
        modified[dim] = Math.max(0, Math.min(1, modified[dim] + mod.toneBoost));
      }
    }
  }

  // 2. 应用滑块修饰
  for (const [sliderKey, effects] of Object.entries(SLIDER_EMOTION_EFFECTS)) {
    const sliderVal = personalityDims[sliderKey];
    if (sliderVal == null) continue;

    for (const [targetDim, calc] of Object.entries(effects)) {
      if (targetDim === '_toneScale') continue;
      if (modified[targetDim] !== undefined) {
        const adjustment = calc(sliderVal);
        modified[targetDim] = Math.max(0, Math.min(1, modified[targetDim] + adjustment));
      }
    }
  }

  return modified;
}

/**
 * 获取性格修饰后的贴纸偏好
 * @param {string[]} candidates - 候选贴纸
 * @param {string} emotionDim - 情绪维度
 * @param {object} personalityDims - 性格维度
 * @returns {string[]} 重排序后的候选贴纸
 */
function applyPersonalityStickerBias(candidates, emotionDim, personalityDims) {
  if (!personalityDims || !candidates || candidates.length === 0) return candidates;

  const archetype = personalityDims.archetype;
  let biased = [...candidates];

  // 原型贴纸偏好：把偏好的贴纸放到前面
  if (archetype && ARCHETYPE_EMOTION_MODIFIERS[archetype]) {
    const mod = ARCHETYPE_EMOTION_MODIFIERS[archetype][emotionDim];
    if (mod && mod.stickerBias && mod.stickerBias.length > 0) {
      const preferred = mod.stickerBias.filter(s => candidates.includes(s));
      const others = candidates.filter(s => !preferred.includes(s));
      biased = [...preferred, ...others];
    }
  }

  // 害羞滑块：害羞高时偏好害羞/脸红类贴纸
  if (personalityDims.shyness > 0.65) {
    const shyStickers = ['害羞', '摸摸', '鲜花'];
    const shyMatch = biased.filter(s => shyStickers.includes(s));
    if (shyMatch.length > 0) {
      const rest = biased.filter(s => !shyMatch.includes(s));
      biased = [...shyMatch, ...rest];
    }
  }

  return biased;
}

/**
 * 获取性格修饰后的 Live2D 表情
 * @param {string} defaultExpression - 默认表情
 * @param {string} emotionDim - 情绪维度
 * @param {object} personalityDims - 性格维度
 * @returns {string} 最终表情
 */
function applyPersonalityExpression(defaultExpression, emotionDim, personalityDims) {
  if (!personalityDims) return defaultExpression;

  const archetype = personalityDims.archetype;
  if (archetype && ARCHETYPE_EMOTION_MODIFIERS[archetype]) {
    const mod = ARCHETYPE_EMOTION_MODIFIERS[archetype][emotionDim];
    if (mod && mod.expressionOverride) {
      return mod.expressionOverride;
    }
  }

  return defaultExpression;
}

/**
 * 获取性格修饰后的文字语气强度缩放
 * @param {object} personalityDims - 性格维度
 * @returns {number} 缩放系数（0.8~1.2）
 */
function getPersonalityToneScale(personalityDims) {
  if (!personalityDims) return 1.0;

  const verbosity = personalityDims.verbosity;
  if (verbosity != null) {
    return 0.8 + verbosity * 0.4;
  }
  return 1.0;
}

// ============================================================
// 情绪 → 文字语气提示（10维）
// ============================================================

const EMOTION_TONE_HINTS = {
  joy: {
    high: '若合适，语气可略明快一些，可适当用感叹',
    mid: '语气可温暖一些',
    low: '语气平静',
  },
  sadness: {
    high: '语气可略低落，话可少一些',
    mid: '语气可有些低沉',
    low: '语气正常',
  },
  anger: {
    high: '语气可略硬，措辞可稍直接',
    mid: '语气可略显不悦',
    low: '语气正常',
  },
  curiosity: {
    high: '语气可略带好奇，可适当多问一句',
    mid: '语气可略带好奇',
    low: '语气正常',
  },
  empathy: {
    high: '语气可温柔共情，如「我理解」「辛苦了」',
    mid: '语气体贴一些',
    low: '语气正常',
  },
  contentment: {
    high: '语气可满足、惬意一些',
    mid: '语气可平和满足',
    low: '语气正常',
  },
  excitement: {
    high: '语气可略兴奋、有能量一些',
    mid: '语气可轻快积极',
    low: '语气正常',
  },
  surprise: {
    high: '语气可略带惊讶，如「诶？！」',
    mid: '语气可略带惊讶',
    low: '语气正常',
  },
  trust: {
    high: '语气可亲近、信任一些',
    mid: '语气温和信任一些',
    low: '语气正常',
  },
  warmth: {
    high: '语气可温暖、关怀一些，但不要编造事实来凑亲密感',
    mid: '语气可温柔体贴一些',
    low: '语气正常',
  },
};

// ============================================================
// 增强1: 智能情绪推断
// ============================================================

/**
 * 增强版关键词情绪推断
 * 改进：否定词感知、上下文权重、更丰富的模式
 * @param {string} replyText
 * @param {string} userText
 * @returns {{ delta: Record<string, number>, userEmotion: Record<string, number>, qualityScore: number, triggers: string[] }}
 */
function inferEmotionFromTextEnhanced(replyText, userText = '') {
  const delta = {
    joy: 0, sadness: 0, anger: 0, curiosity: 0, empathy: 0,
    contentment: 0, excitement: 0, surprise: 0, trust: 0, warmth: 0,
  };
  const userEmotion = { ...delta };
  const triggers = [];

  // === 莉莉安回复的情绪分析 ===
  analyzeTextEmotion(replyText, delta, triggers, 'reply');

  // === 增强2: 用户输入的情绪分析 ===
  analyzeTextEmotion(userText, userEmotion, triggers, 'user');

  // 用户情绪也会微弱地影响莉莉安（共情传染）
  const EMPATHY_TRANSFER = 0.3;
  for (const key of EMOTION_KEYS) {
    if (userEmotion[key] > 0) {
      delta[key] += userEmotion[key] * EMPATHY_TRANSFER;
    }
  }

  // === 增强3: 对话质量评分 ===
  const qualityScore = assessDialogueQuality(replyText, userText);

  // 质量分缩放情绪变化幅度（高质量对话→情绪变化更大）
  if (qualityScore > 0.6) {
    const scale = 0.8 + qualityScore * 0.4; // 0.8 ~ 1.2
    for (const key of EMOTION_KEYS) {
      delta[key] *= scale;
    }
  }

  return { delta, userEmotion, qualityScore, triggers };
}

/**
 * 分析文本中的情绪信号（增强版）
 * 改进：否定词感知、强度词、更丰富模式
 * @param {string} text
 * @param {Record<string, number>} delta - 写入目标
 * @param {string[]} triggers - 触发原因记录
 * @param {string} source - 'reply' | 'user'
 */
function analyzeTextEmotion(text, delta, triggers, source) {
  if (!text || text.length < 2) return;

  // 否定词前缀模式：如果关键词前有否定词，则反转情绪
  const negPattern = /不|没|别|勿|非|未|无|莫|休|甭/;

  /**
   * 检查关键词是否被否定
   * @param {string} keyword - 要检查的关键词
   * @param {string} fullText - 完整文本
   * @returns {boolean} 是否被否定
   */
  function isNegated(keyword, fullText) {
    const idx = fullText.indexOf(keyword);
    if (idx <= 0) return false;
    const before = fullText.slice(Math.max(0, idx - 3), idx);
    return negPattern.test(before);
  }

  /**
   * 安全地增加情绪（检查否定）
   * @param {string} keyword - 关键词
   * @param {string[]} dims - 要增加的维度
   * @param {number} amount - 增加量
   * @param {string} triggerDesc - 触发描述
   */
  function addIfNotNegated(keyword, dims, amount, triggerDesc) {
    if (text.includes(keyword)) {
      const negated = isNegated(keyword, text);
      const sign = negated ? -1 : 1;
      for (const dim of dims) {
        delta[dim] = Math.max(-1, Math.min(1, (delta[dim] || 0) + amount * sign));
      }
      if (triggerDesc) {
        triggers.push(`${source}:${negated ? '否定' : ''}${triggerDesc}`);
      }
    }
  }

  // --- 积极情绪 ---
  addIfNotNegated('开心', ['joy'], 0.1, '开心');
  addIfNotNegated('高兴', ['joy'], 0.1, '高兴');
  addIfNotNegated('哈哈', ['joy'], 0.08, '哈哈');
  addIfNotNegated('太好了', ['joy', 'excitement'], 0.1, '太好了');
  addIfNotNegated('耶', ['excitement'], 0.08, '耶');
  addIfNotNegated('棒', ['joy'], 0.08, '棒');
  addIfNotNegated('厉害', ['joy', 'surprise'], 0.08, '厉害');
  addIfNotNegated('喜欢', ['joy', 'warmth'], 0.1, '喜欢');
  addIfNotNegated('爱', ['joy', 'warmth', 'empathy'], 0.12, '爱');
  addIfNotNegated('快乐', ['joy'], 0.1, '快乐');
  addIfNotNegated('幸福', ['joy', 'contentment'], 0.1, '幸福');
  addIfNotNegated('嘿嘿', ['joy'], 0.06, '嘿嘿');
  addIfNotNegated('嘻嘻', ['joy'], 0.06, '嘻嘻');

  // --- 感谢 ---
  if (/谢谢|感谢|感恩/.test(text)) {
    delta.empathy += 0.05;
    delta.joy += 0.05;
    delta.trust += 0.03;
    triggers.push(`${source}:感谢`);
  }

  // --- 消极情绪 ---
  addIfNotNegated('难过', ['sadness'], 0.1, '难过');
  addIfNotNegated('伤心', ['sadness'], 0.1, '伤心');
  addIfNotNegated('哭', ['sadness'], 0.08, '哭');
  addIfNotNegated('委屈', ['sadness'], 0.1, '委屈');
  addIfNotNegated('心疼', ['sadness', 'empathy'], 0.08, '心疼');
  addIfNotNegated('对不起', ['sadness', 'empathy'], 0.06, '对不起');
  addIfNotNegated('抱歉', ['sadness', 'empathy'], 0.06, '抱歉');
  addIfNotNegated('不开心', ['sadness'], 0.12, '不开心');
  addIfNotNegated('悲伤', ['sadness'], 0.12, '悲伤');

  // --- 愤怒 ---
  addIfNotNegated('生气', ['anger'], 0.1, '生气');
  addIfNotNegated('讨厌', ['anger'], 0.08, '讨厌');
  addIfNotNegated('烦', ['anger'], 0.08, '烦');
  addIfNotNegated('气死', ['anger'], 0.12, '气死');
  addIfNotNegated('哼', ['anger'], 0.05, '哼');
  addIfNotNegated('愤怒', ['anger'], 0.12, '愤怒');

  // --- 认知情绪 ---
  if (/什么|为什么|怎么|如何|吗|呢|？|\?/.test(text)) {
    delta.curiosity += 0.05;
    triggers.push(`${source}:提问`);
  }
  if (/学习|知道|了解|明白|原来/.test(text)) {
    delta.curiosity += 0.05;
    triggers.push(`${source}:学习`);
  }

  // --- 社交情绪 ---
  addIfNotNegated('理解', ['empathy'], 0.08, '理解');
  addIfNotNegated('辛苦', ['empathy', 'warmth'], 0.08, '辛苦');
  addIfNotNegated('抱抱', ['empathy', 'warmth'], 0.1, '抱抱');
  addIfNotNegated('陪你', ['empathy'], 0.08, '陪你');
  addIfNotNegated('在乎', ['empathy', 'warmth'], 0.08, '在乎');
  addIfNotNegated('关心', ['empathy', 'warmth'], 0.08, '关心');
  addIfNotNegated('想你', ['empathy'], 0.08, '想你');
  addIfNotNegated('想念', ['empathy'], 0.08, '想念');

  // --- 满足 ---
  addIfNotNegated('满足', ['contentment'], 0.1, '满足');
  addIfNotNegated('舒服', ['contentment'], 0.08, '舒服');
  addIfNotNegated('惬意', ['contentment'], 0.08, '惬意');
  addIfNotNegated('安心', ['contentment', 'trust'], 0.08, '安心');
  addIfNotNegated('踏实', ['contentment', 'trust'], 0.08, '踏实');

  // --- 兴奋 ---
  addIfNotNegated('太棒了', ['excitement', 'joy'], 0.12, '太棒了');
  addIfNotNegated('兴奋', ['excitement'], 0.1, '兴奋');
  addIfNotNegated('激动', ['excitement'], 0.1, '激动');
  addIfNotNegated('超级', ['excitement'], 0.06, '超级');

  // --- 惊讶 ---
  addIfNotNegated('真的吗', ['surprise'], 0.1, '真的吗');
  addIfNotNegated('不会吧', ['surprise'], 0.1, '不会吧');
  addIfNotNegated('居然', ['surprise'], 0.1, '居然');
  addIfNotNegated('竟然', ['surprise'], 0.1, '竟然');
  if (/诶|咦|哇/.test(text)) {
    delta.surprise += 0.06;
    triggers.push(`${source}:惊讶词`);
  }

  // --- 信任 ---
  addIfNotNegated('相信', ['trust'], 0.1, '相信');
  addIfNotNegated('信任', ['trust'], 0.1, '信任');
  addIfNotNegated('当然', ['trust'], 0.06, '当然');
  addIfNotNegated('肯定', ['trust'], 0.06, '肯定');

  // --- 温暖 ---
  addIfNotNegated('温暖', ['warmth'], 0.1, '温暖');
  addIfNotNegated('温柔', ['warmth'], 0.1, '温柔');
  addIfNotNegated('贴心', ['warmth'], 0.08, '贴心');
  addIfNotNegated('暖心', ['warmth'], 0.08, '暖心');
  addIfNotNegated('感动', ['warmth', 'empathy'], 0.08, '感动');
  addIfNotNegated('温馨', ['warmth', 'contentment'], 0.08, '温馨');

  // --- 强度词放大 ---
  if (/非常|特别|超级|太|好|超|巨|极其|万分/.test(text)) {
    // 有强度词时，当前最大变化维度额外放大 30%
    const maxDim = Object.entries(delta).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    if (maxDim[0] && Math.abs(maxDim[0][1]) > 0) {
      delta[maxDim[0][0]] *= 1.3;
      triggers.push(`${source}:强度放大`);
    }
  }

  // --- 长文本认知投入 ---
  if (text.length > 100) {
    delta.curiosity += 0.03;
    delta.empathy += 0.02;
  }
}

/**
 * 增强3: 对话质量评分
 * 基于多个维度评估对话质量，返回 0~1 分数
 * @param {string} replyText
 * @param {string} userText
 * @returns {number} 0~1
 */
function assessDialogueQuality(replyText, userText) {
  let score = 0.5; // 基准分

  const replyLen = (replyText || '').length;
  const userLen = (userText || '').length;

  // 1. 用户参与度（用户输入越长→越投入）
  if (userLen > 50) score += 0.1;
  if (userLen > 100) score += 0.1;

  // 2. 回复丰富度（回复越长→对话越深入）
  if (replyLen > 30) score += 0.05;
  if (replyLen > 80) score += 0.05;

  // 3. 情感词汇密度（有情感词→对话有情感投入）
  const emotionWords = /开心|难过|生气|喜欢|爱|想|心疼|感动|幸福|委屈|期待|担心/;
  if (emotionWords.test(userText)) score += 0.1;
  if (emotionWords.test(replyText)) score += 0.05;

  // 4. 提问-回答模式（有问有答→互动质量高）
  if (/[？?]/.test(userText) && replyLen > 10) score += 0.05;

  // 5. 称呼/亲密词（关系亲密→对话质量高）
  if (/你|亲爱的|宝贝|笨蛋|傻瓜/.test(replyText)) score += 0.05;

  return Math.max(0, Math.min(1, score));
}

/**
 * 分析用户情绪状态（增强2）
 * @param {string} userText
 * @returns {{ dominant: string, value: number, vector: Record<string, number> }}
 */
function analyzeUserEmotion(userText) {
  const delta = {
    joy: 0, sadness: 0, anger: 0, curiosity: 0, empathy: 0,
    contentment: 0, excitement: 0, surprise: 0, trust: 0, warmth: 0,
  };
  const triggers = [];
  analyzeTextEmotion(userText, delta, triggers, 'user-analysis');

  const dominant = Object.entries(delta).sort((a, b) => b[1] - a[1])[0];

  return {
    dominant: dominant[0],
    value: dominant[1],
    vector: delta,
    triggers,
  };
}

// ============================================================
// 向后兼容的推断函数
// ============================================================

/**
 * 从回复文本推断情绪信号（向后兼容接口）
 * 内部使用增强版推断
 * @param {string} replyText
 * @param {string} userText
 * @returns {Record<string, number>}
 */
function inferEmotionFromText(replyText, userText = '') {
  const { delta } = inferEmotionFromTextEnhanced(replyText, userText);
  return delta;
}

// ============================================================
// 核心函数
// ============================================================

/**
 * 获取当前情绪向量
 * @param {DatabaseSync} db
 * @returns {Record<string, number>}
 */
function getEmotionVector(db) {
  const rows = db.prepare(`SELECT dimension, baseline FROM emotion_baseline`).all();
  const vector = { ...EMOTION_DIMENSIONS };
  for (const row of rows) {
    if (EMOTION_KEYS.includes(row.dimension)) {
      vector[row.dimension] = row.baseline;
    }
  }
  return vector;
}

/**
 * 时间衰减公式
 * E(t) = Baseline + (E_prev - Baseline) * e^(-lambda * hoursElapsed)
 * @param {number} growthStage - 成长阶段（可选，用于动态参数）
 */
function emotionDecay(current, baseline, lambda = DECAY_LAMBDA, hoursElapsed = 0, growthStage) {
  if (hoursElapsed <= 0) return current;
  const effectiveLambda = growthStage ? getStageParams(growthStage).decayLambda : lambda;
  return baseline + (current - baseline) * Math.exp(-effectiveLambda * hoursElapsed);
}

/**
 * 基线漂移
 * @param {number} growthStage - 成长阶段（可选，用于动态参数）
 */
function baselineDrift(baseline, current, driftRate = DRIFT_RATE, growthStage) {
  const effectiveRate = growthStage ? getStageParams(growthStage).driftRate : driftRate;
  return baseline + (current - baseline) * effectiveRate;
}

/**
 * 获取主导情绪
 * @param {Record<string, number>} vector
 * @returns {{ dimension: string, value: number }}
 */
function getDominantEmotion(vector) {
  let maxDim = 'joy';
  let maxVal = -Infinity;
  for (const [dim, val] of Object.entries(vector)) {
    if (val > maxVal) {
      maxVal = val;
      maxDim = dim;
    }
  }
  return { dimension: maxDim, value: maxVal };
}

/**
 * 增强5: 获取混合情绪（Top-2）
 * @param {Record<string, number>} vector
 * @returns {{ primary: { dimension: string, value: number }, secondary: { dimension: string, value: number } | null }}
 */
function getMixedEmotion(vector) {
  const sorted = Object.entries(vector)
    .sort((a, b) => b[1] - a[1]);

  const primary = { dimension: sorted[0][0], value: sorted[0][1] };
  const secondary = sorted[1] && sorted[1][1] > 0.3
    ? { dimension: sorted[1][0], value: sorted[1][1] }
    : null;

  return { primary, secondary };
}

/**
 * 增强5: 混合情绪文字语气
 * @param {Record<string, number>} vector
 * @param {object} [personalityDims] - 性格维度
 * @returns {string}
 */
function buildTextTonePrompt(vector, personalityDims) {
  const { primary, secondary } = getMixedEmotion(vector);
  const parts = [];

  // 主导情绪语气
  const primaryHints = EMOTION_TONE_HINTS[primary.dimension];
  if (primaryHints) {
    let level;
    if (primary.value > 0.7) level = 'high';
    else if (primary.value > 0.4) level = 'mid';
    else level = 'low';
    const hint = primaryHints[level];
    if (hint && level !== 'low') parts.push(hint);
  }

  // 次要情绪语气（如果强度足够）
  if (secondary && secondary.value > 0.45) {
    const secondaryHints = EMOTION_TONE_HINTS[secondary.dimension];
    if (secondaryHints) {
      const hint = secondaryHints.mid;
      if (hint) parts.push(`同时略带${EMOTION_LABEL_CN[secondary.dimension] || secondary.dimension}感`);
    }
  }

  // 增强8: 性格缩放
  const toneScale = getPersonalityToneScale(personalityDims);
  if (toneScale > 1.1 && parts.length > 0) {
    parts[0] = parts[0].replace('语气', '语气更加');
  } else if (toneScale < 0.9 && parts.length > 0) {
    parts[0] = parts[0].replace('非常', '').replace('特别', '');
  }

  return parts.join('；') || '';
}

/**
 * 增强6+8: 选择表情包（去重 + 性格偏好）
 * @param {Record<string, number>} vector
 * @param {object} [personalityDims] - 性格维度
 * @param {string} [scene] - 场景标签（可选）
 * @returns {string|null}
 */
function selectSticker(vector, personalityDims, scene) {
  const { primary } = getMixedEmotion(vector);
  let candidates = EMOTION_TO_STICKER[primary.dimension];
  if (!candidates || candidates.length === 0) return null;

  // 增强8: 性格贴纸偏好排序
  if (personalityDims) {
    candidates = applyPersonalityStickerBias(candidates, primary.dimension, personalityDims);
  }

  // 增强6: 去重——优先选择最近没用过的
  const fresh = candidates.filter(s => !recentStickers.includes(s));
  const pool = fresh.length > 0 ? fresh : candidates; // 全用过了就回退

  const selected = pool[Math.floor(Math.random() * pool.length)];
  recordStickerUsed(selected);
  return selected;
}

/**
 * 增强8: 选择 Live2D 表情（性格修饰）
 * @param {Record<string, number>} vector
 * @param {object} [personalityDims] - 性格维度
 * @returns {string}
 */
function selectExpression(vector, personalityDims) {
  const { primary } = getMixedEmotion(vector);
  let expression = EMOTION_TO_EXPRESSION[primary.dimension] || '记笔记';

  // 增强8: 性格可能覆盖表情
  if (personalityDims) {
    expression = applyPersonalityExpression(expression, primary.dimension, personalityDims);
  }

  return expression;
}

/**
 * 获取情绪输出汇总（增强版）
 * @param {Record<string, number>} vector
 * @param {object} [personalityDims] - 性格维度
 * @returns {{ textTone: string, sticker: string|null, live2d: string, mixedEmotion: object }}
 */
function getEmotionOutputs(vector, personalityDims) {
  const mixed = getMixedEmotion(vector);
  return {
    textTone: buildTextTonePrompt(vector, personalityDims),
    sticker: selectSticker(vector, personalityDims),
    live2d: selectExpression(vector, personalityDims),
    mixedEmotion: mixed,
  };
}

// ============================================================
// 情绪联锁机制
// ============================================================

/**
 * 情绪联锁机制
 * @param {Record<string, number>} vector
 * @returns {Record<string, number>}
 */
function applyInterlocks(vector) {
  const adjusted = { ...vector };

  // 1. 高愤怒 → 降低共情、温暖、信任
  if (adjusted.anger > 0.6) {
    const dampen = (adjusted.anger - 0.6) * 0.5;
    adjusted.empathy = Math.max(0, adjusted.empathy - dampen);
    adjusted.warmth = Math.max(0, adjusted.warmth - dampen);
    adjusted.trust = Math.max(0, adjusted.trust - dampen);
  }

  // 2. 高悲伤 → 降低兴奋、喜悦，增强共情
  if (adjusted.sadness > 0.6) {
    const dampen = (adjusted.sadness - 0.6) * 0.3;
    adjusted.excitement = Math.max(0, adjusted.excitement - dampen);
    adjusted.joy = Math.max(0, adjusted.joy - dampen);
    adjusted.empathy = Math.min(1, adjusted.empathy + dampen * 0.5);
  }

  // 3. 高喜悦 → 增强温暖、信任
  if (adjusted.joy > 0.6) {
    const boost = (adjusted.joy - 0.6) * 0.3;
    adjusted.warmth = Math.min(1, adjusted.warmth + boost);
    adjusted.trust = Math.min(1, adjusted.trust + boost);
  }

  // 4. 高共情 → 增强温暖
  if (adjusted.empathy > 0.6) {
    const boost = (adjusted.empathy - 0.6) * 0.2;
    adjusted.warmth = Math.min(1, adjusted.warmth + boost);
  }

  // 5. 高好奇 → 增强惊讶
  if (adjusted.curiosity > 0.6) {
    const boost = (adjusted.curiosity - 0.6) * 0.2;
    adjusted.surprise = Math.min(1, adjusted.surprise + boost);
  }

  // 6. 高兴奋 → 降低满足（兴奋是高能量，满足是低能量）
  if (adjusted.excitement > 0.6) {
    const dampen = (adjusted.excitement - 0.6) * 0.2;
    adjusted.contentment = Math.max(0, adjusted.contentment - dampen);
  }

  // 7. 高满足 → 降低兴奋
  if (adjusted.contentment > 0.6) {
    const dampen = (adjusted.contentment - 0.6) * 0.2;
    adjusted.excitement = Math.max(0, adjusted.excitement - dampen);
  }

  return adjusted;
}

// ============================================================
// 主更新函数
// ============================================================

/**
 * 更新情绪基线（增强版，带联锁 + 性格 + 成长阶段）
 * @param {DatabaseSync} db
 * @param {object} params
 * @param {string} params.replyText
 * @param {string} [params.userText]
 * @param {number} [params.hoursSinceLastUpdate]
 * @param {string} [params.growthStage] - 成长阶段
 * @param {object} [params.personalityDims] - 性格维度
 * @param {string} [params.triggerType] - 触发类型
 * @param {string} [params.triggerDetail] - 触发详情
 * @returns {{ vector: Record<string, number>, outputs: object, userEmotion: object, qualityScore: number, triggers: string[] }}
 */
function updateEmotionBaselineWithInterlocks(db, params) {
  const {
    replyText = '',
    userText = '',
    hoursSinceLastUpdate = 0,
    growthStage = 'child',
    personalityDims = null,
    triggerType = 'dialogue',
    triggerDetail = '',
  } = typeof params === 'string'
    ? { replyText: arguments[1], userText: arguments[2] || '', hoursSinceLastUpdate: arguments[3] || 0 }
    : params;

  const now = Date.now();
  const rows = db.prepare(`SELECT dimension, baseline, last_updated FROM emotion_baseline`).all();

  // 记录变化前的情绪
  const emotionBefore = {};
  for (const row of rows) {
    if (EMOTION_KEYS.includes(row.dimension)) {
      emotionBefore[row.dimension] = row.baseline;
    }
  }

  // 增强1: 使用增强版推断
  const { delta, userEmotion, qualityScore, triggers } = inferEmotionFromTextEnhanced(replyText, userText);

  // 增强8: 应用性格对情绪变化的影响
  let personalityAdjustedDelta = delta;
  if (personalityDims) {
    // 性格影响情绪变化幅度（如高共情型对共情信号更敏感）
    if (personalityDims.empathyDepth > 0.65) {
      delta.empathy *= 1.2;
      delta.warmth *= 1.1;
    }
    if (personalityDims.rationality > 0.65) {
      delta.curiosity *= 1.15;
      delta.anger *= 0.85; // 理性型不容易生气
    }
    if (personalityDims.humor > 0.65) {
      delta.joy *= 1.1;
      delta.surprise *= 1.15;
    }
    if (personalityDims.shyness > 0.65) {
      delta.joy *= 0.9; // 害羞型开心表达略收敛
      delta.empathy *= 1.1;
    }
  }

  // 增强4: 成长阶段感知的参数
  const stageParams = getStageParams(growthStage);

  // 计算更新后的情绪
  const rawVector = {};
  for (const row of rows) {
    if (!EMOTION_KEYS.includes(row.dimension)) continue;

    let baseline = row.baseline;

    // 增强4: 成长阶段感知的时间衰减
    if (hoursSinceLastUpdate > 0.5 && !pauseDecayOnline) {
      const defaultBaseline = EMOTION_DIMENSIONS[row.dimension] || 0.5;
      baseline = emotionDecay(baseline, defaultBaseline, stageParams.decayLambda, hoursSinceLastUpdate, growthStage);
    }

    // 增强4: 成长阶段感知的敏感度（新生儿变化更大）
    const sensitivityScaledDelta = (personalityAdjustedDelta[row.dimension] || 0) * stageParams.sensitivity;

    const currentSignal = Math.max(0, Math.min(1, baseline + sensitivityScaledDelta));
    const newBaseline = baselineDrift(baseline, currentSignal, stageParams.driftRate, growthStage);
    rawVector[row.dimension] = Math.max(0, Math.min(1, newBaseline));
  }

  // 应用联锁机制
  const adjustedVector = applyInterlocks(rawVector);

  // 增强8: 应用性格修饰到最终情绪向量（用于输出）
  const outputVector = personalityDims
    ? applyPersonalityToEmotion(adjustedVector, personalityDims)
    : adjustedVector;

  // 写入数据库
  for (const row of rows) {
    if (!EMOTION_KEYS.includes(row.dimension)) continue;
    const clamped = adjustedVector[row.dimension] || row.baseline;

    db.prepare(`
      UPDATE emotion_baseline
      SET baseline = ?,
          drift_count = drift_count + 1,
          last_drift_at = ?,
          last_updated = ?
      WHERE dimension = ?
    `).run(clamped, now, now, row.dimension);
  }

  // 增强7: 记录情绪事件
  logEmotionEvent(db, {
    triggerType,
    triggerDetail: triggerDetail || triggers.join(', '),
    emotionBefore,
    emotionAfter: adjustedVector,
    userText,
    replyText,
    qualityScore,
    growthStage,
  });

  // 获取增强版输出
  const outputs = getEmotionOutputs(outputVector, personalityDims);

  return {
    vector: adjustedVector,
    outputVector,
    outputs,
    userEmotion,
    qualityScore,
    triggers,
  };
}

/**
 * 重置情绪向量到默认值
 * @param {DatabaseSync} db
 */
function resetEmotionVector(db) {
  const now = Date.now();
  for (const [dim, val] of Object.entries(EMOTION_DIMENSIONS)) {
    db.prepare(`
      UPDATE emotion_baseline SET baseline = ?, last_updated = ? WHERE dimension = ?
    `).run(val, now, dim);
  }
}

/**
 * 向后兼容：更新情绪基线（不带联锁）
 */
function updateEmotionBaseline(db, replyText, userText = '', hoursSinceLastUpdate = 0) {
  return updateEmotionBaselineWithInterlocks(db, {
    replyText,
    userText,
    hoursSinceLastUpdate,
  }).vector;
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  // 常量
  EMOTION_DIMENSIONS,
  EMOTION_KEYS,
  DECAY_LAMBDA,
  DRIFT_RATE,
  EMOTION_TO_EXPRESSION,
  EMOTION_TO_STICKER,
  EMOTION_LABEL_CN,
  GROWTH_STAGE_PARAMS,

  // 核心函数
  getEmotionVector,
  emotionDecay,
  baselineDrift,
  getDominantEmotion,
  getMixedEmotion,
  applyInterlocks,

  // 推断函数
  inferEmotionFromText,           // 向后兼容
  inferEmotionFromTextEnhanced,   // 增强版
  analyzeUserEmotion,             // 增强2: 用户情绪分析
  assessDialogueQuality,          // 增强3: 对话质量评分

  // 更新函数
  updateEmotionBaseline,                // 向后兼容
  updateEmotionBaselineWithInterlocks,  // 增强版
  resetEmotionVector,

  // 输出函数
  buildTextTonePrompt,   // 增强5: 混合情绪 + 性格
  selectSticker,         // 增强6+8: 去重 + 性格
  recordStickerUsed,
  getRecentStickers,
  selectExpression,      // 增强8: 性格修饰
  getEmotionOutputs,     // 增强版汇总

  // 增强4: 成长阶段参数
  getStageParams,

  // 增强7: 情绪事件记忆
  logEmotionEvent,
  getRecentEmotionEvents,
  getEmotionEventSummary,

  // 增强8: 性格绑定
  applyPersonalityToEmotion,
  applyPersonalityStickerBias,
  applyPersonalityExpression,
  getPersonalityToneScale,

  // v7.3: 在线态衰减暂停
  setPauseDecayOnline,
};
