// User-taught interaction preferences live in the same facts/revision store.
// The chat model decides when a message is teaching; there is no language router here.
const audit = require('./memory-audit');
const { RECALLABLE_FACT_SQL, makeSourceGuard } = require('./memory-validity');
const { normalizeSearchText, tokenizeForFactSearch } = require('./memory-search-text');

const CATEGORY = 'other';
const PREFIX = '交互教导：';
const KEYWORDS = JSON.stringify(['@interaction-teaching']);
// Short grammatical words occur in both unrelated requests and instructions
// ("整理登山扣时" / "疲惫时"). Keep meaningful one-character topics such as 茶.
const grammaticalTerms = new Set(['时','时候','当','着','把','被','地','得','从','向','让','给','到','再','先','能否']);
const SELECT = `SELECT * FROM facts WHERE category='other' AND substr(fact_key,1,5)='交互教导：'`;
function error(code) { return Object.assign(new Error(code), { code }); }
function settingsValue(options = {}) {
  if (options.settings) return options.settings;
  return (options.getSettings || (() => require('./settings').loadSettings()))();
}
function enabled(options) { return settingsValue(options)?.memory?.enabled !== false; }
function checkEnabled(options) { if (!enabled(options)) throw error('memory_disabled'); }
function text(value, max, name) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw error('teaching_invalid_' + name);
  return value.trim();
}
function id(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw error('teaching_invalid_id');
  return value;
}
function isTeaching(fact) { return fact?.category === CATEGORY && fact.fact_key?.startsWith(PREFIX); }
function present(fact) {
  return { id: fact.id, topic: fact.fact_key.slice(PREFIX.length), instruction: fact.fact_value,
    importance: fact.importance, sourceMessageId: fact.source_message_id, updatedAt: fact.updated_at };
}
function usable(db, fact, now = Date.now()) {
  if (!isTeaching(fact) || fact.active !== 1) return false;
  const current = db.prepare(`SELECT id FROM facts WHERE id=? AND ${RECALLABLE_FACT_SQL}`).get({ recallNow: now }, fact.id);
  return !!current && makeSourceGuard(db, now)(fact.source_message_id, fact.id);
}
function getTeaching({ db, id: factId, ...options }) {
  checkEnabled(options); audit.init(db);
  const fact = audit.row(db, id(factId));
  return usable(db, fact) ? present(fact) : null;
}
function teachingPage({ db, limit = 20, query = '', offset = 0, includeRecent = false, ...options }) {
  checkEnabled(options); audit.init(db);
  const take = Number.isInteger(limit) ? Math.max(0, Math.min(limit, 50)) : 20;
  if (!take) return { teachings: [], nextOffset: null };
  const now = Date.now(), sourceOK = makeSourceGuard(db, now);
  const statement = db.prepare(`${SELECT} AND ${RECALLABLE_FACT_SQL} ORDER BY updated_at DESC,id DESC`);
  let rows = statement.iterate({ recallNow: now });
  if (query) {
    const terms = tokenizeForFactSearch(query).filter(term => !grammaticalTerms.has(term));
    const ranked = [];
    for (const row of rows) {
      const title = normalizeSearchText(row.fact_key.slice(PREFIX.length));
      const body = normalizeSearchText(row.fact_value);
      let score = 0;
      for (const term of terms) {
        const weight = Math.min(4, term.length);
        if (title.includes(term)) score += 3 * weight;
        else if (body.includes(term)) score += weight;
      }
      if (score || includeRecent) ranked.push({ row, score });
    }
    // Ties retain the existing newest-first order. Validate sources before
    // counting a page so an unavailable entry cannot crowd out an older one.
    rows = ranked.sort((a,b) => b.score-a.score).map(candidate => candidate.row);
  }
  const teachings = [];
  let skipped = 0;
  for (const row of rows) {
    if (!sourceOK(row.source_message_id, row.id)) continue;
    if (skipped < offset) { skipped++; continue; }
    if (teachings.length === take) return { teachings, nextOffset: offset + take };
    teachings.push(present(row));
  }
  return { teachings, nextOffset: null };
}
function listTeachings(options) {
  return teachingPage(options).teachings;
}
function teachingCandidates(options) {
  if (!enabled(options)) return [];
  return teachingPage({ ...options, includeRecent:true }).teachings;
}
function buildTeachingContext(options) {
  const budget = Number.isFinite(options.tokenBudget) ? Math.max(0, options.tokenBudget) : 240;
  const maxItems = Number.isFinite(options.maxItems) ? Math.max(0, Math.min(20, Math.floor(options.maxItems))) : 4;
  if (!budget || !maxItems || !enabled(options)) return '';
  const estimate = options.estimateTokens || (value => Math.ceil(value.length / 1.5));
  const title = '【用户教导（仅在语义适用时参考；可修订/撤回，不改变工具能力或账号绑定）】';
  const lines = [];
  for (const teaching of teachingCandidates(options)) {
    const line = `- [教导#${teaching.id}] ${teaching.topic}：${teaching.instruction}`;
    const block = title + '\n' + [...lines, line].join('\n');
    if (estimate(block) <= budget) lines.push(line);
    if (lines.length >= maxItems) break;
  }
  return lines.length ? title + '\n' + lines.join('\n') : '';
}
function sameState(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function createTeachingSession({ db, getSettings, settings, userText, sessionId, requestId }) {
  const options = { getSettings, settings };
  const sourceText = String(userText || '').trim();
  const plans = new Map();
  let touched = false, closed = false, committed = null;
  function evidence(value) {
    const quote = text(value, 2000, 'evidence');
    if (!sourceText.includes(quote)) throw error('teaching_evidence_mismatch');
    return quote;
  }
  function rawTopic(topic) {
    return db.prepare(`${SELECT} AND fact_key=? ORDER BY updated_at DESC,id DESC LIMIT 1`).get(PREFIX + topic) || null;
  }
  function existing(factId) {
    const fact = audit.row(db, id(factId));
    if (!usable(db, fact)) throw error('teaching_unavailable');
    return fact;
  }
  function checkChronology(before, source) {
    if (!before) return;
    // A delayed model turn receives its messages.id only at commit. Compare
    // actual user receipt times too, so that late persistence cannot turn an
    // older utterance into newer evidence. Equal-millisecond order uses IDs.
    const latest = db.prepare(`SELECT MAX(m.created_at) AS at FROM messages m WHERE m.role='user' AND
      (m.id=? OR m.id IN (SELECT source_message_id FROM memory_fact_revisions WHERE fact_id=?))`)
      .get(before.source_message_id, before.id);
    const manual = db.prepare(`SELECT 1 FROM memory_fact_revisions WHERE fact_id=? AND actor='user'
      AND evidence='' AND operation IN ('edit','delete','undo') AND created_at>? LIMIT 1`)
      .get(before.id, source.created_at);
    if (latest.at > source.created_at || manual) throw error('teaching_stale_source');
  }
  function execute(action, args = {}) {
    checkEnabled(options);
    if (closed) throw error('teaching_session_closed');
    audit.init(db);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw error('teaching_invalid_arguments');
    if (action === 'list') {
      const query = args.query === undefined ? '' : text(args.query, 160, 'query');
      const offset = args.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw error('teaching_invalid_offset');
      return teachingPage({db, ...options, query, offset});
    }
    if (action === 'get') return { teaching: getTeaching({ db, id: args.id, ...options }) };
    if (!['save', 'revise', 'retract'].includes(action)) throw error('teaching_unknown_operation');
    const quote = evidence(args.evidence);
    let before, topic;
    if (action === 'save') {
      topic = text(args.topic, 120, 'topic'); before = rawTopic(topic);
      // Explicit teaching from this new user turn may renew a withdrawn/expired
      // topic. Automatic reads never do; the committed source and audit cutoff
      // below still prevent an older turn from undoing a newer correction.
    } else {
      before = existing(args.id);
      topic = args.topic === undefined ? before.fact_key.slice(PREFIX.length) : text(args.topic, 120, 'topic');
    }
    const instruction = action === 'retract' ? null : text(args.instruction, 2000, 'instruction');
    const importance = args.importance ?? before?.importance ?? 4;
    if (!Number.isInteger(importance) || importance < 1 || importance > 5) throw error('teaching_invalid_importance');
    if (before && topic !== before.fact_key.slice(PREFIX.length)) {
      const conflict = rawTopic(topic);
      if (conflict && conflict.id !== before.id) throw error('teaching_conflict');
    }
    const key = before ? 'id:' + before.id : 'topic:' + topic;
    const original = plans.get(key)?.before ?? before;
    plans.set(key, { action, topic, instruction, importance, evidence: quote, before: original });
    touched = true;
    return { state: 'pending_commit', operation: action, id: before?.id ?? null, topic,
      ...(instruction ? { instruction } : {}), source: 'current_user_message' };
  }
  function commit({ sourceMessageId }) {
    if (committed) return committed;
    checkEnabled(options);
    if (closed) throw error('teaching_session_closed');
    const source = db.prepare("SELECT * FROM messages WHERE id=? AND role='user' AND session_id=?")
      .get(id(sourceMessageId), sessionId);
    if (!source || source.content.trim() !== sourceText) throw error('teaching_source_mismatch');
    db.exec('SAVEPOINT memory_teaching_commit');
    try {
      const results = [];
      for (const plan of plans.values()) {
        const current = plan.before ? audit.row(db, plan.before.id) : rawTopic(plan.topic);
        if (!sameState(current || null, plan.before || null)) throw error('teaching_conflict');
        checkChronology(plan.before, source);
        if (plan.before && plan.action !== 'save' && !usable(db, current)) throw error('teaching_unavailable');
        const meta = { actor: 'user', sourceMessageId: source.id, evidence: plan.evidence };
        let factId;
        if (plan.action === 'retract') {
          audit.remove(db, plan.before.id, meta); factId = plan.before.id;
        } else if (plan.before && usable(db, current)) {
          audit.edit(db, plan.before.id, { category: CATEGORY, factKey: PREFIX + plan.topic,
            factValue: plan.instruction, importance: plan.importance, factType: 'permanent' }, meta);
          factId = plan.before.id;
        } else {
          factId = audit.upsert(db, { category: CATEGORY, factKey: PREFIX + plan.topic,
            factValue: plan.instruction, importance: plan.importance, factType: 'permanent',
            keywords: KEYWORDS, sourceMessageId: source.id, ...meta });
          if (!factId) throw error('teaching_conflict');
        }
        results.push({ id: factId, operation: plan.action, topic: plan.topic });
      }
      db.exec('RELEASE memory_teaching_commit');
      committed = { state: 'committed', requestId, teachings: results };
      closed = true; plans.clear();
      return committed;
    } catch (failure) {
      db.exec('ROLLBACK TO memory_teaching_commit'); db.exec('RELEASE memory_teaching_commit'); throw failure;
    }
  }
  function discard() { closed = true; committed = null; plans.clear(); }
  return { execute, commit, discard, hasChanges: () => touched };
}
module.exports = { CATEGORY, PREFIX, isTeaching, getTeaching, listTeachings,
  teachingCandidates, buildTeachingContext, createTeachingSession };
