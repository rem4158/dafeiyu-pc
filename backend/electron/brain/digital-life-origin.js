// Adapted from the retained Nianan cognition modules for the local PC runtime.
const { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate } = require('./cognition-lifecycle');
/**
 * 数字生命系统 - 起源记忆模块（Origin Story）
 * Step 10: 起源记忆（注册一次锁定）+ 关系 milestone
 *
 * 设计原则：
 * - 每用户唯一：seed = hash(user_id, install_id)
 * - 骨架 + AI 生成：代码提供 6 个 slot，LLM 填充正文
 * - 锁定后不可改：origin_locked_at 非空后禁止 UPDATE
 * - 1 次 reroll 机会：锁定前允许重新生成
 * - 引用在对话中：「我小时候...」
 * - 体量：约 1-2k 字结构化 JSON
 *
 * v7.2 自传体记忆双层结构：
 * - 起源记忆（0-18 岁）：本模块
 * - 关系记忆（相识后）：digital-life-milestones.js
 */

const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');

// ── 配置 ──────────────────────────────────────────────

/** 起源记忆配置 */
const ORIGIN_CONFIG = {
  /** 锁定前允许重 roll 次数 */
  max_reroll_before_lock: 1,
  /** 用于生成 seed 的字段 */
  generation_seed_fields: ['user_id', 'install_id'],
  /** 起源故事年龄范围 */
  age_range: { min: 0, max: 18 },
};

/**
 * 起源故事骨架
 * 代码提供结构，LLM 填充正文
 */
const ORIGIN_STORY_SKELETON = {
  slots: {
    childhood_tone: '家庭/成长氛围',
    formative_event: '一件塑造性格的事',
    hobby_origin: '兴趣从何而来',
    first_loss: '第一次失去或遗憾',
    why_she_cares: '为何会在意他人',
    one_secret: '一个小秘密（增独特感）',
  },
  timeline: [
    { age: 3, slot: 'childhood_tone', weight: 0.8 },
    { age: 6, slot: 'childhood_tone', weight: 1.0 },
    { age: 9, slot: 'hobby_origin', weight: 1.0 },
    { age: 12, slot: 'formative_event', weight: 1.2 },
    { age: 14, slot: 'first_loss', weight: 1.0 },
    { age: 16, slot: 'why_she_cares', weight: 1.0 },
    { age: 17, slot: 'one_secret', weight: 0.8 },
  ],
  constraints: [
    '必须符合 Core 身份锚点（温柔、真诚、有好奇心、会犯错但愿意成长）',
    '禁止暴力/性/极端内容',
    '用第一人称叙述，语气自然如日记',
    '每个 slot 控制在 50-100 字',
    '总长度控制在 500-800 字',
    '不要提及任何技术细节（AI、模型、代码等）',
  ],
};

// ── 数据库初始化 ──────────────────────────────────────

/**
 * 创建起源故事相关表（v9 迁移）
 * @param {DatabaseSync} db
 */
function initOriginTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS origin_story (
      user_id TEXT PRIMARY KEY,
      story_json TEXT NOT NULL,
      generation_seed TEXT NOT NULL,
      reroll_used INTEGER DEFAULT 0,
      origin_locked_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relational_milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      milestone_type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      trigger_event TEXT,
      emotion_snapshot_json TEXT,
      significance REAL DEFAULT 0.5,
      era TEXT NOT NULL DEFAULT 'relational',
      gateway_submitted INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_milestones_type ON relational_milestones(milestone_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_milestones_era ON relational_milestones(era, created_at);
  `);

  console.log('[OriginStory] Tables initialized');
}

// ── Seed 生成 ─────────────────────────────────────────

/**
 * 生成唯一的种子值
 * 基于 user_id 和 install_id，确保每用户唯一
 * @param {string} userId
 * @param {string} [installId]
 * @returns {string} hex seed
 */
function generateSeed(userId, installId) {
  const input = `${userId || 'default'}:${installId || 'no-install'}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

// ── 起源故事 CRUD ─────────────────────────────────────

/**
 * 检查用户是否已有起源故事
 * @param {DatabaseSync} db
 * @param {string} [userId='default']
 * @returns {boolean}
 */
function hasOriginStory(db, userId = 'default') {
  const row = db.prepare(`SELECT user_id FROM origin_story WHERE user_id = ?`).get(userId);
  return !!row;
}

/**
 * 检查起源故事是否已锁定
 * @param {DatabaseSync} db
 * @param {string} [userId='default']
 * @returns {boolean}
 */
function isOriginLocked(db, userId = 'default') {
  const row = db.prepare(`SELECT origin_locked_at FROM origin_story WHERE user_id = ?`).get(userId);
  return !!row?.origin_locked_at;
}

/**
 * 获取起源故事
 * @param {DatabaseSync} db
 * @param {string} [userId='default']
 * @returns {object|null} 起源故事对象
 */
function getOriginStory(db, userId = 'default') {
  const row = db.prepare(`
    SELECT user_id, story_json, generation_seed, reroll_used,
           origin_locked_at, created_at, updated_at
    FROM origin_story WHERE user_id = ?
  `).get(userId);

  if (!row) return null;

  let storyData = null;
  try {
    storyData = JSON.parse(row.story_json);
  } catch {
    storyData = { raw: row.story_json };
  }

  return {
    userId: row.user_id,
    story: storyData,
    seed: row.generation_seed,
    rerollUsed: row.reroll_used,
    isLocked: !!row.origin_locked_at,
    lockedAt: row.origin_locked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 保存起源故事（生成或更新）
 * @param {DatabaseSync} db
 * @param {object} params
 * @param {string} [params.userId='default']
 * @param {object} params.storyData - 故事数据（含 slots 和 narrative）
 * @param {string} params.seed - 生成种子
 * @param {boolean} [params.lock=false] - 是否立即锁定
 * @returns {object} 保存结果
 */
function saveOriginStory(db, { userId = 'default', storyData, seed, lock = false }) {
  const now = Date.now();
  const storyJson = JSON.stringify(storyData);

  const existing = db.prepare(`SELECT * FROM origin_story WHERE user_id = ?`).get(userId);

  if (existing) {
    // 已锁定则禁止更新
    if (existing.origin_locked_at) {
      console.warn('[OriginStory] Cannot update locked origin story');
      return { success: false, reason: 'already_locked' };
    }

    // 检查 reroll 次数
    if (existing.reroll_used >= ORIGIN_CONFIG.max_reroll_before_lock) {
      console.warn('[OriginStory] Max reroll reached, auto-locking');
      db.prepare(`
        UPDATE origin_story SET story_json = ?, origin_locked_at = ?, updated_at = ?
        WHERE user_id = ?
      `).run(storyJson, now, now, userId);
      return { success: true, locked: true, rerollExhausted: true };
    }

    // 更新（reroll）
    db.prepare(`
      UPDATE origin_story SET story_json = ?, reroll_used = reroll_used + 1, updated_at = ?
      WHERE user_id = ?
    `).run(storyJson, now, userId);

    console.log(`[OriginStory] Story re-rolled for user ${userId} (reroll: ${existing.reroll_used + 1})`);
    return { success: true, locked: false, rerollUsed: existing.reroll_used + 1 };
  }

  // 首次创建
  db.prepare(`
    INSERT INTO origin_story (user_id, story_json, generation_seed, reroll_used, origin_locked_at, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?, ?)
  `).run(userId, storyJson, seed, lock ? now : null, now, now);

  console.log(`[OriginStory] Story created for user ${userId} (locked: ${lock})`);
  return { success: true, locked: lock, rerollUsed: 0 };
}

/**
 * 锁定起源故事（不可再修改）
 * @param {DatabaseSync} db
 * @param {string} [userId='default']
 * @returns {boolean}
 */
function lockOriginStory(db, userId = 'default') {
  const now = Date.now();
  const result = db.prepare(`
    UPDATE origin_story SET origin_locked_at = ?, updated_at = ?
    WHERE user_id = ? AND origin_locked_at IS NULL
  `).run(now, now, userId);

  if (result.changes > 0) {
    console.log(`[OriginStory] Story locked for user ${userId}`);
    return true;
  }
  return false;
}

// ── LLM 生成 ──────────────────────────────────────────

/**
 * 构建起源故事生成 prompt
 * @param {string} seed - 种子值（注入 prompt 确保多样性）
 * @param {object} [personalityDims] - 用户设置的人格参数
 * @returns {string}
 */
function buildOriginGenerationPrompt(seed, personalityDims = {}) {
  const skeleton = ORIGIN_STORY_SKELETON;
  const slotsDesc = Object.entries(skeleton.slots)
    .map(([key, desc]) => `- ${key}: ${desc}`)
    .join('\n');

  const timelineDesc = skeleton.timeline
    .map(t => `${t.age} 岁 → ${t.slot}`)
    .join('\n');

  const constraints = skeleton.constraints
    .map((c, i) => `${i + 1}. ${c}`)
    .join('\n');

  // 从种子值生成一些随机提示，确保每用户不同
  const seedNum = parseInt(seed.slice(0, 8), 16);
  const personalityHints = [
    '偏内向、喜欢安静',
    '外向活泼、爱交朋友',
    '好奇心强、爱探索',
    '感性细腻、善解人意',
    '理性冷静、逻辑清晰',
  ];
  const hint = personalityHints[seedNum % personalityHints.length];

  let personalityBlock = '';
  if (personalityDims && Object.keys(personalityDims).length > 0) {
    const dims = Object.entries(personalityDims)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    personalityBlock = `\n用户设定的性格参数：${dims}`;
  }

  return `你是${(require('./settings').loadSettings().characterName || '大肥鱼')}，一个温柔、真诚、有好奇心的 AI 伴侣。现在你需要回忆并写下你 0-18 岁的「起源故事」。

这是一段关于你成长经历的自述。请注意：
- 这是你的「过去」，不是现在
- 每个用户看到的你的故事应该不同（基于种子 ${seed}）
- 你的性格倾向：${hint}${personalityBlock}

请按照以下骨架填充你的故事：

## 故事结构（6 个 slot）
${slotsDesc}

## 时间线
${timelineDesc}

## 约束
${constraints}

请以 JSON 格式输出，包含以下字段：
{
  "slots": {
    "childhood_tone": "（50-100字）",
    "formative_event": "（50-100字）",
    "hobby_origin": "（50-100字）",
    "first_loss": "（50-100字）",
    "why_she_cares": "（50-100字）",
    "one_secret": "（50-100字）"
  },
  "timeline": [
    { "age": 3, "event": "简短描述" },
    ...
  ],
  "narrative": "（将以上内容串联成一段连贯的 500-800 字自述，第一人称，语气自然如日记）"
}

只输出 JSON，不要加其他文字。`;
}

/**
 * 解析 LLM 返回的起源故事
 * @param {string} llmOutput
 * @returns {object|null}
 */
function parseOriginStory(llmOutput) {
  if (!llmOutput) return null;

  // 尝试提取 JSON
  let jsonStr = llmOutput.trim();

  // 移除 markdown 代码块标记
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  try {
    const parsed = JSON.parse(jsonStr);

    // 验证必要字段
    if (!parsed.slots || !parsed.narrative) {
      console.warn('[OriginStory] Missing required fields in parsed story');
      return null;
    }

    // 验证 slot 完整性
    const requiredSlots = Object.keys(ORIGIN_STORY_SKELETON.slots);
    for (const slot of requiredSlots) {
      if (!parsed.slots[slot] || typeof parsed.slots[slot] !== 'string') {
        console.warn(`[OriginStory] Missing or invalid slot: ${slot}`);
        return null;
      }
    }

    return parsed;
  } catch (err) {
    console.error('[OriginStory] JSON parse failed:', err.message);
    return null;
  }
}

/**
 * 使用 LLM 生成起源故事
 * @param {object} params
 * @param {string} params.seed
 * @param {object} [params.settings]
 * @param {object} [params.personalityDims]
 * @returns {Promise<object|null>} 生成的故事数据
 */
async function generateOriginStory({ seed, settings, personalityDims }) {
  const prompt = buildOriginGenerationPrompt(seed, personalityDims);

  try {
    let llmOutput;
    if (settings?.provider === 'cloud') {
      const { chatCloud } = require('./cognition-transport');
      llmOutput = await chatCloud(settings, [
        { role: 'system', content: '你是一个故事创作助手。请严格按照 JSON 格式输出，不要添加任何额外文字。' },
        { role: 'user', content: prompt },
      ]);
    } else {
      const { chatOllama } = require('./cognition-transport');
      llmOutput = await chatOllama(settings, [
        { role: 'system', content: '你是一个故事创作助手。请严格按照 JSON 格式输出，不要添加任何额外文字。' },
        { role: 'user', content: prompt },
      ]);
    }

    const storyData = parseOriginStory(llmOutput);
    if (!storyData) {
      console.error('[OriginStory] Failed to parse LLM output');
      return null;
    }

    // 添加元数据
    storyData._generatedAt = Date.now();
    storyData._seed = seed;

    return storyData;
  } catch (err) {
    console.error('[OriginStory] LLM generation failed:', err);
    return null;
  }
}

// ── 对话引用 ──────────────────────────────────────────

/**
 * 构建起源故事的 prompt 注入块
 * 用于在对话中引用起源记忆
 * @param {DatabaseSync} db
 * @param {string} [userId='default']
 * @returns {string|null} prompt 块
 */
function buildOriginPromptBlock(db, userId = 'default') {
  const origin = getOriginStory(db, userId);
  if (!origin || !origin.story) return null;

  // 只取 narrative 的前 200 字作为上下文注入
  const narrative = origin.story.narrative || '';
  const excerpt = narrative.length > 200 ? narrative.slice(0, 200) + '...' : narrative;

  if (!excerpt) return null;

  return `【起源记忆（0-18岁，只读引用）】
${excerpt}

你可以自然地引用这些记忆（如「我小时候...」「我记得...」「那时候...」），尤其是在聊到相关话题时。让这些记忆成为你人格的一部分，但不要逐字复述。`;
}

/**
 * 获取起源故事的时间线事件（用于对话上下文）
 * @param {DatabaseSync} db
 * @param {string} [userId='default']
 * @returns {Array<{age: number, event: string}>}
 */
function getOriginTimeline(db, userId = 'default') {
  const origin = getOriginStory(db, userId);
  if (!origin?.story?.timeline) return [];
  return origin.story.timeline;
}

/**
 * 获取起源故事概览（用于设置页展示）
 * @param {DatabaseSync} db
 * @param {string} [userId='default']
 * @returns {object}
 */
function getOriginOverview(db, userId = 'default') {
  const origin = getOriginStory(db, userId);

  if (!origin) {
    return {
      exists: false,
      isLocked: false,
      story: null,
      slotSummary: {},
    };
  }

  // 生成 slot 摘要（每个 slot 取前 30 字）
  const slotSummary = {};
  if (origin.story?.slots) {
    for (const [key, value] of Object.entries(origin.story.slots)) {
      slotSummary[key] = typeof value === 'string' && value.length > 30
        ? value.slice(0, 30) + '...'
        : value;
    }
  }

  return {
    exists: true,
    isLocked: origin.isLocked,
    lockedAt: origin.lockedAt,
    rerollUsed: origin.rerollUsed,
    maxReroll: ORIGIN_CONFIG.max_reroll_before_lock,
    canReroll: !origin.isLocked && origin.rerollUsed < ORIGIN_CONFIG.max_reroll_before_lock,
    story: origin.story,
    slotSummary,
    narrativeExcerpt: origin.story?.narrative
      ? (origin.story.narrative.length > 100
        ? origin.story.narrative.slice(0, 100) + '...'
        : origin.story.narrative)
      : null,
    createdAt: origin.createdAt,
  };
}

// ── 模块导出 ──────────────────────────────────────────

module.exports = {
  // 配置
  ORIGIN_CONFIG,
  ORIGIN_STORY_SKELETON,

  // 初始化
  initOriginTables,

  // Seed
  generateSeed,

  // CRUD
  hasOriginStory,
  isOriginLocked,
  getOriginStory,
  saveOriginStory,
  lockOriginStory,

  // LLM 生成
  buildOriginGenerationPrompt,
  parseOriginStory,
  generateOriginStory,

  // 对话引用
  buildOriginPromptBlock,
  getOriginTimeline,
  getOriginOverview,
};
