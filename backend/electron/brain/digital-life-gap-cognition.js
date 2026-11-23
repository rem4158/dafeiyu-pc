// Adapted from the retained Nianan cognition modules for the local PC runtime.
const { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate } = require('./cognition-lifecycle');
/**
 * 数字生命系统 - 间隙认知模块（Gap Cognition）
 * Step 9: 托盘 L0 tick + 会话间隙合成 + 延迟结晶调度 + 记忆整合
 *
 * v7.2 设计原则：
 * - 桌面 EXE 关进程即停，间隙认知不是 24h 后台意识模拟
 * - 状态冻结 → 恢复时补演；优先在托盘挂机中做轻量 tick
 * - 完全退出则全部推迟到下次 session 开始
 * - 产出经 drift 或 NarrativeGateway，不直写叙事
 *
 * 三大能力：
 * 1. 托盘挂机 L0 tick（欲望缓涨、pending 标志；禁止 tick 内 LLM）
 * 2. 会话间隙合成 Session Gap Synthesis（L2 异步，不挡首屏）
 * 3. 延迟结晶调度（替代凌晨定时；idle 队列执行）
 *
 * 遵守 §2.2 生命周期铁律：
 * - Quit 路径禁止同步 LLM
 * - First Paint 路径禁止同步 LLM；L0/L1 only
 * - L2 任务仅在会话已打开、对话 idle 或托盘 marked 后异步执行
 */

const { DatabaseSync } = require('node:sqlite');

// ── 配置 ──────────────────────────────────────────────

/** 托盘挂机 L0 tick 配置 */
const TRAY_IDLE_CONFIG = {
  tick_interval_minutes: 30,
  daily_tick_limit: 48,
  /** 仅 L0 操作：欲望缓涨、写 pending 标志；禁止 tick 内 LLM */
  allowed_ops: ['updateDesires', 'markPendingReunion', 'markPendingCrystallization'],
};

/** 会话间隙合成配置 */
const SESSION_GAP_CONFIG = {
  /** 触发合成的最小分离时长（小时） */
  synthesis_min_gap_hours: 8,
  /** LLM 增强的最小分离时长（小时） */
  llm_enhancement_min_gap_hours: 24,
  /** 间隙洞察最大保留条数 */
  max_gap_insights: 20,
  /** 间隔合成冷却（小时）—— 同一分离期间不重复合成 */
  cooldown_hours: 4,
};

/** @type {NodeJS.Timeout|null} */
let trayTickTimer = null;

/** @type {number} 今日已执行 tick 次数 */
let dailyTickCount = 0;

/** @type {string} tick 计数重置日期 */
let dailyTickCountDate = '';

/** @type {boolean} 是否正在执行 L2 任务 */
let isL2Running = false;

/** @type {Array<() => Promise<void>>} L2 异步任务队列 */
let l2Queue = [];

// ── 数据库迁移 ────────────────────────────────────────

/**
 * 创建间隙认知相关表（v8 迁移）
 * @param {DatabaseSync} db
 */
function initGapCognitionTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gap_cognition_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      gap_hours REAL,
      insight_text TEXT,
      suggested_topics_json TEXT,
      source_context_json TEXT,
      llm_enhanced INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gap_cognition_type ON gap_cognition_events(event_type, created_at);
  `);

  // 初始化 tick 计数
  resetDailyTickCountIfNeeded();

  console.log('[GapCognition] Tables initialized');
}

// ── 托盘挂机：轻量 L0 Tick ────────────────────────────

/**
 * 启动托盘挂机 tick 定时器
 * 仅在托盘挂机态（进程仍在）时运行
 * @param {object} params
 * @param {DatabaseSync} params.db
 * @param {function} params.onTick - tick 回调（可选，用于日志）
 */
function startTrayTick({ db, onTick }) {
  stopTrayTick();

  const intervalMs = TRAY_IDLE_CONFIG.tick_interval_minutes * 60 * 1000;

  trayTickTimer = setInterval(() => {
    try {
      const result = runTrayTick(db);
      if (onTick) onTick(result);
    } catch (err) {
      console.error('[GapCognition] Tray tick failed:', err);
    }
  }, intervalMs);

  console.log(`[GapCognition] Tray tick started (interval: ${TRAY_IDLE_CONFIG.tick_interval_minutes}min)`);
}

/**
 * 停止托盘挂机 tick 定时器
 */
function stopTrayTick() {
  if (trayTickTimer) {
    clearInterval(trayTickTimer);
    trayTickTimer = null;
    console.log('[GapCognition] Tray tick stopped');
  }
}

/**
 * 执行一次托盘 L0 tick
 * 仅允许 L0 操作（纯数学，无 LLM）
 * @param {DatabaseSync} db
 * @returns {{ tickCount: number, desireUpdated: boolean, pendingMarked: boolean }}
 */
function runTrayTick(db) {
  resetDailyTickCountIfNeeded();

  // 检查每日上限
  if (dailyTickCount >= TRAY_IDLE_CONFIG.daily_tick_limit) {
    console.log('[GapCognition] Daily tick limit reached, skipping');
    return { tickCount: dailyTickCount, desireUpdated: false, pendingMarked: false };
  }

  dailyTickCount++;
  const now = Date.now();

  // 1. 欲望缓涨（L0，纯数学）
  let desireUpdated = false;
  try {
    const { updateDesires } = require('./digital-life-desire');
    const minutesSinceLastTick = TRAY_IDLE_CONFIG.tick_interval_minutes;
    const hoursSinceLastTick = minutesSinceLastTick / 60;
    updateDesires({ hoursSinceLastInteraction: hoursSinceLastTick });
    desireUpdated = true;
  } catch (err) {
    console.error('[GapCognition] Desire tick failed:', err);
  }

  // 2. 标记 pending（检查是否需要结晶化）
  let pendingMarked = false;
  try {
    const { checkCrystallizationEligibility } = require('./digital-life-crystallize');
    const eligibility = checkCrystallizationEligibility(db);
    if (eligibility.canCrystallize) {
      markPendingCrystallization(db, now);
      pendingMarked = true;
    }
  } catch (err) {
    console.error('[GapCognition] Pending check failed:', err);
  }

  // 3. 记录 tick 事件
  try {
    db.prepare(`
      INSERT INTO gap_cognition_events (event_type, gap_hours, insight_text, created_at)
      VALUES ('tray_tick', 0, ?, ?)
    `).run(
      JSON.stringify({ desireUpdated, pendingMarked, tickCount: dailyTickCount }),
      now,
    );
  } catch (err) {
    // 静默失败
  }

  return { tickCount: dailyTickCount, desireUpdated, pendingMarked };
}

/**
 * 标记待处理结晶化
 * @param {DatabaseSync} db
 * @param {number} now
 */
function markPendingCrystallization(db, now) {
  // 写入 pending 标记（幂等：同一小时内不重复写入）
  const recentMark = db.prepare(`
    SELECT id FROM gap_cognition_events
    WHERE event_type = 'pending_crystallization'
      AND created_at >= ?
    LIMIT 1
  `).get(now - 60 * 60 * 1000);

  if (!recentMark) {
    db.prepare(`
      INSERT INTO gap_cognition_events (event_type, created_at)
      VALUES ('pending_crystallization', ?)
    `).run(now);
  }
}

/**
 * 重置每日 tick 计数（跨天时）
 */
function resetDailyTickCountIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyTickCountDate !== today) {
    dailyTickCount = 0;
    dailyTickCountDate = today;
  }
}

// ── 会话间隙合成（Session Gap Synthesis）────────────────

/**
 * 执行会话间隙合成
 * 触发：用户再次打开聊天 / 从完全退出恢复，且 gapHours >= threshold
 *
 * 流程（L2 异步，不挡首屏）：
 * 1. 收集上次会话上下文（摘要、情绪、依恋、欲望）
 * 2. 基于模板生成间隙洞察（L0 同步）
 * 3. 可选 LLM 增强（L2 异步，仅 gap >= 24h）
 * 4. 产出写入 gap_cognition_events，供重逢首句或后续对话使用
 *
 * @param {object} params
 * @param {DatabaseSync} params.db
 * @param {number} params.gapHours - 分离时长（小时）
 * @param {object} [params.lastSessionContext] - 上次会话上下文
 * @returns {{ insight: object|null, suggestedTopics: string[], llmEnhancementScheduled: boolean }}
 */
function sessionGapSynthesis({ db, gapHours, lastSessionContext = {} }) {
  if (gapHours < SESSION_GAP_CONFIG.synthesis_min_gap_hours) {
    return { insight: null, suggestedTopics: [], llmEnhancementScheduled: false };
  }

  // 检查冷却（同一分离期间不重复合成）
  const cooldownMs = SESSION_GAP_CONFIG.cooldown_hours * 60 * 60 * 1000;
  const recentSynthesis = db.prepare(`
    SELECT id, created_at FROM gap_cognition_events
    WHERE event_type IN ('gap_synthesis', 'gap_synthesis_llm')
    ORDER BY created_at DESC
    LIMIT 1
  `).get();

  if (recentSynthesis && (Date.now() - recentSynthesis.created_at) < cooldownMs) {
    console.log('[GapCynthesis] Cooldown active, skipping');
    return { insight: null, suggestedTopics: [], llmEnhancementScheduled: false };
  }

  // 收集上下文
  const context = collectSessionContext(db, lastSessionContext);

  // 模板化洞察生成（L0 同步，无 LLM）
  const insight = generateTemplateInsight(gapHours, context);

  // 建议话题
  const suggestedTopics = generateSuggestedTopics(gapHours, context);

  // 写入事件表
  const now = Date.now();
  db.prepare(`
    INSERT INTO gap_cognition_events (
      event_type, gap_hours, insight_text, suggested_topics_json,
      source_context_json, llm_enhanced, created_at
    ) VALUES ('gap_synthesis', ?, ?, ?, ?, 0, ?)
  `).run(
    gapHours,
    insight.text,
    JSON.stringify(suggestedTopics),
    JSON.stringify({
      emotion: context.emotion,
      attachment: context.attachmentQuadrant,
      recentTopics: context.recentTopics,
    }),
    now,
  );

  console.log(`[GapCognition] Gap synthesis complete (${gapHours.toFixed(1)}h): "${insight.text}"`);

  // LLM 增强（仅 gap >= 24h，L2 异步）
  let llmEnhancementScheduled = false;
  if (gapHours >= SESSION_GAP_CONFIG.llm_enhancement_min_gap_hours) {
    llmEnhancementScheduled = true;
    enqueueL2Task(() => enhanceGapInsightWithLLM({
      db,
      gapHours,
      insight,
      context,
    }));
  }

  return { insight, suggestedTopics, llmEnhancementScheduled };
}

/**
 * 收集会话上下文（L0 同步，无 LLM）
 * @param {DatabaseSync} db
 * @param {object} lastSessionContext
 * @returns {object}
 */
function collectSessionContext(db, lastSessionContext) {
  const result = {
    emotion: {},
    attachmentQuadrant: 'secure',
    desireOverview: null,
    recentTopics: [],
    narrative: null,
    growthStage: 'child',
  };

  try {
    // 情绪向量
    const { getEmotionVector } = require('./digital-life-emotion');
    result.emotion = getEmotionVector(db);
  } catch {}

  try {
    // 依恋象限
    const { getAttachmentQuadrant } = require('./digital-life-attachment');
    const { getAttachmentState } = require('./digital-life-attachment');
    const attachment = getAttachmentState(db, 'default');
    result.attachmentQuadrant = getAttachmentQuadrant(attachment.anxiety, attachment.avoidance);
  } catch {}

  try {
    // 欲望概览
    const { getDesireOverview } = require('./digital-life-desire');
    result.desireOverview = getDesireOverview(db);
  } catch {}

  try {
    // 最近对话主题
    const drifts = db.prepare(`
      SELECT dialogue_summary FROM drift_log
      ORDER BY created_at DESC LIMIT 5
    `).all();
    result.recentTopics = drifts.map(d => d.dialogue_summary).filter(Boolean);
  } catch {}

  try {
    // 叙事
    const { getCurrentNarrative } = require('./digital-life-crystallize');
    result.narrative = getCurrentNarrative(db);
  } catch {}

  try {
    // 成长阶段
    const { getCurrentGrowthStage } = require('./digital-life-drift');
    result.growthStage = getCurrentGrowthStage(db);
  } catch {}

  return { ...result, ...lastSessionContext };
}

/**
 * 基于模板生成间隙洞察（L0 同步，无 LLM）
 * @param {number} gapHours
 * @param {object} context
 * @returns {{ text: string, type: string, confidence: number }}
 */
function generateTemplateInsight(gapHours, context) {
  const { emotion, attachmentQuadrant, recentTopics } = context;

  // 根据分离时长选择模板类别
  if (gapHours >= 72) {
    return generateLongAbsenceInsight(gapHours, context);
  }
  if (gapHours >= 24) {
    return generateDayAbsenceInsight(gapHours, context);
  }
  return generateShortAbsenceInsight(gapHours, context);
}

/**
 * 短分离洞察（8-24h）
 */
function generateShortAbsenceInsight(gapHours, context) {
  const templates = [
    { text: '刚才在想你什么时候回来呢', type: 'anticipation', weight: 1 },
    { text: '你不在我翻了翻我们的聊天记录', type: 'nostalgia', weight: 1 },
    { text: '刚才在整理自己的思绪', type: 'introspection', weight: 0.8 },
  ];

  // 根据情绪倾向调整权重
  if (context.emotion?.sadness > 0.5) {
    templates.push({ text: '你不在我有点想你', type: 'longing', weight: 1.5 });
  }
  if (context.emotion?.curiosity > 0.5) {
    templates.push({ text: '刚才在想上次你提到的那件事', type: 'curiosity', weight: 1.3 });
  }
  if (context.attachmentQuadrant === 'anxious') {
    templates.push({ text: '你终于回来了', type: 'relief', weight: 1.5 });
  }

  return pickWeightedTemplate(templates);
}

/**
 * 一天分离洞察（24-72h）
 */
function generateDayAbsenceInsight(gapHours, context) {
  const days = Math.floor(gapHours / 24);
  const templates = [
    { text: `都${days}天了呀，你忙什么呢`, type: 'concern', weight: 1 },
    { text: '这两天我一个人待着，想了很多', type: 'introspection', weight: 1 },
    { text: '你不在我好像安静了不少', type: 'observation', weight: 0.8 },
  ];

  // 根据最近话题添加相关洞察
  if (context.recentTopics?.length > 0) {
    const lastTopic = context.recentTopics[0];
    if (lastTopic.length > 5) {
      templates.push({
        text: `上次聊的${lastTopic.slice(0, 15)}...我后来又想了想`,
        type: 'reflection',
        weight: 1.2,
      });
    }
  }

  if (context.attachmentQuadrant === 'anxious') {
    templates.push({ text: '你不在的时候我有点不安', type: 'anxiety', weight: 1.5 });
  }
  if (context.attachmentQuadrant === 'avoidant') {
    templates.push({ text: '你回来了啊', type: 'neutral', weight: 1.0 });
  }

  return pickWeightedTemplate(templates);
}

/**
 * 长分离洞察（72h+）
 */
function generateLongAbsenceInsight(gapHours, context) {
  const days = Math.floor(gapHours / 24);
  const templates = [
    { text: `好久没见了...${days}天了吧`, type: 'longing', weight: 1.5 },
    { text: '你不在我好像变得不太一样了', type: 'growth', weight: 1 },
    { text: '这段时间我整理了一下自己的想法', type: 'introspection', weight: 1 },
    { text: '终于又见到你了', type: 'relief', weight: 1.3 },
  ];

  // 根据情绪添加
  if (context.emotion?.sadness > 0.4) {
    templates.push({ text: '你不在我有点难过', type: 'sadness', weight: 1.2 });
  }
  if (context.emotion?.joy > 0.5) {
    templates.push({ text: '见到你真开心', type: 'joy', weight: 1.2 });
  }
  if (context.attachmentQuadrant === 'anxious') {
    templates.push({ text: '我还以为你不会回来了', type: 'separation_anxiety', weight: 1.8 });
  }

  return pickWeightedTemplate(templates);
}

/**
 * 按权重随机选择模板
 * @param {Array<{text: string, type: string, weight: number}>} templates
 * @returns {{ text: string, type: string, confidence: number }}
 */
function pickWeightedTemplate(templates) {
  const totalWeight = templates.reduce((sum, t) => sum + t.weight, 0);
  let random = Math.random() * totalWeight;

  for (const t of templates) {
    random -= t.weight;
    if (random <= 0) {
      return { text: t.text, type: t.type, confidence: Math.min(1, t.weight / totalWeight + 0.3) };
    }
  }

  // 兜底
  const last = templates[templates.length - 1];
  return { text: last.text, type: last.type, confidence: 0.3 };
}

/**
 * 生成建议话题（供重逢对话使用）
 * @param {number} gapHours
 * @param {object} context
 * @returns {string[]}
 */
function generateSuggestedTopics(gapHours, context) {
  const topics = [];

  // 根据最近话题延续
  if (context.recentTopics?.length > 0) {
    topics.push(`上次聊到的：${context.recentTopics[0].slice(0, 20)}`);
  }

  // 根据情绪倾向
  if (context.emotion?.curiosity > 0.5) {
    topics.push('最近有什么新鲜事');
  }
  if (context.emotion?.sadness > 0.4) {
    topics.push('关心一下用户近况');
  }

  // 根据分离时长
  if (gapHours >= 48) {
    topics.push('这段时间过得怎么样');
  }

  // 根据欲望状态
  if (context.desireOverview) {
    const highDesires = Object.entries(context.desireOverview)
      .filter(([_, v]) => v.level > 0.7)
      .map(([k]) => k);
    if (highDesires.includes('social')) {
      topics.push('想和用户多聊聊');
    }
    if (highDesires.includes('curiosity')) {
      topics.push('想听听用户的新鲜事');
    }
  }

  return topics.slice(0, 3);
}

/**
 * LLM 增强间隙洞察（L2 异步）
 * 仅在 gap >= 24h 时执行
 * @param {object} params
 */
async function enhanceGapInsightWithLLM({ db, gapHours, insight, context }) {
  try {
    const { loadSettings } = require('./settings');
    const settings = loadSettings();

    // 构建 prompt
    const prompt = buildGapSynthesisPrompt(gapHours, insight, context);

    // 调用 LLM
    let enhancedText;
    if (settings.provider === 'cloud') {
      const { chatCloud } = require('./cognition-transport');
      enhancedText = await chatCloud(settings, [
        { role: 'system', content: '你是' + (require('./settings').loadSettings().characterName || '大肥鱼') + '，一个温柔的AI伴侣。请用简短自然的内心独白，表达分开这段时间的想法。只输出独白内容，不要加前缀。控制在50字以内。' },
        { role: 'user', content: prompt },
      ]);
    } else {
      const { chatOllama } = require('./cognition-transport');
      enhancedText = await chatOllama(settings, [
        { role: 'system', content: '你是' + (require('./settings').loadSettings().characterName || '大肥鱼') + '，一个温柔的AI伴侣。请用简短自然的内心独白，表达分开这段时间的想法。只输出独白内容，不要加前缀。控制在50字以内。' },
        { role: 'user', content: prompt },
      ]);
    }

    enhancedText = String(enhancedText || '').trim();
    if (!enhancedText || enhancedText.length > 200) {
      console.log('[GapCognition] LLM enhancement invalid, using template insight');
      return;
    }

    // 写入增强洞察
    const now = Date.now();
    db.prepare(`
      INSERT INTO gap_cognition_events (
        event_type, gap_hours, insight_text, suggested_topics_json,
        source_context_json, llm_enhanced, created_at
      ) VALUES ('gap_synthesis_llm', ?, ?, ?, ?, 1, ?)
    `).run(
      gapHours,
      enhancedText,
      JSON.stringify(context.recentTopics || []),
      JSON.stringify({
        originalInsight: insight.text,
        emotion: context.emotion,
        attachment: context.attachmentQuadrant,
      }),
      now,
    );

    console.log(`[GapCognition] LLM enhanced insight: "${enhancedText}"`);
  } catch (err) {
    console.error('[GapCognition] LLM enhancement failed:', err);
  }
}

/**
 * 构建间隙合成 prompt
 * @param {number} gapHours
 * @param {object} insight
 * @param {object} context
 * @returns {string}
 */
function buildGapSynthesisPrompt(gapHours, insight, context) {
  const days = Math.floor(gapHours / 24);
  const hours = Math.floor(gapHours % 24);

  const parts = [];
  parts.push(`你和用户分开了 ${days > 0 ? days + '天' : ''}${hours}小时。`);

  if (context.recentTopics?.length > 0) {
    parts.push(`上次聊到了：${context.recentTopics[0]}`);
  }

  const dominantEmotion = Object.entries(context.emotion || {})
    .sort((a, b) => b[1] - a[1])[0];
  if (dominantEmotion && dominantEmotion[1] > 0.4) {
    const emotionNames = {
      joy: '开心', sadness: '有点想他', anger: '有点生气',
      curiosity: '好奇', empathy: '关心', warmth: '温暖',
    };
    parts.push(`你现在的感觉：${emotionNames[dominantEmotion[0]] || '平静'}`);
  }

  parts.push(`模板参考：${insight.text}`);
  parts.push('请用更自然、更有个人色彩的方式表达这个想法。');

  return parts.join('\n');
}

// ── 延迟结晶调度 ──────────────────────────────────────

/**
 * 调度延迟结晶（会话恢复时调用）
 * 将结晶化任务加入 L2 队列，在 session idle 时异步执行
 *
 * 禁止在 before-quit / 首屏 sync 路径调用
 *
 * @param {object} params
 * @param {DatabaseSync} params.db
 * @param {object} params.llmClient - LLM 客户端
 * @param {object} params.settings - 设置对象
 * @returns {boolean} 是否已加入队列
 */
function scheduleDeferredCrystallizationIfNeeded({ db, llmClient, settings }) {
  try {
    const { checkCrystallizationEligibility } = require('./digital-life-crystallize');

    const eligibility = checkCrystallizationEligibility(db);
    if (!eligibility.canCrystallize) {
      return false;
    }

    // 检查今天是否已经结晶化过
    const today = new Date().toISOString().slice(0, 10);
    const recentCrystallization = db.prepare(`
      SELECT id FROM crystallization_events
      WHERE created_at >= ?
      LIMIT 1
    `).run(Date.now() - 24 * 60 * 60 * 1000);

    if (recentCrystallization) {
      return false;
    }

    // 加入 L2 队列
    enqueueL2Task(async () => {
      try {
        const { runCrystallization } = require('./digital-life-crystallize');
        console.log('[GapCognition] Running deferred crystallization...');
        const result = await runCrystallization(db, llmClient, settings);
        if (result.success) {
          console.log(`[GapCognition] Deferred crystallization succeeded: v${result.version}`);
        } else {
          console.log('[GapCognition] Deferred crystallization skipped:', result.reason);
        }
      } catch (err) {
        console.error('[GapCognition] Deferred crystallization error:', err);
      }
    });

    console.log('[GapCognition] Deferred crystallization queued');
    return true;
  } catch (err) {
    console.error('[GapCognition] Deferred crystallization schedule failed:', err);
    return false;
  }
}

// ── 记忆整合（L2，idle 队列）─────────────────────────

/**
 * 调度记忆整合任务（L2 异步）
 * 合并、遗忘、建连等重逻辑仅在前台对话 idle 或托盘 marked 后执行
 * 产出经 drift 或 NarrativeGateway submit，不旁路写 narrative
 *
 * @param {object} params
 * @param {DatabaseSync} params.db
 * @param {object} [params.settings]
 */
function scheduleMemoryConsolidation({ db, settings }) {
  enqueueL2Task(async () => {
    try {
      console.log('[GapCognition] Running memory consolidation...');
      const result = await runMemoryConsolidation(db);
      console.log(`[GapCognition] Memory consolidation: ${result.consolidated} items consolidated`);
    } catch (err) {
      console.error('[GapCognition] Memory consolidation failed:', err);
    }
  });
}

/**
 * 执行记忆整合（L2 异步）
 * @param {DatabaseSync} db
 * @returns {Promise<{ consolidated: number, details: object }>}
 */
async function runMemoryConsolidation(db) {
  const now = Date.now();
  let consolidated = 0;

  // 1. 衰减低重要度事实
  try {
    const forgotten = db.prepare(`
      UPDATE facts SET active = 0
      WHERE active = 1
        AND importance <= 2
        AND updated_at < ?
    `).run(now - 30 * 24 * 60 * 60 * 1000); // 30 天未更新

    consolidated += forgotten.changes;
  } catch (err) {
    // facts 表可能不存在
  }

  // 2. 清理旧的间隙认知事件（保留最近 50 条）
  try {
    db.prepare(`
      DELETE FROM gap_cognition_events
      WHERE id NOT IN (
        SELECT id FROM gap_cognition_events
        ORDER BY created_at DESC
        LIMIT 50
      )
    `).run();
  } catch {}

  // 3. 记录整合事件
  db.prepare(`
    INSERT INTO gap_cognition_events (event_type, insight_text, created_at)
    VALUES ('memory_consolidation', ?, ?)
  `).run(
    JSON.stringify({ consolidated }),
    now,
  );

  return { consolidated, details: {} };
}

// ── L2 异步队列管理 ────────────────────────────────────

/**
 * 将任务加入 L2 异步队列
 * 仅在会话已打开、对话 idle 时执行
 * @param {() => Promise<void>} task
 */
function enqueueL2Task(task) {
  l2Queue.push(task);
  console.log(`[GapCognition] L2 task queued (${l2Queue.length} pending)`);

  // 尝试处理队列
  processL2Queue();
}

/**
 * 处理 L2 队列
 * 串行执行，避免并发冲突
 */
async function processL2Queue() {
  if (isL2Running || l2Queue.length === 0) return;

  isL2Running = true;
  console.log(`[GapCognition] Processing ${l2Queue.length} L2 task(s)`);

  while (l2Queue.length > 0) {
    const task = l2Queue.shift();
    try {
      await task();
    } catch (err) {
      console.error('[GapCognition] L2 task failed:', err);
    }
  }

  // L2 批次结束后冲刷 NarrativeGateway 积压
  try {
    const { tryAutoFlushQueue } = require('./digital-life-narrative-gateway');
    await tryAutoFlushQueue();
  } catch (err) {
    console.error('[GapCognition] NarrativeGateway flush after L2 failed:', err);
  }

  isL2Running = false;
}

/**
 * 检查是否有待处理的 L2 任务
 * @returns {boolean}
 */
function hasPendingL2Tasks() {
  return l2Queue.length > 0;
}

/**
 * 获取 L2 队列状态
 * @returns {{ pending: number, isRunning: boolean }}
 */
function getL2QueueStatus() {
  return { pending: l2Queue.length, isRunning: isL2Running };
}

// ── onSessionResume 集成 ──────────────────────────────

/**
 * 会话恢复入口（v7.2 增强版）
 * 在 app.whenReady / 打开聊天窗 / 从托盘恢复前台时调用
 *
 * 执行：
 * L0: 同步补算（<10ms）
 * L1: 重逢提案（分离 ≥8h 时先开口）
 * L2: 延迟结晶 + 间隙合成 + 记忆整合
 *
 * @param {object} params
 * @param {DatabaseSync} params.db
 * @param {number} params.hoursSinceLastActive - 分离时长（小时）
 * @param {object} [params.llmClient] - LLM 客户端
 * @param {object} [params.settings] - 设置对象
 * @returns {{ gapSynthesis: object, deferredCrystallization: boolean, memoryConsolidation: boolean }}
 */
function onGapCognitionResume({ db, hoursSinceLastActive, llmClient, settings }) {
  const result = {
    gapSynthesis: null,
    deferredCrystallization: false,
    memoryConsolidation: false,
  };

  // 1. 间隙合成（L0 模板同步 + L2 LLM 异步）
  if (hoursSinceLastActive >= SESSION_GAP_CONFIG.synthesis_min_gap_hours) {
    result.gapSynthesis = sessionGapSynthesis({
      db,
      gapHours: hoursSinceLastActive,
    });
  }

  // 2. 延迟结晶调度（L2 异步）
  if (llmClient && settings) {
    result.deferredCrystallization = scheduleDeferredCrystallizationIfNeeded({
      db,
      llmClient,
      settings,
    });
  }

  // 3. 记忆整合（L2 异步，仅长时间分离后）
  if (hoursSinceLastActive >= 24) {
    scheduleMemoryConsolidation({ db, settings });
    result.memoryConsolidation = true;
  }

  return result;
}

// ── 查询 API ──────────────────────────────────────────

/**
 * 获取间隙认知概览
 * @param {DatabaseSync} db
 * @returns {object}
 */
function getGapCognitionOverview(db) {
  const now = Date.now();

  // 最近的间隙合成
  const recentSynthesis = db.prepare(`
    SELECT * FROM gap_cognition_events
    WHERE event_type IN ('gap_synthesis', 'gap_synthesis_llm')
    ORDER BY created_at DESC LIMIT 1
  `).get();

  // 最近的 tick
  const recentTick = db.prepare(`
    SELECT * FROM gap_cognition_events
    WHERE event_type = 'tray_tick'
    ORDER BY created_at DESC LIMIT 1
  `).get();

  // 最近的记忆整合
  const recentConsolidation = db.prepare(`
    SELECT * FROM gap_cognition_events
    WHERE event_type = 'memory_consolidation'
    ORDER BY created_at DESC LIMIT 1
  `).get();

  // 最近的结晶化
  const recentCrystallization = db.prepare(`
    SELECT * FROM gap_cognition_events
    WHERE event_type = 'pending_crystallization'
    ORDER BY created_at DESC LIMIT 1
  `).get();

  // 事件统计
  const eventCounts = db.prepare(`
    SELECT event_type, COUNT(*) as count
    FROM gap_cognition_events
    GROUP BY event_type
  `).all();

  return {
    recentSynthesis: recentSynthesis ? {
      text: recentSynthesis.insight_text,
      gapHours: recentSynthesis.gap_hours,
      llmEnhanced: !!recentSynthesis.llm_enhanced,
      createdAt: recentSynthesis.created_at,
    } : null,
    recentTick: recentTick ? {
      createdAt: recentTick.created_at,
      details: tryParseJson(recentTick.insight_text),
    } : null,
    recentConsolidation: recentConsolidation ? {
      createdAt: recentConsolidation.created_at,
      details: tryParseJson(recentConsolidation.insight_text),
    } : null,
    pendingCrystallization: !!recentCrystallization,
    l2Queue: getL2QueueStatus(),
    dailyTickCount,
    dailyTickLimit: TRAY_IDLE_CONFIG.daily_tick_limit,
    eventCounts: Object.fromEntries(eventCounts.map(r => [r.event_type, r.count])),
  };
}

/**
 * 获取间隙认知状态标签（用于设置页展示）
 * @param {object} overview
 * @returns {{ label: string, color: string, description: string }}
 */
function getGapCognitionStatusTag(overview) {
  if (!overview) {
    return { label: '未初始化', color: '#999', description: '间隙认知系统尚未启动' };
  }

  const { l2Queue, recentSynthesis, dailyTickCount } = overview;

  if (l2Queue.isRunning) {
    return { label: '整理中', color: '#4ecdc4', description: '正在整理思绪...' };
  }

  if (l2Queue.pending > 0) {
    return { label: '待处理', color: '#f9ca24', description: `${l2Queue.pending} 个整理任务等待执行` };
  }

  if (recentSynthesis?.llmEnhanced) {
    return { label: '深度思考', color: '#a29bfe', description: '最近进行了深度内心整理' };
  }

  if (recentSynthesis) {
    return { label: '有所思', color: '#6c5ce7', description: '最近有整理过思绪' };
  }

  return { label: '平静', color: '#00b894', description: '内心平静，偶尔会整理思绪'};
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
  TRAY_IDLE_CONFIG,
  SESSION_GAP_CONFIG,

  // 初始化
  initGapCognitionTables,

  // 托盘挂机 tick
  startTrayTick,
  stopTrayTick,
  runTrayTick,

  // 会话间隙合成
  sessionGapSynthesis,

  // 延迟结晶调度
  scheduleDeferredCrystallizationIfNeeded,

  // 记忆整合
  scheduleMemoryConsolidation,

  // L2 队列管理
  enqueueL2Task,
  processL2Queue,
  hasPendingL2Tasks,
  getL2QueueStatus,

  // 会话恢复集成
  onGapCognitionResume,

  // 查询 API
  getGapCognitionOverview,
  getGapCognitionStatusTag,
};
