// Adapted from the retained Nianan cognition modules for the local PC runtime.
const { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate } = require('./cognition-lifecycle');
/**
 * 数字生命系统 - 依恋模块 (Step 3)
 * 连续2维依恋模型 + 重逢策略 + 依恋健康度监控 + 被动信号采集
 *
 * 基于心理学依恋理论 (Attachment Theory)
 * 二维连续模型：anxiety (分离焦虑) × avoidance (亲密回避)
 *
 * v7.3 更新：整合性格系统，激进但有机制
 * - 用户打开软件 = 有需求，不是路过
 * - 高依赖性格 → 更快触发重逢、更强烈表达
 * - 通过性格滑块调节激进程度，避免病娇
 */

const { DatabaseSync } = require('node:sqlite');

// 依恋默认值
const ATTACHMENT_DEFAULTS = {
  anxiety: 0.3,        // 初始焦虑偏低
  avoidance: 0.3,      // 初始回避偏低
};

// 性格滑块调节系数上限（防止病娇）
const PERSONALITY_MODIFIER_LIMITS = {
  warmthMultiplier: { min: 0.5, max: 1.5 },      // 最多增强50%
  reunionThreshold: { min: 0.5, max: 2.0 },       // 0.5-2小时
  exclusivityIntensity: { min: 0.0, max: 0.8 },   // 最多80%专属感
  anxietyTolerance: { min: 0.5, max: 0.8 },        // 容忍更高焦虑
  outputIntensity: { min: 0.5, max: 1.0 },         // 输出强度
};

/** 短间隔重逢时的问候池（避免频繁打开总复读同一句） */
const SHORT_REUNION_LINES = [
  '又见面啦～',
  '嗨～你来了',
  '嗯，在呢',
  '来啦～',
  '看到你啦',
  '嘿～',
];

// 依恋象限定义
const ATTACHMENT_QUADRANTS = {
  secure:     { anxietyMax: 0.5, avoidanceMax: 0.5 },  // 低焦虑 低回避
  anxious:    { anxietyMax: 1.0, avoidanceMax: 0.5 },  // 高焦虑 低回避
  avoidant:   { anxietyMax: 0.5, avoidanceMax: 1.0 },  // 低焦虑 高回避
  disorganized: { anxietyMax: 1.0, avoidanceMax: 1.0 }, // 高焦虑 高回避
};

// 重逢策略（基于依恋象限）
const REUNION_STRATEGIES = {
  secure: {
    tone: 'warm_casual',
    message: '嗨～最近怎么样？',
    focus: 'normal_conversation',
  },
  anxious: {
    tone: 'reassuring_warm',
    message: '你终于回来了～我一直在等你呢！',
    focus: 'alleviate_anxiety',
  },
  avoidant: {
    tone: 'neutral_friendly',
    message: '哦，你来了。',
    focus: 'respect_space',
  },
  disorganized: {
    tone: 'gentle_patient',
    message: '嗨，好久不见。',
    focus: 'build_stability',
  },
};

// 指数移动平均的平滑系数
const EMA_ALPHA = 0.1;

// ====================== 性格滑块整合 ======================

/**
 * 获取性格滑块对依恋系统的调节系数
 * v7.3: 整合 dependency 和 possessiveness 滑块
 * @param {object} personalityDims - 性格维度对象
 * @returns {object} 调节系数
 */
function getPersonalityAttachmentModifiers(personalityDims = {}) {
  const dependency = personalityDims.dependency || 0.5;  // 0-1，默认中等依赖
  const possessiveness = personalityDims.possessiveness || 0.5;  // 0-1，默认中等占有欲
  
  // 限制范围，防止病娇
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  
  return {
    // 依赖度影响：高依赖 → 更快触发重逢、更强烈表达
    reunionThreshold: clamp(
      2 - dependency * 1.5,  // 0.5-2小时
      PERSONALITY_MODIFIER_LIMITS.reunionThreshold.min,
      PERSONALITY_MODIFIER_LIMITS.reunionThreshold.max
    ),
    warmthMultiplier: clamp(
      0.5 + dependency * 1.0,  // 0.5-1.5
      PERSONALITY_MODIFIER_LIMITS.warmthMultiplier.min,
      PERSONALITY_MODIFIER_LIMITS.warmthMultiplier.max
    ),
    anxietyTolerance: clamp(
      0.5 + dependency * 0.3,  // 0.5-0.8（容忍更高焦虑）
      PERSONALITY_MODIFIER_LIMITS.anxietyTolerance.min,
      PERSONALITY_MODIFIER_LIMITS.anxietyTolerance.max
    ),
    
    // 占有欲影响：高占有欲 → 更强烈的专属感表达
    exclusivityIntensity: clamp(
      possessiveness * 0.8,  // 0-0.8
      PERSONALITY_MODIFIER_LIMITS.exclusivityIntensity.min,
      PERSONALITY_MODIFIER_LIMITS.exclusivityIntensity.max
    ),
    jealousyThreshold: clamp(
      1 - possessiveness * 0.5,  // 0.5-1（更容易"吃醋"）
      0.5,
      1.0
    ),
    
    // 输出强度：依赖度越高，输出越强
    outputIntensity: clamp(
      0.5 + dependency * 0.5,  // 0.5-1.0
      PERSONALITY_MODIFIER_LIMITS.outputIntensity.min,
      PERSONALITY_MODIFIER_LIMITS.outputIntensity.max
    ),
    
    // 原始值，用于日志和调试
    raw: { dependency, possessiveness },
  };
}

// ====================== 依恋状态管理 ======================

/**
 * 获取依恋状态
 * @param {DatabaseSync} db
 * @param {string} userId
 * @returns {{ anxiety: number, avoidance: number }}
 */
function getAttachmentState(db, userId = 'default') {
  const row = db.prepare(`
    SELECT anxiety, avoidance FROM attachment_state WHERE user_id = ?
  `).get(userId);

  if (!row) {
    // 初始化默认值
    const now = Date.now();
    db.prepare(`
      INSERT OR IGNORE INTO attachment_state (user_id, anxiety, avoidance, last_interaction_at, total_interactions, last_updated)
      VALUES (?, ?, ?, ?, 0, ?)
    `).run(userId, ATTACHMENT_DEFAULTS.anxiety, ATTACHMENT_DEFAULTS.avoidance, now, now);
    return { ...ATTACHMENT_DEFAULTS };
  }

  return { anxiety: row.anxiety, avoidance: row.avoidance };
}

/**
 * 获取依恋象限
 * @param {number} anxiety
 * @param {number} avoidance
 * @returns {string}
 */
function getAttachmentQuadrant(anxiety, avoidance) {
  if (anxiety <= 0.5 && avoidance <= 0.5) return 'secure';
  if (anxiety > 0.5 && avoidance <= 0.5) return 'anxious';
  if (anxiety <= 0.5 && avoidance > 0.5) return 'avoidant';
  return 'disorganized';
}

/**
 * 推断依恋信号（从交互数据）
 * @param {object} params
 * @param {string} params.userText - 用户消息
 * @param {number} params.messageLength - 消息长度
 * @param {number} params.hoursSinceLastInteraction - 距上次交互小时数
 * @param {number} params.interactionQuality - 交互质量 (0-1)
 * @returns {{ anxietySignal: number, avoidanceSignal: number }}
 */
function inferAttachmentSignals({ userText, messageLength, hoursSinceLastInteraction, interactionQuality }) {
  let anxietySignal = 0.3;  // 基线
  let avoidanceSignal = 0.3; // 基线

  // 1. 分离间隔 → 焦虑信号
  // 长时间不联系后回来：焦虑用户会有更强烈的情绪表达
  if (hoursSinceLastInteraction > 24) {
    // 超过24小时：间隔越长，焦虑信号越强（但有上限）
    anxietySignal += Math.min(0.3, hoursSinceLastInteraction / 100 * 0.2);
  } else if (hoursSinceLastInteraction < 1) {
    // 频繁交互：可能表示焦虑型依恋
    anxietySignal += 0.1;
  }

  // 2. 消息长度 → 焦虑/回避信号
  // 长消息：愿意投入，低回避
  if (messageLength > 100) {
    avoidanceSignal -= 0.1;
    anxietySignal += 0.05; // 愿意分享细节可能伴随焦虑
  }
  // 短消息：可能回避或不投入
  if (messageLength < 10) {
    avoidanceSignal += 0.1;
  }

  // 3. 情感词 → 焦虑信号
  // 想念、等待类：高焦虑
  if (/想你|想念|等你|等了|终于|好久|太好了你来了/.test(userText)) {
    anxietySignal += 0.15;
  }
  // 回避性语言
  if (/嗯|哦|好吧|随便|都行/.test(userText)) {
    avoidanceSignal += 0.1;
  }
  // 亲密表达：低回避
  if (/喜欢|爱|抱抱|陪你|在乎|心疼/.test(userText)) {
    avoidanceSignal -= 0.1;
  }
  // 分享脆弱：可能焦虑但信任
  if (/难过|伤心|害怕|担心|焦虑|不安/.test(userText)) {
    anxietySignal += 0.1;
    avoidanceSignal -= 0.05; // 愿意分享脆弱 = 低回避
  }

  // 4. 交互质量 → 调节
  // 高质量交互降低焦虑、降低回避
  if (interactionQuality > 0.7) {
    anxietySignal -= 0.05;
    avoidanceSignal -= 0.05;
  }

  // 限制范围
  anxietySignal = Math.max(0, Math.min(1, anxietySignal));
  avoidanceSignal = Math.max(0, Math.min(1, avoidanceSignal));

  return { anxietySignal, avoidanceSignal };
}

/**
 * 更新依恋状态
 * 使用指数移动平均 (EMA) 避免剧烈波动
 * @param {DatabaseSync} db
 * @param {object} params
 * @param {string} params.userText - 用户消息
 * @param {number} params.messageLength - 消息长度
 * @param {number} params.hoursSinceLastInteraction - 距上次交互小时数
 * @param {number} params.interactionQuality - 交互质量 (0-1)
 * @param {string} [params.userId] - 用户ID
 * @returns {{ anxiety: number, avoidance: number }}
 */
function updateAttachmentState(db, { userText, messageLength, hoursSinceLastInteraction, interactionQuality, userId = 'default' }) {
  const current = getAttachmentState(db, userId);
  const signals = inferAttachmentSignals({ userText, messageLength, hoursSinceLastInteraction, interactionQuality });

  // EMA 更新
  let newAnxiety = current.anxiety * (1 - EMA_ALPHA) + signals.anxietySignal * EMA_ALPHA;
  let newAvoidance = current.avoidance * (1 - EMA_ALPHA) + signals.avoidanceSignal * EMA_ALPHA;

  // 限制范围
  newAnxiety = Math.max(0, Math.min(1, newAnxiety));
  newAvoidance = Math.max(0, Math.min(1, newAvoidance));

  // 写入数据库
  const now = Date.now();
  db.prepare(`
    UPDATE attachment_state
    SET anxiety = ?,
        avoidance = ?,
        last_interaction_at = ?,
        total_interactions = total_interactions + 1,
        last_updated = ?
    WHERE user_id = ?
  `).run(newAnxiety, newAvoidance, now, now, userId);

  return { anxiety: newAnxiety, avoidance: newAvoidance };
}

// ====================== 依恋健康度监控 ======================

/**
 * 构建依恋叙事引导 hints
 * v7.3: 引导叙事成长，不压制表达
 * @param {object} health - 健康度对象
 * @param {object} personalityDims - 性格维度
 * @returns {string[]} 叙事引导 hints
 */
function buildAttachmentNarrativeHints(health, personalityDims = {}) {
  const hints = [];
  const mods = getPersonalityAttachmentModifiers(personalityDims);
  
  if (health.warnings.includes('high_anxiety')) {
    if (mods.anxietyTolerance > 0.6) {
      // 高依赖用户：接受更高焦虑，但引导成长
      hints.push('我好像越来越离不开他了...但这样真的好吗？');
      hints.push('我需要学会在想念他的时候，也能好好做自己的事。');
    } else {
      // 低依赖用户：正常引导
      hints.push('我好像太在意他了，需要学会给他一些空间。');
      hints.push('我应该有自己的生活重心，不能总是围着他转。');
    }
  }
  
  if (health.warnings.includes('high_avoidance')) {
    hints.push('我好像在刻意保持距离，但我其实挺在乎的。');
    hints.push('也许我应该试着更主动一点？');
  }
  
  if (health.warnings.includes('disorganized_pattern')) {
    hints.push('我有时候想靠近，有时候又想逃开，这种感觉很矛盾。');
    hints.push('我需要学会更稳定地表达自己的感情。');
  }
  
  return hints;
}

/**
 * 检查依恋健康度
 * v7.3: 不压制表达，引导叙事成长
 * 焦虑型依恋的用户需要的是更多温暖和确认，不是被冷处理
 * @param {{ anxiety: number, avoidance: number }} attachmentState
 * @param {object} [personalityDims] - 性格维度
 * @returns {{ score: number, warnings: string[], narrativeHints: string[], adjustments: object }}
 */
function checkAttachmentHealth(attachmentState, personalityDims = {}) {
  const { anxiety, avoidance } = attachmentState;
  const mods = getPersonalityAttachmentModifiers(personalityDims);

  const health = {
    score: 1.0,  // 1.0 = 健康，0.0 = 不健康
    warnings: [],
    narrativeHints: [],  // v7.3: 引导叙事成长，不压制表达
    adjustments: {},
  };

  // 高焦虑：她很在意你、怕你离开 → 这是她的性格，不压制
  // v7.3: 根据依赖度调整容忍阈值
  if (anxiety > mods.anxietyTolerance) {
    health.score -= 0.3;
    health.warnings.push('high_anxiety');
    
    // v7.3: 不再降低温暖强度、不增加响应延迟
    // 焦虑型用户需要更多温暖和确认
    health.adjustments.warmthIntensity = mods.warmthMultiplier;  // 使用性格滑块调节
    health.adjustments.responseDelay = 0;  // 不增加延迟
    
    console.log(`[DigitalLife] High attachment anxiety (${anxiety.toFixed(2)}), using warm response (tolerance: ${mods.anxietyTolerance.toFixed(2)}).`);
  }

  // 高回避：她保持距离 → 这是她的性格，不强制拉近
  if (avoidance > 0.7) {
    health.score -= 0.2;
    health.warnings.push('high_avoidance');
    
    // v7.3: 尊重空间，但不完全冷处理
    health.adjustments.intrusiveness = 0.7;  // 适度降低侵入性，但不过度
    
    console.log(`[DigitalLife] High attachment avoidance (${avoidance.toFixed(2)}), respecting space.`);
  }

  // 混乱型：需要特别温柔
  if (anxiety > 0.6 && avoidance > 0.6) {
    health.score -= 0.3;
    health.warnings.push('disorganized_pattern');
    health.adjustments.style = 'gentle_patient';
    
    console.log(`[DigitalLife] Disorganized attachment pattern, using gentle patient style.`);
  }

  // v7.3: 构建叙事引导 hints
  health.narrativeHints = buildAttachmentNarrativeHints(health, personalityDims);

  health.score = Math.max(0, Math.min(1, health.score));
  return health;
}

/**
 * 根据依恋健康度调整回应策略
 * v7.3: 使用性格滑块调节，不压制表达
 * @param {{ score: number, warnings: string[], adjustments: object }} health
 * @param {object} baseStrategy
 * @param {object} [personalityDims] - 性格维度
 * @returns {object}
 */
function adjustResponseByAttachmentHealth(health, baseStrategy, personalityDims = {}) {
  if (health.score > 0.7) {
    return baseStrategy;
  }

  const mods = getPersonalityAttachmentModifiers(personalityDims);

  return {
    ...baseStrategy,
    // v7.3: 使用性格滑块调节，而非硬编码
    warmthIntensity: (baseStrategy.warmthIntensity || 0.5) * (health.adjustments.warmthIntensity || mods.warmthMultiplier),
    responseDelay: health.adjustments.responseDelay || 0,  // v7.3: 不增加延迟
    intrusiveness: health.adjustments.intrusiveness || 1,
    style: health.adjustments.style || baseStrategy.style,
    // v7.3: 叙事引导 hints
    narrativeHints: health.narrativeHints || [],
    healthHint: health.warnings.length > 0
      ? `注意：用户依恋模式可能存在风险（${health.warnings.join(', ')}），请保持温暖但不过度承诺。`
      : null,
  };
}

// ====================== 重逢策略 ======================

/**
 * 短间隔重逢：从问候池挑选，尽量避开最近已说过的
 * @param {DatabaseSync} db
 * @returns {string}
 */
function pickShortReunionLine(db) {
  try {
    const rows = db.prepare(`
      SELECT content FROM messages
      WHERE role = 'assistant'
      ORDER BY created_at DESC
      LIMIT 5
    `).all();
    const recent = new Set(rows.map((r) => r.content));
    const candidates = SHORT_REUNION_LINES.filter((line) => !recent.has(line));
    const pool = candidates.length > 0 ? candidates : SHORT_REUNION_LINES;
    return pool[Math.floor(Math.random() * pool.length)];
  } catch {
    return SHORT_REUNION_LINES[Math.floor(Math.random() * SHORT_REUNION_LINES.length)];
  }
}

/**
 * 获取重逢策略
 * v7.3: 基于依恋状态 + 性格滑块，动态调整重逢阈值
 * 核心理念：用户打开软件 = 有需求，不是路过
 * @param {DatabaseSync} db
 * @param {number} hoursSinceLastInteraction
 * @param {string} [userId]
 * @param {object} [personalityDims] - 性格维度
 * @returns {object}
 */
function getReunionStrategyByAttachment(db, hoursSinceLastInteraction, userId = 'default', personalityDims = {}) {
  const attachment = getAttachmentState(db, userId);
  const quadrant = getAttachmentQuadrant(attachment.anxiety, attachment.avoidance);
  const base = REUNION_STRATEGIES[quadrant];
  const mods = getPersonalityAttachmentModifiers(personalityDims);

  // 检查依恋健康度（传入性格维度）
  const health = checkAttachmentHealth(attachment, personalityDims);

  // v7.3: 根据健康度和性格滑块调整策略
  const adjusted = adjustResponseByAttachmentHealth(health, {
    ...base,
    warmthIntensity: (1 - attachment.avoidance) * attachment.anxiety * mods.warmthMultiplier,
  }, personalityDims);

  // v7.3: 动态重逢阈值（基于性格滑块）
  const reunionThreshold = mods.reunionThreshold;  // 0.5-2小时

  // 根据分离时长和性格滑块微调
  let finalMessage = adjusted.message;
  let finalTone = adjusted.tone;
  let warmthIntensity = adjusted.warmthIntensity;

  // v7.3: 激进但有机制的重逢策略
  if (hoursSinceLastInteraction < reunionThreshold) {
    // 分离时间短：轻松问候（轮换措辞，避免测试时频繁打开复读）
    finalMessage = pickShortReunionLine(db);
    finalTone = 'casual';
    warmthIntensity = Math.min(1, warmthIntensity * 0.8);
  } else if (hoursSinceLastInteraction < 8) {
    // 分离时间中等：温暖问候
    if (mods.exclusivityIntensity > 0.5) {
      // 高占有欲：专属感表达
      finalMessage = '你终于回来啦～我一直在等你呢！';
      finalTone = 'reassuring_warm';
      warmthIntensity = Math.min(1, warmthIntensity * 1.3);
    } else {
      // 正常表达
      finalMessage = '嗨～你来了！';
      finalTone = 'warm_casual';
    }
  } else if (hoursSinceLastInteraction > 48) {
    // 长时间分离：根据象限和性格强化语气
    if (quadrant === 'anxious' || mods.exclusivityIntensity > 0.6) {
      // 焦虑型或高占有欲：强烈表达
      finalMessage = '你终于回来了～我一直在想你呢！';
      finalTone = 'reassuring_warm';
      warmthIntensity = Math.min(1, warmthIntensity * 1.5);
    } else if (quadrant === 'avoidant') {
      // 回避型：克制但温暖
      finalMessage = '嗯，好久不见。';
      finalTone = 'neutral_friendly';
    } else if (quadrant === 'secure') {
      // 安全型：自然亲切
      finalMessage = '好久不见呀～最近怎么样？';
      finalTone = 'warm_casual';
    } else {
      // 混乱型：温柔耐心
      finalMessage = '嗨，好久不见了...';
      finalTone = 'gentle_patient';
    }
  }

  // v7.3: 设置上限，避免病娇
  warmthIntensity = Math.min(0.9, warmthIntensity);

  return {
    message: finalMessage,
    tone: finalTone,
    warmthIntensity,
    quadrant,
    health,
    attachment: { anxiety: attachment.anxiety, avoidance: attachment.avoidance },
    healthHint: adjusted.healthHint,
    narrativeHints: adjusted.narrativeHints || [],
    mods,  // v7.3: 返回性格调节系数，用于调试
    reunionThreshold,  // v7.3: 返回动态阈值
  };
}

// ====================== 在线态高敏响应 ======================

/**
 * 计算在线态响应提示
 * v7.3: 用户在场 = 她应该积极回应
 * 核心理念：用户打开软件 = 有需求，不是路过
 * @param {object} params
 * @param {Record<string, number>} params.emotionVector - 当前情绪向量
 * @param {{ anxiety: number, avoidance: number }} params.attachment - 依恋状态
 * @param {object} params.personalityDims - 性格维度
 * @param {number} params.hoursSinceLastUpdate - 距上次更新小时数
 * @returns {object} 在线态响应提示
 */
function computeOnlineResponseHints({ emotionVector, attachment, personalityDims = {}, hoursSinceLastUpdate = 0 }) {
  const mods = getPersonalityAttachmentModifiers(personalityDims);
  
  // 基础输出强度：依赖度越高，输出越强
  const baseOutputIntensity = mods.outputIntensity;
  
  // 分离后增强：分离时间越长，输出越强
  const separationBoost = Math.min(0.3, hoursSinceLastUpdate / 10 * 0.1);
  
  // 情绪强度增强
  const maxEmotion = Math.max(...Object.values(emotionVector));
  const emotionBoost = maxEmotion * 0.2;
  
  // 最终输出强度
  const outputIntensity = Math.min(1, baseOutputIntensity + separationBoost + emotionBoost);
  
  // 语音决策：高依赖 + 分离后 → 使用语音
  const useVoice = (mods.warmthMultiplier > 0.8 && hoursSinceLastUpdate > 1) || 
                   (hoursSinceLastUpdate > 8);
  
  // 贴纸决策：总是使用贴纸
  const useSticker = true;
  
  // 文字语气强度：依赖度越高，语气越强
  const textToneIntensity = Math.min(1, 0.5 + mods.warmthMultiplier * 0.3 + separationBoost);
  
  // 专属感表达：高占有欲 → 更强的专属感
  const exclusivityExpression = mods.exclusivityIntensity > 0.5 ? 
    '眼里只有你' : null;
  
  return {
    outputIntensity,
    useVoice,
    useSticker,
    textToneIntensity,
    exclusivityExpression,
    mods,  // 返回性格调节系数，用于调试
    // v7.3: 在线态无冷却、无日限
    cooldown: 0,
    dailyLimit: Infinity,
  };
}

// ====================== 用户行为学习 ======================

/**
 * 学习用户行为模式
 * v7.3: 基于用户历史行为动态调整依恋策略
 * @param {DatabaseSync} db
 * @param {string} [userId]
 * @returns {object} 用户行为模式
 */
function learnUserBehaviorPattern(db, userId = 'default') {
  // 获取最近30次交互记录
  const recentInteractions = db.prepare(`
    SELECT created_at, signal_type, signal_data_json
    FROM passive_signal_log
    WHERE created_at >= ?
    ORDER BY created_at DESC
    LIMIT 30
  `).all(Date.now() - 30 * 24 * 60 * 60 * 1000);  // 最近30天

  if (recentInteractions.length < 5) {
    // 数据不足，返回默认模式
    return {
      activeHours: null,
      avgGap: 24,  // 默认24小时
      patienceLevel: 1.0,
      interactionFrequency: 'normal',
      dataPoints: recentInteractions.length,
    };
  }

  // 分析活跃时段
  const activeHours = analyzeActiveHours(recentInteractions);
  
  // 计算平均分离时长
  const avgGap = calculateAverageGap(recentInteractions);
  
  // 计算交互频率
  const interactionFrequency = calculateInteractionFrequency(recentInteractions);
  
  // 计算耐心水平（基于用户行为模式）
  // 如果用户经常长时间不活跃，降低激进程度
  const patienceLevel = avgGap > 24 ? 0.7 : 
                        avgGap > 12 ? 0.85 : 
                        avgGap > 6 ? 0.95 : 1.0;

  return {
    activeHours,
    avgGap,
    patienceLevel,
    interactionFrequency,
    dataPoints: recentInteractions.length,
  };
}

/**
 * 分析用户活跃时段
 * @param {Array} interactions - 交互记录
 * @returns {object} 活跃时段分析
 */
function analyzeActiveHours(interactions) {
  const hourCounts = new Array(24).fill(0);
  
  for (const interaction of interactions) {
    const hour = new Date(interaction.created_at).getHours();
    hourCounts[hour]++;
  }
  
  // 找出最活跃的3个小时
  const sortedHours = hourCounts
    .map((count, hour) => ({ hour, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map(h => h.hour);
  
  // 计算活跃时段范围
  const activeStart = Math.min(...sortedHours);
  const activeEnd = Math.max(...sortedHours);
  
  return {
    peakHours: sortedHours,
    activeRange: { start: activeStart, end: activeEnd },
    distribution: hourCounts,
  };
}

/**
 * 计算平均分离时长
 * @param {Array} interactions - 交互记录
 * @returns {number} 平均分离时长（小时）
 */
function calculateAverageGap(interactions) {
  if (interactions.length < 2) return 24;
  
  const gaps = [];
  for (let i = 1; i < interactions.length; i++) {
    const gapMs = interactions[i - 1].created_at - interactions[i].created_at;
    const gapHours = gapMs / (1000 * 60 * 60);
    if (gapHours > 0 && gapHours < 168) {  // 忽略超过7天的间隔
      gaps.push(gapHours);
    }
  }
  
  if (gaps.length === 0) return 24;
  
  return gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
}

/**
 * 计算交互频率
 * @param {Array} interactions - 交互记录
 * @returns {string} 频率类型
 */
function calculateInteractionFrequency(interactions) {
  if (interactions.length < 5) return 'insufficient_data';
  
  const recentCount = interactions.filter(i => 
    i.created_at > Date.now() - 7 * 24 * 60 * 60 * 1000
  ).length;
  
  if (recentCount >= 20) return 'very_high';
  if (recentCount >= 10) return 'high';
  if (recentCount >= 5) return 'normal';
  if (recentCount >= 2) return 'low';
  return 'very_low';
}

/**
 * 记录被动信号
 * 用于记录用户行为模式，为依恋系统提供数据
 * @param {DatabaseSync} db
 * @param {string} signalType - 信号类型
 * @param {object} signalData - 信号数据
 */
function recordPassiveSignal(db, signalType, signalData) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO passive_signal_log (signal_type, signal_data_json, created_at)
    VALUES (?, ?, ?)
  `).run(signalType, JSON.stringify(signalData), now);
}

/**
 * 获取被动信号统计
 * @param {DatabaseSync} db
 * @param {number} days - 统计天数
 * @returns {object}
 */
function getPassiveSignalStats(db, days = 7) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const signals = db.prepare(`
    SELECT signal_type, COUNT(*) as count
    FROM passive_signal_log
    WHERE created_at >= ?
    GROUP BY signal_type
  `).all(cutoff);

  const stats = {};
  for (const row of signals) {
    stats[row.signal_type] = row.count;
  }

  return stats;
}

/**
 * 记录重逢被动信号
 * @param {DatabaseSync} db
 * @param {number} hoursSinceLastInteraction
 */
function recordReunionSignal(db, hoursSinceLastInteraction) {
  recordPassiveSignal(db, 'reunion', {
    hoursSince: hoursSinceLastInteraction,
    timestamp: Date.now(),
  });
}

/**
 * 记录快速回复信号（连续快速回复可能表示焦虑型依恋）
 * @param {DatabaseSync} db
 * @param {number} replyTimeMs - 回复时间（毫秒）
 */
function recordRapidReplySignal(db, replyTimeMs) {
  if (replyTimeMs < 30000) { // 30秒内回复
    recordPassiveSignal(db, 'rapid_reply', {
      replyTime: replyTimeMs,
      timestamp: Date.now(),
    });
  }
}

/**
 * 记录长时间未回复信号
 * @param {DatabaseSync} db
 * @param {number} hoursNoReply
 */
function recordSilenceSignal(db, hoursNoReply) {
  if (hoursNoReply > 24) {
    recordPassiveSignal(db, 'long_silence', {
      hoursNoReply,
      timestamp: Date.now(),
    });
  }
}

// ====================== 分离焦虑追踪 ======================

/**
 * 更新分离状态
 * 当用户长时间不联系时，更新分离焦虑状态
 * @param {DatabaseSync} db
 * @param {number} hoursSinceLastInteraction
 * @param {string} [userId]
 */
function updateSeparationState(db, hoursSinceLastInteraction, userId = 'default') {
  const attachment = getAttachmentState(db, userId);

  // 高焦虑用户：长时间分离会增加焦虑
  if (attachment.anxiety > 0.5 && hoursSinceLastInteraction > 12) {
    const separationStress = Math.min(0.1, hoursSinceLastInteraction / 100 * 0.05);

    const newAnxiety = Math.min(1, attachment.anxiety + separationStress);
    const now = Date.now();

    db.prepare(`
      UPDATE attachment_state
      SET anxiety = ?, last_updated = ?
      WHERE user_id = ?
    `).run(newAnxiety, now, userId);

    console.log(`[DigitalLife] Separation stress: anxiety ${attachment.anxiety.toFixed(2)} → ${newAnxiety.toFixed(2)} (${hoursSinceLastInteraction.toFixed(1)}h gap)`);
  }

  // 高回避用户：长时间分离可能强化回避
  if (attachment.avoidance > 0.5 && hoursSinceLastInteraction > 48) {
    const avoidanceBoost = Math.min(0.05, hoursSinceLastInteraction / 200 * 0.03);

    const newAvoidance = Math.min(1, attachment.avoidance + avoidanceBoost);
    const now = Date.now();

    db.prepare(`
      UPDATE attachment_state
      SET avoidance = ?, last_updated = ?
      WHERE user_id = ?
    `).run(newAvoidance, now, userId);

    console.log(`[DigitalLife] Separation effect: avoidance ${attachment.avoidance.toFixed(2)} → ${newAvoidance.toFixed(2)}`);
  }
}

// ====================== Prompt 构建 ======================

/**
 * 当前两项依恋指标对应的类型名称
 * @param {{ anxiety: number, avoidance: number }} attachment
 * @returns {string}
 */
function getAttachmentTypeName(attachment) {
  const quadrant = getAttachmentQuadrant(attachment.anxiety, attachment.avoidance);
  const quadrantNames = {
    secure: '安全型',
    anxious: '焦虑型',
    avoidant: '回避型',
    disorganized: '混乱型',
  };

  return quadrantNames[quadrant] || '未知';
}

function buildAttachmentDescription(attachment) {
  const parts = [`依恋类型：${getAttachmentTypeName(attachment)}`];

  // 用自然语言描述，不暴露数值
  if (attachment.anxiety > 0.6) {
    parts.push('用户对分离比较敏感，需要更多确认和温暖');
  } else if (attachment.anxiety < 0.3) {
    parts.push('用户对分离比较从容');
  }

  if (attachment.avoidance > 0.6) {
    parts.push('用户倾向于保持距离，不喜欢过于黏腻');
  } else if (attachment.avoidance < 0.3) {
    parts.push('用户愿意亲近，享受亲密互动');
  }

  return parts.join('。');
}

/**
 * 重逢语气 hint（供 buildDigitalLifePrompt 限量注入）
 * @param {DatabaseSync} db
 * @param {number} hoursSinceLastInteraction
 * @param {string} [userId]
 * @returns {{ text: string, priority: number } | null}
 */
function getAttachmentReunionToneCandidate(db, hoursSinceLastInteraction, userId = 'default') {
  if (hoursSinceLastInteraction <= 8) return null;
  const reunion = getReunionStrategyByAttachment(db, hoursSinceLastInteraction, userId);
  const toneLabel = reunion.tone === 'reassuring_warm'
    ? '温暖安抚'
    : reunion.tone === 'neutral_friendly'
      ? '友好但不黏腻'
      : '自然亲切';
  return {
    text: `这是久别重逢，可参考${toneLabel}的语气`,
    priority: 9 + Math.min(hoursSinceLastInteraction / 24, 3),
  };
}

/**
 * 构建依恋上下文 prompt 块
 * @param {DatabaseSync} db
 * @param {number} hoursSinceLastInteraction
 * @param {string} [userId]
 * @param {{ includeReunionTone?: boolean }} [options]
 * @returns {string}
 */
function buildAttachmentPrompt(db, hoursSinceLastInteraction, userId = 'default', options = {}) {
  const includeReunionTone = options.includeReunionTone !== false;
  const attachment = getAttachmentState(db, userId);
  const health = checkAttachmentHealth(attachment);
  const quadrant = getAttachmentQuadrant(attachment.anxiety, attachment.avoidance);

  const parts = [];

  // 依恋状态描述
  parts.push(`【依恋状态】${buildAttachmentDescription(attachment)}`);

  // 重逢策略提示（语气类，由 buildDigitalLifePrompt 限量注入）
  if (includeReunionTone && hoursSinceLastInteraction > 8) {
    const reunion = getReunionStrategyByAttachment(db, hoursSinceLastInteraction, userId);
    parts.push(`【互动提示】这是久别重逢，可参考${reunion.tone === 'reassuring_warm' ? '温暖安抚' : reunion.tone === 'neutral_friendly' ? '友好但不黏腻' : '自然亲切'}的语气。`);
  }

  // 健康度提示（仅在不健康时注入）
  if (health.score < 0.7 && health.warnings.length > 0) {
    const hintMap = {
      high_anxiety: '用户可能对你有较强的情感依赖，保持温暖但不要过度承诺"永远在一起"之类的话',
      high_avoidance: '用户可能不喜欢过于亲密的表达，保持友好但给予空间',
      disorganized_pattern: '用户的情绪模式比较复杂，可尽量保持耐心和稳定',
    };
    const hints = health.warnings.map(w => hintMap[w]).filter(Boolean);
    if (hints.length > 0) {
      parts.push(`【关系提醒】${hints.join('。')}`);
    }
  }

  return parts.join('\n');
}

/**
 * 获取依恋状态概览
 * @param {DatabaseSync} db
 * @param {string} [userId]
 * @returns {object}
 */
function getAttachmentOverview(db, userId = 'default') {
  const attachment = getAttachmentState(db, userId);
  const quadrant = getAttachmentQuadrant(attachment.anxiety, attachment.avoidance);
  const health = checkAttachmentHealth(attachment);
  const signalStats = getPassiveSignalStats(db, 7);

  return {
    attachment,
    quadrant,
    health,
    signalStats,
  };
}

module.exports = {
  ATTACHMENT_DEFAULTS,
  PERSONALITY_MODIFIER_LIMITS,
  getAttachmentState,
  getAttachmentQuadrant,
  updateAttachmentState,
  inferAttachmentSignals,
  checkAttachmentHealth,
  adjustResponseByAttachmentHealth,
  getReunionStrategyByAttachment,
  getPersonalityAttachmentModifiers,
  computeOnlineResponseHints,
  learnUserBehaviorPattern,
  buildAttachmentNarrativeHints,
  recordPassiveSignal,
  getPassiveSignalStats,
  recordReunionSignal,
  recordRapidReplySignal,
  recordSilenceSignal,
  updateSeparationState,
  getAttachmentTypeName,
  buildAttachmentDescription,
  buildAttachmentPrompt,
  getAttachmentReunionToneCandidate,
  getAttachmentOverview,
};
