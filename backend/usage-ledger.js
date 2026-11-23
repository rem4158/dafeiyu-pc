// Numeric model usage only. Never stores prompts, completions, credentials or URLs.
const { AsyncLocalStorage } = require('node:async_hooks');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { userFilePath } = require('./electron/user-data');
const pricing = require('./usage-pricing');
const { estimateCost } = pricing;
const context = new AsyncLocalStorage();
const PURPOSES = new Set(['chat', 'memory_extract', 'memory_summary', 'memory_people', 'memory_profile',
  'proactive', 'browser_vision', 'model_test', 'cognition', 'background', 'other']);
let enabled = false, storage = null, fault = false;
let auxiliary = false;
const budgetSources = new Set();
const MAX_OUTPUT_TOKENS = 4096;
const noop = Object.freeze({ observe() {}, finish() {} });
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null;

function withUsageContext(value, operation) {
  const merged = { ...(context.getStore() || {}) };
  for (const name of ['requestId', 'sessionId', 'taskId']) if (safeId(value?.[name])) merged[name] = value[name];
  if (PURPOSES.has(value?.purpose)) merged.purpose = value.purpose;
  if (['pc', 'qq', 'system', 'background', 'other'].includes(value?.channel)) merged.channel = value.channel;
  return context.run(merged, operation);
}

function connection(settings) {
  const local = settings.provider === 'ollama';
  const config = (local ? settings.ollama : settings.cloud) || {};
  let endpoint = '', provider = local ? 'ollama' : 'compatible';
  try {
    const url = new URL(config.baseUrl);
    if (!local && url.protocol === 'https:' && url.hostname === 'api.openai.com') provider = 'openai';
    if (!local && url.protocol === 'https:' && url.hostname === 'api.deepseek.com') provider = 'deepseek';
    const suffix = ['openai', 'deepseek'].includes(provider) ? '' : url.pathname
      .replace(/\/(?:chat\/completions|responses)\/?$/i, '').replace(/\/+$/, '');
    endpoint = url.protocol + '//' + url.host.toLowerCase() + suffix;
  } catch { endpoint = 'unconfigured'; }
  return { provider, model: String(config.model || '').trim().slice(0, 160),
    source: crypto.createHash('sha256').update(`${provider}\0${endpoint}\0${local ? '' : String(config.apiKey || '').trim()}`).digest('hex') };
}

function openStorage() {
  if (!enabled) return null;
  const filename = path.resolve(userFilePath('usage-ledger.db'));
  if (storage?.active && storage.filename === filename) return storage;
  if (storage?.active) { storage.active = false; storage.db.close(); }
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  try {
    db.exec(`PRAGMA busy_timeout=1500; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS usage_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_usage (
        id TEXT PRIMARY KEY,source TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,
        kind TEXT NOT NULL,purpose TEXT NOT NULL,channel TEXT NOT NULL,
        request_id TEXT,session_id TEXT,task_id TEXT,created_at INTEGER NOT NULL,finished_at INTEGER,
        state TEXT NOT NULL,input_tokens INTEGER,output_tokens INTEGER,total_tokens INTEGER,
        cached_tokens INTEGER,reasoning_tokens INTEGER,cache_write_tokens INTEGER,
        cache_write_30m_tokens INTEGER,cache_write_12h_tokens INTEGER,service_tier TEXT,
        estimated_cost REAL,currency TEXT,price_version TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_usage_source_time ON model_usage(source,created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_request ON model_usage(source,request_id);
      CREATE INDEX IF NOT EXISTS idx_usage_task ON model_usage(source,task_id);
      CREATE TABLE IF NOT EXISTS usage_budget_policy (
        source TEXT NOT NULL,scope TEXT NOT NULL,task_id TEXT NOT NULL DEFAULT '',
        tokens INTEGER,usd REAL,updated_at INTEGER NOT NULL,
        PRIMARY KEY(source,scope,task_id)
      );
      CREATE TABLE IF NOT EXISTS usage_budget_origin (
        source TEXT PRIMARY KEY,origin_order INTEGER NOT NULL,request_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_budget_audit (
        source TEXT NOT NULL,operation_id TEXT NOT NULL,scope TEXT NOT NULL,task_id TEXT NOT NULL,
        tokens INTEGER,usd REAL,origin_order INTEGER NOT NULL,request_id TEXT NOT NULL,created_at INTEGER NOT NULL,
        PRIMARY KEY(source,operation_id)
      );
      CREATE TABLE IF NOT EXISTS usage_budget_reservation (
        call_id TEXT PRIMARY KEY,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,
        reserved_tokens INTEGER NOT NULL,reserved_usd REAL,currency TEXT,price_version TEXT,
        FOREIGN KEY(call_id) REFERENCES model_usage(id)
      );`);
    db.prepare("INSERT OR IGNORE INTO usage_meta(key,value) VALUES ('started_at',?)").run(String(Date.now()));
    if (!auxiliary) db.prepare("UPDATE model_usage SET state='interrupted',finished_at=? WHERE state='pending'").run(Date.now());
    storage = { db, filename, active: true };
    return storage;
  } catch (error) { db.close(); throw error; }
}

// An auxiliary client writes its own usage through the same transaction and budget
// engine, without taking over crash recovery for a concurrently running backend.
function enableUsageLedger(options = {}) {
  if (!enabled) auxiliary = options.auxiliary === true;
  enabled = true;
  try { openStorage(); return true; } catch { fault = true; return false; }
}

function budgetError(code) {
  const error = new Error(code); error.code = code; return error;
}

function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = operation(); db.exec('COMMIT'); return result; }
  catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}

function dayRange(now) {
  const date = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  const start = Date.parse(date + 'T00:00:00+08:00');
  return [start, start + 86400000];
}

function loadPolicies(db, source, taskId) {
  const policies = { daily: null, per_task: null, current_task: null };
  for (const row of db.prepare(`SELECT scope,task_id,tokens,usd FROM usage_budget_policy
    WHERE source=? AND (scope<>'task' OR task_id=?)`).all(source, taskId || '')) {
    policies[row.scope === 'task' ? 'current_task' : row.scope] = { tokens: row.tokens, usd: row.usd };
  }
  if (Object.values(policies).some(Boolean)) budgetSources.add(source);
  return policies;
}

// A held invocation contributes its upper bound instead of its observed partial usage.
// Old invocations without an upper bound remain explicitly unresolved, never zero.
function budgetTotals(db, source, where = '', params = []) {
  const rows = db.prepare(`SELECT u.id,u.state,u.total_tokens,u.estimated_cost,
    r.call_id,r.reserved_tokens,r.reserved_usd FROM model_usage u
    LEFT JOIN usage_budget_reservation r ON r.call_id=u.id WHERE u.source=? ${where}`).all(source, ...params);
  const result = { used_tokens: 0, reserved_tokens: 0, used_usd: 0, reserved_usd: 0,
    remaining_tokens: null, remaining_usd: null, unresolved_tokens: [], unresolved_usd: [] };
  for (const row of rows) {
    const held = row.call_id && (row.state === 'pending' || row.state === 'interrupted' || row.total_tokens === null);
    if (held) result.reserved_tokens += row.reserved_tokens;
    else if (row.total_tokens !== null) result.used_tokens += row.total_tokens;
    else result.unresolved_tokens.push(row.id);
    if (row.call_id && (held || row.estimated_cost === null)) {
      if (row.reserved_usd !== null) result.reserved_usd += row.reserved_usd;
      else result.unresolved_usd.push(row.id);
    } else if (row.estimated_cost !== null) result.used_usd += row.estimated_cost;
    else result.unresolved_usd.push(row.id);
  }
  return result;
}

function intersectLimits(...policies) {
  const available = policies.filter(Boolean);
  if (!available.length) return null;
  const minimum = name => {
    const values = available.map(policy => policy[name]).filter(value => value !== null);
    return values.length ? Math.min(...values) : null;
  };
  return { tokens: minimum('tokens'), usd: minimum('usd') };
}

function applyLimits(totals, limits, unresolved) {
  if (!limits) return;
  if (limits.tokens !== null) {
    totals.remaining_tokens = Math.max(0, limits.tokens - totals.used_tokens - totals.reserved_tokens);
    for (const id of totals.unresolved_tokens) unresolved.add(id);
  }
  if (limits.usd !== null) {
    totals.remaining_usd = Math.max(0, limits.usd - totals.used_usd - totals.reserved_usd);
    for (const id of totals.unresolved_usd) unresolved.add(id);
  }
}

function budgetSnapshot(db, info, taskId, now) {
  const policies = loadPolicies(db, info.source, taskId);
  const [start, end] = dayRange(now);
  const daily = budgetTotals(db, info.source, 'AND u.created_at>=? AND u.created_at<?', [start, end]);
  const task = safeId(taskId) ? budgetTotals(db, info.source, 'AND u.task_id=?', [taskId]) : {
    used_tokens: 0, reserved_tokens: 0, used_usd: 0, reserved_usd: 0,
    remaining_tokens: null, remaining_usd: null, unresolved_tokens: [], unresolved_usd: [] };
  const unresolved = new Set();
  applyLimits(daily, policies.daily, unresolved);
  applyLimits(task, intersectLimits(policies.per_task, policies.current_task), unresolved);
  const enforced = Object.values(policies).some(Boolean);
  const exhausted = unresolved.size > 0 || [daily, task].some(row =>
    row.remaining_tokens !== null && row.remaining_tokens <= 0 || row.remaining_usd !== null && row.remaining_usd <= 0);
  return { status: enforced ? exhausted ? 'exhausted' : 'active' : 'not_configured', enforced,
    policies, daily, task, unresolved_calls: unresolved.size, max_output_tokens: MAX_OUTPUT_TOKENS };
}

function publicBudget(snapshot) {
  for (const scope of ['daily', 'task']) {
    delete snapshot[scope].unresolved_tokens; delete snapshot[scope].unresolved_usd;
  }
  return snapshot;
}

function getBudgetStatus(settings, { taskId = context.getStore()?.taskId, now = Date.now() } = {}) {
  const info = connection(settings);
  if (!enabled) return publicBudget({ status: 'not_configured', enforced: false,
    policies: { daily: null, per_task: null, current_task: null },
    daily: { used_tokens: 0, reserved_tokens: 0, used_usd: 0, reserved_usd: 0, remaining_tokens: null, remaining_usd: null },
    task: { used_tokens: 0, reserved_tokens: 0, used_usd: 0, reserved_usd: 0, remaining_tokens: null, remaining_usd: null },
    unresolved_calls: 0, max_output_tokens: MAX_OUTPUT_TOKENS });
  try {
    const result = publicBudget(budgetSnapshot(openStorage().db, info, safeId(taskId), now));
    if (fault) { result.status = 'unavailable'; result.error_code = 'usage_budget_unavailable'; }
    return result;
  } catch {
    fault = true;
    return { status: 'unavailable', enforced: budgetSources.has(info.source), error_code: 'usage_budget_unavailable',
      policies: null, daily: null, task: null, unresolved_calls: null, max_output_tokens: MAX_OUTPUT_TOKENS };
  }
}

function hasActiveBudget(settings) {
  if (!enabled) return false;
  try {
    if (fault) throw budgetError('usage_budget_unavailable');
    return Object.values(loadPolicies(openStorage().db, connection(settings).source,
      safeId(context.getStore()?.taskId))).some(Boolean);
  } catch { fault = true; throw budgetError('usage_budget_unavailable'); }
}

function validateMutation({ tokens, usd, originOrder, operationId, requestId }) {
  if (!(tokens === null || Number.isSafeInteger(tokens) && tokens >= 1 && tokens <= 1e9) ||
      !(usd === null || typeof usd === 'number' && Number.isFinite(usd) && usd > 0 && usd <= 1e6 &&
        Number(usd.toFixed(6)) === usd) ||
      !Number.isSafeInteger(originOrder) || originOrder < 0 || !safeId(operationId) || !safeId(requestId))
    throw budgetError('usage_budget_invalid');
}

function assertCurrentOrigin(db, source, originOrder, requestId) {
  const previous = db.prepare('SELECT origin_order,request_id FROM usage_budget_origin WHERE source=?').get(source);
  if (previous && (originOrder < previous.origin_order || originOrder === previous.origin_order && requestId !== previous.request_id))
    throw budgetError('usage_budget_stale');
}

function storeOrigin(db, source, originOrder, requestId) {
  db.prepare(`INSERT INTO usage_budget_origin(source,origin_order,request_id) VALUES(?,?,?)
    ON CONFLICT(source) DO UPDATE SET origin_order=excluded.origin_order,request_id=excluded.request_id`)
    .run(source, originOrder, requestId);
}

function writePolicy(db, source, scope, taskId, tokens, usd, now) {
  if (tokens === null && usd === null) {
    db.prepare('DELETE FROM usage_budget_policy WHERE source=? AND scope=? AND task_id=?').run(source, scope, taskId);
  } else {
    db.prepare(`INSERT INTO usage_budget_policy(source,scope,task_id,tokens,usd,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(source,scope,task_id) DO UPDATE SET tokens=excluded.tokens,usd=excluded.usd,updated_at=excluded.updated_at`)
      .run(source, scope, taskId, tokens, usd, now);
  }
}

function setBudget(settings, options = {}) {
  const { scope, tokens, usd, taskId = context.getStore()?.taskId, requestId,
    originOrder, operationId } = options;
  validateMutation({ tokens, usd, originOrder, operationId, requestId });
  if (!['daily', 'per_task', 'task'].includes(scope) || scope === 'task' && !safeId(taskId))
    throw budgetError('usage_budget_invalid');
  if (!enabled || fault) throw budgetError('usage_budget_unavailable');
  const info = connection(settings), policyTaskId = scope === 'task' ? taskId : '';
  let duplicate = false;
  try {
    const db = openStorage().db;
    transaction(db, () => {
      const previous = db.prepare('SELECT * FROM usage_budget_audit WHERE source=? AND operation_id=?').get(info.source, operationId);
      if (previous) {
        if (previous.scope !== scope || previous.task_id !== policyTaskId || previous.tokens !== tokens || previous.usd !== usd ||
            previous.origin_order !== originOrder || previous.request_id !== requestId)
          throw budgetError('usage_budget_operation_conflict');
        duplicate = true; return;
      }
      assertCurrentOrigin(db, info.source, originOrder, requestId);
      writePolicy(db, info.source, scope, policyTaskId, tokens, usd, Date.now());
      storeOrigin(db, info.source, originOrder, requestId);
      db.prepare(`INSERT INTO usage_budget_audit
        (source,operation_id,scope,task_id,tokens,usd,origin_order,request_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(info.source, operationId, scope, policyTaskId, tokens, usd, originOrder, requestId, Date.now());
    });
    const budget = publicBudget(budgetSnapshot(db, info, safeId(taskId), Date.now()));
    return { applied: true, idempotent: duplicate, scope, limits: tokens === null && usd === null ? null : { tokens, usd }, budget };
  } catch (error) {
    if (error.code?.startsWith('usage_budget_')) throw error;
    fault = true; throw budgetError('usage_budget_unavailable');
  }
}

function setTokenLimits(settings, limits, originOrder) {
  const entries = Object.entries(limits);
  if (!entries.length || !Number.isSafeInteger(originOrder) || originOrder < 0 || entries.some(([scope, tokens]) =>
    !['daily', 'per_task'].includes(scope) || (tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > 10_000_000)))) {
    throw budgetError('usage_budget_invalid');
  }
  if (!enabled || fault) throw budgetError('usage_budget_unavailable');
  const { source } = connection(settings);
  const requestId = 'local-settings';
  const now = Date.now();
  try {
    const { db } = openStorage();
    transaction(db, () => {
      const previous = db.prepare('SELECT origin_order FROM usage_budget_origin WHERE source=?').get(source);
      if (previous && originOrder < previous.origin_order) throw budgetError('usage_budget_stale');
      const policies = loadPolicies(db, source);
      const audit = db.prepare(`INSERT INTO usage_budget_audit
        (source,operation_id,scope,task_id,tokens,usd,origin_order,request_id,created_at) VALUES(?,?,?,'',?,?,?,?,?)`);
      for (const [scope, tokens] of entries) {
        const usd = policies[scope]?.usd ?? null;
        writePolicy(db, source, scope, '', tokens, usd, now);
        audit.run(source, crypto.randomUUID(), scope, tokens, usd, originOrder, requestId, now);
      }
      storeOrigin(db, source, originOrder, requestId);
    });
  } catch (error) {
    if (error.code?.startsWith('usage_budget_')) throw error;
    fault = true;
    throw budgetError('usage_budget_unavailable');
  }
}

function clearBudgets(settings, { originOrder, operationId } = {}) {
  const requestId = 'local-clear';
  validateMutation({ tokens: null, usd: null, originOrder, operationId, requestId });
  if (!enabled || fault) throw budgetError('usage_budget_unavailable');
  const info = connection(settings);
  try {
    const db = openStorage().db;
    let duplicate = false;
    transaction(db, () => {
      const previous = db.prepare('SELECT * FROM usage_budget_audit WHERE source=? AND operation_id=?').get(info.source, operationId);
      if (previous) {
        if (previous.scope !== 'clear' || previous.origin_order !== originOrder || previous.request_id !== requestId)
          throw budgetError('usage_budget_operation_conflict');
        duplicate = true; return;
      }
      // Local recovery can supersede the newest chat at the same order.
      const previousOrigin = db.prepare('SELECT origin_order FROM usage_budget_origin WHERE source=?').get(info.source);
      if (previousOrigin && originOrder < previousOrigin.origin_order) throw budgetError('usage_budget_stale');
      db.prepare('DELETE FROM usage_budget_policy WHERE source=?').run(info.source);
      storeOrigin(db, info.source, originOrder, requestId);
      db.prepare(`INSERT INTO usage_budget_audit
        (source,operation_id,scope,task_id,tokens,usd,origin_order,request_id,created_at) VALUES(?,?,'clear','',NULL,NULL,?,?,?)`)
        .run(info.source, operationId, originOrder, requestId, Date.now());
    });
    return { applied: true, idempotent: duplicate, budget: publicBudget(budgetSnapshot(db, info, safeId(context.getStore()?.taskId), Date.now())) };
  } catch (error) {
    if (error.code?.startsWith('usage_budget_')) throw error;
    fault = true; throw budgetError('usage_budget_unavailable');
  }
}

function normalizeUsage(data, kind) {
  const raw = kind === 'ollama' ? { input_tokens: data?.prompt_eval_count, output_tokens: data?.eval_count } : data?.usage;
  if (!raw || typeof raw !== 'object') return null;
  const input = count(raw.input_tokens ?? raw.prompt_tokens), output = count(raw.output_tokens ?? raw.completion_tokens);
  if (input === null || output === null || count(input + output) === null) return null;
  if (raw.total_tokens !== undefined && count(raw.total_tokens) !== input + output) return null;
  const details = raw.input_tokens_details || raw.prompt_tokens_details || {};
  const outputDetails = raw.output_tokens_details || raw.completion_tokens_details || {};
  let cached = count(details.cached_tokens ?? raw.prompt_cache_hit_tokens);
  let reasoning = count(outputDetails.reasoning_tokens);
  let writes = count(details.cache_write_tokens);
  const retention = details.cache_write_tokens_details || {};
  let write30 = count(retention.ttl_30m_tokens), write12 = count(retention.ttl_12h_tokens);
  if (kind === 'ollama') { cached = 0; writes = 0; reasoning = null; }
  if (writes === 0) { write30 = 0; write12 = 0; }
  if (cached !== null && cached > input) cached = null;
  if (raw.prompt_cache_miss_tokens !== undefined &&
      (count(raw.prompt_cache_miss_tokens) === null || cached === null || cached + raw.prompt_cache_miss_tokens !== input)) cached = null;
  if (reasoning !== null && reasoning > output) reasoning = null;
  if (writes !== null && (writes > input || (cached !== null && cached + writes > input))) writes = null;
  if (write30 !== null && write12 !== null && write30 + write12 !== writes) { write30 = null; write12 = null; }
  return { input_tokens: input, output_tokens: output, total_tokens: input + output,
    cached_tokens: cached, reasoning_tokens: reasoning, cache_write_tokens: writes,
    cache_write_30m_tokens: write30, cache_write_12h_tokens: write12,
    service_tier: ['default', 'standard', 'auto', 'flex', 'priority', 'fast', 'scale'].includes(data.service_tier)
      ? data.service_tier : data.service_tier == null ? 'default' : 'unknown' };
}

function upperCost(info, input, output) {
  const priced = typeof pricing.estimateUpperCost === 'function'
    ? pricing.estimateUpperCost({ provider: info.provider, model: info.model, input_tokens: input, output_tokens: output })
    : { amount: null, currency: null, price_version: null };
  return priced.currency === 'USD' && typeof priced.amount === 'number' && Number.isFinite(priced.amount) && priced.amount >= 0
    ? priced : { amount: null, currency: null, price_version: null };
}

function admitReservation(db, info, current, reservation, now) {
  // The normal unconfigured path need not rescan past invocations on every call.
  if (!Object.values(loadPolicies(db, info.source, safeId(current.taskId))).some(Boolean)) {
    if (!reservation || count(reservation.inputTokens) === null ||
        !Number.isSafeInteger(reservation.maxOutputTokens) || reservation.maxOutputTokens < 1) return null;
    if (count(reservation.inputTokens + reservation.maxOutputTokens) === null) throw budgetError('usage_budget_invalid');
    const priced = upperCost(info, reservation.inputTokens, reservation.maxOutputTokens);
    return { inputTokens: reservation.inputTokens, maxOutputTokens: reservation.maxOutputTokens,
      tokens: reservation.inputTokens + reservation.maxOutputTokens,
      usd: priced.amount, currency: priced.currency, priceVersion: priced.price_version };
  }
  const snapshot = budgetSnapshot(db, info, safeId(current.taskId), now);
  if (snapshot.enforced && (!reservation || count(reservation.inputTokens) === null ||
      !Number.isSafeInteger(reservation.maxOutputTokens) || reservation.maxOutputTokens < 1))
    throw budgetError('usage_budget_preflight_required');
  if (snapshot.enforced && (snapshot.policies.per_task || snapshot.policies.current_task) && !safeId(current.taskId))
    throw budgetError('usage_budget_context_required');
  if (!reservation || count(reservation.inputTokens) === null ||
      !Number.isSafeInteger(reservation.maxOutputTokens) || reservation.maxOutputTokens < 1) return null;
  if (snapshot.unresolved_calls) throw budgetError('usage_budget_unresolved');
  const input = reservation.inputTokens;
  const desired = snapshot.enforced ? Math.min(reservation.maxOutputTokens, MAX_OUTPUT_TOKENS) : reservation.maxOutputTokens;
  if (count(input + desired) === null) throw budgetError('usage_budget_invalid');
  const scopes = [
    { totals: snapshot.daily, limits: snapshot.policies.daily },
    { totals: snapshot.task, limits: intersectLimits(snapshot.policies.per_task, snapshot.policies.current_task) },
  ].filter(scope => scope.limits);
  const moneyRequired = scopes.some(scope => scope.limits.usd !== null);
  const fits = output => {
    const priced = upperCost(info, input, output);
    if (moneyRequired && priced.amount === null) throw budgetError('usage_budget_unpriced');
    return scopes.every(({ totals, limits }) =>
      (limits.tokens === null || totals.used_tokens + totals.reserved_tokens + input + output <= limits.tokens) &&
      (limits.usd === null || totals.used_usd + totals.reserved_usd + priced.amount <= limits.usd));
  };
  if (!fits(1)) throw budgetError('usage_budget_exceeded');
  let low = 1, high = desired;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle; else high = middle - 1;
  }
  const priced = upperCost(info, input, low);
  return { inputTokens: input, maxOutputTokens: low, tokens: input + low,
    usd: priced.amount, currency: priced.currency, priceVersion: priced.price_version };
}

function beginCall(settings, { kind = 'chat_completions', reservation } = {}) {
  if (!enabled) return noop;
  let store, id, info, admitted;
  try {
    store = openStorage(); info = connection(settings); id = crypto.randomUUID();
    if (fault && (auxiliary || budgetSources.has(info.source))) throw budgetError('usage_budget_unavailable');
    const current = context.getStore() || {};
    transaction(store.db, () => {
      const now = Date.now();
      admitted = admitReservation(store.db, info, current, reservation, now);
      store.db.prepare(`INSERT INTO model_usage
        (id,source,provider,model,kind,purpose,channel,request_id,session_id,task_id,created_at,state)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending')`).run(id, info.source, info.provider, info.model,
        ['responses', 'chat_completions', 'ollama'].includes(kind) ? kind : 'chat_completions',
        current.purpose || 'background', current.channel || 'background', current.requestId || null,
        current.sessionId || null, current.taskId || null, now);
      if (admitted) store.db.prepare(`INSERT INTO usage_budget_reservation
        (call_id,input_tokens,output_tokens,reserved_tokens,reserved_usd,currency,price_version) VALUES(?,?,?,?,?,?,?)`)
        .run(id, admitted.inputTokens, admitted.maxOutputTokens, admitted.tokens, admitted.usd, admitted.currency, admitted.priceVersion);
    });
  } catch (error) {
    if (error.code?.startsWith('usage_budget_')) throw error;
    fault = true;
    if (auxiliary || reservation || budgetSources.has(info?.source)) throw budgetError('usage_budget_unavailable');
    return noop;
  }
  let finished = false;
  return {
    ...(admitted ? { maxOutputTokens: admitted.maxOutputTokens } : {}),
    observe(data) {
      if (finished || !store.active) return;
      const usage = normalizeUsage(data, kind);
      if (!usage) return;
      try {
        const priced = usage.cached_tokens !== null && usage.cache_write_tokens !== null
          ? estimateCost({ ...usage, provider: info.provider, model: info.model }) : { amount: null, currency: null, price_version: null };
        store.db.prepare(`UPDATE model_usage SET input_tokens=?,output_tokens=?,total_tokens=?,cached_tokens=?,
          reasoning_tokens=?,cache_write_tokens=?,cache_write_30m_tokens=?,cache_write_12h_tokens=?,
          service_tier=?,estimated_cost=?,currency=?,price_version=? WHERE id=?`).run(
          usage.input_tokens, usage.output_tokens, usage.total_tokens, usage.cached_tokens, usage.reasoning_tokens,
          usage.cache_write_tokens, usage.cache_write_30m_tokens, usage.cache_write_12h_tokens, usage.service_tier,
          priced.amount, priced.currency, priced.price_version, id);
      } catch { fault = true; }
    },
    finish(state = 'completed') {
      if (finished || !store.active) return;
      finished = true;
      try { store.db.prepare('UPDATE model_usage SET state=?,finished_at=? WHERE id=?').run(
        ['completed', 'failed', 'cancelled', 'interrupted'].includes(state) ? state : 'failed', Date.now(), id); }
      catch { fault = true; }
    },
  };
}

const AGGREGATE = `COUNT(*) calls,
  COALESCE(SUM(total_tokens IS NOT NULL),0) known_calls,
  COALESCE(SUM(total_tokens IS NULL AND state<>'pending'),0) unknown_calls,
  COALESCE(SUM(state='pending'),0) pending_calls,
  COALESCE(SUM(state='failed'),0) failed_calls,COALESCE(SUM(state='cancelled'),0) cancelled_calls,
  COALESCE(SUM(state='interrupted'),0) interrupted_calls,
  COALESCE(SUM(input_tokens),0) input_tokens,COALESCE(SUM(output_tokens),0) output_tokens,
  COALESCE(SUM(total_tokens),0) total_tokens,COALESCE(SUM(cached_tokens),0) known_cached_tokens,
  COALESCE(SUM(reasoning_tokens),0) known_reasoning_tokens,COALESCE(SUM(cache_write_tokens),0) known_cache_write_tokens,
  COALESCE(SUM(total_tokens IS NOT NULL AND cached_tokens IS NULL),0) cached_details_unknown_calls,
  COALESCE(SUM(total_tokens IS NOT NULL AND reasoning_tokens IS NULL),0) reasoning_details_unknown_calls,
  COALESCE(SUM(total_tokens IS NOT NULL AND cache_write_tokens IS NULL),0) cache_write_details_unknown_calls,
  COALESCE(SUM(total_tokens IS NOT NULL AND estimated_cost IS NULL),0) unpriced_calls,
  COUNT(estimated_cost) priced_calls,SUM(estimated_cost) estimated_cost,MAX(currency) currency,
  MAX(created_at) last_call_at,MAX(finished_at) last_settled_at`;

function publicTotals(row, provider) {
  const total = { ...row };
  total.cached_tokens = row.cached_details_unknown_calls ? null : row.known_cached_tokens;
  total.reasoning_tokens = row.reasoning_details_unknown_calls ? null : row.known_reasoning_tokens;
  total.cache_write_tokens = row.cache_write_details_unknown_calls ? null : row.known_cache_write_tokens;
  if (!row.calls && provider === 'openai') { total.estimated_cost = 0; total.currency = 'USD'; }
  total.cost_is_estimate = true;
  total.complete = row.unknown_calls === 0 && row.pending_calls === 0;
  return total;
}

function getUsageSummary(settings, { requestId, taskId, now = Date.now() } = {}) {
  const info = connection(settings);
  const result = { available: false, status: enabled ? 'unavailable' : 'disabled',
    scope: 'this_app_only', provider: info.provider, model: info.model, timezone: 'Asia/Shanghai',
    started_at: null, updated_at: now, today: {}, all_time: {} };
  if (!enabled) return result;
  try {
    const store = openStorage(), db = store.db;
    const [start] = dayRange(now);
    const heldTotals = (where, params) => {
      const budget = budgetTotals(db, info.source, where, params);
      return { budget_used_tokens: budget.used_tokens, reserved_tokens: budget.reserved_tokens,
        budget_used_usd: budget.used_usd, reserved_usd: budget.reserved_usd,
        budget_unresolved_calls: new Set([...budget.unresolved_tokens, ...budget.unresolved_usd]).size };
    };
    const totals = (where, params) => ({ ...publicTotals(db.prepare(`SELECT ${AGGREGATE} FROM model_usage WHERE source=? ${where}`)
      .get(info.source, ...params), info.provider), ...heldTotals(where, params) });
    result.started_at = Number(db.prepare("SELECT value FROM usage_meta WHERE key='started_at'").get()?.value) || null;
    result.today = totals('AND created_at>=? AND created_at<?', [start, start + 86400000]);
    result.all_time = totals('', []);
    result.price_versions = db.prepare(`SELECT DISTINCT price_version FROM model_usage
      WHERE source=? AND price_version IS NOT NULL ORDER BY price_version DESC LIMIT 8`).all(info.source)
      .map(row => row.price_version);
    result.today.by_purpose = {};
    for (const row of db.prepare(`SELECT purpose,${AGGREGATE} FROM model_usage
      WHERE source=? AND created_at>=? AND created_at<? GROUP BY purpose`).all(info.source, start, start + 86400000)) {
      const { purpose, ...values } = row; result.today.by_purpose[purpose] = publicTotals(values, info.provider);
    }
    if (safeId(requestId)) result.current_request = totals('AND request_id=?', [requestId]);
    if (safeId(taskId)) result.current_task = totals('AND task_id=?', [taskId]);
    const previous = db.prepare(`SELECT request_id FROM model_usage WHERE source=? AND request_id IS NOT NULL
      AND request_id<>? ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(info.source, safeId(requestId) || '');
    if (previous) result.previous_request = totals('AND request_id=?', [previous.request_id]);
    result.available = !fault; result.status = fault ? 'unavailable' : 'ok';
    if (fault) result.error_code = 'usage_storage_incomplete';
    return result;
  } catch { fault = true; result.error_code = 'usage_storage_unavailable'; return result; }
}

function getTokenLimitView(settings, now = Date.now()) {
  if (!enabled || fault) throw budgetError('usage_budget_unavailable');
  const info = connection(settings);
  try {
    const { db } = openStorage();
    const latest = db.prepare(`SELECT task_id FROM model_usage WHERE source=? AND task_id IS NOT NULL
      ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(info.source)?.task_id;
    const [start, end] = dayRange(now);
    const totals = (where, ...values) => db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS tokens,
      COALESCE(SUM(total_tokens IS NULL AND state<>'pending'),0) AS unknown,
      COALESCE(SUM(state='pending'),0) AS pending FROM model_usage WHERE source=? AND ${where}`).get(info.source, ...values);
    return { budget: publicBudget(budgetSnapshot(db, info, latest, now)),
      today: totals('created_at>=? AND created_at<?', start, end),
      latest_task: latest ? totals('task_id=?', latest) : null };
  } catch {
    fault = true;
    throw budgetError('usage_budget_unavailable');
  }
}

function closeUsageLedger() {
  enabled = false;
  if (storage?.active) {
    try {
      if (!auxiliary) storage.db.prepare("UPDATE model_usage SET state='interrupted',finished_at=? WHERE state='pending'").run(Date.now());
      storage.active = false; storage.db.close();
    } catch { fault = true; }
  }
  storage = null; fault = false; auxiliary = false;
}

module.exports = { enableUsageLedger, closeUsageLedger, withUsageContext, beginCall, getUsageSummary,
  getBudgetStatus, getTokenLimitView, setBudget, setTokenLimits, clearBudgets, hasActiveBudget,
  connectionKey: settings => connection(settings).source };
