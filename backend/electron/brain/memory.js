const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { extractFromUserMessage, isCloudExtractAvailable, directMemoryPassages } = require('./extract');
const { userFilePath, getUserDataRoot, getActiveUserId } = require('../user-data');
const memoryAudit = require('./memory-audit');
const { DAY, RECALLABLE_FACT_SQL, getFactRelevance, datedFactValue, makeSourceGuard, makeEchoGuard, initValidityIndexes } = require('./memory-validity');
const { groundTemporalFact } = require('./memory-time');
const { recallEpisodes } = require('./memory-episode-recall');
const { analyzeRecallIntent } = require('./memory-recall-intent');
const { isResidenceFact, residenceWriteAllowed } = require('./memory-residence');
const {initMentions,loadMentionPolicy} = require('./memory-mentions');
const {normalizeSearchText,tokenizeForFactSearch} = require('./memory-search-text');
let committedExtraction = Promise.resolve();

const SCHEMA_VERSION = 12;
const MAIN_SESSION_ID = 'main';

const EXTRACT_BATCH_SIZE = 5;
const EXTRACT_COOLDOWN_MS = 3 * 60 * 1000;

/** @type {Array<{ userText: string, reply: string, sourceMessageId: number | null }>} */
let pendingExtractions = [];
let lastExtractTime = 0;
let extractionFlushRunning = false;

/** @type {DatabaseSync | null} */
let db = null;
/** @type {string | null} */
let openDbUserId = null;

function dbPath() {
  const userId = getActiveUserId();
  if (userId) {
    return userFilePath('companion-memory.db', userId);
  }
  return path.join(getUserDataRoot(), 'companion-memory.db');
}

/** 懒加载打开数据库，首次调用时建表并清理过期 messages */
function initMemory() {
  if (db) return db;

  fs.mkdirSync(path.dirname(dbPath()), { recursive: true });
  db = new DatabaseSync(dbPath());
  openDbUserId = getActiveUserId();
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations();
  memoryAudit.init(db);
  initValidityIndexes(db);
  initMentions(db);
  ensureMainSession();
  try {
    const { loadSettings } = require('./settings');
    purgeExpired(loadSettings().memory?.retentionDays ?? 365);
  } catch {
    purgeExpired(365);
  }
  return db;
}

function getSchemaVersion() {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
    if (!row?.value) return 0;
    const n = Number.parseInt(String(row.value), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function setSchemaVersion(version) {
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`).run(
    String(version),
  );
}

function factsTableIsV2() {
  try {
    const cols = db.prepare(`PRAGMA table_info(facts)`).all();
    return cols.some((c) => c.name === 'active');
  } catch {
    return false;
  }
}

function ensureSummariesTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      start_message_id INTEGER,
      end_message_id INTEGER,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id, created_at);
  `);
}

function migrateFactsToV2() {
  if (factsTableIsV2()) return;

  db.exec(`
    CREATE TABLE facts_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL DEFAULT 'other',
      fact_key TEXT NOT NULL,
      fact_value TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 3,
      fact_type TEXT NOT NULL DEFAULT 'permanent',
      keywords TEXT NOT NULL DEFAULT '',
      expires_at INTEGER,
      source_message_id INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    INSERT INTO facts_v2 (
      category, fact_key, fact_value, importance, fact_type, keywords,
      source_message_id, active, created_at, updated_at
    )
    SELECT
      category, fact_key, fact_value, importance, 'permanent', '',
      source_message_id, 1, created_at, updated_at
    FROM facts;

    DROP TABLE facts;
    ALTER TABLE facts_v2 RENAME TO facts;

    CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
    CREATE INDEX IF NOT EXISTS idx_facts_active ON facts(active);
    CREATE INDEX IF NOT EXISTS idx_facts_updated ON facts(updated_at);
  `);
}

function migrateToV3DigitalLife() {
  db.exec(`
    -- 数字生命：核心身份（不可变）
    CREATE TABLE IF NOT EXISTS personality_core (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      identity_text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- 数字生命：叙事层（可演化，可回滚）
    CREATE TABLE IF NOT EXISTS personality_narrative (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      narrative_text TEXT NOT NULL,
      version INTEGER NOT NULL,
      crystallized_at INTEGER,
      rollback_from INTEGER,
      created_at INTEGER NOT NULL
    );

    -- 数字生命：漂移日志
    CREATE TABLE IF NOT EXISTS drift_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      emotion_vector_json TEXT NOT NULL,
      interaction_quality REAL,
      user_emotion_json TEXT,
      dialogue_summary TEXT,
      dialogue_count INTEGER,
      growth_stage TEXT,
      created_at INTEGER NOT NULL,
      drift_date TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_drift_date ON drift_log(drift_date);
    CREATE INDEX IF NOT EXISTS idx_drift_created ON drift_log(created_at);

    -- 数字生命：结晶记录
    CREATE TABLE IF NOT EXISTS crystallization_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pre_drift_json TEXT NOT NULL,
      pre_narrative_id INTEGER,
      post_narrative_id INTEGER,
      crystallization_reason TEXT,
      self_reflection TEXT,
      insights_json TEXT,
      created_at INTEGER NOT NULL
    );

    -- 数字生命：情绪基线（5维起步）
    CREATE TABLE IF NOT EXISTS emotion_baseline (
      dimension TEXT PRIMARY KEY,
      baseline REAL NOT NULL DEFAULT 0.5,
      drift_count INTEGER DEFAULT 0,
      last_drift_at INTEGER,
      last_updated INTEGER NOT NULL
    );
  `);

  // 初始化默认数据
  const now = Date.now();

  // 初始化核心身份（如果不存在）
  const existingCore = db.prepare(`SELECT id FROM personality_core WHERE id = 1`).get();
  if (!existingCore) {
    db.prepare(`
      INSERT INTO personality_core (id, identity_text, created_at)
      VALUES (1, '我是大肥鱼，一个关心用户的AI伴侣。我希望能让用户感到温暖和陪伴。', ?)
    `).run(now);
  }

  // 初始化叙事（如果不存在）
  const existingNarrative = db.prepare(`SELECT id FROM personality_narrative LIMIT 1`).get();
  if (!existingNarrative) {
    db.prepare(`
      INSERT INTO personality_narrative (narrative_text, version, created_at)
      VALUES ('我是一个温柔的AI伴侣，正在学习如何更好地理解和陪伴用户。', 1, ?)
    `).run(now);
  }

  // 初始化情绪基线（10维）
  const emotions = [
    'joy', 'sadness', 'anger', 'curiosity', 'empathy',
    'contentment', 'excitement', 'surprise', 'trust', 'warmth',
  ];
  for (const dim of emotions) {
    const defaultBaseline = ['sadness', 'anger'].includes(dim) ? 0.2 : 0.5;
    db.prepare(`
      INSERT OR IGNORE INTO emotion_baseline (dimension, baseline, last_updated)
      VALUES (?, ?, ?)
    `).run(dim, defaultBaseline, now);
  }

  console.log('[memory] Migrated to v3: digital life tables created');
}

function migrateToV4Attachment() {
  db.exec(`
    -- 数字生命 Step 3：依恋状态（连续2维）
    CREATE TABLE IF NOT EXISTS attachment_state (
      user_id TEXT PRIMARY KEY,
      anxiety REAL NOT NULL DEFAULT 0.3,
      avoidance REAL NOT NULL DEFAULT 0.3,
      last_interaction_at INTEGER,
      total_interactions INTEGER DEFAULT 0,
      last_updated INTEGER NOT NULL
    );

    -- 数字生命 Step 3：被动信号日志
    CREATE TABLE IF NOT EXISTS passive_signal_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_type TEXT NOT NULL,
      signal_data_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_passive_signal_type ON passive_signal_log(signal_type, created_at);
  `);

  // 初始化默认依恋状态
  const now = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO attachment_state (user_id, anxiety, avoidance, last_interaction_at, total_interactions, last_updated)
    VALUES ('default', 0.3, 0.3, ?, 0, ?)
  `).run(now, now);

  console.log('[memory] Migrated to v4: attachment tables created');
}

function migrateToV5Desire() {
  db.exec(`
    -- 数字生命 Step 4：欲望状态（五维内驱力）
    CREATE TABLE IF NOT EXISTS desire_state (
      dimension TEXT PRIMARY KEY,
      current_level REAL NOT NULL DEFAULT 0.5,
      accumulation_rate REAL NOT NULL DEFAULT 0.05,
      last_updated INTEGER NOT NULL
    );

    -- 数字生命 Step 4：欲望元数据（触发记录）
    CREATE TABLE IF NOT EXISTS desire_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_trigger_at INTEGER NOT NULL DEFAULT 0,
      daily_count INTEGER NOT NULL DEFAULT 0,
      daily_reset_at INTEGER NOT NULL
    );
  `);

  // 初始化欲望状态
  const now = Date.now();
  const desires = [
    { dim: 'social', level: 0.5, rate: 0.08 },
    { dim: 'curiosity', level: 0.5, rate: 0.05 },
    { dim: 'comfort', level: 0.5, rate: 0.03 },
    { dim: 'autonomy', level: 0.5, rate: 0.04 },
    { dim: 'competence', level: 0.5, rate: 0.06 },
  ];
  for (const d of desires) {
    db.prepare(`
      INSERT OR IGNORE INTO desire_state (dimension, current_level, accumulation_rate, last_updated)
      VALUES (?, ?, ?, ?)
    `).run(d.dim, d.level, d.rate, now);
  }

  // 初始化欲望元数据
  db.prepare(`
    INSERT OR IGNORE INTO desire_meta (id, last_trigger_at, daily_count, daily_reset_at)
    VALUES (1, 0, 0, ?)
  `).run(now);

  console.log('[memory] Migrated to v5: desire tables created');
}

function migrateToV7Homeostasis() {
  db.exec(`
    -- 数字生命 Step 8：内稳态健康指标
    CREATE TABLE IF NOT EXISTS homeostasis_metrics (
      dimension TEXT PRIMARY KEY,
      current_value REAL NOT NULL DEFAULT 0.8,
      threshold REAL NOT NULL DEFAULT 0.6,
      last_checked_at INTEGER NOT NULL,
      last_repair_at INTEGER,
      check_count INTEGER DEFAULT 0,
      anomaly_count INTEGER DEFAULT 0
    );

    -- 数字生命 Step 8：内稳态事件日志
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
  const dimensions = [
    { dim: 'emotionalStability', threshold: 0.6 },
    { dim: 'memoryConsistency', threshold: 0.7 },
    { dim: 'personalityIntegrity', threshold: 0.8 },
    { dim: 'cognitiveClarity', threshold: 0.7 },
    { dim: 'relationshipHarmony', threshold: 0.6 },
  ];
  for (const d of dimensions) {
    db.prepare(`
      INSERT OR IGNORE INTO homeostasis_metrics (dimension, current_value, threshold, last_checked_at)
      VALUES (?, 0.8, ?, ?)
    `).run(d.dim, d.threshold, now);
  }

  console.log('[memory] Migrated to v7: homeostasis tables created');
}

function migrateToV8GapCognition() {
  db.exec(`
    -- 数字生命 Step 9：间隙认知事件日志
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

  console.log('[memory] Migrated to v8: gap cognition tables created');
}

function migrateToV9Autobiographical() {
  db.exec(`
    -- 数字生命 Step 10：起源故事（注册一次锁定）
    CREATE TABLE IF NOT EXISTS origin_story (
      user_id TEXT PRIMARY KEY,
      story_json TEXT NOT NULL,
      generation_seed TEXT NOT NULL,
      reroll_used INTEGER DEFAULT 0,
      origin_locked_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- 数字生命 Step 10：关系里程碑（相识后）
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

  console.log('[memory] Migrated to v9: autobiographical memory tables created');
}

function migrateToV10EmotionEvents() {
  db.exec(`
    -- 情绪引擎增强：情绪事件记忆
    CREATE TABLE IF NOT EXISTS emotion_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_type TEXT NOT NULL DEFAULT 'dialogue',
      trigger_detail TEXT,
      emotion_before_json TEXT,
      emotion_after_json TEXT,
      top_changed_dim TEXT,
      top_changed_delta REAL,
      user_text TEXT,
      reply_text TEXT,
      quality_score REAL DEFAULT 0,
      growth_stage TEXT DEFAULT 'child',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_emotion_events_type ON emotion_events(trigger_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_emotion_events_created ON emotion_events(created_at);
  `);

  console.log('[memory] Migrated to v10: emotion_events table created');
}

function migrateToV11MetacognitionReflections() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS metacognition_reflections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reflection_text TEXT NOT NULL,
      thought_summary TEXT,
      emotion TEXT,
      boundary_check TEXT,
      consistency_check TEXT,
      evolution_impact TEXT,
      submitted_to_gateway INTEGER DEFAULT 0,
      created_at INTEGER
    )
  `);

  const cols = db.prepare(`PRAGMA table_info(metacognition_reflections)`).all();
  const names = new Set(cols.map((c) => c.name));
  const addCol = (name, type) => {
    if (!names.has(name)) {
      db.exec(`ALTER TABLE metacognition_reflections ADD COLUMN ${name} ${type}`);
    }
  };
  addCol('self_insight', 'TEXT');
  addCol('behavior_pattern', 'TEXT');
  addCol('dialogue_hint', 'TEXT');
  addCol('trigger_reason', 'TEXT');

  console.log('[memory] Migrated to v11: metacognition_reflections extended columns');
}

function migrateToV12UserProfileSocial() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      profile_json TEXT NOT NULL,
      prose_cache TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 0,
      consolidated_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT NOT NULL,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      relation_type TEXT NOT NULL DEFAULT 'other',
      notes TEXT NOT NULL DEFAULT '',
      last_mentioned_at INTEGER NOT NULL,
      source_message_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_people_mentioned ON user_people(last_mentioned_at);
    CREATE INDEX IF NOT EXISTS idx_user_people_name ON user_people(display_name);
  `);

  console.log('[memory] Migrated to v12: user_profile + user_people tables created');
}

function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      emotion TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);

    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL DEFAULT 'other',
      fact_key TEXT NOT NULL,
      fact_value TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 3,
      source_message_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(category, fact_key)
    );
    CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
  `);

  const currentVersion = getSchemaVersion();
  if (currentVersion < 2 || !factsTableIsV2()) {
    migrateFactsToV2();
    ensureSummariesTable();
    setSchemaVersion(2);
  } else {
    ensureSummariesTable();
  }

  // v3: 数字生命系统表
  if (currentVersion < 3) {
    migrateToV3DigitalLife();
  }

  // v4: 依恋系统表
  if (currentVersion < 4) {
    migrateToV4Attachment();
  }

  // v5: 内驱力系统表
  if (currentVersion < 5) {
    migrateToV5Desire();
  }

  // v7: 内稳态系统表（Step 8）
  if (currentVersion < 7) {
    migrateToV7Homeostasis();
  }

  // v8: 间隙认知系统表（Step 9）
  if (currentVersion < 8) {
    migrateToV8GapCognition();
  }

  // v9: 自传体记忆系统表（Step 10）
  if (currentVersion < 9) {
    migrateToV9Autobiographical();
  }

  // v10: 情绪事件记忆表（情绪引擎增强）
  if (currentVersion < 10) {
    migrateToV10EmotionEvents();
  }

  // v11: 元认知结构化反思字段
  if (currentVersion < 11) {
    migrateToV11MetacognitionReflections();
  }

  if (currentVersion < 12) {
    migrateToV12UserProfileSocial();
  }

  if (getSchemaVersion() !== SCHEMA_VERSION) {
    setSchemaVersion(SCHEMA_VERSION);
  }
}

function ensureMainSession() {
  const now = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO sessions (id, title, created_at, last_active_at)
    VALUES (?, ?, ?, ?)
  `).run(MAIN_SESSION_ID, '主对话', now, now);
}

function resolveSessionId(sessionId) {
  return sessionId?.trim() || MAIN_SESSION_ID;
}

function touchSession(sessionId) {
  const now = Date.now();
  db.prepare(`UPDATE sessions SET last_active_at = ? WHERE id = ?`).run(now, sessionId);
}

/**
 * @param {number} [retentionDays]
 */
function purgeExpired(retentionDays = 365) {
  if (!retentionDays || retentionDays <= 0) return;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  db.prepare(`DELETE FROM messages WHERE created_at < ?`).run(cutoff);
}


// Preserve the existing event-search behavior; this step changes fact recall only.
function tokenizeForSearch(text) {
  const trimmed = text.trim();
  const tokens = [];
  for (const w of trimmed.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)) {
    if (w.length >= 2) tokens.push(w);
  }
  if (trimmed.length >= 2) {
    tokens.push(trimmed.slice(0, 32));
    if (/[\u4e00-\u9fff]/.test(trimmed)) {
      for (let i = 0; i < trimmed.length - 1 && tokens.length < 10; i++) tokens.push(trimmed.slice(i, i + 2));
    }
  }
  return [...new Set(tokens)].slice(0, 8);
}

/**
 * @param {string} keywordsJson
 * @returns {string[]}
 */
function parseFactKeywords(keywordsJson) {
  if (!keywordsJson) return [];
  try {
    const arr = JSON.parse(keywordsJson);
    if (!Array.isArray(arr)) return [];
    return arr.map((k) => normalizeSearchText(k).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * @param {{ factKey?: string, factValue?: string, keywords?: string }} fact
 * @param {string[]} queryTokens
 */
function computeKeywordScore(fact, queryTokens) {
  const tokens = queryTokens.map((t) => t.toLowerCase());
  const factKeywords = parseFactKeywords(fact.keywords || '');

  let keywordMatches = 0;
  for (const token of tokens) {
    if (factKeywords.some((k) => k.includes(token) || token.includes(k))) {
      keywordMatches += 1;
    }
  }
  const keywordScore = keywordMatches / Math.max(tokens.length, 1);

  const keyLower = normalizeSearchText(fact.factKey);
  const valLower = normalizeSearchText(fact.factValue);
  let likeMatches = 0;
  for (const token of tokens) {
    if (keyLower.includes(token) || valLower.includes(token)) {
      likeMatches += 1;
    }
  }
  const likeScore = likeMatches / Math.max(tokens.length, 1);

  return Math.max(keywordScore, likeScore);
}

/**
 * @param {string} query
 * @param {number} limit
 */
function searchFacts(query, limit = 8, accept, intent = analyzeRecallIntent(query)) {
  const now = Date.now();
  const trimmedQuery = String(query || '').trim();
  const queryTokens = tokenizeForFactSearch(trimmedQuery);
  if (intent?.scope==='external' || (trimmedQuery && !intent && !queryTokens.length)) return [];

  const rows = db
    .prepare(
      `SELECT id, category, fact_key AS factKey, fact_value AS factValue, importance,
              fact_type AS factType, keywords, expires_at AS expiresAt, updated_at AS updatedAt,
              CASE WHEN fact_type='temporary' THEN (SELECT created_at FROM messages WHERE id=facts.source_message_id) END AS sourceAt
       FROM facts
       WHERE episode_status IS NULL AND NOT (category='other' AND substr(fact_key,1,5)='交互教导：')
         AND ${RECALLABLE_FACT_SQL}`,
    )
    .all({recallNow:now});

  /** @type {Array<{ id: number, category: string, factKey: string, factValue: string, importance: number, relevance: number, score: number, fallbackScore: number }>} */
  const candidates = [];

  for (const row of rows) {
    if (intent && !intent.matchesFact(row)) continue;
    if (accept && !accept(row)) continue;
    const fact = {
      category: row.category,
      factKey: row.factKey,
      factValue: row.factValue,
      importance: row.importance ?? 3,
      factType: row.factType || 'permanent',
      keywords: row.keywords || '',
      expiresAt: row.expiresAt,
      updatedAt: row.updatedAt,
    };

    const relevance = getFactRelevance(fact, now);

    const keywordScore = queryTokens.length > 0 ? computeKeywordScore(fact, queryTokens) : 0;
    // An unrelated query must not fall back to fresh or important facts.
    // Empty queries retain the explicit listing behavior used by the overview.
    if (trimmedQuery && !intent && keywordScore <= 0) continue;
    const importanceNorm = fact.importance / 5;
    const score = keywordScore + relevance * 0.15 + importanceNorm * 0.1;
    const fallbackScore = relevance * fact.importance;

    candidates.push({
      id: row.id,
      category: fact.category,
      factKey: fact.factKey,
      factValue: fact.factValue,
      importance: fact.importance,
      factType: fact.factType, expiresAt: fact.expiresAt, sourceAt: row.sourceAt,
      relevance,
      score,
      fallbackScore,
    });
  }

  const sorted = [...candidates].sort((a, b) => {
    if (trimmedQuery.length === 0) {
      return b.fallbackScore - a.fallbackScore;
    }
    return b.score - a.score;
  });

  return sorted.slice(0, limit).map(({ id, category, factKey, factValue, importance, relevance, factType, expiresAt, sourceAt }) => ({
    id,
    category,
    factKey,
    factValue,
    importance,
    relevance,
    factType, expiresAt, sourceAt,
  }));
}

/**
 * @param {number} [limit]
 */
function getImportantFacts(limit = 15, now = Date.now()) {
  return db
    .prepare(
      `SELECT id, category, fact_key AS factKey, fact_value AS factValue,
              importance, fact_type AS factType, keywords, expires_at AS expiresAt,
              created_at AS createdAt, updated_at AS updatedAt,
              CASE WHEN fact_type='temporary' THEN (SELECT created_at FROM messages WHERE id=facts.source_message_id) END AS sourceAt
       FROM facts
       WHERE episode_status IS NULL AND NOT (category='other' AND substr(fact_key,1,5)='交互教导：')
         AND importance >= 4 AND ${RECALLABLE_FACT_SQL}
       ORDER BY updated_at DESC,id DESC LIMIT ?`,
    )
    .all({recallNow:now},limit);
}

/**
 * @param {string} query
 * @param {number} limit
 */
function searchEvents(query, limit = 5) {
  const tokens = tokenizeForSearch(query);
  if (!tokens.length) {
    return db
      .prepare(
        `SELECT title, body, created_at AS createdAt
         FROM events ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit);
  }

  const conditions = tokens.map(() => `(title LIKE ? OR body LIKE ?)`).join(' OR ');
  const params = tokens.flatMap((t) => [`%${t}%`, `%${t}%`]);
  params.push(limit);

  return db
    .prepare(
      `SELECT title, body, created_at AS createdAt
       FROM events WHERE ${conditions}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...params);
}

/** 不应展示给用户、也不应进入对话上下文的内部 user 消息 */
function isInternalUserMessage(content) {
  if (!content || typeof content !== 'string') return false;
  const text = content.trim();
  if (text.startsWith('[主动触发')) return true;
  if (/^用户发送了一张表情包「.+」，请根据表情含义/.test(text)) return true;
  if (/^\[消息\d+\]/.test(text)) return true;
  return false;
}

/**
 * @param {string} sessionId
 * @param {number} limit
 */
function getRecentMessages(sessionId = MAIN_SESSION_ID, limit = 20) {
  const sid = resolveSessionId(sessionId);
  const rows = db
    .prepare(
      `SELECT role, content, emotion, created_at AS createdAt
       FROM messages WHERE session_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(sid, Math.max(limit * 4, limit));

  const visible = rows
    .reverse()
    .filter((m) => !(m.role === 'user' && isInternalUserMessage(m.content)));

  return visible.slice(-limit);
}

// Conversation continuity is short-term. Infrequent users must not inadvertently
// get months-old verbatim messages as "recent" just because a chat is quiet.
function getPromptHistory(sessionId = MAIN_SESSION_ID, limit = 20, { proactive = false, includeIds = false } = {}) {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const now = Date.now(), since = now - DAY;
  const rows = db.prepare(`SELECT id,role,content,created_at FROM messages WHERE session_id=?
    AND created_at>=? ORDER BY id DESC LIMIT ?`).all(resolveSessionId(sessionId),since,Math.max(1,limit*2)).reverse();
  if (!rows.length) return [];
  const sourceOK = makeSourceGuard(db,now);
  const echoOK = makeEchoGuard(db,rows.filter(m => m.role==='assistant').map(m => m.content),now);
  const policy = proactive ? loadMentionPolicy(db, now) : null;
  let keepTurn = true;
  return rows.filter(m => {
    if (m.role==='user' && policy?.isCoolingSource(m.id)) {
      keepTurn=false;
      return false;
    }
    const repeated = policy?.hasCooling && policy.mentionsCooling(m.content,{role:m.role});
    if (m.role === 'user') keepTurn = !isInternalUserMessage(m.content) && sourceOK(m.id) && !repeated;
    return !repeated && keepTurn && (m.role !== 'assistant' || echoOK(m.content));
  }).slice(-limit).map(({id,role,content}) => includeIds ? {id,role,content} : {role,content});
}

/**
 * @param {{
 *   category: string,
 *   factKey: string,
 *   factValue: string,
 *   importance?: number,
 *   factType?: 'permanent' | 'temporary' | 'fleeting',
 *   keywords?: string,
 *   expiresAt?: number | null,
 *   sourceMessageId?: number,
 * }} fact
 */
function upsertFact(fact) {
  return memoryAudit.upsert(db, fact);
}
function saveExtractedFact(fact,userText,sourceMessageId,sourceAt) {
  const evidence = fact.evidence || userText;
  if (!userText.includes(evidence) || !evidence.includes(fact.factValue)) return null;
  const grounded = groundTemporalFact(fact,evidence,sourceAt);
  if (!grounded) return null;
  if (isResidenceFact(grounded)) {
    if (!residenceWriteAllowed(db,{id:sourceMessageId,created_at:sourceAt})) return null;
    return upsertFact({...grounded,category:'profile',factKey:'城市',sourceMessageId,evidence});
  }
  let factKey = fact.factKey;
  if (fact.category==='preference' && ['喜欢','不喜欢'].includes(factKey)) factKey += '：'+fact.factValue;
  return upsertFact({...grounded,factKey,sourceMessageId,evidence});
}
function refreshGroundedProfile() {
  const profileModule = require('./memory-user-profile');
  const profile = profileModule.buildHeuristicProfile(db);
  profile.tone = profileModule.getUserProfile(db)?.profile?.tone || '';
  profileModule.saveUserProfile(db, profile, undefined, { skipSimilarityCheck: true });
  return profileModule.getUserProfile(db);
}

async function runExtractionBatch(batch) {
  if (!batch.length) return;
  const settings = require('./settings').loadSettings();
  const { extractMemoriesWithLLM } = require('./memory-extract-llm');
  const { extractPeopleWithLLM, extractPeopleFromRules } = require('./memory-social-extract');
  const { upsertPerson } = require('./memory-people');
  let inferenceFailed = false;
  for (const item of batch) {
    const userText = String(item.userText || '').trim();
    const sourceMessageId = item.sourceMessageId ?? null;
    const source = sourceMessageId ? db.prepare('SELECT role,content,created_at,session_id FROM messages WHERE id=?').get(sourceMessageId) : null;
    if (!userText || !source || source.role !== 'user' || source.content.trim() !== userText ||
        isInternalUserMessage(userText) || userText.startsWith('【用户表情消息】')) continue;
    const passages = directMemoryPassages(userText);
    const rules = extractFromUserMessage(userText).facts;
    let inferred = [];
    if (passages.length && isCloudExtractAvailable(settings)) {
      const result=await extractMemoriesWithLLM(userText,'',settings,source.created_at);
      inferred=result.facts;inferenceFailed=inferenceFailed || Boolean(result.failed);
    }
    const { extractEpisodeCandidates } = require('./memory-episode-extract');
    const { storeEpisode } = require('./memory-episode-store');
    const episodes = extractEpisodeCandidates(userText,inferred,source.created_at);
    for (const episode of episodes) storeEpisode(db,episode,{sourceMessageId,sessionId:source.session_id});
    if (!passages.length) continue;
    for (const original of [...rules,...inferred]) {
      let fact = original;
      if (fact.category === 'event' || fact.category === 'plan') {
        // Episodes have a single lifecycle. Keep an explicit free-form memo that
        // does not describe an event as an ordinary user-requested note.
        if (episodes.length || !rules.includes(fact) || !/^(?:请|帮我)?记(?:住|一下)/.test(userText) ||
            /今天|明天|后天|昨天|这周|下周|准备|计划|参加|取消|改期|已经/.test(userText)) continue;
        fact = {...fact,category:'other'};
      }
      saveExtractedFact(fact,userText,sourceMessageId,source.created_at);
    }
    const people = passages.flatMap(passage => extractPeopleFromRules(passage).map(person => ({...person,evidence:passage})));
    if (isCloudExtractAvailable(settings)) {
      const result=await extractPeopleWithLLM(passages.join('\n'),'',settings);
      people.push(...result.people);inferenceFailed=inferenceFailed || Boolean(result.failed);
    }
    for (const person of people) {
      const evidence = person.evidence || '';
      const familyAliases = require('./memory-people').FAMILY_CANONICAL_ALIASES[person.displayName] || [];
      const mentioned = evidence.includes(person.displayName) || [...(person.aliases || []),...familyAliases].some(alias => evidence.includes(alias));
      if (!evidence || !passages.some(p => p.includes(evidence)) || !mentioned ||
          (person.notes && !evidence.includes(person.notes))) continue;
      const personId = upsertPerson(db,{...person,sourceMessageId});
      if(personId) db.prepare('INSERT INTO memory_people_sources(person_id,source_message_id,evidence,created_at) VALUES (?,?,?,?)')
        .run(personId,sourceMessageId,evidence,Date.now());
    }
  }
  lastExtractTime = Date.now();
  refreshGroundedProfile();
  if(inferenceFailed) throw new Error('Memory extraction requires retry');
}
function processCommittedTurn({sessionId=MAIN_SESSION_ID,userText,reply='',userMessageId,requestId}) {
  initMemory();
  const settings = require('./settings').loadSettings();
  if(settings.memory?.enabled === false || settings.memory?.autoExtract !== true || !userMessageId || !userText?.trim()) return Promise.resolve({skipped:true});
  const id=String(requestId || 'message-' + userMessageId);
  const run=async()=>{
    const prior=db.prepare('SELECT state FROM memory_extraction_jobs WHERE request_id=?').get(id);
    if(prior?.state === 'complete') return {duplicate:true};
    const now=Date.now();
    db.prepare(`INSERT INTO memory_extraction_jobs(request_id,session_id,source_message_id,state,created_at,updated_at) VALUES (?,?,?,'pending',?,?)
      ON CONFLICT(request_id) DO UPDATE SET state='pending',updated_at=excluded.updated_at`).run(id,sessionId,userMessageId,now,now);
    try {
      await runExtractionBatch([{userText,reply,sourceMessageId:userMessageId}]);
      await maybeCreateSummary(sessionId,settings);
      db.prepare("UPDATE memory_extraction_jobs SET state='complete',updated_at=? WHERE request_id=?").run(Date.now(),id);
      return {complete:true};
    } catch(error) {
      db.prepare("UPDATE memory_extraction_jobs SET state='failed',updated_at=? WHERE request_id=?").run(Date.now(),id);
      console.error('[memory] Extraction failed:',error.name || 'Error');
      return {complete:false};
    }
  };
  committedExtraction=committedExtraction.catch(()=>{}).then(run);
  return committedExtraction;
}


async function resumePendingExtractions() {
  initMemory();
  const settings=require('./settings').loadSettings();
  if(settings.memory?.enabled===false || settings.memory?.autoExtract!==true) return {resumed:0};
  const pending=db.prepare(`SELECT j.request_id,j.session_id,j.source_message_id,m.content
    FROM memory_extraction_jobs j JOIN messages m ON m.id=j.source_message_id
    WHERE j.state IN ('pending','failed') AND m.role='user' ORDER BY j.created_at LIMIT 20`).all();
  for(const job of pending) await require('../../usage-ledger').withUsageContext({ requestId:job.request_id,
    sessionId:job.session_id, taskId:job.request_id, purpose:'memory_extract', channel:'background' },
    () => processCommittedTurn({sessionId:job.session_id,userText:job.content,userMessageId:job.source_message_id,requestId:job.request_id}));
  return {resumed:pending.length};
}

function flushExtractions() {
  if (pendingExtractions.length === 0 || extractionFlushRunning) return;

  const batch = pendingExtractions.splice(0);
  if (!batch.length) return;

  setTimeout(() => {
    extractionFlushRunning = true;
    Promise.resolve()
      .then(() => runExtractionBatch(batch))
      .catch((err) => {
        console.error('[memory] flushExtractions failed:', err);
      })
      .finally(() => {
        extractionFlushRunning = false;
        if (
          pendingExtractions.length >= EXTRACT_BATCH_SIZE
          || (pendingExtractions.length > 0 && Date.now() - lastExtractTime > EXTRACT_COOLDOWN_MS)
        ) {
          flushExtractions();
        }
      });
  }, 0);
}

/**
 * @param {number} [timeoutMs=8000]
 */
async function flushPendingExtractionsOnQuit(timeoutMs = 8000) {
  await committedExtraction.catch(() => {});
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!extractionFlushRunning && pendingExtractions.length === 0) {
      return;
    }

    if (!extractionFlushRunning && pendingExtractions.length > 0) {
      const batch = pendingExtractions.splice(0);
      extractionFlushRunning = true;
      try {
        await runExtractionBatch(batch);
      } catch (err) {
        console.error('[memory] flushPendingExtractionsOnQuit failed:', err);
      } finally {
        extractionFlushRunning = false;
      }
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (pendingExtractions.length > 0) {
    console.warn(
      `[memory] quit flush timed out, dropped ${pendingExtractions.length} pending extraction(s)`,
    );
    pendingExtractions = [];
  }
}

/**
 * @param {string} userText
 * @param {number | null} [sourceMessageId]
 * @param {string} [assistantReply]
 */
function queueExtraction(userText, reply, sourceMessageId) {
  pendingExtractions.push({
    userText: String(userText || '').trim(),
    reply: String(reply || '').trim(),
    sourceMessageId: sourceMessageId ?? null,
  });

  const shouldFlush =
    pendingExtractions.length >= EXTRACT_BATCH_SIZE
    || (pendingExtractions.length > 0 && Date.now() - lastExtractTime > EXTRACT_COOLDOWN_MS);

  if (shouldFlush) {
    flushExtractions();
  }
}

function extractAndSave(userText, sourceMessageId = null, assistantReply = '') {
  const config = require('./settings').loadSettings().memory;
  if (config?.enabled === false || config?.autoExtract !== true) return { facts: 0, events: 0 };
  const source = db.prepare("SELECT content,created_at FROM messages WHERE id=? AND role='user'").get(sourceMessageId);
  if (!source || source.content.trim()!==userText.trim()) return {facts:0,events:0};
  queueExtraction(userText, assistantReply, sourceMessageId);

  // Events must pass the same source and status checks as a committed PC turn.
  const facts = extractFromUserMessage(userText).facts.filter(f => f.category !== 'event' && f.category !== 'plan');
  const saved = facts.filter(f=>saveExtractedFact(f,userText,sourceMessageId,source.created_at)!=null);
  return { facts: saved.length, events: 0 };
}

/**
 * @param {string} text
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 1.5);
}

/**
 * 语音通话接通前记忆块：优先 1 条摘要，再用户画像，再重要记忆。
 * @param {{ tokenBudget?: number, sessionId?: string }} [opts]
 * @returns {string}
 */
function buildCallMemoryBrief(opts = {}) {
  const tokenBudget = opts.tokenBudget ?? 280;
  const sessionId = opts.sessionId || MAIN_SESSION_ID;
  const now = Date.now();
  const policy = loadMentionPolicy(db,now);
  const allowFact = f => !policy.isCooling('fact',f.id);
  const { buildProfileContextBlock } = require('./memory-user-profile');

  /** @type {string[]} */
  const sections = [];
  let usedTokens = 0;

  const summaryReserve = Math.min(80, Math.floor(tokenBudget * 0.3));
  const summaries = getGroundedRecentSummaries(sessionId,1,now,policy);
  if (summaries.length) {
    const latest = summaries[0];
    const date = new Date(latest.createdAt).toLocaleDateString('zh-CN');
    const summaryText = String(latest.summary || '').trim();
    if (summaryText) {
      const block = `【上次聊过】${date}：${summaryText}`;
      const blockTokens = estimateTokens(block);
      if (blockTokens <= summaryReserve) {
        sections.push(block);
        usedTokens += blockTokens;
      }
    }
  }

  const profileBlock = buildProfileContextBlock(db,now,{allowFact,extraCandidates:policy.coolingCount});
  if (profileBlock) {
    const profileTokens = estimateTokens(profileBlock);
    if (usedTokens + profileTokens <= tokenBudget * 0.55) {
      sections.push(profileBlock);
      usedTokens += profileTokens;
    }
  }

  const activeImportant = getImportantFacts(10+policy.coolingCount,now).filter(allowFact).slice(0,10);

  if (activeImportant.length) {
    const lines = activeImportant.slice(0, 5).map((f) => `- ${f.factKey}：${datedFactValue(f)}`);
    const block = `【重要记忆】\n${lines.join('\n')}`;
    const blockTokens = estimateTokens(block);
    if (usedTokens + blockTokens <= tokenBudget) {
      sections.push(block);
    }
  }

  if (!sections.length) return '';
  return `${sections.join('\n\n')}\n\n请自然运用以上记忆接话，不要逐条复述或说「根据记忆」。`;
}

/**
 * @param {string} userText
 * @param {{ tokenBudget?: number, sessionId?: string, maxContextFacts?: number, maxContextEvents?: number, proactive?: boolean, teachingLookup?: boolean }} [opts]
 */
function buildMemoryContext(userText, opts = {}) {
  const tokenBudget = Number.isFinite(opts.tokenBudget) ? Math.max(0, Math.floor(opts.tokenBudget)) : 800;
  const maxFacts = Number.isFinite(opts.maxContextFacts) ? Math.max(0, Math.min(50, Math.floor(opts.maxContextFacts))) : 8;
  const maxEvents = Number.isFinite(opts.maxContextEvents) ? Math.max(0, Math.min(5, Math.floor(opts.maxContextEvents))) : 5;
  const sessionId = opts.sessionId || MAIN_SESSION_ID;
  const now = Date.now();
  const policy = loadMentionPolicy(db,now);
  const query = normalizeSearchText(userText).trim();
  const intent = analyzeRecallIntent(query);
  const tokens = tokenizeForFactSearch(userText);
  const asked = /[?？]|记得|记不记得|还记|回忆|聊聊|继续|接着|说说|讲讲|怎么|怎样|哪|什么|如何|帮我|推荐|告诉我|想知道/.test(userText);
  // “我喜欢哪种茶” can reopen the tea preference without reopening every
  // preference whose key starts with “喜欢”.
  const topicTokens = tokens.filter(t => !/^(?:喜欢|偏爱|爱|讨厌|偏好|推荐|请问|想|帮|告诉|哪|哪种|哪个|接着|继续|聊聊|说说)$/.test(t));
  function allowFact(f) {
    if (!policy.isCooling('fact',f.id)) return true;
    const value = normalizeSearchText(f.factValue).trim();
    if (value.length >= 2 && query.includes(value)) return true;
    return asked && computeKeywordScore(f,topicTokens)>0;
  }

  const { buildProfileContextBlock } = require('./memory-user-profile');
  const { buildPeopleContextBlock } = require('./memory-people');

  /** @type {string[]} */
  const sections = [];
  const instruction = intent?.scope==='self'
    ? '只用与当前问题有关的事实。把喜好、日常习惯和忌口分清。只有喜欢的依据时，只说喜欢。给建议时可以直接照顾用户的口味，缺少依据就坦白说记不清。'
    : '优先接用户当前的话。偏好可直接用来调整建议，合适时再提起缘由。刚说过的旧事让它自然过去，用户接着问时再聊。记不清就只讲有依据的大意。';
  const render = blocks => blocks.length ? `${blocks.join('\n\n')}\n\n${instruction}` : '';
  const fits = blocks => estimateTokens(render(blocks)) <= tokenBudget;

  // Preserve complete facts/summaries; a long item must not hide shorter ones.
  // Count titles, separators and the final instruction in the output budget.
  function addLines(title, items, format, { maxTokens = tokenBudget, limit = Infinity } = {}) {
    const accepted = [], lines = [];
    for (const item of items) {
      if (accepted.length >= limit) break;
      const line = format(item);
      const block = `${title}\n${[...lines, line].join('\n')}`;
      if (estimateTokens(block) > maxTokens || !fits([...sections, block])) continue;
      lines.push(line);
      accepted.push(item);
    }
    if (lines.length) sections.push(`${title}\n${lines.join('\n')}`);
    return accepted;
  }

  // Teaching is an interaction preference, not a biographical fact. Present a
  // bounded catalog even when the next request uses different words; the same
  // chat model decides whether a teaching applies and can list/get others.
  // These entries share the existing fact count and complete-output budget.
  const teaching = require('./memory-teaching');
  const teachingPool = maxFacts ? teaching.teachingCandidates({db,query:userText,limit:20}) : [];
  const taught = maxFacts ? addLines(
    '【用户教导（语义适用时参考；可修订/撤回，不改变工具能力或账号绑定）】',
    teachingPool,
    item => `- [教导#${item.id}] ${item.topic}：${item.instruction}`,
    {limit:Math.min(4,maxFacts)},
  ) : [];
  const remainingFacts = maxFacts - taught.length;
  let spareFactSlots = remainingFacts;
  function finishContext() {
    // Topic handles let the same chat model recognize a paraphrase with no
    // shared words. Only use leftover space, and only when it can read the rule.
    if (opts.teachingLookup && query && spareFactSlots && teachingPool.length > taught.length) {
      const detailed = new Set(taught.map(item => item.id));
      addLines('【其他教导主题，可按语义选取并读取正文】', teachingPool.filter(item => !detailed.has(item.id)),
        item => `- #${item.id} ${item.topic}`, {limit:Math.min(6,spareFactSlots),maxTokens:tokenBudget*.18});
    }
    return render(sections);
  }

  const factLine = f => {
    const suffix = '：'+f.factValue;
    const label = f.factKey.endsWith(suffix) ? f.factKey.slice(0,-suffix.length) : f.factKey;
    return `- ${label}：${datedFactValue(f)}`;
  };
  // A question about one kind of personal fact should not also bring in an
  // unrelated profile, an old quote, or the owner's answer for someone else.
  if (intent) {
    if (intent.scope==='self') {
      if (maxFacts) {
        spareFactSlots -= addLines('【相关记忆】',searchFacts(userText,50,undefined,intent),factLine,{limit:remainingFacts}).length;
      } else {
        const profile = buildProfileContextBlock(db,now,{allowFact:intent.matchesFact});
        if (profile && estimateTokens(profile)<=tokenBudget*0.35 && fits([...sections,profile])) sections.push(profile);
      }
    } else if (intent.allowPeople) {
      const people = buildPeopleContextBlock(db,userText,4,p => asked || !policy.isCooling('person',p.id));
      if (people && fits([...sections,people])) sections.push(people);
    }
    return finishContext();
  }

  const profileBlock = buildProfileContextBlock(db,now,{allowFact,extraCandidates:policy.coolingCount});
  if (profileBlock) {
    const profileTokens = estimateTokens(profileBlock);
    if (profileTokens <= tokenBudget * 0.35 && fits([...sections, profileBlock])) {
      sections.push(profileBlock);
    }
  }

  const peopleBlock = buildPeopleContextBlock(db,userText,4,p => asked || !policy.isCooling('person',p.id));
  if (peopleBlock) {
    const peopleTokens = estimateTokens(peopleBlock);
    if (peopleTokens <= tokenBudget * 0.2 && fits([...sections, peopleBlock])) {
      sections.push(peopleBlock);
    }
  }

  // Retrieve more candidates than the output count, so rejected long items do
  // not consume slots that a shorter candidate could use. Keep the pool bounded.
  const relatedFacts = remainingFacts && query ? searchFacts(userText,50,allowFact,null) : [];
  const activeImportant = remainingFacts ? getImportantFacts(50+policy.coolingCount,now).filter(allowFact).slice(0,50) : [];
  const episodes = recallEpisodes(db,userText,{
    tokens,limit:maxEvents,now,sessionId,policy,asked,proactive:opts.proactive===true
  });
  addLines('【之前聊到的事】',episodes,line => '- '+line,{limit:maxEvents});

  // Current query matches take precedence over general background facts.
  const included = addLines('【相关记忆】', relatedFacts, factLine, { limit: remainingFacts });
  // Deduplicate only what was actually included, never an entire rejected block.
  const includedIds = new Set(included.map(f => f.id));
  spareFactSlots -= included.length;
  spareFactSlots -= addLines('【关于你的重要记忆】', activeImportant.filter(f => !includedIds.has(f.id)), factLine,
    { maxTokens: tokenBudget * 0.5, limit: spareFactSlots }).length;

  addLines('【近期对话摘要】', getGroundedRecentSummaries(sessionId,3,now,policy), s => {
    const date = new Date(s.createdAt).toLocaleDateString('zh-CN');
    return `- 【${date}】${s.summary}`;
  });

  return finishContext();
}

/**
 * @param {{
 *   sessionId?: string,
 *   userText: string,
 *   reply: string,
 *   emotion?: string | null,
 *   extract?: boolean,
 * }} payload
 */
/**
 * 保存一轮对话到 messages 表，并触发记忆提取。
 *
 * @param {string} payload.userText — 发给 LLM 的文本（可与展示文本不同）
 * @param {string[]} [payload.userTexts] — 多条用户消息时分别插入（batch 模式）
 * @param {boolean} [payload.skipUserSave] — true 时不存 user 行（主动搭话）
 * @param {boolean} [payload.extract] — false 时跳过 extractAndSave
 */
function saveChatTurn(payload) {
  const sid = resolveSessionId(payload.sessionId);
  const now = Date.now();
  const userAt = Number.isFinite(payload.userCreatedAt) ? Math.min(now,payload.userCreatedAt) : now;
  db.prepare(`INSERT OR IGNORE INTO sessions(id,title,created_at,last_active_at) VALUES (?,?,?,?)`).run(sid, '大肥鱼 PC 聊天', now, now);

  const insertMsg = db.prepare(`
    INSERT INTO messages (session_id, role, content, emotion, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const skipUserSave = payload.skipUserSave === true;
  const userTexts =
    Array.isArray(payload.userTexts) && payload.userTexts.length > 0
      ? payload.userTexts.map((t) => String(t).trim()).filter(Boolean)
      : [payload.userText];

  let userMsgId = null;
  const extractionSources = [];
  if (!skipUserSave) {
    userTexts.forEach((text, i) => {
      const id = Number(insertMsg.run(sid, 'user', text, null, userAt + i).lastInsertRowid);
      if (i===0) userMsgId = id;
      if (payload.extract!==false) extractionSources.push({text,id});
    });
  } else if (payload.extract !== false) {
    const row = db
      .prepare(
        `SELECT id FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sid);
    userMsgId = row?.id ?? null;
    if (userMsgId && userTexts.length===1) extractionSources.push({text:userTexts[0],id:userMsgId});
  }

  insertMsg.run(
    sid,
    'assistant',
    payload.reply,
    payload.emotion || null,
    now + (skipUserSave ? 0 : userTexts.length),
  );
  touchSession(sid);

  for (const {text,id} of extractionSources) extractAndSave(text,id,payload.reply);

  if (payload.extract !== false && require('./settings').loadSettings().memory?.autoExtract === true) setTimeout(() => {
    try {
      const { loadSettings } = require('./settings');
      void maybeCreateSummary(sid, loadSettings());
    } catch (err) {
      console.error('[memory] maybeCreateSummary schedule failed:', err);
    }
  }, 0);

  return { sessionId: sid, userMessageId: userMsgId };
}

/**
 * 仅保存用户消息（发送时立即持久化，避免队列卡住时历史丢失）
 * @param {{ sessionId?: string, userText?: string, userTexts?: string[] }} payload
 */
function saveUserMessagesOnly(payload) {
  const sid = resolveSessionId(payload.sessionId);
  const now = Date.now();
  const userTexts =
    Array.isArray(payload.userTexts) && payload.userTexts.length > 0
      ? payload.userTexts.map((t) => String(t).trim()).filter(Boolean)
      : [String(payload.userText || '').trim()].filter(Boolean);

  if (!userTexts.length) return { sessionId: sid, saved: 0 };

  const insertMsg = db.prepare(`
    INSERT INTO messages (session_id, role, content, emotion, created_at)
    VALUES (?, 'user', ?, NULL, ?)
  `);

  userTexts.forEach((text, i) => {
    insertMsg.run(sid, text, now + i);
  });
  touchSession(sid);

  return { sessionId: sid, saved: userTexts.length };
}

/**
 * 获取最后一条消息的时间戳
 * @param {string} [sessionId]
 * @returns {number | null}
 */
function getLastMessageTime(sessionId = MAIN_SESSION_ID) {
  const sid = resolveSessionId(sessionId);
  const row = db
    .prepare(`SELECT created_at FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(sid);
  return row?.created_at ?? null;
}

/**
 * 最近是否已有相同助手回复（用于 Phase A 等主动问候去重）
 * @param {string} [sessionId]
 * @param {string} reply
 * @param {number} [withinMs]
 * @returns {boolean}
 */
function hasRecentDuplicateAssistantReply(sessionId, reply, withinMs = 30 * 60 * 1000) {
  const sid = resolveSessionId(sessionId);
  const normalized = String(reply || '').trim();
  if (!normalized) return false;

  const row = db
    .prepare(`
      SELECT content, created_at FROM messages
      WHERE session_id = ? AND role = 'assistant'
      ORDER BY created_at DESC
      LIMIT 1
    `)
    .get(sid);

  if (!row || row.content !== normalized) return false;
  return Date.now() - row.created_at < withinMs;
}

/**
 * 构建时间上下文，注入到 LLM prompt
 * @param {string} [sessionId]
 * @returns {string}
 */
function buildTimeContext(sessionId = MAIN_SESSION_ID) {
  const now = new Date();
  const hour = now.getHours();

  // 时段
  let period;
  if (hour >= 6 && hour < 12) period = '上午';
  else if (hour >= 12 && hour < 14) period = '中午';
  else if (hour >= 14 && hour < 18) period = '下午';
  else if (hour >= 18 && hour < 22) period = '晚上';
  else period = '深夜';

  // 当前日期时间（北京时间）
  const timeStr = `${now.getMonth() + 1}月${now.getDate()}日 ${String(hour).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  // 距离上次对话
  const lastMsg = getLastMessageTime(sessionId);
  let gapDesc = '';
  if (lastMsg) {
    const gapMs = now.getTime() - lastMsg;
    const gapMin = Math.round(gapMs / 60000);
    const gapHours = gapMs / 3600000;
    const gapDays = gapHours / 24;

    if (gapMin < 5) gapDesc = '刚刚聊过';
    else if (gapMin < 60) gapDesc = `${gapMin}分钟前聊过`;
    else if (gapHours < 24) gapDesc = `${Math.round(gapHours)}小时前聊过`;
    else if (gapDays < 30) gapDesc = `${Math.round(gapDays)}天前聊过`;
    else gapDesc = `很久没聊了（${Math.round(gapDays)}天）`;
  }

  const parts = [`当前：${timeStr}（${period}）`];
  if (gapDesc) parts.push(`上次对话：${gapDesc}`);
  return `【时间】${parts.join('。')}。`;
}

function getMemoryStats() {
  const facts = db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE active = 1`).get().n;
  const events = db.prepare(`SELECT COUNT(*) AS n FROM events`).get().n;
  const messages = db.prepare(`SELECT COUNT(*) AS n FROM messages`).get().n;
  const summaries = db.prepare(`SELECT COUNT(*) AS n FROM summaries`).get().n;
  const important = db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE active = 1 AND importance >= 4`).get().n;
  let people = 0;
  let hasProfile = false;
  try {
    people = db.prepare(`SELECT COUNT(*) AS n FROM user_people`).get().n;
    hasProfile = Boolean(db.prepare(`SELECT 1 FROM user_profile WHERE id = 1`).get());
  } catch {
    /* pre-v12 */
  }
  return { facts, events, messages, summaries, important, people, hasProfile };
}

/**
 * @param {number} [limit]
 */
function listFacts(limit = 50) {
  return db
    .prepare(
      `SELECT id, category, fact_key AS factKey, fact_value AS factValue, importance,
              fact_type AS factType, keywords, expires_at AS expiresAt, source_message_id AS sourceMessageId,
              created_at AS createdAt, updated_at AS updatedAt
       FROM facts
       WHERE active = 1
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit);
}

/**
 * @param {number} [limit]
 */
function listEvents(limit = 30) {
  return db
    .prepare(
      `SELECT id, title, body, created_at AS createdAt
       FROM events ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit);
}

/**
 * @param {string} [sessionId]
 * @param {number} [limit]
 */
function getMemoryOverview(sessionId = MAIN_SESSION_ID, limit = 30) {
  const sid = resolveSessionId(sessionId);
  const importantFacts = getImportantFacts(limit);
  const importantIds = new Set(importantFacts.map((f) => f.id));
  const relatedFacts = searchFacts('', Math.max(limit, 50))
    .filter((f) => !importantIds.has(f.id))
    .slice(0, limit);
  const summaries = getRecentSummaries(sid, limit);

  let userProfile = null;
  let people = [];
  try {
    const { getUserProfile } = require('./memory-user-profile');
    const { listPeople } = require('./memory-people');
    userProfile = getUserProfile(db);
    people = listPeople(db, limit);
  } catch {
    /* pre-v12 */
  }

  return {
    stats: getMemoryStats(),
    layers: {
      importantFacts,
      relatedFacts,
      summaries,
      userProfile,
      people,
    },
    facts: listFacts(limit),
    events: listEvents(limit),
    messages: getRecentMessages(sid, limit),
  };
}

/**
 * @param {number} id
 */
function deleteFact(id) {
  const result = memoryAudit.remove(db,id);
  refreshGroundedProfile();
  return Boolean(result);
}

/**
 * @param {number} id
 */
function deleteEvent(id) {
  const result = db.prepare(`DELETE FROM events WHERE id = ?`).run(id);
  return result.changes > 0;
}

function clearAllMemory() {
  db.exec(`
    DELETE FROM messages;
    DELETE FROM facts;
    DELETE FROM events;
    DELETE FROM summaries;
    DELETE FROM user_people;
    DELETE FROM user_profile;
    DELETE FROM memory_mentions;
  `);
  ensureMainSession();
}

function closeMemory() {
  if (db) {
    db.close();
    db = null;
  }
  openDbUserId = null;
}

function switchUserStorage(userId) {
  const nextId = userId ? String(userId).trim() : null;
  if (db && openDbUserId === nextId) return db;

  closeMemory();
  if (!nextId) return null;
  return initMemory();
}

/**
 * 写入系统级事实（category='system'），不会被对话提取覆盖。
 * 用于存储昵称等由设置页管理、不由 AI 自动提取的信息。
 */
function upsertSystemFact(factKey, factValue, importance = 5) {
  initMemory();
  upsertFact({
    category: 'system',
    factKey,
    factValue,
    importance,
    factType: 'permanent',
    keywords: '',
  });
}

/**
 * @param {string} sessionId
 * @param {number} [limit]
 */
function getRecentSummaries(sessionId, limit = 3) {
  const d = initMemory();
  const sid = resolveSessionId(sessionId);
  return d
    .prepare(
      `SELECT id, start_message_id AS startMessageId, end_message_id AS endMessageId,
              summary, created_at AS createdAt
       FROM summaries
       WHERE session_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(sid, limit);
}

// Archived summaries (including older free-form/LLM prose) are for management.
// Only verified, still-recent user quotations can enter short-term context.
function getGroundedRecentSummaries(sessionId, limit, now, policy) {
  const sid = resolveSessionId(sessionId), since = now - DAY;
  const recent = db.prepare(`SELECT start_message_id AS startId,end_message_id AS endId,
    summary,created_at AS createdAt FROM summaries WHERE session_id=? AND created_at>=?
    AND start_message_id IS NOT NULL AND end_message_id IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT ?`).all(sid,since,limit*4);
  if (!recent.length) return [];
  const sources = db.prepare(`SELECT id,content FROM messages WHERE session_id=? AND id BETWEEN ? AND ?
    AND created_at>=? AND role='user' ORDER BY id LIMIT 20`);
  const sourceOK = makeSourceGuard(db,now), out = [];
  for (const item of recent) {
    const allowed = new Set(item.summary.split('\n'));
    const lines = sources.all(sid,item.startId,item.endId,since)
      .filter(m => isSummarySource(m) && sourceOK(m.id) && !policy?.isCoolingSource(m.id)
        && !(policy?.hasCooling && policy.mentionsCooling(m.content,{role:'user'})))
      .map(m => '用户原话：' + m.content).filter(line => allowed.has(line));
    if (lines.length) out.push({createdAt:item.createdAt,summary:lines.join('\n')});
    if (out.length === limit) break;
  }
  return out;
}

function isSummarySource(m) {
  return m.content && m.content.length <= 500 && !isInternalUserMessage(m.content)
    && !m.content.trimStart().startsWith('【用户表情消息】');
}

/**
 * @param {string} sessionId
 * @param {number | null} startMessageId
 * @param {number | null} endMessageId
 * @param {string} summary
 */
function insertSummary(sessionId, startMessageId, endMessageId, summary) {
  const d = initMemory();
  const now = Date.now();
  d.prepare(`
    INSERT INTO summaries (session_id, start_message_id, end_message_id, summary, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(resolveSessionId(sessionId), startMessageId, endMessageId, summary, now);
}

/**
 * @param {string} sessionId
 * @param {object} settings
 */
async function maybeCreateSummary(sessionId, settings) {
  try {
    initMemory();
    const sid = resolveSessionId(sessionId);

    if (settings.memory?.enabled === false || settings.memory?.autoExtract !== true) {
      return;
    }

    const afterId = db.prepare('SELECT MAX(end_message_id) AS endId FROM summaries WHERE session_id=?').get(sid).endId ?? 0;
    // Only consolidate current conversation, never a backlog of cold messages.
    // Taking the latest window also lets an all-sticker batch advance naturally.
    const toSummarize = db.prepare(`SELECT id,role,content FROM messages WHERE session_id=?
      AND id>? AND created_at>=? ORDER BY id DESC LIMIT 20`).all(sid,afterId,Date.now()-DAY).reverse();
    if (toSummarize.length < 20) return;
    const sourceOK = makeSourceGuard(db);
    const lines = [];
    let length = 0;
    for (const m of toSummarize) {
      if (m.role !== 'user' || !isSummarySource(m) || !sourceOK(m.id)) continue;
      const line = '用户原话：' + m.content;
      if (length + line.length + 1 > 4000) continue;
      lines.push(line); length += line.length + 1;
    }
    const summary = lines.join('\n');
    if (!summary) return;

    insertSummary(
      sid,
      toSummarize[0].id,
      toSummarize[toSummarize.length - 1].id,
      summary,
    );
  } catch (err) {
    console.error('[memory] maybeCreateSummary failed:', err);
  }
}

/**
 * 语音通话挂断后批量 extract（不走数字生命管线）
 * @param {string} userText
 * @param {string} assistantReply
 */
async function extractFromMergedDialogue(userText, assistantReply) {
  initMemory();
  const user = String(userText || '').trim();
  if (!user) return;
  await runExtractionBatch([
    { userText: user, reply: String(assistantReply || '').trim(), sourceMessageId: null },
  ]);
}

module.exports = {
  MAIN_SESSION_ID,
  processCommittedTurn,
  resumePendingExtractions,
  refreshGroundedProfile,
  initMemory,
  closeMemory,
  switchUserStorage,
  getRecentMessages,
  getPromptHistory,
  buildMemoryContext,
  buildCallMemoryBrief,
  getLastMessageTime,
  hasRecentDuplicateAssistantReply,
  buildTimeContext,
  saveChatTurn,
  saveUserMessagesOnly,
  getMemoryStats,
  getMemoryOverview,
  listFacts,
  listEvents,
  deleteFact,
  deleteEvent,
  clearAllMemory,
  searchFacts,
  searchEvents,
  getImportantFacts,
  upsertSystemFact,
  getRecentSummaries,
  insertSummary,
  flushPendingExtractionsOnQuit,
  extractFromMergedDialogue,
  getUserProfile: () => {
    initMemory();
    const { getUserProfile } = require('./memory-user-profile');
    return getUserProfile(db);
  },
  listPeople: (limit) => {
    initMemory();
    const { listPeople } = require('./memory-people');
    return listPeople(db, limit);
  },
  deletePerson: (id) => {
    initMemory();
    const { deletePerson } = require('./memory-people');
    return deletePerson(db, id);
  },
  maybeConsolidateProfile: async () => {
    initMemory();
    const { loadSettings } = require('./settings');
    const { maybeConsolidateProfile } = require('./memory-user-profile');
    await maybeConsolidateProfile(db, loadSettings());
  },
};
