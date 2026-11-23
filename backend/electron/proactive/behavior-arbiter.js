/**
 * 行为仲裁器 (BehaviorArbiter) - Step 5, v7.3 重构
 *
 * v7.3: 从「门卫」改为「导演」
 * - 在线态：无全局冷却、无日限、默认倾向通过；只管节奏（连发间隔 30-120s）
 * - 离线态：保留旧的保守参数（60min 冷却、4 次/日）
 * - 职责不再是「能不能说」，而是「说几条、什么语气、间隔多久」
 *
 * 设计原则（v7.3）：
 * - 用户打开了软件 = 用户想聊天，别拦着
 * - 在线态默认倾向说；仲裁只决定节奏
 * - 离线态保留安全底线
 */

// ── 配置 ──────────────────────────────────────────────

// v7.4: 获取性格驱动的连发间隔
const { getBurstIntervalRange } = require('../brain/digital-life-desire');

/** 当前性格原型（v7.4: 由外部设置） */
let currentArchetype = 'gentle';

/**
 * v7.4: 设置当前性格原型（由 main.js 或 settings 变更时调用）
 * @param {string} archetype
 */
function setArchetype(archetype) {
  currentArchetype = archetype || 'gentle';
}

/** 行为优先级（越高越优先） */
const PRIORITY = {
  /** 内稳态关系修复（Step 8 接入后） */
  relationship_repair: 1.0,
  /** 依恋重逢安抚 */
  attachment_reunion: 0.9,
  /** 依恋健康度调整 */
  attachment_health: 0.85,
  /** 内驱力 - 社交欲望 */
  desire_social: 0.7,
  /** 内驱力 - 好奇欲望 */
  desire_curiosity: 0.6,
  /** 内驱力 - 能力欲望 */
  desire_competence: 0.6,
  /** 内驱力 - 自主欲望 */
  desire_autonomy: 0.5,
  /** 内驱力 - 舒适欲望 */
  desire_comfort: 0.5,
  /** 好奇心表达（内驱力触发后的表达风格） */
  curiosity_expression: 0.5,
  /** 仅语气 hint，不主动搭话 */
  subtle_tone_only: 0.3,
};

/** 默认仲裁配置（离线态） */
const ARBITER_CONFIG_OFFLINE = {
  /** 全局冷却期（毫秒）- 两次主动行为之间的最小间隔 */
  globalCooldownMs: 60 * 60 * 1000, // 60 分钟
  /** 每日主动行为上限 */
  dailyLimit: 4,
  /** 同类型行为冷却期（毫秒） */
  typeCooldownMs: 30 * 60 * 1000, // 30 分钟
  /** 最大等待播放时间（毫秒） */
  maxPlaybackWaitMs: 120 * 1000,
};

/** 在线态仲裁配置（v7.3） */
const ARBITER_CONFIG_ONLINE = {
  /** 全局冷却期：连发间隔 30-120 秒（随机） */
  globalCooldownMs: 30 * 1000, // 30 秒基础，实际会随机化
  globalCooldownMaxMs: 120 * 1000, // 最大 120 秒
  /** 每日上限：无限制 */
  dailyLimit: Infinity,
  /** 同类型行为冷却期：较短 */
  typeCooldownMs: 60 * 1000, // 1 分钟
  /** 最大等待播放时间（毫秒） */
  maxPlaybackWaitMs: 120 * 1000,
};

/** 当前使用的配置（默认离线态） */
let ARBITER_CONFIG = { ...ARBITER_CONFIG_OFFLINE };

// ── 在线态管理（v7.3） ────────────────────────────────

/** @type {boolean} 当前是否在线态 */
let isOnlineMode = false;

/**
 * v7.3: 设置在线态模式
 * 在线态：无日限、短冷却、默认倾向通过
 * 离线态：保留旧的保守参数
 * @param {boolean} online
 */
function setOnlineMode(online) {
  isOnlineMode = online;
  if (online) {
    ARBITER_CONFIG = { ...ARBITER_CONFIG_ONLINE };
  } else {
    ARBITER_CONFIG = { ...ARBITER_CONFIG_OFFLINE };
  }
  console.log(`[BehaviorArbiter] Mode: ${online ? 'ONLINE (director)' : 'OFFLINE (gatekeeper)'}`);
}

/**
 * v7.3: 获取是否在线态
 * @returns {boolean}
 */
function getIsOnlineMode() {
  return isOnlineMode;
}

// ── 状态管理 ──────────────────────────────────────────

/** @type {object} 仲裁器状态 */
let arbiterState = {
  lastFiredAt: 0,
  lastFiredType: null,
  dailyCount: 0,
  dailyDate: '',
  typeHistory: {}, // { type: lastFiredAt }
};

/**
 * 重置仲裁器状态
 */
function resetArbiterState() {
  arbiterState = {
    lastFiredAt: 0,
    lastFiredType: null,
    dailyCount: 0,
    dailyDate: '',
    typeHistory: {},
  };
}

/**
 * 更新仲裁器状态（从外部状态恢复）
 * @param {object} state - 外部状态对象
 */
function syncFromExternalState(state) {
  if (state) {
    arbiterState.lastFiredAt = state.lastTriggerAt || state.lastFireAt || arbiterState.lastFiredAt;
    arbiterState.dailyCount = state.dailyCount || arbiterState.dailyCount;
  }
}

/**
 * 获取仲裁器状态（用于持久化）
 * @returns {object}
 */
function getArbiterState() {
  return { ...arbiterState };
}

// ── 核心仲裁逻辑 ──────────────────────────────────────

/**
 * 生成在线态连发间隔（v7.4: 由性格驱动）
 * genki 20-90s，cool 45-180s，gentle 35-120s
 * @returns {number} 毫秒
 */
function getOnlineCooldownMs() {
  const [minMs, maxMs] = getBurstIntervalRange(currentArchetype);
  return minMs + Math.random() * (maxMs - minMs);
}

/**
 * 检查是否可以执行行为
 * v7.3: 在线态默认倾向通过，只检查连发间隔
 * @param {object} proposal - 行为提案
 * @param {string} proposal.type - 提案类型（如 desire_social, attachment_reunion）
 * @param {number} [proposal.priority] - 提案优先级（0-1，默认从 PRIORITY 查找）
 * @param {object} [proposal.context] - 提案上下文
 * @returns {{ allowed: boolean, reason?: string }}
 */
function canExecute(proposal) {
  const now = Date.now();
  const type = proposal.type || 'unknown';
  const priority = proposal.priority ?? PRIORITY[type] ?? 0.5;

  // v7.5: Phase C 内驱力 — refractory 由阶段机门控，仲裁器不再二次冷却
  if (isOnlineMode) {
    if (String(type).startsWith('desire_')) {
      return { allowed: true };
    }
    const timeSinceLastFired = now - arbiterState.lastFiredAt;
    const cooldownMs = getOnlineCooldownMs();
    if (timeSinceLastFired < cooldownMs) {
      // 高优先级（重逢/关系修复）可以突破连发间隔
      if (priority < PRIORITY.attachment_reunion) {
        return {
          allowed: false,
          reason: 'online_rhythm_cooldown',
          remainingMs: cooldownMs - timeSinceLastFired,
        };
      }
    }
    return { allowed: true };
  }

  // 离线态：原有逻辑
  // 1. 检查每日上限
  const today = new Date().toDateString();
  if (arbiterState.dailyDate !== today) {
    arbiterState.dailyDate = today;
    arbiterState.dailyCount = 0;
  }
  if (arbiterState.dailyCount >= ARBITER_CONFIG.dailyLimit) {
    return { allowed: false, reason: 'daily_limit_reached' };
  }

  // 2. 检查全局冷却期
  const timeSinceLastFired = now - arbiterState.lastFiredAt;
  if (timeSinceLastFired < ARBITER_CONFIG.globalCooldownMs) {
    // 高优先级可以突破全局冷却
    if (priority < PRIORITY.attachment_reunion) {
      return {
        allowed: false,
        reason: 'global_cooldown',
        remainingMs: ARBITER_CONFIG.globalCooldownMs - timeSinceLastFired,
      };
    }
  }

  // 3. 检查同类型冷却期
  const lastTypeFired = arbiterState.typeHistory[type] || 0;
  const timeSinceTypeFired = now - lastTypeFired;
  if (timeSinceTypeFired < ARBITER_CONFIG.typeCooldownMs) {
    // 高优先级可以突破类型冷却
    if (priority < PRIORITY.attachment_health) {
      return {
        allowed: false,
        reason: 'type_cooldown',
        type,
        remainingMs: ARBITER_CONFIG.typeCooldownMs - timeSinceTypeFired,
      };
    }
  }

  return { allowed: true };
}

/**
 * 仲裁多个提案，选择最高优先级的一个执行
 * v7.3: 在线态默认倾向通过
 * @param {Array<object>} proposals - 提案列表
 * @param {string} proposals[].type - 提案类型
 * @param {number} [proposals[].priority] - 优先级
 * @param {object} [proposals[].payload] - 提案负载（模板、文本等）
 * @returns {{ selected: object|null, rejected: Array<{ type: string, reason: string }> }}
 */
function arbitrate(proposals) {
  if (!proposals || proposals.length === 0) {
    return { selected: null, rejected: [] };
  }

  const rejected = [];
  const candidates = [];

  // 1. 过滤和评分
  for (const proposal of proposals) {
    const type = proposal.type || 'unknown';
    const priority = proposal.priority ?? PRIORITY[type] ?? 0.5;

    const check = canExecute(proposal);
    if (!check.allowed) {
      rejected.push({ type, reason: check.reason, details: check });
      continue;
    }

    candidates.push({
      ...proposal,
      effectivePriority: priority,
    });
  }

  // 2. 按优先级排序（高优先级在前）
  candidates.sort((a, b) => b.effectivePriority - a.effectivePriority);

  // 3. 选择最高优先级的提案
  const selected = candidates.length > 0 ? candidates[0] : null;

  return { selected, rejected };
}

/**
 * 标记行为已执行
 * @param {string} type - 执行的行为类型
 */
function markExecuted(type) {
  const now = Date.now();
  arbiterState.lastFiredAt = now;
  arbiterState.lastFiredType = type;
  arbiterState.dailyCount += 1;
  arbiterState.typeHistory[type] = now;
}

// ── 提案构建辅助 ──────────────────────────────────────

/**
 * 构建内驱力提案
 * @param {string} desireType - 欲望类型
 * @param {object} payload - 提案负载
 * @returns {object}
 */
function buildDesireProposal(desireType, payload) {
  const type = `desire_${desireType}`;
  return {
    type,
    priority: PRIORITY[type] ?? PRIORITY.desire_social,
    source: 'desire_engine',
    payload,
  };
}

/**
 * 构建依恋重逢提案
 * @param {object} payload - 提案负载
 * @returns {object}
 */
function buildReunionProposal(payload) {
  return {
    type: 'attachment_reunion',
    priority: PRIORITY.attachment_reunion,
    source: 'attachment',
    payload,
  };
}

/**
 * 构建依恋健康度调整提案
 * @param {object} payload - 提案负载
 * @returns {object}
 */
function buildAttachmentHealthProposal(payload) {
  return {
    type: 'attachment_health',
    priority: PRIORITY.attachment_health,
    source: 'attachment',
    payload,
  };
}

/**
 * 构建内稳态关系修复提案（Step 8 接入）
 * @param {object} payload - 提案负载
 * @returns {object}
 */
function buildRelationshipRepairProposal(payload) {
  return {
    type: 'relationship_repair',
    priority: PRIORITY.relationship_repair,
    source: 'homeostasis',
    payload,
  };
}

// ── 导出 ──────────────────────────────────────────────

module.exports = {
  // 常量
  PRIORITY,
  ARBITER_CONFIG,
  ARBITER_CONFIG_OFFLINE,
  ARBITER_CONFIG_ONLINE,

  // 状态管理
  resetArbiterState,
  syncFromExternalState,
  getArbiterState,

  // 核心逻辑
  canExecute,
  arbitrate,
  markExecuted,

  // v7.3: 在线态管理
  setOnlineMode,
  getIsOnlineMode,

  // v7.4: 性格原型
  setArchetype,

  // 提案构建
  buildDesireProposal,
  buildReunionProposal,
  buildAttachmentHealthProposal,
  buildRelationshipRepairProposal,
};
