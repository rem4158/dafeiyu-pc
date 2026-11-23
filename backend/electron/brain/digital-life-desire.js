// Adapted from the retained Nianan cognition modules for the local PC runtime.
const { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate } = require('./cognition-lifecycle');
/**
 * 数字生命系统 - 内驱力模块（欲望引擎）
 * Step 4: 统一动机主控，让角色从"被动等待"变为"主动想要"
 * v7.4: 内驱力动态化 + 性格驱动表达
 *
 * 设计原则：
 * - 欲望随时间自然累积，人格特质和情绪调节速率
 * - 最高欲望超过随机阈值时触发主动行为
 * - 触发后对应欲望消耗（非硬重置），自然回升形成呼吸感
 * - 本模块是主动搭话的唯一决策源（场景感知降级为信息层）
 *
 * v7.4 变更：
 * - P0: 欲望消耗模型 + outputIntensity 多维计算
 * - P1: 回应质量驱动欲望调节（替代无条件减法）
 * - P2: 性格全维度驱动欲望累积速率
 * - P3: 性格形态矩阵（同频率不同表达形式）
 * - P4: 欲望间联锁 + comfort/autonomy 满足路径
 */

/** @type {import('node:sqlite').DatabaseSync|null} */
let dbRef = null;

// ── 常量 ──────────────────────────────────────────────

/** 五维欲望默认值 */
const DESIRE_DEFAULTS = {
  social: 0.5,
  curiosity: 0.5,
  comfort: 0.5,
  autonomy: 0.5,
  competence: 0.5,
};

const DESIRE_KEYS = Object.keys(DESIRE_DEFAULTS);

/** 欲望累积速率（每小时） */
const ACCUMULATION_RATES = {
  social: 0.08,       // 社交欲望累积较快
  curiosity: 0.05,    // 好奇欲望中等
  comfort: 0.03,      // 舒适欲望较慢
  autonomy: 0.04,     // 自主欲望中等
  competence: 0.06,   // 能力欲望较快
};

/** 触发阈值范围（随机化，避免可预测性） */
const THRESHOLD_MIN = 0.55;
const THRESHOLD_MAX = 0.85;

/** 触发后消耗比例（v7.4: 消耗模型替代硬重置） */
const TRIGGER_CONSUMPTION_RATIO = 0.2;
/** 消耗后下限 */
const TRIGGER_CONSUMPTION_FLOOR = 0.1;

/** 每日主动联系上限（离线态） */
const DAILY_CONTACT_LIMIT = 4;

/** 冷却期（毫秒，离线态） */
const COOLDOWN_MS = 60 * 60 * 1000; // 60 分钟

/** 中文名称映射 */
const DESIRE_NAMES = {
  social: '社交',
  curiosity: '好奇',
  comfort: '舒适',
  autonomy: '自主',
  competence: '能力',
};

/**
 * 欲望类型 → 行为风格映射
 * 每种欲望触发时，生成对应风格的主动行为
 */
const DESIRE_BEHAVIOR_MAP = {
  social: {
    type: 'proactive_chat',
    style: 'warm_casual',
    toneHint: '想找用户聊聊天，语气温暖随意',
  },
  curiosity: {
    type: 'ask_question',
    style: 'curious_excited',
    toneHint: '对某件事感到好奇，想问用户或分享发现',
  },
  comfort: {
    type: 'seek_reassurance',
    style: 'gentle',
    toneHint: '安全感库存偏低，语气轻柔地确认关系（聊天内表达，非桌面打扰）',
  },
  autonomy: {
    type: 'share_thought',
    style: 'independent',
    toneHint: '想主动分享自己的想法，语气独立自信',
  },
  competence: {
    type: 'offer_help',
    style: 'eager',
    toneHint: '想展示自己的能力或帮助用户，语气积极',
  },
};

// ── P2: 性格驱动欲望累积速率 ──────────────────────────

/**
 * 5 种原型各有欲望速率乘法器（性格指纹）
 * genki: 社交和好奇涨飞快
 * gentle: 舒适和社交为主，自主低
 * cool: 自主涨最快，社交慢
 * cunning: 好奇和能力为主
 * airhead: 好奇最高，其余中等
 */
const ARCHETYPE_DESIRE_MULTIPLIERS = {
  genki:    { social: 1.4, curiosity: 1.3, comfort: 0.9, autonomy: 0.7, competence: 1.1 },
  gentle:   { social: 1.2, curiosity: 0.9, comfort: 1.3, autonomy: 0.8, competence: 0.9 },
  cool:     { social: 0.8, curiosity: 1.0, comfort: 0.9, autonomy: 1.4, competence: 1.1 },
  cunning:  { social: 0.9, curiosity: 1.3, comfort: 0.8, autonomy: 1.1, competence: 1.3 },
  airhead:  { social: 1.0, curiosity: 1.4, comfort: 1.1, autonomy: 0.9, competence: 0.8 },
};

// ── P3: 性格形态矩阵 ─────────────────────────────────

/**
 * 5 种原型的输出形态（同频率不同表达形式）
 * textLength: 文字长度偏好 (short/normal/long)
 * stickerProb: 附带贴纸概率
 * voiceProb: 使用语音概率
 * style: 整体风格关键词
 * enthusiasm: 热情度系数 (0.5-1.5)
 * burstIntervalRange: 连发间隔范围 [min, max] 秒
 */
const PERSONALITY_EXPRESSION_MODES = {
  genki: {
    textLength: 'long',
    stickerProb: 0.8,
    voiceProb: 0.3,
    style: 'enthusiastic',
    enthusiasm: 1.4,
    burstIntervalRange: [20, 90],
  },
  gentle: {
    textLength: 'normal',
    stickerProb: 0.6,
    voiceProb: 0.15,
    style: 'warm',
    enthusiasm: 1.0,
    burstIntervalRange: [35, 120],
  },
  cool: {
    textLength: 'short',
    stickerProb: 0.4,
    voiceProb: 0.05,
    style: 'reserved',
    enthusiasm: 0.7,
    burstIntervalRange: [45, 180],
  },
  cunning: {
    textLength: 'normal',
    stickerProb: 0.65,
    voiceProb: 0.1,
    style: 'playful',
    enthusiasm: 1.1,
    burstIntervalRange: [30, 130],
  },
  airhead: {
    textLength: 'long',
    stickerProb: 0.7,
    voiceProb: 0.2,
    style: 'scattered',
    enthusiasm: 1.2,
    burstIntervalRange: [25, 100],
  },
};

/**
 * 5 种欲望的表达姿态
 * 影响生成的内容类型和语气方向
 */
const DESIRE_EXPRESSION_POSTURE = {
  social: {
    contentStyle: 'chat',        // 闲聊/分享/问近况
    keywords: ['你', '今天', '干嘛', '想你'],
    stickerCategory: 'social',
  },
  curiosity: {
    contentStyle: 'question',    // 提问/探索/分享发现
    keywords: ['诶', '然后呢', '为什么', '好奇'],
    stickerCategory: 'curious',
  },
  comfort: {
    contentStyle: 'gentle',      // 温柔/安抚/求安稳
    keywords: ['嗯', '抱抱', '安心', '在呢'],
    stickerCategory: 'comfort',
  },
  autonomy: {
    contentStyle: 'share',       // 分享想法/表达观点
    keywords: ['我觉得', '其实', '对了', '你知道吗'],
    stickerCategory: 'confident',
  },
  competence: {
    contentStyle: 'offer',       // 主动帮忙/展示能力
    keywords: ['帮你', '这个我会', '看看', '搞定'],
    stickerCategory: 'capable',
  },
};

// ── P4: 欲望间联锁规则 ────────────────────────────────

/**
 * 联锁规则：当某个欲望超过阈值时，对其他欲望施加修正
 * modifier: 正值促进，负值抑制（乘法系数，1.0 为无影响）
 * threshold: 触发联锁的欲望阈值
 */
const DESIRE_INTERLOCKS = [
  { source: 'comfort',   target: 'autonomy',   modifier: 0.85, threshold: 0.7, description: '高舒适抑制自主' },
  { source: 'social',    target: 'autonomy',   modifier: 0.9,  threshold: 0.75, description: '高社交抑制自主' },
  { source: 'autonomy',  target: 'social',     modifier: 0.9,  threshold: 0.75, description: '高自主抑制社交' },
  { source: 'curiosity', target: 'competence', modifier: 1.15, threshold: 0.6,  description: '高好奇促进能力' },
];

// ── 数据库操作 ────────────────────────────────────────

/**
 * 初始化欲望状态（首次创建时写入默认值）
 * @param {import('node:sqlite').DatabaseSync} db
 */
function initDesireState(db) {
  const now = Date.now();
  for (const dim of DESIRE_KEYS) {
    db.prepare(`
      INSERT OR IGNORE INTO desire_state (dimension, current_level, accumulation_rate, last_updated)
      VALUES (?, ?, ?, ?)
    `).run(dim, DESIRE_DEFAULTS[dim], ACCUMULATION_RATES[dim], now);
  }
}

/**
 * 读取当前欲望状态
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Record<string, number>}
 */
function getDesireVector(db) {
  const rows = db.prepare(`SELECT dimension, current_level FROM desire_state`).all();
  const vector = { ...DESIRE_DEFAULTS };
  for (const row of rows) {
    if (DESIRE_KEYS.includes(row.dimension)) {
      vector[row.dimension] = row.current_level;
    }
  }
  return vector;
}

/**
 * 写入欲望状态
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Record<string, number>} vector
 */
function saveDesireVector(db, vector) {
  const now = Date.now();
  const stmt = db.prepare(`
    UPDATE desire_state SET current_level = ?, last_updated = ? WHERE dimension = ?
  `);
  for (const dim of DESIRE_KEYS) {
    if (vector[dim] !== undefined) {
      stmt.run(Math.max(0, Math.min(1, vector[dim])), now, dim);
    }
  }
}

/**
 * 获取上次触发时间
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number}
 */
function getLastTriggerAt(db) {
  try {
    const row = db.prepare(`SELECT last_trigger_at FROM desire_meta WHERE id = 1`).get();
    return row?.last_trigger_at || 0;
  } catch {
    return 0;
  }
}

/**
 * 设置上次触发时间
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} timestamp
 */
function setLastTriggerAt(db, timestamp) {
  db.prepare(`
    INSERT OR REPLACE INTO desire_meta (id, last_trigger_at, daily_count, daily_reset_at)
    VALUES (1, ?, COALESCE((SELECT daily_count FROM desire_meta WHERE id = 1), 0), COALESCE((SELECT daily_reset_at FROM desire_meta WHERE id = 1), ?))
  `).run(timestamp, timestamp);
}

/**
 * 获取今日触发次数
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number}
 */
function getDailyCount(db) {
  try {
    const row = db.prepare(`SELECT daily_count, daily_reset_at FROM desire_meta WHERE id = 1`).get();
    if (!row) return 0;
    const now = new Date();
    const resetDate = new Date(row.daily_reset_at);
    if (now.toDateString() !== resetDate.toDateString()) {
      db.prepare(`UPDATE desire_meta SET daily_count = 0, daily_reset_at = ? WHERE id = 1`).run(Date.now());
      return 0;
    }
    return row.daily_count || 0;
  } catch {
    return 0;
  }
}

/**
 * 增加今日触发次数
 * @param {import('node:sqlite').DatabaseSync} db
 */
function incrementDailyCount(db) {
  db.prepare(`
    UPDATE desire_meta SET daily_count = daily_count + 1 WHERE id = 1
  `).run();
}

/**
 * 近窗口内欲望触发次数（供元认知 prompt 情境判断）
 * 无逐次日志时用 last_trigger_at + daily_count 近似
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} [windowMs=3600000]
 * @returns {number}
 */
function getRecentDesireTriggerCount(db, windowMs = 60 * 60 * 1000) {
  if (!db) return 0;
  try {
    const lastAt = getLastTriggerAt(db);
    if (!lastAt || Date.now() - lastAt > windowMs) return 0;
    const daily = getDailyCount(db);
    if (daily >= 3) return daily;
    return 1;
  } catch {
    return 0;
  }
}

// ── 在线态管理（v7.3） ────────────────────────────────

/** @type {{ isOnline: boolean, isDesktopVisible: boolean }} */
let onlineState = { isOnline: false, isDesktopVisible: false };

/**
 * v7.3: 设置在线态（由 main.js 在窗口状态变化时调用）
 * @param {{ isOnline?: boolean, isDesktopVisible?: boolean }} state
 */
function setOnlineState(state) {
  if (state.isOnline !== undefined) onlineState.isOnline = state.isOnline;
  if (state.isDesktopVisible !== undefined) onlineState.isDesktopVisible = state.isDesktopVisible;
}

/**
 * v7.3: 获取当前在线态
 * @returns {{ isOnline: boolean, isDesktopVisible: boolean }}
 */
function getOnlineState() {
  return { ...onlineState };
}

// ── P0: 在线态底噪注入（v7.4 降低底噪） ───────────────

/**
 * v7.4: 在线态底噪注入
 * 降低底噪以允许欲望涨到更高，形成动态呼吸感
 * 聊天态 social≥0.45（原 0.6），桌面态 social≥0.35（原 0.55）
 * curiosity≥0.35（原 0.5）
 * @param {Record<string, number>} vector - 当前欲望向量
 * @param {boolean} isOnline - 是否前台在线（聊天或桌面）
 * @param {boolean} isDesktopVisible - 桌面窗是否可见（非聊天窗）
 * @returns {Record<string, number>} 注入底噪后的欲望向量
 */
function applyOnlineNoise(vector, isOnline, isDesktopVisible) {
  if (!isOnline) return vector;
  const updated = { ...vector };
  if (isDesktopVisible) {
    // 桌面窗可见但未在聊天：中敏态
    updated.social = Math.max(updated.social, 0.35);
  } else {
    // 聊天窗打开：高敏态
    updated.social = Math.max(updated.social, 0.45);
    updated.curiosity = Math.max(updated.curiosity, 0.35);
  }
  return updated;
}

// ── P2: 性格驱动欲望累积速率 ─────────────────────────

/**
 * v7.4: 根据 10 个性格滑块计算各欲望维度的累积速率乘法器
 * 每个滑块影响 1-2 个欲望维度，形成"性格指纹"
 * @param {object} personalityDims - 性格维度（来自 personality.js）
 * @returns {Record<string, number>} 各欲望维度的累积速率乘法器
 */
function computePersonalityAccumulationModifiers(personalityDims) {
  const mods = { social: 1.0, curiosity: 1.0, comfort: 1.0, autonomy: 1.0, competence: 1.0 };
  if (!personalityDims || typeof personalityDims !== 'object') return mods;
  const d = personalityDims;

  // dependency（依赖度）: 高→社交快，低→自主快
  if (d.dependency > 0.65) mods.social *= 1.0 + (d.dependency - 0.65) * 1.2;
  if (d.dependency < 0.4) mods.autonomy *= 1.0 + (0.4 - d.dependency) * 0.8;

  // proactivity（主动性）: 高→社交和能力快
  if (d.proactivity > 0.6) {
    mods.social *= 1.0 + (d.proactivity - 0.6) * 0.8;
    mods.competence *= 1.0 + (d.proactivity - 0.6) * 0.6;
  }

  // humor（幽默感）: 高→好奇快
  if (d.humor > 0.6) mods.curiosity *= 1.0 + (d.humor - 0.6) * 1.0;

  // empathyDepth（共情深度）: 高→舒适快
  if (d.empathyDepth > 0.65) mods.comfort *= 1.0 + (d.empathyDepth - 0.65) * 0.8;

  // rationality（理性）: 高→自主快
  if (d.rationality > 0.6) mods.autonomy *= 1.0 + (d.rationality - 0.6) * 0.6;

  // warmth（温暖）: 高→社交和舒适快
  if (d.warmth > 0.65) {
    mods.social *= 1.0 + (d.warmth - 0.65) * 0.5;
    mods.comfort *= 1.0 + (d.warmth - 0.65) * 0.4;
  }

  // shyness（害羞）: 高→社交慢，自主慢
  if (d.shyness > 0.65) {
    mods.social *= Math.max(0.6, 1.0 - (d.shyness - 0.65) * 0.8);
    mods.autonomy *= Math.max(0.7, 1.0 - (d.shyness - 0.65) * 0.5);
  }

  // verbosity（话多）: 高→社交快
  if (d.verbosity > 0.65) mods.social *= 1.0 + (d.verbosity - 0.65) * 0.6;

  // possessiveness（占有欲）: 高→社交快，舒适快
  if (d.possessiveness > 0.6) {
    mods.social *= 1.0 + (d.possessiveness - 0.6) * 0.7;
    mods.comfort *= 1.0 + (d.possessiveness - 0.6) * 0.4;
  }

  // 限幅：最多 ±60%
  for (const k of DESIRE_KEYS) {
    mods[k] = Math.max(0.4, Math.min(1.6, mods[k]));
  }
  return mods;
}

// ── 核心逻辑 ──────────────────────────────────────────

/**
 * 更新欲望状态
 * v7.4: 集成性格累积速率修正 + 原型乘法器 + 情绪→欲望联锁
 * @param {object} params
 * @param {number} [params.hoursSinceLastInteraction=0] - 距上次交互的小时数
 * @param {object} [params.personalityTraits] - 人格特质（来自 personality.js 维度）
 * @param {Record<string, number>} [params.emotionVector] - 当前情绪向量
 * @param {string} [params.archetype] - 性格原型名（genki/gentle/cool/cunning/airhead）
 * @returns {Record<string, number>} 更新后的欲望向量
 */
function updateDesires({ hoursSinceLastInteraction = 0, personalityTraits = {}, emotionVector = {}, archetype = 'gentle' } = {}) {
  const db = getDb();
  const current = getDesireVector(db);
  const updated = { ...current };

  if (hoursSinceLastInteraction <= 0) return updated;

  // 1. 基于时间的自然累积
  for (const dim of DESIRE_KEYS) {
    updated[dim] = Math.min(1, updated[dim] + ACCUMULATION_RATES[dim] * hoursSinceLastInteraction);
  }

  // 2. v7.4 P2: 性格滑块驱动累积速率修正
  const personalityMods = computePersonalityAccumulationModifiers(personalityTraits);
  for (const dim of DESIRE_KEYS) {
    updated[dim] *= personalityMods[dim];
  }

  // 3. v7.4 P2: 原型乘法器
  const archetypeMods = ARCHETYPE_DESIRE_MULTIPLIERS[archetype] || ARCHETYPE_DESIRE_MULTIPLIERS.gentle;
  for (const dim of DESIRE_KEYS) {
    updated[dim] *= archetypeMods[dim];
  }

  // 4. 情绪状态调节（保留原有 + 增强）
  if (emotionVector.sadness > 0.6) {
    updated.social *= 1.15;
  }
  if (emotionVector.curiosity > 0.6) {
    updated.curiosity *= 1.2;
  }
  if (emotionVector.anger > 0.6) {
    updated.autonomy *= 1.15;
  }
  // v7.4 增强：高悲伤抑制社交累积
  if (emotionVector.sadness > 0.7) {
    updated.social *= 0.85;
  }
  // 高共情促进社交
  if (emotionVector.empathy > 0.7) {
    updated.social *= 1.1;
  }

  // 5. v7.4 P4: 欲望间联锁
  for (const lock of DESIRE_INTERLOCKS) {
    if (updated[lock.source] > lock.threshold) {
      updated[lock.target] *= lock.modifier;
    }
  }

  // 6. 限制范围
  for (const dim of DESIRE_KEYS) {
    updated[dim] = Math.max(0, Math.min(1, updated[dim]));
  }

  saveDesireVector(db, updated);
  return updated;
}

/**
 * v7.4 P0: 多维加权计算输出强度
 * max×0.6 + avgTop3×0.4，再乘性格缩放
 * @param {Record<string, number>} vector - 欲望向量
 * @param {object} [personalityDims] - 性格维度
 * @returns {number} 输出强度 0-1
 */
function computeOutputIntensity(vector, personalityDims = {}) {
  const values = Object.values(vector).sort((a, b) => b - a);
  const maxVal = values[0] || 0;
  const top3 = values.slice(0, 3);
  const avgTop3 = top3.length > 0 ? top3.reduce((s, v) => s + v, 0) / top3.length : 0;

  let intensity = maxVal * 0.6 + avgTop3 * 0.4;

  // 性格缩放：verbosity 和 proactivity 放大活跃度
  const verbosity = personalityDims.verbosity ?? 0.5;
  const proactivity = personalityDims.proactivity ?? 0.5;
  const personalityScale = 0.7 + verbosity * 0.3 + proactivity * 0.2;
  intensity *= personalityScale;

  return Math.max(0, Math.min(1, intensity));
}

/**
 * 检查是否应该触发主动行为
 * v7.3: 在线态无阈值、无冷却、无日限，持续映射输出强度
 * v7.4: outputIntensity 改用多维加权 + 性格缩放
 * 离线态：使用随机阈值，避免可预测性
 * @param {object} [options]
 * @param {boolean} [options.isOnline] - 是否在线态（覆盖内部状态）
 * @param {boolean} [options.isDesktopVisible] - 桌面窗是否可见
 * @param {object} [options.personalityDims] - 性格维度（v7.4: 用于 outputIntensity）
 * @returns {{ shouldTrigger: boolean, desireType?: string, desireValue?: number, threshold?: number, reason?: string, outputIntensity?: number }}
 */
function checkDesireTrigger(options = {}) {
  const db = getDb();
  let vector = getDesireVector(db);
  const now = Date.now();

  // v7.3: 确定在线态（参数优先，否则用模块状态）
  const isOnline = options.isOnline ?? onlineState.isOnline;
  const isDesktopVisible = options.isDesktopVisible ?? onlineState.isDesktopVisible;

  // v7.5: 在线态 — Phase C proximity burst（非 tick 恒触发）
  if (isOnline) {
    try {
      const { checkPhaseCDesireBurst } = require('./digital-life-phase');
      return checkPhaseCDesireBurst({
        isOnline,
        isDesktopVisible,
        personalityDims: options.personalityDims,
      });
    } catch (err) {
      console.error('[DigitalLife:Desire] Phase C burst check failed:', err);
      return { shouldTrigger: false, reason: 'phase_c_check_failed' };
    }
  }

  vector = applyOnlineNoise(vector, isOnline, isDesktopVisible);

  // v7.5: 离线态也受 Phase A / grace 门控（避免与重逢问候抢首发）
  try {
    const { shouldBlockDesireProposals } = require('./digital-life-phase');
    const block = shouldBlockDesireProposals(now);
    if (block.blocked) {
      return { shouldTrigger: false, reason: block.reason };
    }
  } catch (err) {
    console.error('[DigitalLife:Desire] Phase gate check failed:', err);
  }

  // 离线态：原有逻辑
  // 检查每日上限
  const dailyCount = getDailyCount(db);
  if (dailyCount >= DAILY_CONTACT_LIMIT) {
    return { shouldTrigger: false, reason: 'daily_limit_reached' };
  }

  // 检查冷却期
  const lastTriggerAt = getLastTriggerAt(db);
  if (now - lastTriggerAt < COOLDOWN_MS) {
    return { shouldTrigger: false, reason: 'cooldown' };
  }

  // 生成随机阈值
  const threshold = THRESHOLD_MIN + Math.random() * (THRESHOLD_MAX - THRESHOLD_MIN);

  // 找到最高的欲望维度
  const maxDesire = Math.max(...Object.values(vector));
  const dominantEntry = Object.entries(vector).sort((a, b) => b[1] - a[1])[0];
  const dominantType = dominantEntry[0];

  if (maxDesire >= threshold) {
    return {
      shouldTrigger: true,
      desireType: dominantType,
      desireValue: maxDesire,
      threshold,
      outputIntensity: 0.5,
    };
  }

  return {
    shouldTrigger: false,
    reason: 'desire_below_threshold',
    maxDesire,
    threshold,
    dominantType,
  };
}

/**
 * v7.4 P0: 触发后消耗对应欲望（消耗模型替代硬重置）
 * 在线态：消耗 20%，下限 0.1，自然回升形成呼吸感
 * 离线态：保持旧逻辑（硬重置到 0.2）
 * @param {string} desireType - 触发的欲望类型
 */
function resetAfterTrigger(desireType) {
  const db = getDb();
  const vector = getDesireVector(db);

  if (onlineState.isOnline) {
    // v7.4: 在线态消耗模型
    const consumed = vector[desireType] * TRIGGER_CONSUMPTION_RATIO;
    vector[desireType] = Math.max(TRIGGER_CONSUMPTION_FLOOR, vector[desireType] - consumed);
  } else {
    // 离线态：保持旧逻辑
    vector[desireType] = 0.2;
  }

  saveDesireVector(db, vector);
  setLastTriggerAt(db, Date.now());
  incrementDailyCount(db);
  console.log(`[DigitalLife:Desire] Triggered: ${desireType}, ${onlineState.isOnline ? 'consumed' : 'reset'} to ${vector[desireType].toFixed(3)}`);
}

// ── P1: 回应质量驱动欲望调节 ─────────────────────────

/**
 * v7.4 P1: 评估用户回应质量（0-1）
 * 冷淡信号减分，热情信号加分，连续模式叠加
 * @param {object} params
 * @param {string} params.userText - 用户消息文本
 * @param {number} [params.messageLength=0] - 消息长度（覆盖 userText.length）
 * @param {boolean} [params.isQuestion=false] - 用户是否提问
 * @param {number} [params.prevEngagement=0.5] - 上一次 engagement 分数（用于连续模式）
 * @returns {number} engagement score 0-1
 */
function assessUserEngagement({ userText = '', messageLength = 0, isQuestion = false, prevEngagement = 0.5 }) {
  const text = userText.trim();
  const len = messageLength || text.length;

  // 敷衍回复（嗯/哦等）不算理
  try {
    const { isPerfunctoryReply } = require('../proactive/ignore-tracker');
    if (isPerfunctoryReply(text)) {
      return Math.max(0, Math.min(1, 0.12 * 0.6 + prevEngagement * 0.4));
    }
  } catch {}

  let score = 0.5; // 中性起点

  // 1. 短回复信号（冷淡）
  if (len <= 2) {
    score -= 0.25; // "嗯" "哦" "好"
  } else if (len <= 5) {
    score -= 0.1;
  }

  // 2. 敷衍词检测
  const dismissive = /^(嗯|哦|好|行|嗯嗯|哦哦|好的|行吧|知道了|随便|都行|无所谓|嗯哼)$/;
  if (dismissive.test(text)) {
    score -= 0.15;
  }

  // 3. 不耐烦信号
  const impatient = /(别说了|烦不烦|你有完没完|闭嘴|安静|不想聊|让我静静)/;
  if (impatient.test(text)) {
    score -= 0.3;
  }

  // 4. 长消息加分（用户在认真交流）
  if (len > 30) score += 0.1;
  if (len > 80) score += 0.1;

  // 5. 提问加分（用户在参与）
  if (isQuestion) score += 0.12;

  // 6. 情感词加分（用户在表达情感）
  const emotional = /(喜欢|爱你|想你|开心|高兴|难过|生气|害怕|谢谢|感谢|嘿嘿|哈哈|呜呜|嘻嘻|哇|诶|！)/;
  if (emotional.test(text)) score += 0.1;

  // 7. 撒娇/亲密信号
  const intimate = /(嘛|呀|啦|嘻嘻|嘿嘿|抱抱|亲亲|mua|么么|宝宝|宝贝)/;
  if (intimate.test(text)) score += 0.08;

  // 8. 连续模式叠加（滑动平均）
  // 如果连续热情/冷淡，分数会逐渐偏移
  score = score * 0.6 + prevEngagement * 0.4;

  return Math.max(0, Math.min(1, score));
}

/**
 * v7.4 P1: 计算性格对 engagement 的敏感度
 * 高 dependency/possessiveness 对冷淡更受伤
 * 高 autonomy/rationality 对冷淡不敏感
 * @param {object} personalityDims - 性格维度
 * @returns {{ positiveSensitivity: number, negativeSensitivity: number }}
 */
function computeEngagementSensitivity(personalityDims) {
  const d = personalityDims || {};
  // 正面敏感度：热情回复带来的欲望增幅
  let positive = 1.0;
  if ((d.empathyDepth ?? 0.5) > 0.6) positive += 0.2;
  if ((d.warmth ?? 0.5) > 0.6) positive += 0.15;
  if ((d.dependency ?? 0.5) > 0.6) positive += 0.1;

  // 负面敏感度：冷淡回复带来的欲望降幅（绝对值）
  let negative = 1.0;
  if ((d.dependency ?? 0.5) > 0.65) negative += 0.3;   // 粘人型更受伤
  if ((d.possessiveness ?? 0.5) > 0.6) negative += 0.2;
  if ((d.shyness ?? 0.5) > 0.65) negative += 0.15;
  if ((d.autonomy ?? 0.5) > 0.65) negative -= 0.2;     // 独立型不那么受伤
  if ((d.rationality ?? 0.5) > 0.65) negative -= 0.15;

  return {
    positiveSensitivity: Math.max(0.5, Math.min(2.0, positive)),
    negativeSensitivity: Math.max(0.3, Math.min(2.0, negative)),
  };
}

/**
 * v7.4 P1: 根据 engagement score 计算各欲望维度的调节量
 * 热情→涨，冷淡→降，中性→性格决定
 * @param {number} engagement - engagement score 0-1
 * @param {{ positiveSensitivity: number, negativeSensitivity: number }} sensitivity - 性格敏感度
 * @returns {Record<string, number>} 各维度的调节量（可正可负）
 */
function computeDesireModulation(engagement, sensitivity) {
  const mods = { social: 0, curiosity: 0, comfort: 0, autonomy: 0, competence: 0 };
  const midpoint = 0.5;
  const delta = engagement - midpoint; // -0.5 ~ +0.5

  if (delta > 0.05) {
    // 热情：社交和好奇涨
    const intensity = delta * sensitivity.positiveSensitivity;
    mods.social = intensity * 0.15;
    mods.curiosity = intensity * 0.1;
    mods.competence = intensity * 0.05;
    // 高热情也微涨舒适（感到被接纳）
    mods.comfort = intensity * 0.08;
  } else if (delta < -0.05) {
    // 冷淡：社交和能力降；v7.5 comfort=安全感库存，敷衍时下降
    const intensity = Math.abs(delta) * sensitivity.negativeSensitivity;
    mods.social = -intensity * 0.12;
    mods.competence = -intensity * 0.08;
    mods.comfort = -intensity * 0.14;
    // 冷淡微涨自主（退缩后自保）
    mods.autonomy = intensity * 0.04;
  }
  // 中性（-0.05 ~ 0.05）：不调节

  return mods;
}

/**
 * v7.4 P1: 回应质量驱动欲望调节（替代 satisfyFromInteraction）
 * 整合 engagement 评估、性格敏感度、维度调节
 * @param {object} params
 * @param {string} params.userText - 用户消息文本
 * @param {number} [params.messageLength=0] - 消息长度
 * @param {boolean} [params.isQuestion=false] - 是否提问
 * @param {object} [params.personalityDims] - 性格维度
 */
function modulateDesireByEngagement({ userText = '', messageLength = 0, isQuestion = false, personalityDims = {} }) {
  const db = getDb();
  const vector = getDesireVector(db);

  // 获取上一次 engagement（用于连续模式）
  let prevEngagement = 0.5;
  try {
    const row = db.prepare(`SELECT prev_engagement FROM desire_meta WHERE id = 1`).get();
    if (row && row.prev_engagement !== undefined) prevEngagement = row.prev_engagement;
  } catch {
    // 旧数据库无此字段，使用默认值
  }

  // 1. 评估 engagement
  const engagement = assessUserEngagement({ userText, messageLength, isQuestion, prevEngagement });

  // 2. 计算性格敏感度
  const sensitivity = computeEngagementSensitivity(personalityDims);

  // 3. 计算各维度调节量
  const modulation = computeDesireModulation(engagement, sensitivity);

  // 4. 应用调节
  const updated = { ...vector };
  for (const dim of DESIRE_KEYS) {
    updated[dim] = Math.max(0, Math.min(1, updated[dim] + modulation[dim]));
  }

  // 5. v7.5: comfort=安全感库存 — 稳定互动补库存，极度敷衍额外消耗
  if (engagement > 0.62) {
    updated.comfort = Math.min(1, updated.comfort + 0.04);
  } else if (engagement < 0.22) {
    updated.comfort = Math.max(0, updated.comfort - 0.06);
  }

  // 6. v7.4 P4: autonomy 满足路径 — 用户含独立表达时降低 autonomy
  const independentMarkers = /(我觉得|我认为|我决定|我自己|不用了|我会|我能)/;
  if (independentMarkers.test(userText)) {
    updated.autonomy = Math.max(0, updated.autonomy - 0.05);
  }

  // 7. 保存
  saveDesireVector(db, updated);

  // 8. 记录 engagement 供下次使用
  try {
    db.prepare(`UPDATE desire_meta SET prev_engagement = ? WHERE id = 1`).run(engagement);
  } catch {
    // 旧数据库无此字段，静默忽略
  }

  console.log(`[DigitalLife:Desire] Engagement: ${engagement.toFixed(2)}, modulation: social=${modulation.social.toFixed(3)}, curiosity=${modulation.curiosity.toFixed(3)}, comfort=${modulation.comfort.toFixed(3)}`);
}

/**
 * 获取欲望对语气的隐晦影响（单条最高优先级）
 * @param {{ userText?: string, topicGuards?: object }} [options]
 * @returns {{ text: string, priority: number } | null}
 */
function getDesireToneCandidate(options = {}) {
  const db = getDb();
  const vector = getDesireVector(db);
  const { topicGuards = {} } = options;

  /** @type {{ text: string, priority: number, type: string }[]} */
  const candidates = [];

  if (vector.social > 0.7) {
    candidates.push({
      text: topicGuards.suppressGenericPraise
        ? '或许想聊聊天，语气可稍亲近一些，但不要编造夸奖'
        : '或许想聊聊天，语气可稍亲近一些',
      priority: vector.social * 10,
      type: 'social',
    });
  }

  if (vector.curiosity > 0.7) {
    candidates.push({
      text: '对新话题有兴趣，可适当多问一句',
      priority: vector.curiosity * 9,
      type: 'curiosity',
    });
  }

  if (vector.comfort > 0.7) {
    candidates.push({
      text: '想要一些安稳感，语气可稍温柔一些',
      priority: vector.comfort * 8,
      type: 'comfort',
    });
  }

  if (vector.autonomy > 0.7) {
    candidates.push({
      text: '若有想法，可适当分享看法',
      priority: vector.autonomy * 7,
      type: 'autonomy',
    });
  }

  if (vector.competence > 0.7 && !topicGuards.suppressCompetencePraise) {
    candidates.push({
      text: '可表达关心或提供帮助，但不要编造用户未提及的能力',
      priority: vector.competence * 8,
      type: 'competence',
    });
  }

  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.priority - a.priority)[0];
}

/**
 * 获取欲望对语气的隐晦影响
 * @param {{ userText?: string, topicGuards?: object }} [options]
 * @returns {string} prompt hint 或空字符串
 */
function getDesireInfluenceOnTone(options = {}) {
  const candidate = getDesireToneCandidate(options);
  if (!candidate) return '';
  return `【内驱力提示】${candidate.text}。`;
}

/**
 * 获取欲望状态概览（用于 IPC 和设置页）
 * @returns {object}
 */
function getDesireOverview() {
  const db = getDb();
  const vector = getDesireVector(db);
  const dailyCount = getDailyCount(db);
  const lastTriggerAt = getLastTriggerAt(db);

  // 找到主导欲望
  const sorted = Object.entries(vector).sort((a, b) => b[1] - a[1]);
  const dominant = sorted[0];

  return {
    desires: vector,
    dominantType: dominant[0],
    dominantValue: dominant[1],
    dailyCount,
    dailyLimit: DAILY_CONTACT_LIMIT,
    lastTriggerAt: lastTriggerAt || null,
    cooldownMs: COOLDOWN_MS,
    thresholdRange: { min: THRESHOLD_MIN, max: THRESHOLD_MAX },
  };
}

/**
 * 获取欲望行为映射
 * @param {string} desireType
 * @returns {object}
 */
function getDesireBehavior(desireType) {
  return DESIRE_BEHAVIOR_MAP[desireType] || DESIRE_BEHAVIOR_MAP.social;
}

/**
 * v7.4 P3: 获取性格形态（供 expression-layer 使用）
 * @param {string} archetype - 原型名
 * @returns {object} 性格形态配置
 */
function getPersonalityExpressionMode(archetype) {
  return PERSONALITY_EXPRESSION_MODES[archetype] || PERSONALITY_EXPRESSION_MODES.gentle;
}

/**
 * v7.4 P3: 获取欲望表达姿态（供 expression-layer 使用）
 * @param {string} desireType - 欲望类型
 * @returns {object} 欲望表达姿态
 */
function getDesireExpressionPosture(desireType) {
  return DESIRE_EXPRESSION_POSTURE[desireType] || DESIRE_EXPRESSION_POSTURE.social;
}

/**
 * v7.4: 获取连发间隔范围（供 behavior-arbiter 使用）
 * @param {string} archetype - 原型名
 * @returns {[number, number]} [minMs, maxMs]
 */
function getBurstIntervalRange(archetype) {
  const mode = PERSONALITY_EXPRESSION_MODES[archetype] || PERSONALITY_EXPRESSION_MODES.gentle;
  return [mode.burstIntervalRange[0] * 1000, mode.burstIntervalRange[1] * 1000];
}

// ── 内部辅助 ──────────────────────────────────────────

function getDb() {
  if (!dbRef) {
    // 懒加载：从 digital-life 主模块获取
    try {
      const { getDb } = require('./digital-life');
      dbRef = getDb();
    } catch {
      throw new Error('[DigitalLife:Desire] Database not available');
    }
  }
  return dbRef;
}

/**
 * 设置数据库引用（由 digital-life.js 主模块调用）
 * @param {import('node:sqlite').DatabaseSync} db
 */
function setDb(db) {
  dbRef = db;
}

module.exports = {
  // 常量
  DESIRE_DEFAULTS,
  DESIRE_KEYS,
  ACCUMULATION_RATES,
  DESIRE_BEHAVIOR_MAP,
  DESIRE_NAMES,
  DAILY_CONTACT_LIMIT,
  COOLDOWN_MS,
  TRIGGER_CONSUMPTION_RATIO,
  TRIGGER_CONSUMPTION_FLOOR,
  ARCHETYPE_DESIRE_MULTIPLIERS,
  PERSONALITY_EXPRESSION_MODES,
  DESIRE_EXPRESSION_POSTURE,
  DESIRE_INTERLOCKS,

  // 初始化
  initDesireState,
  setDb,

  // 状态读写
  getDesireVector,
  saveDesireVector,
  getDesireOverview,
  getDesireBehavior,

  // 核心逻辑
  updateDesires,
  checkDesireTrigger,
  resetAfterTrigger,
  getDesireInfluenceOnTone,
  getDesireToneCandidate,

  // v7.3: 在线态管理
  setOnlineState,
  getOnlineState,
  applyOnlineNoise,

  // v7.4 P0: 欲望消耗 + 多维强度
  computeOutputIntensity,

  // v7.4 P1: 回应质量驱动
  assessUserEngagement,
  computeEngagementSensitivity,
  computeDesireModulation,
  modulateDesireByEngagement,

  // v7.4 P2: 性格驱动累积
  computePersonalityAccumulationModifiers,

  // v7.4 P3: 性格形态矩阵
  getPersonalityExpressionMode,
  getDesireExpressionPosture,
  getBurstIntervalRange,

  // 元认知 P0
  getRecentDesireTriggerCount,
};
