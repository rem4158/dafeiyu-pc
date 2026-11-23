// These labels describe the current city. Hometown, workplace and a street
// address are separate claims even if their values happen to look similar.
const cityKeys = ['城市','所在城市','居住城市','常住城市','现居城市','现居','现居地','居住地','常住地','目前居住地','当前居住地'];
const keys = new Set(['','我','我的','用户','用户的'].flatMap(prefix=>cityKeys.map(key=>prefix+key)));
const sqlKeys = [...keys].map(k=>"'"+k+"'").join(',');
const detailTokens = ['街道','小区','公寓','单元','门牌','胡同','弄堂','号楼','大厦','栋','巷'];
const detailSuffixes = ['路','街','弄','号','室'];
const detailPatterns = [...detailTokens.map(t=>'*'+t+'*'),...detailSuffixes.map(t=>'*'+t),'*[0-9]*','*路*号*','*街*号*'];

function isResidenceKey(key) { return keys.has(key); }
function isResidenceFact(fact) {
  const value=String(fact.factValue??fact.fact_value??'');
  return (fact.category==='profile' || fact.category==='other') &&
    isResidenceKey(fact.factKey??fact.fact_key) && Boolean(value.trim()) &&
    !detailTokens.some(t=>value.includes(t)) && !detailSuffixes.some(t=>value.endsWith(t)) &&
    !/[0-9]|[路街].*号/.test(value);
}

// Expression arguments are aliases/JSON paths chosen in the source code.
function residenceKeySql(key,category,value) {
  const detailed=detailPatterns.map(pattern=>value+" GLOB '"+pattern+"'").join(' OR ');
  return '('+category+" IN ('profile','other') AND "+key+' IN ('+sqlKeys+') AND trim('+value+")<>'' AND NOT ("+detailed+'))';
}

function snapshotResidence(column) {
  const field = name => "json_extract("+column+",'$."+name+"')";
  return residenceKeySql(field('fact_key'),field('category'),field('fact_value'));
}

// Each candidate is evidence, not the time the extraction job happened to
// finish. Deleting, expiring, cooling or relabelling the winning claim leaves
// a gap. Only undoing its evidence or providing a new claim can fill it.
// The uncorrelated scalar subquery is shared by both facts and facts AS f.
const original = 'r.before_json', updated = 'r.after_json';
const stableBefore = snapshotResidence(original);
const stableAfter = snapshotResidence(updated);
// Undo is itself reversible. An even number of consecutive undo operations
// restores the original evidence at its original position in time.
const revisionInForceSql = "(r.undone_by IS NULL OR (WITH RECURSIVE chain(id,next,depth) AS ("+
  "SELECT r.id,r.undone_by,0 UNION ALL SELECT u.id,u.undone_by,depth+1 FROM chain JOIN memory_fact_revisions u ON u.id=chain.next WHERE u.id>chain.id) "+
  "SELECT next IS NULL AND depth%2=0 FROM chain ORDER BY depth DESC LIMIT 1))";
const winningClaim = [
  'SELECT live.id AS claim_id FROM (SELECT claim_id,claim_value FROM (',
  // Unedited pre-audit rows have only their stored observation and row ID.
  'SELECT base.id AS claim_id,base.fact_value AS claim_value,base.updated_at AS at,coalesce(base.source_message_id,0) AS source_order,0 AS manual_sequence',
  'FROM facts base WHERE base.episode_status IS NULL AND '+residenceKeySql('base.fact_key','base.category','base.fact_value'),
  'AND NOT EXISTS(SELECT 1 FROM memory_fact_revisions r WHERE r.fact_id=base.id)',
  'UNION ALL',
  // The first revision of a legacy row preserves its original observation.
  "SELECT r.fact_id,json_extract(r.before_json,'$.fact_value'),json_extract(r.before_json,'$.updated_at'),coalesce(json_extract(r.before_json,'$.source_message_id'),0),0",
  'FROM memory_fact_revisions r WHERE '+stableBefore,
  "AND json_extract(r.before_json,'$.episode_status') IS NULL",
  'AND r.id=(SELECT min(first.id) FROM memory_fact_revisions first WHERE first.fact_id=r.fact_id)',
  'UNION ALL',
  // A new source or a management edit can establish a city. Merely changing
  // importance, deleting a shadowed row, or undoing an edit establishes none.
  "SELECT r.fact_id,json_extract(r.after_json,'$.fact_value'),json_extract(r.after_json,'$.updated_at'),",
  "coalesce(CASE WHEN r.actor='user' THEN r.source_cutoff_id END,r.source_message_id,json_extract(r.after_json,'$.source_message_id'),0),",
  "CASE WHEN r.actor='user' THEN r.id ELSE 0 END",
  'FROM memory_fact_revisions r WHERE '+stableAfter,
  "AND "+revisionInForceSql+" AND r.operation IN ('create','confirm','update','edit')",
  "AND json_extract(r.after_json,'$.active')=1 AND json_extract(r.after_json,'$.episode_status') IS NULL",
  "AND (r.operation<>'edit' OR json_extract(r.before_json,'$.fact_value') IS NOT json_extract(r.after_json,'$.fact_value')",
  'OR NOT '+stableBefore+')',
  ') ORDER BY at DESC,source_order DESC,manual_sequence DESC,claim_id DESC LIMIT 1) winner',
  // A stale legacy update might have overwritten the very same row. Never
  // use that old value in place of the winning observation from the audit.
  'JOIN facts live ON live.id=winner.claim_id AND live.fact_value=winner.claim_value',
].join('\n');

function eligibleResidenceSql(winner='('+winningClaim+')') {
  return '(NOT '+residenceKeySql('fact_key','category','fact_value')+' OR id IS '+winner+')';
}

function currentResidenceId(db) {
  return db.prepare(winningClaim).get()?.claim_id ?? null;
}

function residenceWriteAllowed(db,source) {
  if (!source || !Number.isSafeInteger(source.id) || !Number.isFinite(source.created_at)) return false;
  const args={id:source.id,at:source.created_at};
  const current=residenceKeySql('fact_key','category','fact_value');
  if (db.prepare('SELECT 1 FROM facts WHERE episode_status IS NULL AND '+current+
    ' AND (source_message_id >= $id OR updated_at > $at) LIMIT 1').get(args)) return false;
  // A retry cannot overwrite a later user action, including a deletion,
  // rename out of the city slot, or undo. A new message after it still can.
  for (const snapshot of [original,updated]) {
    const guard = "r.source_message_id >= $id OR r.source_cutoff_id >= $id OR "+
      "json_extract("+snapshot+",'$.updated_at') > $at OR (r.actor='user' AND "+
      "(r.created_at > $at OR (r.source_cutoff_id IS NULL AND r.created_at=$at)))";
    if (db.prepare('SELECT 1 FROM memory_fact_revisions r WHERE '+snapshotResidence(snapshot)+
      " AND json_extract("+snapshot+",'$.episode_status') IS NULL AND ("+guard+') LIMIT 1').get(args)) return false;
  }
  return true;
}

function initResidenceIndex(db) {
  // Most facts in a long-running installation belong to other topics.
  db.exec('CREATE INDEX IF NOT EXISTS idx_pc_residence_keys ON facts(fact_key,category) WHERE episode_status IS NULL AND '+
    "category IN ('profile','other') AND fact_key IN ("+sqlKeys+')');
}

module.exports={isResidenceKey,isResidenceFact,residenceKeySql,eligibleResidenceSql,currentResidenceId,residenceWriteAllowed,
  initResidenceIndex,revisionInForceSql};
