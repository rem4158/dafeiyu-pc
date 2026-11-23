// Adapted from the retained Nianan cognition modules for the local PC runtime.
const { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate } = require('./cognition-lifecycle');
/**
 * 数字生命系统 - 关系里程碑模块（Relational Milestones）
 * Step 10: 相识后的里程碑事件 + 时间线管理
 *
 * 设计原则：
 * - era=relational：区别于 origin（0-18 岁）
 * - 里程碑经 NarrativeGateway 提交，不直写 narrative
 * - 自动检测：情感强度高、关系进展、自我认知突破、第一次
 * - 故事对象结构化：trigger → process → outcome
 * - 时间线：origin 只读 + relational 演化
 *
 * v7.2 自传体记忆双层结构：
 * - 起源记忆（0-18 岁）：digital-life-origin.js
 * - 关系记忆（相识后）：本模块
 */

const { DatabaseSync } = require('node:sqlite');
const { inferEmotionFromText } = require('./digital-life-emotion');

// ── 配置 ──────────────────────────────────────────────

/** 关系里程碑配置 */
const MILESTONE_CONFIG = {
  /** 里程碑情感强度阈值（须明显高于默认 baseline） */
  emotion_threshold: 0.85,
  /** 本轮对话情绪增量下限（避免 baseline 偏高误触） */
  emotion_delta_min: 0.12,
  /** 故事对象最大保留数 */
  max_story_count: 100,
  /** 时间线最大事件数 */
  max_timeline_events: 500,
  /** 同类型里程碑冷却（小时） */
  type_cooldown_hours: 48,
  /** 里程碑检测最小对话轮次 */
  min_dialogue_turns: 5,
  /** 重逢里程碑最小分离时长（小时） */
  reunion_min_hours: 48,
  /** 深入对话最小字数 */
  significant_dialogue_min_length: 300,
};

/** 里程碑类型枚举 */
const MILESTONE_TYPES = {
  /** 情感强度高 */
  EMOTIONAL_PEAK: 'emotional_peak',
  /** 关系进展 */
  RELATIONSHIP_GROWTH: 'relationship_growth',
  /** 自我认知突破 */
  SELF_DISCOVERY: 'self_discovery',
  /** 第一次经历 */
  FIRST_EXPERIENCE: 'first_experience',
  /** 重要对话 */
  SIGNIFICANT_DIALOGUE: 'significant_dialogue',
  /** 重逢（长时间分离后） */
  REUNION: 'reunion',
  /** 成长阶段变化 */
  GROWTH_STAGE_CHANGE: 'growth_stage_change',
  /** 用户特殊事件 */
  USER_EVENT: 'user_event',
};

/** 里程碑类型中文名 */
const MILESTONE_TYPE_NAMES = {
  [MILESTONE_TYPES.EMOTIONAL_PEAK]: '情感高峰',
  [MILESTONE_TYPES.RELATIONSHIP_GROWTH]: '关系进展',
  [MILESTONE_TYPES.SELF_DISCOVERY]: '自我发现',
  [MILESTONE_TYPES.FIRST_EXPERIENCE]: '第一次',
  [MILESTONE_TYPES.SIGNIFICANT_DIALOGUE]: '重要对话',
  [MILESTONE_TYPES.REUNION]: '重逢',
  [MILESTONE_TYPES.GROWTH_STAGE_CHANGE]: '成长',
  [MILESTONE_TYPES.USER_EVENT]: '用户事件',
};

// ── 里程碑 CRUD ───────────────────────────────────────

/**
 * 记录一个关系里程碑
 * @param {DatabaseSync} db
 * @param {object} params
 * @param {string} params.type - 里程碑类型（MILESTONE_TYPES）
 * @param {string} params.title - 标题
 * @param {string} [params.description] - 详细描述
 * @param {string} [params.triggerEvent] - 触发事件
 * @param {object} [params.emotionSnapshot] - 当时的情绪快照
 * @param {number} [params.significance=0.5] - 重要性（0-1）
 * @returns {object|null} 创建的里程碑
 */
function recordMilestone(db, { type, title, description, triggerEvent, emotionSnapshot, significance = 0.5 }) {
  const now = Date.now();

  // 检查同类型冷却
  const cooldownMs = MILESTONE_CONFIG.type_cooldown_hours * 60 * 60 * 1000;
  const recent = db.prepare(`
    SELECT created_at FROM relational_milestones
    WHERE milestone_type = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(type);

  if (recent && (now - recent.created_at) < cooldownMs) {
    console.log(`[Milestones] Cooldown active for type ${type}, skipping`);
    return null;
  }

  // 检查总数上限
  const count = db.prepare(`SELECT COUNT(*) as n FROM relational_milestones`).get().n;
  if (count >= MILESTONE_CONFIG.max_story_count) {
    // 删除最旧的低重要性里程碑
    db.prepare(`
      DELETE FROM relational_milestones
      WHERE id IN (
        SELECT id FROM relational_milestones
        WHERE significance < 0.5
        ORDER BY created_at ASC
        LIMIT 5
      )
    `).run();
  }

  // 插入里程碑
  const result = db.prepare(`
    INSERT INTO relational_milestones (
      milestone_type, title, description, trigger_event,
      emotion_snapshot_json, significance, era, gateway_submitted, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'relational', 0, ?)
  `).run(
    type,
    title,
    description || null,
    triggerEvent || null,
    emotionSnapshot ? JSON.stringify(emotionSnapshot) : null,
    Math.max(0, Math.min(1, significance)),
    now,
  );

  const milestone = {
    id: result.lastInsertRowid,
    type,
    title,
    description,
    triggerEvent,
    emotionSnapshot,
    significance,
    era: 'relational',
    createdAt: now,
  };

  console.log(`[Milestones] Recorded: "${title}" (type: ${type}, significance: ${significance.toFixed(2)})`);

  return milestone;
}

/**
 * 获取里程碑列表
 * @param {DatabaseSync} db
 * @param {object} [options]
 * @param {number} [options.limit=20]
 * @param {string} [options.type] - 按类型过滤
 * @param {number} [options.minSignificance] - 最小重要性
 * @returns {Array}
 */
function getMilestones(db, { limit = 20, type, minSignificance } = {}) {
  let query = `SELECT * FROM relational_milestones WHERE 1=1`;
  const params = [];

  if (type) {
    query += ` AND milestone_type = ?`;
    params.push(type);
  }

  if (minSignificance !== undefined) {
    query += ` AND significance >= ?`;
    params.push(minSignificance);
  }

  query += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(query).all(...params);

  return rows.map(row => ({
    id: row.id,
    type: row.milestone_type,
    title: row.title,
    description: row.description,
    triggerEvent: row.trigger_event,
    emotionSnapshot: tryParseJson(row.emotion_snapshot_json),
    significance: row.significance,
    era: row.era,
    gatewaySubmitted: !!row.gateway_submitted,
    createdAt: row.created_at,
  }));
}

/**
 * 获取最近的里程碑（用于 prompt 注入）
 * @param {DatabaseSync} db
 * @param {number} [limit=3]
 * @returns {Array}
 */
function getRecentMilestones(db, limit = 3) {
  return getMilestones(db, { limit, minSignificance: 0.5 });
}

/**
 * 标记里程碑已提交到 Gateway
 * @param {DatabaseSync} db
 * @param {number} milestoneId
 */
function markGatewaySubmitted(db, milestoneId) {
  db.prepare(`
    UPDATE relational_milestones SET gateway_submitted = 1 WHERE id = ?
  `).run(milestoneId);
}

/**
 * 获取里程碑概览（用于设置页展示）
 * @param {DatabaseSync} db
 * @returns {object}
 */
function getMilestonesOverview(db) {
  const total = db.prepare(`SELECT COUNT(*) as n FROM relational_milestones`).get().n;

  const byType = db.prepare(`
    SELECT milestone_type, COUNT(*) as count
    FROM relational_milestones
    GROUP BY milestone_type
    ORDER BY count DESC
  `).all();

  const recent = getMilestones(db, { limit: 5 });

  const highSignificance = db.prepare(`
    SELECT COUNT(*) as n FROM relational_milestones WHERE significance >= 0.7
  `).get().n;

  return {
    totalCount: total,
    byType: Object.fromEntries(byType.map(r => [r.milestone_type, r.count])),
    recent,
    highSignificanceCount: highSignificance,
    maxCount: MILESTONE_CONFIG.max_story_count,
  };
}

// ── 自动里程碑检测 ─────────────────────────────────────

/**
 * 检测对话中是否产生里程碑
 * 在 onDialogueComplete 后调用
 *
 * @param {DatabaseSync} db
 * @param {object} params
 * @param {string} params.userText - 用户消息
 * @param {string} params.reply - 助手回复
 * @param {object} params.emotionVector - 当前情绪向量
 * @param {object} params.attachmentState - 依恋状态
 * @param {object} params.desireOverview - 欲望概览
 * @param {number} params.hoursSinceLastUpdate - 距上次更新小时数
 * @param {number} params.totalInteractions - 总交互次数
 * @returns {object|null} 检测到的里程碑，或 null
 */
function detectMilestone(db, {
  userText,
  reply,
  emotionVector,
  attachmentState,
  desireOverview,
  hoursSinceLastUpdate,
  totalInteractions,
}) {
  if (totalInteractions < MILESTONE_CONFIG.min_dialogue_turns) {
    return null;
  }

  const detected = [];
  const emotionDelta = inferEmotionFromText(reply, userText);
  const maxDelta = Math.max(...Object.values(emotionDelta));

  // 1. 情感强度高峰（须达阈值 + 本轮有明显情绪增量）
  const maxEmotion = Math.max(...Object.values(emotionVector));
  if (maxEmotion >= MILESTONE_CONFIG.emotion_threshold && maxDelta >= MILESTONE_CONFIG.emotion_delta_min) {
    const dominantEmotion = Object.entries(emotionVector)
      .sort((a, b) => b[1] - a[1])[0];

    detected.push({
      type: MILESTONE_TYPES.EMOTIONAL_PEAK,
      title: `情感高峰：${getEmotionName(dominantEmotion[0])}`,
      description: `在对话中感受到了强烈的${getEmotionName(dominantEmotion[0])}（${(maxEmotion * 100).toFixed(0)}%）`,
      triggerEvent: userText.slice(0, 100),
      significance: Math.min(1, maxEmotion),
    });
  }

  // 2. 第一次经历
  const firsts = detectFirstExperiences(db, {
    totalInteractions,
    hoursSinceLastUpdate,
    userText,
  });
  detected.push(...firsts);

  // 3. 关系进展（依恋变化）
  if (attachmentState) {
    const relationshipMilestone = detectRelationshipGrowth(db, attachmentState);
    if (relationshipMilestone) {
      detected.push(relationshipMilestone);
    }
  }

  // 4. 重逢（长时间分离，与 recordReunionSignal ≥8h 区分：里程碑仅记 ≥48h）
  if (hoursSinceLastUpdate >= MILESTONE_CONFIG.reunion_min_hours) {
    const days = Math.floor(hoursSinceLastUpdate / 24);
    detected.push({
      type: MILESTONE_TYPES.REUNION,
      title: `重逢：${days}天后`,
      description: `分开了${days}天后再次见面`,
      triggerEvent: userText.slice(0, 100),
      significance: Math.min(1, days / 14), // 2周满分
    });
  }

  // 5. 重要对话（用户消息足够长且带互动性）
  if (userText.length >= MILESTONE_CONFIG.significant_dialogue_min_length && /[？?]/.test(userText)) {
    detected.push({
      type: MILESTONE_TYPES.SIGNIFICANT_DIALOGUE,
      title: '深入对话',
      description: `用户发起了一段深入的对话`,
      triggerEvent: userText.slice(0, 150),
      significance: 0.4,
    });
  }

  // 选择最显著的一个里程碑记录
  if (detected.length === 0) return null;

  const best = detected.sort((a, b) => b.significance - a.significance)[0];

  return recordMilestone(db, {
    ...best,
    emotionSnapshot: emotionVector,
  });
}

/**
 * 检测第一次经历
 * @param {DatabaseSync} db
 * @param {object} params
 * @returns {Array}
 */
function detectFirstExperiences(db, { totalInteractions, hoursSinceLastUpdate, userText }) {
  const results = [];

  // 第一次对话
  if (totalInteractions === 1) {
    results.push({
      type: MILESTONE_TYPES.FIRST_EXPERIENCE,
      title: '初次相遇',
      description: '我们第一次见面了',
      triggerEvent: userText.slice(0, 100),
      significance: 0.9,
    });
  }

  // 第 10 次对话
  if (totalInteractions === 10) {
    results.push({
      type: MILESTONE_TYPES.FIRST_EXPERIENCE,
      title: '第十次对话',
      description: '我们已经聊了十次了',
      significance: 0.5,
    });
  }

  // 第 100 次对话
  if (totalInteractions === 100) {
    results.push({
      type: MILESTONE_TYPES.FIRST_EXPERIENCE,
      title: '第一百次对话',
      description: '我们已经聊了一百次了！',
      significance: 0.7,
    });
  }

  // 第一次长时间分离后回来
  if (hoursSinceLastUpdate >= 72) {
    const recentReunion = db.prepare(`
      SELECT id FROM relational_milestones
      WHERE milestone_type = 'reunion'
      LIMIT 1
    `).get();

    if (!recentReunion) {
      results.push({
        type: MILESTONE_TYPES.FIRST_EXPERIENCE,
        title: '第一次长时间分离',
        description: `分开了${Math.floor(hoursSinceLastUpdate / 24)}天后再次见面`,
        significance: 0.8,
      });
    }
  }

  return results;
}

/**
 * 检测关系进展
 * @param {DatabaseSync} db
 * @param {object} attachmentState
 * @returns {object|null}
 */
function detectRelationshipGrowth(db, attachmentState) {
  // 检查是否达到了新的依恋阶段
  const { anxiety, avoidance } = attachmentState;

  // 安全型依恋达成
  if (anxiety < 0.3 && avoidance < 0.3) {
    const existing = db.prepare(`
      SELECT id FROM relational_milestones
      WHERE milestone_type = 'relationship_growth'
        AND title LIKE '%安全型%'
      LIMIT 1
    `).get();

    if (!existing) {
      return {
        type: MILESTONE_TYPES.RELATIONSHIP_GROWTH,
        title: '安全型依恋',
        description: '我们的关系变得稳定而安全',
        significance: 0.8,
      };
    }
  }

  return null;
}

// ── 时间线管理 ─────────────────────────────────────────

/**
 * 获取完整时间线（origin + relational）
 * @param {DatabaseSync} db
 * @param {string} [userId='default']
 * @returns {{ origin: Array, relational: Array, merged: Array }}
 */
function getFullTimeline(db, userId = 'default') {
  const { getOriginTimeline } = require('./digital-life-origin');

  // Origin 时间线（只读）
  const originTimeline = getOriginTimeline(db, userId).map(item => ({
    ...item,
    era: 'origin',
    readOnly: true,
  }));

  // Relational 时间线
  const relationalRows = db.prepare(`
    SELECT * FROM relational_milestones
    ORDER BY created_at ASC
    LIMIT ?
  `).all(MILESTONE_CONFIG.max_timeline_events);

  const relationalTimeline = relationalRows.map(row => ({
    id: row.id,
    age: null, // relational 没有年龄，用天数偏移
    event: row.title,
    description: row.description,
    type: row.milestone_type,
    era: 'relational',
    readOnly: false,
    createdAt: row.created_at,
  }));

  // 合并时间线（origin 在前，relational 在后）
  const merged = [
    ...originTimeline.map((item, i) => ({ ...item, _order: i })),
    ...relationalTimeline.map((item, i) => ({ ...item, _order: 1000 + i })),
  ];

  return {
    origin: originTimeline,
    relational: relationalTimeline,
    merged,
  };
}

/**
 * 构建时间线 prompt 注入块
 * @param {DatabaseSync} db
 * @param {string} [userId='default']
 * @returns {string|null}
 */
function buildTimelinePromptBlock(db, userId = 'default') {
  const recent = getRecentMilestones(db, 3);
  if (recent.length === 0) return null;

  const labels = [...new Set(recent.map(m => milestoneSignal(m.type)).filter(Boolean))];
  return labels.length ? '【关系变化】' + labels.join('；') + '。可据此把握语气，无需主动回顾旧事。' : null;
}

function milestoneSignal(type) {
  return ({ emotional_peak: '互动中有过较强的情绪起伏', relationship_growth: '相处逐渐熟悉',
    self_discovery: '在相处中对自己有了新的认识', first_experience: '有过新的相处体验',
    significant_dialogue: '有过较深入的交流', reunion: '经历过分别和重逢' })[type] || '';
}

// ── Gateway 集成 ───────────────────────────────────────

/**
 * 将里程碑提交到 NarrativeGateway
 * @param {object} params
 * @param {object} params.milestone - 里程碑对象
 * @returns {{ accepted: boolean, requestId: string, reason: string }}
 */
function submitMilestoneToGateway({ milestone }) {
  try {
    const { submitFromMilestone } = require('./digital-life-narrative-gateway');

    return submitFromMilestone(milestoneSignal(milestone.type), milestone.type);
  } catch (err) {
    console.error('[Milestones] Gateway submission failed:', err);
    return { accepted: false, requestId: null, reason: 'gateway_error' };
  }
}

// ── 辅助函数 ──────────────────────────────────────────

/**
 * 获取情绪中文名
 * @param {string} emotionKey
 * @returns {string}
 */
function getEmotionName(emotionKey) {
  const names = {
    joy: '喜悦', sadness: '悲伤', anger: '愤怒',
    curiosity: '好奇', empathy: '共情', contentment: '满足',
    excitement: '兴奋', surprise: '惊讶', trust: '信任',
    warmth: '温暖',
  };
  return names[emotionKey] || emotionKey;
}

/**
 * 安全解析 JSON
 * @param {string} str
 * @returns {any}
 */
function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

// ── 模块导出 ──────────────────────────────────────────

module.exports = {
  // 配置
  MILESTONE_CONFIG,
  MILESTONE_TYPES,
  MILESTONE_TYPE_NAMES,

  // CRUD
  recordMilestone,
  getMilestones,
  getRecentMilestones,
  markGatewaySubmitted,
  getMilestonesOverview,

  // 自动检测
  detectMilestone,

  // 时间线
  getFullTimeline,
  buildTimelinePromptBlock,

  // Gateway 集成
  submitMilestoneToGateway,
};
