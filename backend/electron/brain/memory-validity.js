// One read-time policy for automatic recall. Archives and revisions stay intact.
const { eligibleResidenceSql, currentResidenceId, initResidenceIndex, revisionInForceSql } = require('./memory-residence');
const DAY = 86400000;
const HALF_LIFE = { 1: 30, 2: 60, 3: 90, 4: 180, 5: Infinity };
const FACT_FORGET_THRESHOLD = 0.1;
function getFactRelevance({ importance = 3, updatedAt }, now = Date.now()) {
  const age = Math.max(0, now - (updatedAt ?? now));
  return 0.5 ** (age / (DAY * (HALF_LIFE[importance] ?? 90)));
}
// Preserve both the existing half-lives and the 365-day non-core cutoff,
// without relying on the time the application happened to start.
const span = level => DAY * Math.min(365, -Math.log2(FACT_FORGET_THRESHOLD) * HALF_LIFE[level]);
const REMEMBERED_SQL = `(active = 1
  AND (importance = 5 OR updated_at >= $recallNow - CASE importance
    WHEN 1 THEN ${span(1)} WHEN 2 THEN ${span(2)} WHEN 4 THEN ${span(4)} ELSE ${span(3)} END))`;
// Keep the outline of an experience longer than its occasion-specific details.
const EPISODE_DETAIL_SQL = `(updated_at >= $recallNow - ${DAY} *
  CASE importance WHEN 5 THEN 30 WHEN 4 THEN 14 ELSE 7 END)`;
const currentDetailSql = `(${REMEMBERED_SQL}
  AND (fact_type IS NOT 'temporary' OR (expires_at IS NOT NULL AND expires_at > $recallNow))
  AND ((episode_status IS NULL AND category NOT IN ('plan','event')) OR ${EPISODE_DETAIL_SQL}))`;
const RECALLABLE_FACT_SQL = '('+currentDetailSql+' AND '+eligibleResidenceSql()+')';

function datedFactValue(fact) {
  if (fact.factType !== 'temporary' || !Number.isFinite(fact.expiresAt)) return fact.factValue;
  const when = Number.isFinite(fact.sourceAt) ? new Date(fact.sourceAt).toLocaleDateString('zh-CN')+'所说；' : '';
  return `${fact.factValue}（${when}本地有效期至${new Date(fact.expiresAt).toLocaleString('zh-CN',{hour12:false})}）`;
}

function initValidityIndexes(db) {
  initResidenceIndex(db);
  db.exec("CREATE INDEX IF NOT EXISTS idx_pc_retract_source ON memory_fact_revisions(source_message_id) WHERE operation='retract'");
}

// The withdrawal has its own source on the revision. Its inactive fact can
// still point to the earlier “I like X” message. If the withdrawal was undone
// or the user has since renewed the preference, the old compound utterance
// is no longer valid verbatim. Separate facts from its other clauses remain.
const withdrawalValue="json_extract(r.after_json,'$.fact_value')";
const invalidWithdrawalSql='(NOT '+revisionInForceSql+' OR EXISTS (SELECT 1 FROM facts p WHERE '+
  "p.category='preference' AND p.active=1 AND (p.fact_key='喜欢' OR p.fact_key LIKE '喜欢：%') AND "+
  '(p.id=r.fact_id OR p.fact_value IN ('+withdrawalValue+",'喝'||"+withdrawalValue+",'吃'||"+withdrawalValue+'))))';

// A source can support several records. If one was invalidated, do not replay
// the whole utterance (and accidentally resurrect that obsolete detail).
function makeSourceGuard(db, now = Date.now(), { forWrite = false } = {}) {
  const cache = new Map();
  const condition = '('+(forWrite ? 'active=1' : currentDetailSql)+' AND '+eligibleResidenceSql('$cityId')+')';
  // Many recent messages share this guard. One observation per guard avoids
  // rerunning the same arbitration for every source and revision.
  let params;
  const snapshots = db.prepare(`
    SELECT fact_id, id, 0 AS phase, before_json AS snapshot FROM memory_fact_revisions
      WHERE json_extract(before_json,'$.source_message_id')=? AND fact_id IS NOT ?
    UNION ALL SELECT fact_id, id, 1, after_json FROM memory_fact_revisions
      WHERE json_extract(after_json,'$.source_message_id')=? AND fact_id IS NOT ?
    ORDER BY id,phase`);
  const valid = db.prepare(`SELECT category,fact_key,fact_value,episode_status,episode_topic,episode_gist,expires_at
    FROM facts WHERE id=? AND ${condition}`);
  const inactive = db.prepare(`SELECT 1 FROM facts WHERE source_message_id=? AND id IS NOT ? AND NOT (${condition}) LIMIT 1`);
  const changedPerson = db.prepare(`SELECT 1 FROM memory_entity_revisions r WHERE r.entity_type='person'
    AND r.undone_by IS NULL AND (json_extract(r.before_json,'$.source_message_id')=?
    OR EXISTS(SELECT 1 FROM memory_people_sources ps WHERE ps.source_message_id=? AND ps.person_id=r.entity_id AND ps.created_at<=r.created_at))
    LIMIT 1`);
  const withdrawn = db.prepare("SELECT 1 FROM memory_fact_revisions r WHERE r.operation='retract' AND "+
    'r.source_message_id=? AND '+invalidWithdrawalSql+' LIMIT 1');
  return (messageId, ownEpisodeId = null) => {
    if (!messageId) return false;
    const cacheKey = ownEpisodeId === null ? messageId : messageId + '/' + ownEpisodeId;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    if (!params) {
      const cityId=currentResidenceId(db);
      params = [forWrite ? {cityId} : {cityId,recallNow:now}];
    }
    let ok = !inactive.get(...params,messageId,ownEpisodeId) && !changedPerson.get(messageId,messageId)
      && !withdrawn.get(messageId);
    if (ok) {
      const checked = new Set();
      for (const rev of snapshots.all(messageId,ownEpisodeId,messageId,ownEpisodeId)) {
        if (checked.has(rev.fact_id)) continue;
        checked.add(rev.fact_id);
        const original = JSON.parse(rev.snapshot);
        const current = valid.get(...params,rev.fact_id);
        if (!current || Object.keys(current).some(k => (current[k] ?? null) !== (original[k] ?? null))) { ok = false; break; }
      }
    }
    cache.set(cacheKey,ok);
    return ok;
  };
}
// Assistant replies have no source IDs for individual claims. Use obsolete
// values only as a veto against the *bounded recent replies*, never as recall
// candidates. A correction should not erase unrelated conversation turns.
function makeEchoGuard(db, replies, now = Date.now()) {
  const candidates = replies.join('\n');
  if (!candidates) return () => true;
  const veto = new Set();
  const add = value => {
    if (typeof value === 'string' && value.trim() && candidates.includes(value)) veto.add(value);
  };
  // Includes in-process expiry, regardless of when the source was last edited.
  for (const f of db.prepare(`SELECT fact_value FROM facts WHERE NOT ${RECALLABLE_FACT_SQL}
    AND fact_value<>'' AND instr($replies,fact_value)>0`).all({recallNow:now,replies:candidates})) add(f.fact_value);
  for (const r of db.prepare(`SELECT json_extract(r.before_json,'$.fact_value') AS oldValue
    FROM memory_fact_revisions r LEFT JOIN facts f ON f.id=r.fact_id
    WHERE r.before_json IS NOT NULL AND r.created_at>=? AND (f.active IS NOT 1
      OR json_extract(r.before_json,'$.fact_value') IS NOT f.fact_value
      OR json_extract(r.before_json,'$.fact_key') IS NOT f.fact_key
      OR json_extract(r.before_json,'$.category') IS NOT f.category)`).all(now-DAY)) add(r.oldValue);
  for (const r of db.prepare(`SELECT r.before_json,p.display_name,p.notes FROM memory_entity_revisions r
    LEFT JOIN user_people p ON p.id=r.entity_id WHERE entity_type='person' AND undone_by IS NULL AND r.created_at>=?`).all(now-DAY)) {
    const prev = JSON.parse(r.before_json);
    if (prev.display_name !== r.display_name) add(prev.display_name);
    if (prev.notes !== r.notes) for (const note of String(prev.notes || '').split(/[；;\n]/)) add(note.trim());
  }
  const hidden = [...veto];
  const withdrawnValues = db.prepare('SELECT DISTINCT '+withdrawalValue+" AS value FROM memory_fact_revisions r WHERE "+
    "r.operation='retract' AND instr(?,"+withdrawalValue+')>0 AND '+invalidWithdrawalSql).all(candidates).map(r=>r.value);
  return content => !hidden.some(v => content.includes(v)) && !content.split(/[，,。.!！?？；;\n]/).some(clause=>
    /不再(?:喜欢|爱|喝|吃)|不(?:太)?喜欢|不爱(?:喝|吃)?|以前喜欢|讨厌/.test(clause) && withdrawnValues.some(v=>clause.includes(v)));
}
module.exports = { DAY, FACT_FORGET_THRESHOLD, RECALLABLE_FACT_SQL, REMEMBERED_SQL, getFactRelevance, datedFactValue, makeSourceGuard, makeEchoGuard, initValidityIndexes };
