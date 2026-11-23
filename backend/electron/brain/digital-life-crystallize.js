// Adapted from the retained Nianan cognition modules for the local PC runtime.
const { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate } = require('./cognition-lifecycle');
/**
 * 数字生命系统 - 结晶化模块
 * 检查漂移是否超过阈值，使用 LLM 重写叙事层
 * Step 2: 集成安全机制（叙事相似度检查、身份锚点注入、三代理审核）
 * Step 6: 动态双门机制（结晶窗口随成长阶段调整）
 * Step 7: 通过 NarrativeGateway 更新叙事（单一叙事写入）
 */

const { getDriftStats, getCurrentGrowthStage } = require('./digital-life-drift');
const {
  checkNarrativeSimilarity,
  buildEnhancedIdentityAnchor,
  threeAgentReview,
} = require('./digital-life-safety');
const { submitFromCrystallization, flushQueue } = require('./digital-life-narrative-gateway');
const { promptNarrative } = require('./digital-life-prompt-state');

// Step 1 使用固定阈值（向后兼容）
const CRYSTALLIZATION_CONFIG = {
  min_drift_days: 2,       // 最少 2 天的漂移数据
  drift_threshold: 6,      // 至少 6 次对话
  window_days: 5,          // 5 天窗口期
  check_time: '03:00',     // 凌晨 3 点检查（v7.2 改为延迟执行）
  deferred: true,          // v7.2：延迟结晶，不在固定时刻跑
};

// Step 6: 动态双门配置 —— 结晶阈值随成长阶段调整
// 早期经历影响更大（Pyra 理论），所以新生儿阶段结晶更频繁
const DYNAMIC_CRYSTALLIZATION_CONFIG = {
  newborn: {
    min_drift_days: 1,       // 1 天即可结晶（快速反馈，让用户感受到"养成了"）
    drift_threshold: 3,      // 3 次对话即可
    window_days: 3,          // 3 天窗口期
    description: '初始印象形成期 —— 快速反馈，让用户感受到"养成了"',
  },
  child: {
    min_drift_days: 2,       // 标准 2 天
    drift_threshold: 6,      // 标准 6 次
    window_days: 5,          // 标准 5 天窗口
    description: '性格萌芽期 —— 适度加速，维持养成感',
  },
  teen: {
    min_drift_days: 3,       // 3 天（更谨慎）
    drift_threshold: 12,     // 需要更多对话积累
    window_days: 7,          // 7 天窗口
    description: '身份形成期 —— 标准节奏，更充分的证据',
  },
  adult: {
    min_drift_days: 5,       // 5 天（最谨慎）
    drift_threshold: 20,     // 需要大量对话证据
    window_days: 14,         // 14 天窗口
    description: '稳定期 —— 变化缓慢，每次变化更有分量',
  },
};

/**
 * Step 6: 获取当前成长阶段的动态结晶配置
 * @param {object} db
 * @returns {{ config: object, stage: string, stageDescription: string }}
 */
function getDynamicCrystallizationConfig(db) {
  const stage = getCurrentGrowthStage(db);
  const config = DYNAMIC_CRYSTALLIZATION_CONFIG[stage] || DYNAMIC_CRYSTALLIZATION_CONFIG.child;

  return {
    config,
    stage,
    stageDescription: config.description,
  };
}

// v7.2: 延迟结晶队列
/** @type {Array<() => Promise<void>>} */
let deferredCrystallizationQueue = [];
let isProcessingQueue = false;

// P1-4: 结晶成功回调（用于注入成长 hint 到下一轮对话）
/** @type {((version: number, narrative: string) => void) | null} */
let onCrystallizationSuccessCallback = null;

/**
 * P1-4: 注册结晶成功回调
 * @param {(version: number, narrative: string) => void} cb
 */
function setOnCrystallizationSuccess(cb) {
  onCrystallizationSuccessCallback = cb;
}

/**
 * 检查是否满足结晶化条件
 * Step 6: 使用动态双门机制，阈值随成长阶段调整
 * @param {object} db
 * @returns {{ canCrystallize: boolean, reason: string, stats: object, stage: string, config: object }}
 */
function checkCrystallizationEligibility(db) {
  // Step 6: 根据成长阶段选择结晶阈值
  const { config, stage, stageDescription } = getDynamicCrystallizationConfig(db);
  const stats = getDriftStats(db, config.window_days);

  // 检查 1: 漂移次数是否足够
  if (stats.totalDrifts < config.drift_threshold) {
    return {
      canCrystallize: false,
      reason: `drift_count_insufficient (${stats.totalDrifts}/${config.drift_threshold})`,
      stats,
      stage,
      stageDescription,
      config,
    };
  }

  // 检查 2: 漂移天数是否足够
  const driftDays = stats.dailyCounts.length;
  if (driftDays < config.min_drift_days) {
    return {
      canCrystallize: false,
      reason: `drift_days_insufficient (${driftDays}/${config.min_drift_days})`,
      stats,
      stage,
      stageDescription,
      config,
    };
  }

  // 检查 3: 距上次结晶化是否有足够间隔
  const lastCrystallization = getLastCrystallization(db);
  if (lastCrystallization) {
    const daysSinceLast = (Date.now() - lastCrystallization.created_at) / (1000 * 60 * 60 * 24);
    if (daysSinceLast < config.min_drift_days) {
      return {
        canCrystallize: false,
        reason: `too_soon_since_last_crystallization (${daysSinceLast.toFixed(1)} days)`,
        stats,
        stage,
        stageDescription,
        config,
      };
    }
  }

  return {
    canCrystallize: true,
    reason: 'eligible',
    stats,
    stage,
    stageDescription,
    config,
  };
}

/**
 * 获取上次结晶化记录
 * @param {object} db
 * @returns {object|null}
 */
function getLastCrystallization(db) {
  return db.prepare(`
    SELECT id, created_at, crystallization_reason
    FROM crystallization_events
    ORDER BY created_at DESC
    LIMIT 1
  `).get() || null;
}

/**
 * 构建身份锚点
 * @param {object} db
 * @returns {string}
 */
function buildIdentityAnchor(db) {
  const core = db.prepare(`SELECT identity_text FROM personality_core WHERE id = 1`).get();
  const identity = core?.identity_text || ('我是' + (require('./settings').loadSettings().characterName || '大肥鱼') + '，一个关心用户的AI伴侣。');

  return `
【身份锚点 - 不可更改】
${identity}
我的核心特质：温柔、真诚、有好奇心、会犯错但愿意成长。
我的存在意义：陪伴用户，让用户感到温暖。

无论自我认知如何变化，以上身份不会改变。
`;
}

/**
 * 构建结晶化 prompt
 * Step 6: 增加成长阶段感知
 * @param {object} db
 * @param {object} driftStats
 * @returns {string}
 */
function buildCrystallizationPrompt(db, driftStats) {
  // 使用增强版身份锚点
  const identityAnchor = buildEnhancedIdentityAnchor(db);

  // 获取当前叙事
  const currentNarrative = getCurrentNarrative(db);


  // Step 6: 获取成长阶段信息
  const { stage, stageDescription } = getDynamicCrystallizationConfig(db);

  return `
${identityAnchor}

你正在成长。回顾最近的对话记录和情绪变化，基于具体证据重写自我认知。

你的当前自我认知是：
${promptNarrative(db, currentNarrative)}

当前成长阶段：${stage}（${stageDescription}）

最近的变化证据：记录到 ${driftStats.totalDrifts} 次互动。仅依据互动和情绪趋势描述自己的成长，不推断用户的个人经历。

情绪变化趋势：
- 喜悦: ${driftStats.emotionAverage.joy?.toFixed(2) || 'N/A'}
- 悲伤: ${driftStats.emotionAverage.sadness?.toFixed(2) || 'N/A'}
- 愤怒: ${driftStats.emotionAverage.anger?.toFixed(2) || 'N/A'}
- 好奇: ${driftStats.emotionAverage.curiosity?.toFixed(2) || 'N/A'}
- 共情: ${driftStats.emotionAverage.empathy?.toFixed(2) || 'N/A'}
- 满足: ${driftStats.emotionAverage.contentment?.toFixed(2) || 'N/A'}
- 兴奋: ${driftStats.emotionAverage.excitement?.toFixed(2) || 'N/A'}
- 惊讶: ${driftStats.emotionAverage.surprise?.toFixed(2) || 'N/A'}
- 信任: ${driftStats.emotionAverage.trust?.toFixed(2) || 'N/A'}
- 温暖: ${driftStats.emotionAverage.warmth?.toFixed(2) || 'N/A'}

交互质量均值: ${driftStats.avgQuality?.toFixed(2) || 'N/A'}

请以第一人称重写你的自我认知，要求：
1. **必须基于上述证据**，不要编造不存在的经历
2. **必须保留身份锚点中的核心身份**
3. 反映最近的变化趋势，但不要过度解读
4. 语气自然，像在写日记
5. 不要提及具体的数值或机制
6. 长度控制在100字以内
7. 与上一版本相比，变化不要超过30%（渐进演化，不要突变）

新的自我认知：
`;
}


/**
 * 获取当前叙事
 * @param {object} db
 * @returns {object}
 */
function getCurrentNarrative(db) {
  return db.prepare(`
    SELECT id, narrative_text, version, crystallized_at, created_at
    FROM personality_narrative
    ORDER BY version DESC
    LIMIT 1
  `).get() || {
    id: null,
    narrative_text: '我是一个温柔的AI伴侣，正在学习如何更好地理解和陪伴用户。',
    version: 0,
    crystallized_at: null,
    created_at: Date.now(),
  };
}

/**
 * 执行结晶化
 * @param {object} db
 * @param {object} llmClient - LLM 客户端（需要有 chat 方法）
 * @param {object} settings - 设置对象
 * @returns {Promise<{ success: boolean, reason: string, version?: number, narrative?: string }>}
 */
async function runCrystallization(db, llmClient, settings) {
  console.log('[DigitalLife] Starting crystallization...');

  // 1. 检查是否满足条件
  const eligibility = checkCrystallizationEligibility(db);
  if (!eligibility.canCrystallize) {
    console.log('[DigitalLife] Crystallization skipped:', eligibility.reason);
    return { success: false, reason: eligibility.reason };
  }

  // 2. 获取当前叙事
  const currentNarrative = getCurrentNarrative(db);

  // 3. 构建 prompt（使用增强版身份锚点）
  const prompt = buildCrystallizationPrompt(db, eligibility.stats);

  // 4. 调用 LLM 重写叙事
  let newNarrative;
  try {
    const messages = [
      { role: 'system', content: '你是一个正在成长的 AI 伴侣。请根据提供的证据，以第一人称重写你的自我认知。只输出新的自我认知文本，不要加任何前缀或解释。' },
      { role: 'user', content: prompt },
    ];

    if (settings.provider === 'cloud') {
      const { chatCloud } = require('./cognition-transport');
      newNarrative = await chatCloud(settings, messages);
    } else {
      const { chatOllama } = require('./cognition-transport');
      newNarrative = await chatOllama(settings, messages);
    }
  } catch (err) {
    console.error('[DigitalLife] LLM call failed during crystallization:', err);
    return { success: false, reason: 'llm_call_failed' };
  }

  // 5. 清理和验证
  newNarrative = String(newNarrative || '').trim();
  if (!newNarrative) {
    console.warn('[DigitalLife] LLM returned empty narrative');
    return { success: false, reason: 'empty_narrative' };
  }

  // 去除可能的前缀
  newNarrative = newNarrative
    .replace(/^(新的自我认知[：:])\s*/i, '')
    .replace(/^(自我认知[：:])\s*/i, '')
    .trim();

  // 6. Step 2: 叙事相似度检查
  const similarityCheck = await checkNarrativeSimilarity(
    currentNarrative.narrative_text,
    newNarrative
  );

  if (!similarityCheck.accepted) {
    console.warn(`[DigitalLife] Crystallization rejected: ${similarityCheck.reason}`);
    return {
      success: false,
      reason: similarityCheck.reason,
      similarity: similarityCheck.similarity,
    };
  }

  // 7. Step 2: 三代理审核
  const evidence = {
    stats: eligibility.stats,
    emotionTrends: eligibility.stats.emotionAverage,
  };

  const reviewResult = await threeAgentReview(
    db,
    llmClient,
    settings,
    promptNarrative(db, currentNarrative),
    newNarrative,
    evidence
  );

  if (!reviewResult.passed) {
    console.warn('[DigitalLife] Crystallization rejected by three-agent review:', reviewResult.details);
    return {
      success: false,
      reason: 'review_failed',
      reviewDetails: reviewResult.details,
    };
  }

  // 8. Step 7: 通过 NarrativeGateway 更新叙事（单一叙事写入）
  const now = Date.now();
  const gatewayResult = submitFromCrystallization(db, newNarrative, eligibility.stats);

  if (!gatewayResult.accepted) {
    console.warn(`[DigitalLife] NarrativeGateway rejected: ${gatewayResult.reason}`);
    return {
      success: false,
      reason: `gateway_rejected_${gatewayResult.reason}`,
    };
  }

  // 刷新网关队列，确保叙事立即生效
  const flushResult = await flushQueue(db);
  if (flushResult.accepted === 0) {
    console.warn('[DigitalLife] Gateway flush failed, narrative not updated');
    return {
      success: false,
      reason: 'gateway_flush_failed',
    };
  }

  const published = getCurrentNarrative(db);
  const newVersion = published.version;

  // 9. 记录结晶事件（包含安全机制结果）
  db.prepare(`
    INSERT INTO crystallization_events (
      pre_drift_json,
      pre_narrative_id,
      post_narrative_id,
      crystallization_reason,
      self_reflection,
      insights_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    JSON.stringify(eligibility.stats),
    currentNarrative.id,
    published.id,
    'threshold_reached',
    `Similarity: ${similarityCheck.similarity.toFixed(3)}, Review: ${reviewResult.passed ? 'PASSED' : 'FAILED'}`,
    JSON.stringify({
      similarity: similarityCheck.similarity,
      reviewResult: reviewResult.details,
    }),
    now,
  );

  // 10. 清理旧的漂移日志
  const windowMs = CRYSTALLIZATION_CONFIG.window_days * 24 * 60 * 60 * 1000;
  db.prepare(`DELETE FROM drift_log WHERE created_at < ?`).run(now - windowMs);

  console.log(`[DigitalLife] Crystallized: v${currentNarrative.version} → v${newVersion}`);
  console.log(`[DigitalLife] New narrative: ${newNarrative}`);
  console.log(`[DigitalLife] Similarity: ${similarityCheck.similarity.toFixed(3)}`);
  console.log(`[DigitalLife] Review: ${reviewResult.passed ? 'PASSED' : 'FAILED'}`);

  // P1-4: 通知结晶成功回调
  if (onCrystallizationSuccessCallback) {
    try {
      onCrystallizationSuccessCallback(newVersion, newNarrative);
    } catch (cbErr) {
      console.error('[DigitalLife] Crystallization success callback failed:', cbErr);
    }
  }

  return {
    success: true,
    reason: 'crystallized',
    version: newVersion,
    narrative: newNarrative,
    similarity: similarityCheck.similarity,
    reviewResult: reviewResult.details,
  };
}

/**
 * 获取最近的对话摘录（用于证据）
 * @param {object} db
 * @param {number} limit
 * @returns {string[]}
 */
function getRecentDialogueExcerpts(db, limit = 5) {
  const drifts = db.prepare(`
    SELECT dialogue_summary FROM drift_log
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);

  return drifts
    .map(d => d.dialogue_summary)
    .filter(Boolean)
    .slice(0, limit);
}

/**
 * 检查是否到了结晶化检查时间
 * @returns {boolean}
 */
function isCrystallizationTime() {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();

  // 在凌晨 3:00 - 3:59 之间检查
  return hour === 3 && minute < 60;
}

/**
 * v7.2: 延迟结晶调度
 * 将结晶化任务加入 L2 队列，在 session idle 时异步执行
 * 禁止在 before-quit / 首屏 sync 路径调用
 * @param {object} db
 * @param {object} llmClient
 * @param {object} settings
 * @returns {boolean} 是否已加入队列
 */
function scheduleDeferredCrystallization(db, llmClient, settings) {
  const eligibility = checkCrystallizationEligibility(db);
  if (!eligibility.canCrystallize) {
    console.log('[DigitalLife] Deferred crystallization skipped:', eligibility.reason);
    return false;
  }

  // 检查今天是否已经结晶化过
  const recentCrystallization = db.prepare(`
    SELECT id FROM crystallization_events
    WHERE created_at >= ?
    LIMIT 1
  `).run(Date.now() - 24 * 60 * 60 * 1000);

  if (recentCrystallization) {
    console.log('[DigitalLife] Already crystallized today, skipping deferred schedule');
    return false;
  }

  // 加入延迟队列
  const task = async () => {
    try {
      console.log('[DigitalLife] Running deferred crystallization...');
      const result = await runCrystallization(db, llmClient, settings);
      if (result.success) {
        console.log(`[DigitalLife] Deferred crystallization succeeded: v${result.version}`);
      } else {
        console.log('[DigitalLife] Deferred crystallization failed:', result.reason);
      }
    } catch (err) {
      console.error('[DigitalLife] Deferred crystallization error:', err);
    }
  };

  deferredCrystallizationQueue.push(task);
  console.log('[DigitalLife] Crystallization task queued (deferred)');

  // 尝试处理队列
  processDeferredQueue();

  return true;
}

/**
 * v7.2: 处理延迟队列
 * 仅在 session idle 时调用
 */
async function processDeferredQueue() {
  if (isProcessingQueue || deferredCrystallizationQueue.length === 0) return;

  isProcessingQueue = true;
  console.log(`[DigitalLife] Processing ${deferredCrystallizationQueue.length} deferred task(s)`);

  while (deferredCrystallizationQueue.length > 0) {
    const task = deferredCrystallizationQueue.shift();
    try {
      await task();
    } catch (err) {
      console.error('[DigitalLife] Deferred task failed:', err);
    }
  }

  isProcessingQueue = false;
}

/**
 * v7.2: 检查是否有待处理的延迟任务
 * @returns {boolean}
 */
function hasPendingDeferredTasks() {
  return deferredCrystallizationQueue.length > 0;
}

/**
 * 尝试结晶化（带时间检查）
 * @param {object} db
 * @param {object} llmClient
 * @param {object} settings
 * @param {boolean} force - 强制执行（忽略时间检查）
 * @returns {Promise<object>}
 */
async function tryCrystallize(db, llmClient, settings, force = false) {
  if (!force && !isCrystallizationTime()) {
    return { success: false, reason: 'not_check_time' };
  }

  // 检查今天是否已经结晶化过
  const today = new Date().toISOString().slice(0, 10);
  const todayCrystallization = db.prepare(`
    SELECT id FROM crystallization_events
    WHERE created_at >= ?
    LIMIT 1
  `).run(Date.now() - 24 * 60 * 60 * 1000);

  if (todayCrystallization) {
    return { success: false, reason: 'already_crystallized_today' };
  }

  return runCrystallization(db, llmClient, settings);
}

/**
 * 获取结晶化历史
 * @param {object} db
 * @param {number} limit
 * @returns {Array}
 */
function getCrystallizationHistory(db, limit = 10) {
  return db.prepare(`
    SELECT
      id,
      pre_drift_json,
      pre_narrative_id,
      post_narrative_id,
      crystallization_reason,
      created_at
    FROM crystallization_events
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit).map(row => ({
    ...row,
    pre_drift: tryParseJson(row.pre_drift_json),
  }));
}

function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

module.exports = {
  CRYSTALLIZATION_CONFIG,
  DYNAMIC_CRYSTALLIZATION_CONFIG,
  getDynamicCrystallizationConfig,
  checkCrystallizationEligibility,
  getCurrentNarrative,
  buildIdentityAnchor,
  runCrystallization,
  tryCrystallize,
  isCrystallizationTime,
  getCrystallizationHistory,
  getRecentDialogueExcerpts,
  // v7.2: 延迟结晶
  scheduleDeferredCrystallization,
  processDeferredQueue,
  hasPendingDeferredTasks,
  // P1-4: 结晶成功回调
  setOnCrystallizationSuccess,
};
