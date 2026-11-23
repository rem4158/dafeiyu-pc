// Adapted from the retained Nianan cognition modules for the local PC runtime.
const { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate } = require('./cognition-lifecycle');
/**
 * 数字生命系统 - 内稳态模块（元监控）
 * Step 8: 五维健康指标监控；系统级异常检测与修复
 *
 * 设计原则：
 * - 元监控：只监控和修复，不与情绪衰减并行调节
 * - 修复经 Gateway：所有修复动作通过证据提交，不旁路改叙事
 * - 保守策略：正常情绪波动不被压扁，仅在系统级异常时介入
 *
 * 五维健康指标：
 * - emotionalStability（情绪稳定性）：情绪波动是否在合理范围
 * - memoryConsistency（记忆一致性）：记忆之间是否矛盾
 * - personalityIntegrity（人格完整性）：人格是否稳定连贯
 * - cognitiveClarity（认知清晰度）：思维是否清晰
 * - relationshipHarmony（关系和谐度）：与用户的关系是否健康
 */

const { DatabaseSync } = require('node:sqlite');

// ── 常量 ──────────────────────────────────────────────

/** 健康指标维度 */
const HEALTH_DIMENSIONS = {
  emotionalStability: {
    name: '情绪稳定性',
    weight: 0.25,
    threshold: 0.6,
    description: '情绪波动是否在合理范围',
  },
  memoryConsistency: {
    name: '记忆一致性',
    weight: 0.20,
    threshold: 0.7,
    description: '记忆之间是否矛盾',
  },
  personalityIntegrity: {
    name: '人格完整性',
    weight: 0.25,
    threshold: 0.8,
    description: '人格是否稳定连贯',
  },
  cognitiveClarity: {
    name: '认知清晰度',
    weight: 0.15,
    threshold: 0.7,
    description: '思维是否清晰',
  },
  relationshipHarmony: {
    name: '关系和谐度',
    weight: 0.15,
    threshold: 0.6,
    description: '与用户的关系是否健康',
  },
};

const HEALTH_KEYS = Object.keys(HEALTH_DIMENSIONS);

/** 异常检测阈值 */
const ANOMALY_THRESHOLDS = {
  emotionExtreme: 0.85,        // 情绪极端值（单维度超过此值）
  emotionStuckHours: 24,       // 情绪卡死时间（小时）
  narrativeDrift: 0.3,         // 叙事漂移阈值（与核心身份偏离）
  attachmentImbalance: 0.75,   // 依恋失衡阈值（焦虑或回避超过此值）
  healthScoreCritical: 0.4,    // 综合健康度临界值
};

/** 修复动作类型 */
const REPAIR_ACTIONS = {
  EMOTION_REGULATION: 'emotion_regulation',       // 情绪调节证据
  MEMORY_CONSOLIDATION: 'memory_consolidation',   // 记忆整合证据
  IDENTITY_REINFORCEMENT: 'identity_reinforcement', // 身份强化证据
  COGNITIVE_RESET: 'cognitive_reset',             // 认知重置证据
  RELATIONSHIP_REPAIR: 'relationship_repair',     // 关系修复提案
  CRYSTALLIZATION_TRIGGER: 'crystallization_trigger', // 触发结晶
};

/** 检查间隔（毫秒） */
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 分钟

// ── 数据库操作 ────────────────────────────────────────

/**
 * 初始化内稳态表
 * @param {DatabaseSync} db
 */
function initHomeostasisTables(db) {
  db.exec(`
    -- 内稳态健康指标
    CREATE TABLE IF NOT EXISTS homeostasis_metrics (
      dimension TEXT PRIMARY KEY,
      current_value REAL NOT NULL DEFAULT 0.8,
      threshold REAL NOT NULL DEFAULT 0.6,
      last_checked_at INTEGER NOT NULL,
      last_repair_at INTEGER,
      check_count INTEGER DEFAULT 0,
      anomaly_count INTEGER DEFAULT 0
    );

    -- 内稳态事件日志
    CREATE TABLE IF NOT EXISTS homeostasis_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      dimension TEXT,
      severity REAL,
      details_json TEXT,
      repair_action TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_homeostasis_events_type ON homeostasis_events(event_type, created_at);
  `);

  // 初始化默认健康指标
  const now = Date.now();
  for (const [dim, config] of Object.entries(HEALTH_DIMENSIONS)) {
    db.prepare(`
      INSERT OR IGNORE INTO homeostasis_metrics (dimension, current_value, threshold, last_checked_at)
      VALUES (?, ?, ?, ?)
    `).run(dim, 0.8, config.threshold, now);
  }
}

/**
 * 获取健康指标向量
 * @param {DatabaseSync} db
 * @returns {Record<string, number>}
 */
function getHealthVector(db) {
  const rows = db.prepare(`SELECT dimension, current_value FROM homeostasis_metrics`).all();
  const vector = {};
  for (const row of rows) {
    if (HEALTH_KEYS.includes(row.dimension)) {
      vector[row.dimension] = row.current_value;
    }
  }
  // 填充默认值
  for (const key of HEALTH_KEYS) {
    if (vector[key] === undefined) {
      vector[key] = 0.8;
    }
  }
  return vector;
}

/**
 * 更新健康指标
 * @param {DatabaseSync} db
 * @param {string} dimension
 * @param {number} value
 * @param {boolean} [isAnomaly=false]
 */
function updateHealthMetric(db, dimension, value, isAnomaly = false) {
  const now = Date.now();
  const clamped = Math.max(0, Math.min(1, value));

  if (isAnomaly) {
    db.prepare(`
      UPDATE homeostasis_metrics
      SET current_value = ?,
          last_checked_at = ?,
          anomaly_count = anomaly_count + 1
      WHERE dimension = ?
    `).run(clamped, now, dimension);
  } else {
    db.prepare(`
      UPDATE homeostasis_metrics
      SET current_value = ?,
          last_checked_at = ?,
          check_count = check_count + 1
      WHERE dimension = ?
    `).run(clamped, now, dimension);
  }
}

/**
 * 记录内稳态事件
 * @param {DatabaseSync} db
 * @param {string} eventType
 * @param {string} dimension
 * @param {number} severity
 * @param {object} details
 * @param {string} [repairAction]
 */
function recordHomeostasisEvent(db, eventType, dimension, severity, details, repairAction = null) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO homeostasis_events (event_type, dimension, severity, details_json, repair_action, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    eventType,
    dimension,
    severity,
    JSON.stringify(details),
    repairAction,
    now,
  );
}

/**
 * 获取内稳态事件历史
 * @param {DatabaseSync} db
 * @param {number} [limit=20]
 * @returns {Array}
 */
function getHomeostasisEvents(db, limit = 20) {
  return db.prepare(`
    SELECT id, event_type, dimension, severity, details_json, repair_action, created_at
    FROM homeostasis_events
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit).map(row => ({
    ...row,
    details: row.details_json ? JSON.parse(row.details_json) : null,
  }));
}

// ── 健康指标计算 ──────────────────────────────────────

/**
 * 计算情绪稳定性
 * 检查情绪是否卡在极端值或波动过大
 * @param {Record<string, number>} emotionVector
 * @param {object} [emotionHistory] - 情绪历史（可选）
 * @returns {number} 0-1，越高越稳定
 */
function calculateEmotionalStability(emotionVector, emotionHistory = null) {
  let stability = 1.0;

  // 1. 检查极端值惩罚
  for (const [dim, val] of Object.entries(emotionVector)) {
    if (val > ANOMALY_THRESHOLDS.emotionExtreme) {
      // 越极端，稳定性越低
      const extremity = (val - ANOMALY_THRESHOLDS.emotionExtreme) / (1 - ANOMALY_THRESHOLDS.emotionExtreme);
      stability -= extremity * 0.3;
    }
    if (val < 0.1) {
      // 极低值也惩罚
      stability -= 0.1;
    }
  }

  // 2. 检查情绪多样性（所有情绪都接近基线 = 稳定但单调）
  const values = Object.values(emotionVector);
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  // 适度的方差是健康的（0.01-0.05），过高或过低都惩罚
  if (variance < 0.005) {
    stability -= 0.1; // 过于单调
  } else if (variance > 0.1) {
    stability -= 0.2; // 波动过大
  }

  return Math.max(0, Math.min(1, stability));
}

/**
 * 计算记忆一致性
 * 检查最近的记忆是否有矛盾
 * @param {DatabaseSync} db
 * @returns {number} 0-1，越高越一致
 */
function calculateMemoryConsistency(db) {
  let consistency = 1.0;

  try {
    // 检查最近的事实记忆是否有冲突
    const recentFacts = db.prepare(`
      SELECT id, fact_key, fact_value, importance
      FROM facts
      WHERE active = 1 AND importance >= 3
      ORDER BY updated_at DESC
      LIMIT 50
    `).all();

    // 简单的冲突检测：相同 key 但不同 value 的记录
    const keyValues = {};
    for (const fact of recentFacts) {
      const key = fact.fact_key.toLowerCase().trim();
      if (!keyValues[key]) {
        keyValues[key] = [];
      }
      keyValues[key].push(fact.fact_value);
    }

    // 检测冲突
    let conflictCount = 0;
    for (const [key, values] of Object.entries(keyValues)) {
      if (values.length > 1) {
        // 简单的字符串差异检测
        const uniqueValues = [...new Set(values.map(v => v.toLowerCase().trim()))];
        if (uniqueValues.length > 1) {
          conflictCount++;
        }
      }
    }

    // 冲突越多，一致性越低
    if (conflictCount > 0) {
      consistency -= Math.min(0.3, conflictCount * 0.1);
    }

    // 检查叙事版本是否有回滚（可能表示不一致）
    const narrativeVersions = db.prepare(`
      SELECT COUNT(*) as count FROM personality_narrative
    `).get();

    if (narrativeVersions?.count > 5) {
      // 版本过多可能表示演化过快
      consistency -= 0.05;
    }

  } catch (err) {
    console.error('[Homeostasis] Memory consistency check failed:', err);
    consistency = 0.7; // 出错时给一个中等值
  }

  return Math.max(0, Math.min(1, consistency));
}

/**
 * 计算人格完整性
 * 检查人格是否稳定连贯
 * @param {DatabaseSync} db
 * @param {object} narrative - 当前叙事
 * @returns {number} 0-1，越高越完整
 */
function calculatePersonalityIntegrity(db, narrative) {
  let integrity = 1.0;

  try {
    // 1. 检查核心身份是否存在
    const core = db.prepare(`SELECT identity_text FROM personality_core WHERE id = 1`).get();
    if (!core?.identity_text) {
      integrity -= 0.3;
    }

    // 2. 检查叙事是否存在
    if (!narrative?.narrative_text) {
      integrity -= 0.2;
    } else {
      // 3. 检查叙事与核心身份的一致性（简单的关键词匹配）
      if (core?.identity_text) {
        const coreKeywords = [(require('./settings').loadSettings().characterName || '大肥鱼'), '关心', '陪伴', '温暖'];
        const narrativeLower = narrative.narrative_text.toLowerCase();
        const matchCount = coreKeywords.filter(kw => narrativeLower.includes(kw)).length;
        const matchRatio = matchCount / coreKeywords.length;

        // 匹配度太低可能表示人格漂移
        if (matchRatio < 0.25) {
          integrity -= 0.2;
        }
      }
    }

    // 4. 检查结晶化历史（频繁结晶可能表示不稳定）
    const crystallizationCount = db.prepare(`
      SELECT COUNT(*) as count FROM crystallization_events
      WHERE created_at > ?
    `).get(Date.now() - 7 * 24 * 60 * 60 * 1000); // 最近 7 天

    if (crystallizationCount?.count > 3) {
      integrity -= 0.1;
    }

  } catch (err) {
    console.error('[Homeostasis] Personality integrity check failed:', err);
    integrity = 0.7;
  }

  return Math.max(0, Math.min(1, integrity));
}

/**
 * 计算认知清晰度
 * 检查系统是否正常运行
 * @param {Record<string, number>} emotionVector
 * @param {object} desireVector
 * @returns {number} 0-1，越高越清晰
 */
function calculateCognitiveClarity(emotionVector, desireVector) {
  let clarity = 1.0;

  // 1. 检查情绪是否干扰认知（高愤怒/高悲伤会降低清晰度）
  if (emotionVector.anger > 0.7) {
    clarity -= (emotionVector.anger - 0.7) * 0.5;
  }
  if (emotionVector.sadness > 0.7) {
    clarity -= (emotionVector.sadness - 0.7) * 0.3;
  }

  // 2. 检查欲望是否过度累积（可能导致行为混乱）
  const maxDesire = Math.max(...Object.values(desireVector || {}));
  if (maxDesire > 0.9) {
    clarity -= 0.1;
  }

  // 3. 检查情绪联锁是否正常（高愤怒应降低共情，如果没有则可能异常）
  if (emotionVector.anger > 0.6 && emotionVector.empathy > 0.7) {
    // 异常模式：高愤怒同时高共情
    clarity -= 0.15;
  }

  return Math.max(0, Math.min(1, clarity));
}

/**
 * 计算关系和谐度
 * 基于依恋健康度
 * @param {object} attachmentState
 * @param {object} attachmentHealth
 * @returns {number} 0-1，越高越和谐
 */
function calculateRelationshipHarmony(attachmentState, attachmentHealth) {
  // 直接使用依恋健康度分数
  let harmony = attachmentHealth?.score ?? 0.8;

  // 额外检查：依恋状态是否在健康范围
  const { anxiety = 0.3, avoidance = 0.3 } = attachmentState || {};

  // 焦虑过高降低和谐度
  if (anxiety > 0.7) {
    harmony -= (anxiety - 0.7) * 0.3;
  }

  // 回避过高降低和谐度
  if (avoidance > 0.7) {
    harmony -= (avoidance - 0.7) * 0.2;
  }

  // 混乱型依恋（焦虑+回避都高）额外惩罚
  if (anxiety > 0.6 && avoidance > 0.6) {
    harmony -= 0.15;
  }

  return Math.max(0, Math.min(1, harmony));
}

/**
 * 计算综合健康度
 * @param {Record<string, number>} healthVector
 * @returns {number} 0-1
 */
function calculateOverallHealth(healthVector) {
  let totalScore = 0;
  let totalWeight = 0;

  for (const [dim, config] of Object.entries(HEALTH_DIMENSIONS)) {
    const value = healthVector[dim] ?? 0.8;
    totalScore += value * config.weight;
    totalWeight += config.weight;
  }

  return totalWeight > 0 ? totalScore / totalWeight : 0.8;
}

// ── 异常检测 ──────────────────────────────────────────

/**
 * 检测情绪异常
 * @param {Record<string, number>} emotionVector
 * @param {DatabaseSync} db
 * @returns {Array<object>} 异常列表
 */
function detectEmotionAnomalies(emotionVector, db) {
  const anomalies = [];

  // 1. 检查极端情绪值
  for (const [dim, val] of Object.entries(emotionVector)) {
    if (val > ANOMALY_THRESHOLDS.emotionExtreme) {
      anomalies.push({
        type: 'emotion_extreme',
        dimension: dim,
        value: val,
        severity: (val - ANOMALY_THRESHOLDS.emotionExtreme) / (1 - ANOMALY_THRESHOLDS.emotionExtreme),
        description: `情绪 ${dim} 达到极端值 ${(val * 100).toFixed(0)}%`,
      });
    }
  }

  // 2. 检查情绪卡死（需要历史数据）
  try {
    const recentDrifts = db.prepare(`
      SELECT emotion_vector_json, created_at
      FROM drift_log
      ORDER BY created_at DESC
      LIMIT 10
    `).all();

    if (recentDrifts.length >= 5) {
      // 检查最近的情绪变化是否过小
      const vectors = recentDrifts.map(d => JSON.parse(d.emotion_vector_json));
      let maxChange = 0;

      for (let i = 1; i < vectors.length; i++) {
        for (const dim of EMOTION_KEYS) {
          const change = Math.abs((vectors[i][dim] || 0) - (vectors[i - 1][dim] || 0));
          maxChange = Math.max(maxChange, change);
        }
      }

      // 如果最大变化小于 0.01，可能情绪卡死
      if (maxChange < 0.01) {
        anomalies.push({
          type: 'emotion_stuck',
          maxChange,
          severity: 0.5,
          description: '情绪变化过小，可能卡在某个状态',
        });
      }
    }
  } catch (err) {
    // drift_log 表可能不存在，忽略
  }

  return anomalies;
}

/**
 * 检测叙事异常
 * @param {object} narrative
 * @param {DatabaseSync} db
 * @returns {Array<object>} 异常列表
 */
function detectNarrativeAnomalies(narrative, db) {
  const anomalies = [];

  if (!narrative?.narrative_text) {
    return anomalies;
  }

  try {
    // 检查核心身份
    const core = db.prepare(`SELECT identity_text FROM personality_core WHERE id = 1`).get();

    if (core?.identity_text) {
      // 简单的关键词匹配检查叙事是否偏离核心身份
      const coreKeywords = [(require('./settings').loadSettings().characterName || '大肥鱼'), '关心', '陪伴', '温暖'];
      const narrativeLower = narrative.narrative_text.toLowerCase();
      const matchCount = coreKeywords.filter(kw => narrativeLower.includes(kw)).length;
      const matchRatio = matchCount / coreKeywords.length;

      if (matchRatio < 0.25) {
        anomalies.push({
          type: 'narrative_drift',
          matchRatio,
          severity: (0.25 - matchRatio) / 0.25,
          description: '叙事层可能偏离核心身份',
        });
      }
    }

    // 检查最近的结晶化是否被拒绝
    const recentCrystallizations = db.prepare(`
      SELECT similarity_score, review_result_json, created_at
      FROM crystallization_events
      ORDER BY created_at DESC
      LIMIT 5
    `).all();

    const rejectedCount = recentCrystallizations.filter(c => {
      try {
        const review = JSON.parse(c.review_result_json || '{}');
        return review.passed === false;
      } catch {
        return false;
      }
    }).length;

    if (rejectedCount > 2) {
      anomalies.push({
        type: 'crystallization_rejected',
        rejectedCount,
        severity: 0.4,
        description: '最近多次结晶化被安全机制拒绝',
      });
    }

  } catch (err) {
    console.error('[Homeostasis] Narrative anomaly detection failed:', err);
  }

  return anomalies;
}

/**
 * 检测依恋异常
 * @param {object} attachmentState
 * @param {object} attachmentHealth
 * @returns {Array<object>} 异常列表
 */
function detectAttachmentAnomalies(attachmentState, attachmentHealth) {
  const anomalies = [];
  const { anxiety = 0.3, avoidance = 0.3 } = attachmentState || {};

  // 1. 高焦虑
  if (anxiety > ANOMALY_THRESHOLDS.attachmentImbalance) {
    anomalies.push({
      type: 'high_anxiety',
      value: anxiety,
      severity: (anxiety - ANOMALY_THRESHOLDS.attachmentImbalance) / (1 - ANOMALY_THRESHOLDS.attachmentImbalance),
      description: `依恋焦虑过高 (${(anxiety * 100).toFixed(0)}%)`,
    });
  }

  // 2. 高回避
  if (avoidance > ANOMALY_THRESHOLDS.attachmentImbalance) {
    anomalies.push({
      type: 'high_avoidance',
      value: avoidance,
      severity: (avoidance - ANOMALY_THRESHOLDS.attachmentImbalance) / (1 - ANOMALY_THRESHOLDS.attachmentImbalance),
      description: `依恋回避过高 (${(avoidance * 100).toFixed(0)}%)`,
    });
  }

  // 3. 混乱型依恋
  if (anxiety > 0.6 && avoidance > 0.6) {
    anomalies.push({
      type: 'disorganized_attachment',
      anxiety,
      avoidance,
      severity: 0.6,
      description: '混乱型依恋模式（焦虑+回避双高）',
    });
  }

  // 4. 依恋健康度低
  if (attachmentHealth?.score < 0.5) {
    anomalies.push({
      type: 'low_attachment_health',
      score: attachmentHealth.score,
      severity: (0.5 - attachmentHealth.score) / 0.5,
      description: `依恋健康度过低 (${(attachmentHealth.score * 100).toFixed(0)}%)`,
    });
  }

  return anomalies;
}

// ── 修复动作生成 ──────────────────────────────────────

/**
 * 生成修复动作
 * @param {Array<object>} anomalies - 检测到的异常列表
 * @returns {Array<object>} 修复动作列表
 */
function generateRepairActions(anomalies) {
  const actions = [];

  for (const anomaly of anomalies) {
    switch (anomaly.type) {
      case 'emotion_extreme':
        actions.push({
          type: REPAIR_ACTIONS.EMOTION_REGULATION,
          dimension: anomaly.dimension,
          severity: anomaly.severity,
          description: `调节极端情绪 ${anomaly.dimension}`,
          hint: '情绪可能需要回归基线，建议通过对话自然调节',
        });
        break;

      case 'emotion_stuck':
        actions.push({
          type: REPAIR_ACTIONS.CRYSTALLIZATION_TRIGGER,
          severity: anomaly.severity,
          description: '触发结晶化以打破情绪卡死',
          hint: '情绪变化过小，可能需要新的叙事来打破模式',
        });
        break;

      case 'narrative_drift':
        actions.push({
          type: REPAIR_ACTIONS.IDENTITY_REINFORCEMENT,
          severity: anomaly.severity,
          description: '强化核心身份',
          hint: '叙事层可能偏离核心身份，需要注入身份锚点',
        });
        break;

      case 'crystallization_rejected':
        actions.push({
          type: REPAIR_ACTIONS.MEMORY_CONSOLIDATION,
          severity: anomaly.severity,
          description: '整合记忆以改善结晶化',
          hint: '结晶化被拒绝，可能需要清理矛盾的漂移记录',
        });
        break;

      case 'high_anxiety':
      case 'high_avoidance':
      case 'disorganized_attachment':
        actions.push({
          type: REPAIR_ACTIONS.RELATIONSHIP_REPAIR,
          severity: anomaly.severity,
          description: '关系修复',
          hint: anomaly.type === 'high_anxiety'
            ? '用户可能需要更多确认，但不要过度承诺'
            : '用户可能需要更多空间，保持友好但不黏腻',
          // 提案优先级：依恋修复优先级较高
          priority: 0.85,
        });
        break;

      case 'low_attachment_health':
        actions.push({
          type: REPAIR_ACTIONS.RELATIONSHIP_REPAIR,
          severity: anomaly.severity,
          description: '关系健康度修复',
          hint: '依恋健康度低，需要调整互动策略',
          priority: 0.8,
        });
        break;
    }
  }

  return actions;
}

// ── 主要接口 ──────────────────────────────────────────

/**
 * 执行内稳态检查
 * 这是主入口，应该定期调用（但不与情绪衰减并行）
 * @param {DatabaseSync} db
 * @param {object} context - 上下文信息
 * @param {Record<string, number>} context.emotionVector - 当前情绪向量
 * @param {Record<string, number>} context.desireVector - 当前欲望向量
 * @param {object} context.attachmentState - 依恋状态
 * @param {object} context.attachmentHealth - 依恋健康度
 * @param {object} context.narrative - 当前叙事
 * @returns {{ healthVector: Record<string, number>, overallHealth: number, anomalies: Array, actions: Array }}
 */
function performHomeostasisCheck(db, context) {
  const {
    emotionVector = {},
    desireVector = {},
    attachmentState = {},
    attachmentHealth = {},
    narrative = null,
  } = context;

  // 1. 计算五维健康指标
  const healthVector = {
    emotionalStability: calculateEmotionalStability(emotionVector),
    memoryConsistency: calculateMemoryConsistency(db),
    personalityIntegrity: calculatePersonalityIntegrity(db, narrative),
    cognitiveClarity: calculateCognitiveClarity(emotionVector, desireVector),
    relationshipHarmony: calculateRelationshipHarmony(attachmentState, attachmentHealth),
  };

  // 2. 更新数据库
  for (const [dim, value] of Object.entries(healthVector)) {
    updateHealthMetric(db, dim, value);
  }

  // 3. 计算综合健康度
  const overallHealth = calculateOverallHealth(healthVector);

  // 4. 检测异常（仅在综合健康度低时才详细检测，避免误判）
  let anomalies = [];
  if (overallHealth < ANOMALY_THRESHOLDS.healthScoreCritical + 0.2) {
    anomalies = [
      ...detectEmotionAnomalies(emotionVector, db),
      ...detectNarrativeAnomalies(narrative, db),
      ...detectAttachmentAnomalies(attachmentState, attachmentHealth),
    ];
  }

  // 5. 生成修复动作
  const actions = generateRepairActions(anomalies);

  // 6. 记录事件
  if (anomalies.length > 0) {
    recordHomeostasisEvent(db, 'anomaly_detected', null, overallHealth, {
      anomalies,
      actions: actions.map(a => a.type),
    });
  }

  return {
    healthVector,
    overallHealth,
    anomalies,
    actions,
  };
}

/**
 * 获取内稳态概览
 * @param {DatabaseSync} db
 * @returns {object}
 */
function getHomeostasisOverview(db) {
  const healthVector = getHealthVector(db);
  const overallHealth = calculateOverallHealth(healthVector);
  const recentEvents = getHomeostasisEvents(db, 10);

  // 计算各维度的状态描述
  const dimensions = {};
  for (const [dim, config] of Object.entries(HEALTH_DIMENSIONS)) {
    const value = healthVector[dim] ?? 0.8;
    let status = 'healthy';
    if (value < config.threshold) {
      status = 'warning';
    }
    if (value < config.threshold * 0.7) {
      status = 'critical';
    }

    dimensions[dim] = {
      name: config.name,
      value,
      threshold: config.threshold,
      status,
      description: config.description,
    };
  }

  // 统计最近的异常
  const anomalyEvents = recentEvents.filter(e => e.event_type === 'anomaly_detected');
  const recentAnomalyCount = anomalyEvents.length;

  return {
    healthVector,
    overallHealth,
    dimensions,
    recentAnomalyCount,
    recentEvents: recentEvents.slice(0, 5),
    checkIntervalMs: CHECK_INTERVAL_MS,
  };
}

/**
 * 获取内稳态状态标签（用于设置页）
 * @param {object} overview
 * @returns {object}
 */
function getHomeostasisStatusTag(overview) {
  const { overallHealth, dimensions } = overview;

  // 综合状态
  let overallStatus = 'healthy';
  let overallLabel = '健康';
  let overallColor = '#28a745';

  if (overallHealth < 0.6) {
    overallStatus = 'critical';
    overallLabel = '异常';
    overallColor = '#dc3545';
  } else if (overallHealth < 0.75) {
    overallStatus = 'warning';
    overallLabel = '注意';
    overallColor = '#ffc107';
  }

  // 找出最弱的维度
  let weakestDim = null;
  let weakestValue = 1;
  for (const [dim, info] of Object.entries(dimensions)) {
    if (info.value < weakestValue) {
      weakestDim = dim;
      weakestValue = info.value;
    }
  }

  return {
    overallStatus,
    overallLabel,
    overallColor,
    overallHealth: Math.round(overallHealth * 100),
    weakestDimension: weakestDim ? dimensions[weakestDim]?.name : null,
    weakestValue: Math.round(weakestValue * 100),
  };
}

// ── 导出 ──────────────────────────────────────────────

module.exports = {
  // 常量
  HEALTH_DIMENSIONS,
  HEALTH_KEYS,
  ANOMALY_THRESHOLDS,
  REPAIR_ACTIONS,
  CHECK_INTERVAL_MS,

  // 初始化
  initHomeostasisTables,

  // 健康指标计算
  calculateEmotionalStability,
  calculateMemoryConsistency,
  calculatePersonalityIntegrity,
  calculateCognitiveClarity,
  calculateRelationshipHarmony,
  calculateOverallHealth,

  // 异常检测
  detectEmotionAnomalies,
  detectNarrativeAnomalies,
  detectAttachmentAnomalies,

  // 修复动作
  generateRepairActions,

  // 主要接口
  performHomeostasisCheck,
  getHomeostasisOverview,
  getHomeostasisStatusTag,

  // 数据库操作
  getHealthVector,
  getHomeostasisEvents,
};
