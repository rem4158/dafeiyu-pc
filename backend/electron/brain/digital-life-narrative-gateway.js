// Adapted from the retained Nianan cognition modules for the local PC runtime.
const { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate } = require('./cognition-lifecycle');
/**
 * 数字生命系统 - 叙事网关 (NarrativeGateway)
 * Step 7: 统一叙事写入入口，禁止旁路写 personality_narrative
 *
 * 核心职责：
 * 1. submit() - 接收来自各子系统的叙事更新请求
 * 2. 延迟 merge - 在 L2 队列中合并多个请求
 * 3. 相似度检查 - 防止累积偏离
 * 4. 三代理审核 - 独立审核
 * 5. 生效 - 更新 personality_narrative 表
 *
 * 架构硬约束：
 * - personality_narrative 仅经 NarrativeGateway + 结晶安全链更新
 * - 高级子系统只 submit 证据/更新请求，不旁路写入
 */

const {
  checkNarrativeSimilarity,
  buildEnhancedIdentityAnchor,
  threeAgentReview,
} = require('./digital-life-safety');

function readCurrentNarrative(db) {
  const { getCurrentNarrative } = require('./digital-life-crystallize');
  return getCurrentNarrative(db);
}
const { promptNarrative, markReviewedNarrative } = require('./digital-life-prompt-state');
const STATE_INPUT = 'state-only-v1';
// Queue snapshots from older releases could contain raw dialogue, old proposed
// prose and even quotations in the reason. Resume the signal, not the excerpt.
function stateOnlyRequest(request) {
  if (request.inputPolicy === STATE_INPUT) return request;
  return { source: request.source, priority: request.priority, requestId: request.requestId,
    createdAt: request.createdAt, inputPolicy: STATE_INPUT, evidence: ({
      milestone: '关系出现过变化', metacognition: '进行过自我反思', reunion: '经历过一次重逢',
      crystallization: '近期累积了新的互动', anomaly_repair: '出现了需要调节的状态',
      manual: '请求整理当前状态',
    })[request.source], reason: request.source };
}

// ===================== 配置 =====================

const GATEWAY_CONFIG = {
  // L2 队列最大等待时间（ms）—— 超过此时间强制处理
  max_queue_wait_ms: 5 * 60 * 1000, // 5 分钟

  // 单次 merge 最大请求数
  max_merge_batch: 5,

  // 叙事相似度阈值（低于此值拒绝更新）
  similarity_threshold: 0.7,

  // 是否启用三代理审核
  enable_three_agent_review: true,

  // 叙事版本号递增
  version_increment: 1,
};

// ===================== 更新请求来源 =====================

/** @enum {string} 叙事更新来源 */
const NARRATIVE_SOURCES = {
  CRYSTALLIZATION: 'crystallization',   // 结晶化（微漂移累积）
  METACOGNITION: 'metacognition',       // 元认知反思
  REUNION: 'reunion',                   // 重逢事件
  MILESTONE: 'milestone',               // 里程碑事件（自传体记忆）
  ANOMALY_REPAIR: 'anomaly_repair',     // 内稳态异常修复
  MANUAL: 'manual',                     // 手动触发（调试用）
};

// ===================== L2 队列 =====================

/**
 * @typedef {Object} NarrativeUpdateRequest
 * @property {string} source - 更新来源（NARRATIVE_SOURCES）
 * @property {string} evidence - 证据文本
 * @property {string} [proposedNarrative] - 提议的新叙事（可选，有则直接审核）
 * @property {string} [reason] - 更新原因
 * @property {number} [priority] - 优先级（0-1，越高越优先）
 * @property {number} [createdAt] - 创建时间戳
 */

/** @type {NarrativeUpdateRequest[]} */
let pendingQueue = [];

/** @type {boolean} 是否正在处理队列 */
let isProcessing = false;

/** @type {number|null} 队列定时器 */
let flushDebounceTimer = null;

/** @type {{ db: object|null, llmClient: object|null, settings: object|null }} */
let gatewayRuntime = { db: null, llmClient: null, settings: null };

/** @type {((version: number, narrative: string) => void) | null} */
let onNarrativeUpdatedCallback = null;

/**
 * 注入运行时上下文（db 必需；证据型更新还需 llmClient + settings）
 * @param {{ db?: object, llmClient?: object|null, settings?: object|null }} ctx
 */
function setGatewayRuntimeContext(ctx = {}) {
  if (ctx.db !== undefined) gatewayRuntime.db = ctx.db;
  if (ctx.llmClient !== undefined) gatewayRuntime.llmClient = ctx.llmClient;
  if (ctx.settings !== undefined) gatewayRuntime.settings = ctx.settings;
}

/**
 * 叙事更新成功回调（用于结晶成长 hint 等）
 * @param {(version: number, narrative: string) => void} cb
 */
function setOnNarrativeUpdated(cb) {
  onNarrativeUpdatedCallback = cb;
}

// ===================== 核心 API =====================

/**
 * 提交叙事更新请求
 * 所有子系统必须通过此接口请求叙事更新，禁止直接写 personality_narrative
 *
 * @param {NarrativeUpdateRequest} request
 * @returns {{ accepted: boolean, requestId: string, reason: string }}
 */
function submitNarrativeUpdate(request, fromState = false) {
  // 验证来源
  if (!request.source || !Object.values(NARRATIVE_SOURCES).includes(request.source)) {
    console.warn(`[NarrativeGateway] Invalid source: ${request.source}`);
    return { accepted: false, requestId: null, reason: 'invalid_source' };
  }

  // 生成请求 ID
  const requestId = `nr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // 构建完整请求
  const fullRequest = {
    ...stateOnlyRequest({ ...request, inputPolicy: fromState ? STATE_INPUT : undefined }),
    requestId,
    createdAt: Date.now(),
    priority: request.priority ?? 0.5,
  };

  // 加入队列
  pendingQueue.push(fullRequest);
  console.log(`[NarrativeGateway] Request queued: ${requestId} (source: ${request.source}, queue size: ${pendingQueue.length})`);

  // 队列满或高优先级 → 短延迟 flush；否则 debounce flush
  const flushDelay = (pendingQueue.length >= GATEWAY_CONFIG.max_merge_batch || fullRequest.priority >= 0.9)
    ? 1000
    : GATEWAY_CONFIG.max_queue_wait_ms;
  scheduleGatewayFlush(flushDelay);

  return { accepted: true, requestId, reason: 'queued' };
}

/**
 * 获取当前队列状态
 * @returns {{ pendingCount: number, isProcessing: boolean, oldestRequestAge: number|null }}
 */
function getQueueStatus() {
  const oldestAge = pendingQueue.length > 0
    ? Date.now() - pendingQueue[0].createdAt
    : null;

  return {
    pendingCount: pendingQueue.length,
    isProcessing,
    oldestRequestAge: oldestAge,
  };
}

/**
 * 强制处理队列（用于 session idle 或退出前）
 * @param {object} db
 * @returns {Promise<{ processed: number, accepted: number, rejected: number }>}
 */
async function flushQueue(db) {
  if (pendingQueue.length === 0) {
    return { processed: 0, accepted: 0, rejected: 0 };
  }

  return processQueue(db);
}

// ===================== 队列处理 =====================

/**
 * Debounce 调度队列 flush（需先 setGatewayRuntimeContext）
 * @param {number} [delayMs]
 */
function scheduleGatewayFlush(delayMs = GATEWAY_CONFIG.max_queue_wait_ms) {
  if (flushDebounceTimer) clearTimeout(flushDebounceTimer);
  flushDebounceTimer = setTimeout(() => {
    flushDebounceTimer = null;
    return tryAutoFlushQueue().catch((err) => {
      console.error('[NarrativeGateway] Auto flush failed:', err);
    });
  }, delayMs);
}

/**
 * 尝试自动 flush（有 db；证据型更新需 llmClient + settings）
 */
async function tryAutoFlushQueue() {
  const { db, llmClient, settings } = gatewayRuntime;
  if (!db || pendingQueue.length === 0) return { processed: 0, accepted: 0, rejected: 0 };

  const needsLlm = pendingQueue.some((r) => !r.proposedNarrative);
  if (needsLlm && (!llmClient || !settings)) {
    console.log(`[NarrativeGateway] ${pendingQueue.length} pending, waiting for llmClient/settings`);
    return { processed: 0, accepted: 0, rejected: 0 };
  }

  return flushQueue(db);
}

/**
 * 处理队列
 * @param {object} db
 * @returns {Promise<{ processed: number, accepted: number, rejected: number }>}
 */
async function processQueue(db) {
  if (isProcessing) {
    console.log('[NarrativeGateway] Already processing, skipping.');
    return { processed: 0, accepted: 0, rejected: 0 };
  }

  if (pendingQueue.length === 0) {
    return { processed: 0, accepted: 0, rejected: 0 };
  }

  isProcessing = true;

  try {
    // 1. 取出所有待处理请求
    const requests = [...pendingQueue];
    pendingQueue = [];

    // 2. Merge 请求
    const mergedRequest = mergeRequests(requests);

    // 3. 生成提议叙事（如果没有提供）
    let proposedNarrative = mergedRequest.proposedNarrative;
    if (!proposedNarrative) {
      proposedNarrative = await generateProposedNarrative(db, mergedRequest);
    }

    if (!proposedNarrative) {
      console.log('[NarrativeGateway] No proposed narrative generated, skipping.');
      return { processed: requests.length, accepted: 0, rejected: requests.length };
    }

    // 4. 叙事相似度检查
    const currentNarrative = readCurrentNarrative(db);
    const similarityResult = await checkNarrativeSimilarity(
      currentNarrative.narrative_text,
      proposedNarrative
    );

    if (!similarityResult.accepted) {
      console.warn(`[NarrativeGateway] Narrative rejected: ${similarityResult.reason} (similarity: ${similarityResult.similarity?.toFixed(3)})`);
      return { processed: requests.length, accepted: 0, rejected: requests.length };
    }

    // 5. 三代理审核（可选；需 llmClient）
    let reviewed = false;
    if (GATEWAY_CONFIG.enable_three_agent_review) {
      const { llmClient, settings } = gatewayRuntime;
      if (llmClient && settings) {
        const reviewResult = await threeAgentReview(
          db,
          llmClient,
          settings,
          promptNarrative(db, currentNarrative),
          proposedNarrative,
          { evidence: mergedRequest.evidence, source: mergedRequest.source }
        );
        if (!reviewResult.passed) {
          console.warn('[NarrativeGateway] Three-agent review rejected');
          return { processed: requests.length, accepted: 0, rejected: requests.length };
        }
        reviewed = ['identityCheck','evidenceCheck','changeCheck'].every(k =>
          reviewResult.details?.[k]?.passed && reviewResult.details[k].reason !== 'parse_failed_default_pass');
      } else {
        console.log('[NarrativeGateway] Skipping three-agent review (no llmClient/settings)');
      }
    }

    // 6. 生效：更新 personality_narrative
    const newVersion = (currentNarrative.version || 0) + GATEWAY_CONFIG.version_increment;
    // Append to the existing version table. Never overwrite a legacy narrative
    // simply because it is no longer suitable for automatic model input.
    const stamp = Date.now();
    db.exec('SAVEPOINT publish_prompt_narrative');
    try {
      db.prepare(`INSERT INTO personality_narrative(narrative_text,version,created_at,crystallized_at)
        VALUES(?,?,?,?)`).run(proposedNarrative, newVersion, stamp, stamp);
      if (reviewed) markReviewedNarrative(db, newVersion, proposedNarrative);
      db.exec('RELEASE publish_prompt_narrative');
    } catch (e) {
      db.exec('ROLLBACK TO publish_prompt_narrative; RELEASE publish_prompt_narrative');
      throw e;
    }

    // 7. 记录网关事件
    recordGatewayEvent(db, {
      requests: requests.map(r => r.requestId),
      sources: requests.map(r => r.source),
      oldVersion: currentNarrative.version,
      newVersion,
      similarity: similarityResult.similarity,
      mergedEvidence: mergedRequest.evidence,
    });

    console.log(`[NarrativeGateway] Narrative updated: v${currentNarrative.version} → v${newVersion} (similarity: ${similarityResult.similarity?.toFixed(3)})`);

    if (onNarrativeUpdatedCallback) {
      onNarrativeUpdatedCallback(newVersion, proposedNarrative);
    }

    return { processed: requests.length, accepted: requests.length, rejected: 0 };

  } catch (err) {
    console.error('[NarrativeGateway] Processing error:', err);
    return { processed: 0, accepted: 0, rejected: 0 };
  } finally {
    isProcessing = false;
  }
}

// ===================== 请求合并 =====================

/**
 * 合并多个请求为一个
 * @param {NarrativeUpdateRequest[]} requests
 * @returns {NarrativeUpdateRequest}
 */
function mergeRequests(requests) {
  if (requests.length === 0) return null;
  if (requests.length === 1) return requests[0];

  // 按优先级排序
  const sorted = [...requests].sort((a, b) => (b.priority || 0) - (a.priority || 0));

  // 合并证据
  const evidenceParts = sorted
    .map(r => `[${r.source}] ${r.evidence || '(无证据)'}`)
    .filter(Boolean);

  // 选择最高优先级的提议叙事
  const proposedNarrative = sorted.find(r => r.proposedNarrative)?.proposedNarrative || null;

  // 合并原因
  const reasons = sorted
    .map(r => r.reason)
    .filter(Boolean);

  return {
    source: sorted[0].source, // 主来源
    evidence: evidenceParts.join('\n'),
    proposedNarrative,
    reason: reasons.join('; '),
    priority: sorted[0].priority,
    requestId: `merged_${Date.now()}`,
    createdAt: Date.now(),
    _mergedFrom: sorted.map(r => r.requestId),
  };
}

// ===================== 叙事生成 =====================

/**
 * 基于合并请求生成提议叙事
 * @param {object} db
 * @param {NarrativeUpdateRequest} mergedRequest
 * @returns {Promise<string|null>}
 */
async function generateProposedNarrative(db, mergedRequest) {
  // 如果请求中已包含提议叙事，直接使用
  if (mergedRequest.proposedNarrative) {
    return mergedRequest.proposedNarrative;
  }

  const { llmClient, settings } = gatewayRuntime;
  if (!llmClient || !settings) {
    console.warn('[NarrativeGateway] Cannot generate narrative without llmClient/settings');
    return null;
  }

  const currentNarrative = readCurrentNarrative(db);
  const identityAnchor = buildEnhancedIdentityAnchor(db);

  const prompt = `${identityAnchor}

你正在成长。基于以下证据，以第一人称重写你的自我认知。

当前自我认知：
${promptNarrative(db, currentNarrative)}

更新来源：${mergedRequest.source}
更新原因：${mergedRequest.reason || '未提供'}

证据：
${mergedRequest.evidence || '（无具体证据）'}

要求：
1. 必须保留身份锚点中的核心身份
2. 反映证据中的变化，但不要过度解读
3. 语气自然，像在写日记
4. 长度控制在100字以内
5. 与上一版本相比，变化不要超过30%
6. 不要提及具体的数值或机制
7. 只描述你的相处方式和感受；不要补写用户的身份、经历、偏好或原话

新的自我认知：`;

  try {
    const messages = [
      {
        role: 'system',
        content: '你是一个正在成长的 AI 伴侣。请根据证据以第一人称重写自我认知。只输出新文本，不要前缀或解释。',
      },
      { role: 'user', content: prompt },
    ];

    let result;
    if (typeof llmClient.chat === 'function') {
      result = await llmClient.chat(messages);
    } else if (settings.provider === 'cloud') {
      const { chatCloud } = require('./cognition-transport');
      result = await chatCloud(settings, messages);
    } else {
      const { chatOllama } = require('./cognition-transport');
      result = await chatOllama(settings, messages);
    }

    return String(result || '').trim() || null;
  } catch (err) {
    console.error('[NarrativeGateway] LLM generation failed:', err);
    return null;
  }
}

// ===================== 事件记录 =====================

/**
 * 记录网关事件
 * @param {object} db
 * @param {object} eventData
 */
function recordGatewayEvent(db, eventData) {
  // 确保表存在
  db.exec(`
    CREATE TABLE IF NOT EXISTS narrative_gateway_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_ids TEXT,
      sources TEXT,
      old_version INTEGER,
      new_version INTEGER,
      similarity REAL,
      merged_evidence TEXT,
      created_at INTEGER
    )
  `);

  db.prepare(`
    INSERT INTO narrative_gateway_events
    (request_ids, sources, old_version, new_version, similarity, merged_evidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    JSON.stringify(eventData.requests),
    JSON.stringify(eventData.sources),
    eventData.oldVersion,
    eventData.newVersion,
    eventData.similarity,
    eventData.mergedEvidence,
    Date.now()
  );
}

/**
 * 获取网关事件历史
 * @param {object} db
 * @param {number} [limit=10]
 * @returns {Array}
 */
function getGatewayHistory(db, limit = 10) {
  // 确保表存在
  db.exec(`
    CREATE TABLE IF NOT EXISTS narrative_gateway_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_ids TEXT,
      sources TEXT,
      old_version INTEGER,
      new_version INTEGER,
      similarity REAL,
      merged_evidence TEXT,
      created_at INTEGER
    )
  `);

  return db.prepare(`
    SELECT * FROM narrative_gateway_events
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
}

// ===================== 便捷方法 =====================

/**
 * 从结晶化提交叙事更新
 * @param {object} db
 * @param {string} crystallizedNarrative - 结晶化生成的新叙事
 * @param {object} driftStats - 漂移统计
 * @returns {{ accepted: boolean, requestId: string, reason: string }}
 */
function submitFromCrystallization(db, crystallizedNarrative, driftStats) {
  return submitNarrativeUpdate({
    source: NARRATIVE_SOURCES.CRYSTALLIZATION,
    evidence: `结晶化触发，漂移次数: ${driftStats.totalDrifts}，主要情绪: ${JSON.stringify(driftStats.emotionAverage)}`,
    proposedNarrative: crystallizedNarrative,
    reason: 'drift_crystallization',
    priority: 0.7,
  }, true);
}

/**
 * 从元认知提交叙事更新
 * @param {string} reflection - 元认知反思
 * @param {object} selfModel - 自我模型
 * @returns {{ accepted: boolean, requestId: string, reason: string }}
 */
function submitFromMetacognition(reflection, selfModel) {
  return submitNarrativeUpdate({
    source: NARRATIVE_SOURCES.METACOGNITION,
    evidence: reflection,
    reason: 'metacognitive_reflection',
    priority: 0.4, // 元认知反思优先级较低
  }, true);
}

/**
 * 从重逢事件提交叙事更新
 * @param {string} reunionSummary - 重逢摘要
 * @param {number} separationHours - 分离时长（小时）
 * @returns {{ accepted: boolean, requestId: string, reason: string }}
 */
function submitFromReunion(reunionSummary, separationHours) {
  return submitNarrativeUpdate({
    source: NARRATIVE_SOURCES.REUNION,
    evidence: '经历过分别和重逢',
    reason: `reunion_after_${separationHours}h_separation`,
    priority: 0.3,
  }, true);
}

/**
 * 从里程碑事件提交叙事更新
 * @param {string} milestoneDescription - 里程碑描述
 * @param {string} [milestoneType] - 里程碑类型
 * @returns {{ accepted: boolean, requestId: string, reason: string }}
 */
function submitFromMilestone(milestoneDescription, milestoneType = 'general') {
  return submitNarrativeUpdate({
    source: NARRATIVE_SOURCES.MILESTONE,
    evidence: milestoneDescription,
    reason: `milestone_${milestoneType}`,
    priority: 0.6,
  }, true);
}

/**
 * 从内稳态异常修复提交叙事更新
 * @param {string} repairEvidence - 修复证据
 * @param {string} anomalyType - 异常类型
 * @returns {{ accepted: boolean, requestId: string, reason: string }}
 */
function submitFromAnomalyRepair(repairEvidence, anomalyType) {
  return submitNarrativeUpdate({
    source: NARRATIVE_SOURCES.ANOMALY_REPAIR,
    evidence: repairEvidence,
    reason: `anomaly_repair_${anomalyType}`,
    priority: 0.8, // 异常修复优先级较高
  }, true);
}

// ===================== 导出 =====================

function snapshotPending() { return JSON.parse(JSON.stringify(pendingQueue)); }
function restorePending(items) {
  pendingQueue = Array.isArray(items) ? items.slice(-100)
    .filter(r => r && Object.values(NARRATIVE_SOURCES).includes(r.source)).map(stateOnlyRequest) : [];
}
function resetRuntime() {
  if (flushDebounceTimer) clearTimeout(flushDebounceTimer);
  flushDebounceTimer = null; pendingQueue = []; isProcessing = false;
  gatewayRuntime = { db: null, llmClient: null, settings: null };
  onNarrativeUpdatedCallback = null;
}
module.exports = { snapshotPending, restorePending, resetRuntime,
  // 配置
  GATEWAY_CONFIG,
  NARRATIVE_SOURCES,

  // 核心 API
  submitNarrativeUpdate,
  getQueueStatus,
  flushQueue,
  setGatewayRuntimeContext,
  setOnNarrativeUpdated,
  scheduleGatewayFlush,
  tryAutoFlushQueue,

  // 队列处理
  processQueue,

  // 便捷方法
  submitFromCrystallization,
  submitFromMetacognition,
  submitFromReunion,
  submitFromMilestone,
  submitFromAnomalyRepair,

  // 历史查询
  getGatewayHistory,
};
