const CATEGORIES = new Set(['profile','preference','habit','event','relationship','plan','opinion','system','other']);
const TYPES = new Set(['permanent','temporary','fleeting']);
const initialized = new WeakSet();
const episodeColumns = ['episode_topic', 'episode_gist', 'episode_status'];
const { legacyPreferenceValues } = require('./memory-recall-intent');
function init(db) {
  if(initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS memory_fact_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, fact_id INTEGER NOT NULL,
    operation TEXT NOT NULL, actor TEXT NOT NULL, before_json TEXT, after_json TEXT,
    source_message_id INTEGER, evidence TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
    undo_of INTEGER, undone_by INTEGER, source_cutoff_id INTEGER, group_revision_id INTEGER);
    CREATE INDEX IF NOT EXISTS idx_memory_revision_fact ON memory_fact_revisions(fact_id,id);
    CREATE TABLE IF NOT EXISTS memory_extraction_jobs (
      request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, source_message_id INTEGER NOT NULL,
      state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_entity_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL,
      before_json TEXT NOT NULL, after_json TEXT, created_at INTEGER NOT NULL, undone_by INTEGER);
    CREATE TABLE IF NOT EXISTS memory_people_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL,
      source_message_id INTEGER NOT NULL, evidence TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_memory_rev_source_before ON memory_fact_revisions(json_extract(before_json,'$.source_message_id'));
    CREATE INDEX IF NOT EXISTS idx_memory_rev_source_after ON memory_fact_revisions(json_extract(after_json,'$.source_message_id'));
    CREATE INDEX IF NOT EXISTS idx_memory_people_source ON memory_people_sources(source_message_id,person_id);
    CREATE INDEX IF NOT EXISTS idx_facts_source ON facts(source_message_id);
    CREATE INDEX IF NOT EXISTS idx_memory_rev_before_key ON memory_fact_revisions(json_extract(before_json,'$.category'),json_extract(before_json,'$.fact_key'));
    CREATE INDEX IF NOT EXISTS idx_memory_rev_after_key ON memory_fact_revisions(json_extract(after_json,'$.category'),json_extract(after_json,'$.fact_key'));`);
  const revisionColumns = new Set(db.prepare('PRAGMA table_info(memory_fact_revisions)').all().map(c=>c.name));
  for (const name of ['source_cutoff_id','group_revision_id']) {
    if (!revisionColumns.has(name)) db.exec('ALTER TABLE memory_fact_revisions ADD COLUMN '+name+' INTEGER');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_revision_group ON memory_fact_revisions(group_revision_id) WHERE group_revision_id IS NOT NULL');
  const columns = new Set(db.prepare('PRAGMA table_info(facts)').all().map(c => c.name));
  for (const name of episodeColumns) {
    if (!columns.has(name)) db.exec('ALTER TABLE facts ADD COLUMN ' + name + ' TEXT');
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_episode_topic ON facts(episode_topic,updated_at) WHERE episode_status IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_episode_gist ON facts(episode_gist,updated_at) WHERE episode_status IS NOT NULL`);
  for (const version of ['before','after']) {
    for (const name of ['topic','gist']) {
      const field = `json_extract(${version}_json,'$.episode_${name}')`;
      db.exec(`CREATE INDEX IF NOT EXISTS idx_episode_rev_${version}_${name} ON memory_fact_revisions(${field}) WHERE ${field} IS NOT NULL`);
    }
  }
  initialized.add(db);
}
function sameState(a,b) {
  const clean=value=>value && Object.fromEntries(Object.entries(value)
    .filter(([key,v])=>key!=='updated_at' && !(episodeColumns.includes(key) && v == null))
    .sort(([a],[b])=>a.localeCompare(b)));
  return JSON.stringify(clean(a))===JSON.stringify(clean(b));
}
function row(db,id) { return db.prepare('SELECT * FROM facts WHERE id=?').get(id) || null; }
function audit(db,id,before,after,operation,meta={}) {
  const actor = meta.actor || 'automatic';
  // Message IDs order committed evidence even when an edit and the next turn share a millisecond.
  const cutoff = actor === 'user' ? db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM messages').get().id : null;
  const result = db.prepare(`INSERT INTO memory_fact_revisions
    (fact_id,operation,actor,before_json,after_json,source_message_id,evidence,created_at,undo_of,source_cutoff_id,group_revision_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id,operation,actor,
      before ? JSON.stringify(before) : null,after ? JSON.stringify(after) : null,
      meta.sourceMessageId ?? after?.source_message_id ?? null,String(meta.evidence || ''),Date.now(),meta.undoOf ?? null,cutoff,meta.groupRevisionId ?? null);
  return Number(result.lastInsertRowid);
}
function normalize(fact) {
  const category=String(fact.category || 'other').trim();
  const factKey=String(fact.factKey || '').trim(); const factValue=String(fact.factValue || '').trim();
  const importance=Number(fact.importance ?? 3); const factType=fact.factType || 'permanent';
  if(!CATEGORIES.has(category) || !factKey || factKey.length>200 || !factValue || factValue.length>4000 ||
      !Number.isInteger(importance) || importance<1 || importance>5 || !TYPES.has(factType)) {
    throw new Error('Invalid fact');
  }
  return {category,factKey,factValue,importance,factType,keywords:fact.keywords || '[]',
    expiresAt:fact.expiresAt ?? null,sourceMessageId:fact.sourceMessageId ?? null};
}
function transaction(db,fn) {
  db.exec('SAVEPOINT memory_revision');
  try { const value=fn(); db.exec('RELEASE memory_revision'); return value; }
  catch(error) {db.exec('ROLLBACK TO memory_revision');db.exec('RELEASE memory_revision');throw error;}
}
// Include the previous key of a renamed/deleted record. Retried extraction may
// fill a missing fact, but it cannot overrule evidence or a user action that came later.
function isStale(db, category, key, source) {
  if (db.prepare('SELECT 1 FROM facts WHERE category=? AND fact_key=? AND source_message_id>=? LIMIT 1')
    .get(category, key, source.id)) return true;
  return !!db.prepare(`SELECT 1 FROM memory_fact_revisions
    WHERE ((json_extract(before_json,'$.category')=$cat AND json_extract(before_json,'$.fact_key')=$key)
       OR (json_extract(after_json,'$.category')=$cat AND json_extract(after_json,'$.fact_key')=$key))
      AND (source_message_id >= $id OR source_cutoff_id >= $id OR
        (actor='user' AND source_cutoff_id IS NULL AND created_at >= $at))
    LIMIT 1`).get({ cat: category, key, id: source.id, at: source.created_at });
}
// Old versions stored “喝乌龙茶” as the value, sometimes under a bare “喜欢”
// key. Compare only forms of the current item, never every bare-key preference.
function preferenceTerms(value, input={}) {
  const legacy = Array.isArray(input.legacyValues) ? input.legacyValues.filter(v =>
    (v==='吃'+value || v==='喝'+value) && String(input.evidence || '').includes(v)) : [];
  const values = [...new Set([value,...legacyPreferenceValues(value),...legacy])];
  const bare = value.slice(1);
  if (/^[吃喝]/.test(value) && legacyPreferenceValues(bare).includes(value)) values.push(bare);
  return {values:JSON.stringify(values),keys:JSON.stringify(values.flatMap(v=>['喜欢：'+v,'不喜欢：'+v]))};
}
const actionPrefix='@source-action:';
function withActionTags(keywords, tags, keepExisting=false) {
  if (!tags.length && !keywords.includes(actionPrefix)) return keywords;
  let all;
  try { all=JSON.parse(keywords); } catch { return keywords; }
  if (!Array.isArray(all)) return keywords;
  const kept=keepExisting ? all : all.filter(tag=>typeof tag!=='string' || !tag.startsWith(actionPrefix));
  return JSON.stringify([...new Set([...kept,...tags])]);
}
function sourcedPreferenceClause(fact,input,source) {
  if (!source || typeof input.evidence!=='string' || !source.content.includes(input.evidence)) return null;
  // Only the deterministic clause extractor can issue a withdrawal or an
  // action tag. Quoting the object in somebody else's clause is insufficient.
  const {extractFromUserMessage}=require('./extract');
  return extractFromUserMessage(source.content).facts.find(f=>f.category==='preference'
    && f.factKey+'：'+f.factValue===fact.factKey && f.factValue===fact.factValue
    && f.operation===input.operation && input.evidence.includes(f.evidence));
}
function preferenceMatch(snapshot) {
  const field = name => snapshot ? "json_extract("+snapshot+",'$."+name+"')" : name;
  const key=field('fact_key'), value=field('fact_value');
  // A management edit in an older build may have changed the value while
  // leaving a qualified key with the old spelling.
  return `(${field('category')}='preference' AND (${key} IN (SELECT value FROM json_each($keys)) OR
    ((${key} IN ('喜欢','不喜欢') OR ${key} LIKE '喜欢：%' OR ${key} LIKE '不喜欢：%')
      AND ${value} IN (SELECT value FROM json_each($values)))))`;
}
function stalePreference(db, terms, source) {
  return db.prepare(`SELECT 1 FROM facts WHERE ${preferenceMatch()} AND source_message_id >= $id LIMIT 1`)
    .get({...terms,id:source.id}) ||
    db.prepare(`SELECT 1 FROM memory_fact_revisions
      WHERE (${preferenceMatch('before_json')} OR ${preferenceMatch('after_json')}) AND
        (source_message_id >= $id OR source_cutoff_id >= $id OR
         (actor='user' AND source_cutoff_id IS NULL AND created_at >= $at)) LIMIT 1`)
    .get({...terms,id:source.id,at:source.created_at});
}
function preferenceRows(db, terms, positiveOnly, fact) {
  return db.prepare(`SELECT * FROM facts WHERE ${preferenceMatch()} AND episode_status IS NULL
    AND fact_value IN (SELECT value FROM json_each($values))
    AND ($positive=0 OR fact_key='喜欢' OR fact_key LIKE '喜欢：%')
    ORDER BY active DESC,(fact_key=$key) DESC,updated_at DESC,id DESC`)
    .all({...terms,positive:Number(positiveOnly),key:fact.factKey});
}
function hasActiveConflict(db,category,key,value,excluded) {
  const plain = category==='preference' && ['喜欢','不喜欢'].includes(key);
  const exact = db.prepare(`SELECT id FROM facts WHERE active=1 AND category=? AND fact_key=?
    AND (?=0 OR fact_value=?)`).all(category,key,Number(plain),value);
  if (exact.some(f=>!excluded.has(f.id))) return true;
  return category==='preference' && /^(?:喜欢|不喜欢)(?:：|$)/.test(key)
    && preferenceRows(db,preferenceTerms(value),false,{factKey:key}).some(f=>f.active && !excluded.has(f.id));
}
function retractPreference(db, fact, before, at) {
  // The withdrawn fact keeps the old claim's source. The withdrawal's own
  // source belongs on its revision: another clause of that message can still
  // support a different claim without pointing to a deliberately inactive one.
  if (before) {
    db.prepare('UPDATE facts SET active=0,fact_key=?,fact_value=?,updated_at=? WHERE id=?')
      .run(fact.factKey,fact.factValue,at,before.id);
    return before.id;
  }
  // A withdrawal may finish before an older extraction. Reuse one inactive
  // row per item; its sourced revision establishes chronology even on restart.
  return Number(db.prepare(`INSERT INTO facts(category,fact_key,fact_value,importance,active,created_at,updated_at)
    VALUES ('preference',?,?,?,0,?,?)`).run(fact.factKey,fact.factValue,fact.importance,at,at).lastInsertRowid);
}
function upsert(db,input,episode = null) {
  init(db); const fact=normalize(input); const now=Date.now();
  return transaction(db,()=>{
    // Episodes keep their row ID when a plan becomes a completed event.
    let existing = episode ? (episode.priorId ? row(db,episode.priorId) : null)
      : db.prepare('SELECT * FROM facts WHERE category=? AND fact_key=? AND active=1 AND episode_status IS NULL ORDER BY id DESC LIMIT 1').get(fact.category,fact.factKey);
    let source = null;
    let duplicates = [];
    const retract = input.operation==='retractPreference';
    const preference = !episode && fact.category==='preference' && ['喜欢：','不喜欢：'].some(p=>fact.factKey===p+fact.factValue);
    if (retract && (!preference || fact.factKey!=='喜欢：'+fact.factValue || !fact.sourceMessageId)) return null;
    if (fact.sourceMessageId != null) {
      source = db.prepare("SELECT id,created_at,content FROM messages WHERE id=? AND role='user'").get(fact.sourceMessageId);
      if (!source || (!preference && isStale(db, fact.category, fact.factKey, source))
          || !require('./memory-validity').makeSourceGuard(db,now,{forWrite:true})(source.id)) return null;
      if (episode?.priorId && (!existing?.active || existing.source_message_id>=source.id ||
          existing.updated_at>source.created_at || isStale(db,existing.category,existing.fact_key,source))) return null;
      if (preference) {
        const terms = preferenceTerms(fact.factValue,input);
        if (stalePreference(db,terms,source)) return null;
        const matches = preferenceRows(db,terms,retract,fact);
        existing = matches[0];
        duplicates = matches.slice(1).filter(f=>f.active);
      }
    }
    const observedAt = source ? Math.min(now, source.created_at) : now;
    const clause = preference && (retract || fact.keywords.includes(actionPrefix)) ? sourcedPreferenceClause(fact,input,source) : null;
    if (retract && !clause) return null;
    const actionTags = clause?.keywords ? JSON.parse(clause.keywords) : [];
    fact.keywords = withActionTags(fact.keywords,actionTags);
    const sameEpisode = !episode || (existing?.episode_status === episode.status
      && existing.episode_gist === episode.gist && existing.expires_at === fact.expiresAt);
    let id, operation;
    if (retract) {
      id=retractPreference(db,fact,existing,observedAt);
      operation='retract';
    } else if(existing?.active && existing.fact_key===fact.factKey && existing.fact_value===fact.factValue && existing.fact_type===fact.factType && sameEpisode) {
      if (source) {
        // Only an independent, newer user statement refreshes accessibility/provenance.
        // Keep curated keywords and importance on confirmation. A newly
        // explicit verb may now support a previously unknown food or drink.
        const keywords = actionTags.length ? withActionTags(existing.keywords,actionTags,true) : existing.keywords;
        db.prepare('UPDATE facts SET source_message_id=?,updated_at=?,keywords=?,expires_at=COALESCE(?,expires_at) WHERE id=?')
          .run(source.id, observedAt, keywords, fact.expiresAt, existing.id);
      } else return existing.id;
      id=existing.id;
      operation='confirm';
    } else if(existing) {
      id=existing.id;
      operation='update';
      db.prepare(`UPDATE facts SET active=1,category=?,fact_key=?,fact_value=?,importance=?,fact_type=?,keywords=?,expires_at=?,source_message_id=?,updated_at=?,
        episode_topic=?,episode_gist=?,episode_status=? WHERE id=?`)
        .run(fact.category,fact.factKey,fact.factValue,fact.importance,fact.factType,fact.keywords,fact.expiresAt,fact.sourceMessageId,observedAt,
          episode?.topic ?? null,episode?.gist ?? null,episode?.status ?? null,id);
    } else {
      operation='create';
      const result=db.prepare(`INSERT INTO facts(category,fact_key,fact_value,importance,fact_type,keywords,expires_at,source_message_id,active,created_at,updated_at,
        episode_topic,episode_gist,episode_status) VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?)`).run(fact.category,fact.factKey,fact.factValue,fact.importance,fact.factType,fact.keywords,
          fact.expiresAt,fact.sourceMessageId,observedAt,observedAt,episode?.topic ?? null,episode?.gist ?? null,episode?.status ?? null);
      id=Number(result.lastInsertRowid);
    }
    const revisionId=audit(db,id,existing || null,row(db,id),operation,input);
    for (const duplicate of duplicates) {
      remove(db,duplicate.id,{actor:'automatic',sourceMessageId:source.id,evidence:input.evidence,groupRevisionId:revisionId});
    }
    return id;
  });
}
function edit(db,id,partial,meta={}) {
  init(db); return transaction(db,()=>{
    const before=row(db,id); if(!before || !before.active) throw new Error('Fact not found');
    let sourceMessageId = before.source_message_id;
    if (meta.sourceMessageId != null) {
      const source = db.prepare("SELECT id,content FROM messages WHERE id=? AND role='user'").get(meta.sourceMessageId);
      if (!source || source.id <= (before.source_message_id || 0) || typeof meta.evidence !== 'string'
          || !meta.evidence.trim() || !source.content.includes(meta.evidence)
          || !require('./memory-validity').makeSourceGuard(db,Date.now(),{forWrite:true})(source.id))
        throw new Error('Invalid correction source');
      sourceMessageId = source.id;
    }
    let key=partial.factKey ?? before.fact_key;
    if (partial.factKey==null && partial.factValue!=null && before.category==='preference') {
      for (const prefix of ['喜欢：','不喜欢：']) {
        if (key===prefix+before.fact_value) key=prefix+String(partial.factValue).trim();
      }
    }
    const value=normalize({category:partial.category ?? before.category,factKey:key,
      factValue:partial.factValue ?? before.fact_value,importance:partial.importance ?? before.importance,
      factType:partial.factType ?? before.fact_type,keywords:before.keywords,expiresAt:before.expires_at,sourceMessageId});
    if(hasActiveConflict(db,value.category,value.factKey,value.factValue,new Set([id]))) throw new Error('Fact key conflict');
    const sameContent = value.category === before.category && value.factKey === before.fact_key && value.factValue === before.fact_value;
    const sameClaim = sameContent && value.factType === before.fact_type;
    const keywords = before.episode_status && !sameClaim ? '[]' : sameContent ? before.keywords : withActionTags(before.keywords,[]);
    db.prepare(`UPDATE facts SET category=?,fact_key=?,fact_value=?,importance=?,fact_type=?,updated_at=?,keywords=?,source_message_id=?,
      episode_topic=?,episode_gist=?,episode_status=? WHERE id=?`)
      .run(value.category,value.factKey,value.factValue,value.importance,value.factType,Date.now(),keywords,sourceMessageId,
        ...episodeColumns.map(k => sameClaim ? before[k] : null),id);
    return {fact:row(db,id),revisionId:audit(db,id,before,row(db,id),'edit',{actor:'user',...meta})};
  });
}
function remove(db,id,meta={actor:'user'}) {
  init(db); return transaction(db,()=>{
    const before=row(db,id); if(!before || !before.active) throw new Error('Fact not found');
    db.prepare('UPDATE facts SET active=0,updated_at=? WHERE id=?').run(Date.now(),id);
    return {fact:row(db,id),revisionId:audit(db,id,before,row(db,id),'delete',meta)};
  });
}
function undo(db,id) {
  init(db); return transaction(db,()=>{
    const selected=db.prepare('SELECT * FROM memory_fact_revisions WHERE id=?').get(id);
    if (!selected || selected.undone_by) throw new Error('Revision unavailable');
    const head=selected.group_revision_id || id;
    const group=db.prepare(`SELECT * FROM memory_fact_revisions WHERE id=? OR group_revision_id=? ORDER BY id`).all(head,head);
    const members=new Set(group.map(rev=>rev.fact_id));
    let undoGroup=null, result;
    for (const revision of group) {
      const current=row(db,revision.fact_id), after=JSON.parse(revision.after_json || 'null');
      if (revision.undone_by || !sameState(current,after)) throw new Error('Memory has newer changes; undo the newest revision first');
      const before=JSON.parse(revision.before_json || 'null');
      if (before?.active && hasActiveConflict(db,before.category,before.fact_key,before.fact_value,members))
        throw new Error('Restoring this revision would duplicate another active fact');
      if(before) db.prepare(`UPDATE facts SET category=?,fact_key=?,fact_value=?,importance=?,fact_type=?,keywords=?,expires_at=?,source_message_id=?,active=?,created_at=?,updated_at=?,
        episode_topic=?,episode_gist=?,episode_status=? WHERE id=?`)
        .run(before.category,before.fact_key,before.fact_value,before.importance,before.fact_type,before.keywords,before.expires_at,before.source_message_id,before.active,
          before.created_at,before.updated_at,...episodeColumns.map(k => before[k] ?? null),before.id);
      else db.prepare('UPDATE facts SET active=0,updated_at=? WHERE id=?').run(Date.now(),revision.fact_id);
      const restored=row(db,revision.fact_id);
      const undoId=audit(db,revision.fact_id,current,restored,'undo',{actor:'user',undoOf:revision.id,groupRevisionId:undoGroup});
      if (!undoGroup) undoGroup=undoId;
      db.prepare('UPDATE memory_fact_revisions SET undone_by=? WHERE id=?').run(undoId,revision.id);
      if (revision.id===id) result={fact:restored,revisionId:undoId};
    }
    return result;
  });
}
function overview(db,sessionId='main') {
  init(db);
  const facts=db.prepare(`SELECT f.*,m.content AS source_text,m.session_id AS source_session_id
    FROM facts f LEFT JOIN messages m ON m.id=f.source_message_id ORDER BY f.active DESC,f.updated_at DESC LIMIT 500`).all();
  const revisions=db.prepare('SELECT * FROM memory_fact_revisions ORDER BY id DESC LIMIT 200').all();
  const jobs=db.prepare('SELECT request_id,source_message_id,state,updated_at FROM memory_extraction_jobs ORDER BY updated_at DESC LIMIT 20').all();
  const entityRevisions=db.prepare('SELECT * FROM memory_entity_revisions ORDER BY id DESC LIMIT 100').all();
  return {facts,revisions,jobs,entityRevisions};
}
function editPerson(db,id,partial,remove=false) {
  init(db); return transaction(db,()=>{
    const before=db.prepare('SELECT * FROM user_people WHERE id=?').get(id);
    if(!before) throw new Error('Person unavailable');
    if(remove) db.prepare('DELETE FROM user_people WHERE id=?').run(id);
    else {
      const name=String(partial.displayName ?? before.display_name).trim();
      const notes=String(partial.notes ?? before.notes);
      const relation=partial.relationType ?? before.relation_type;
      if(!name || name.length>100 || notes.length>4000 || !['family','friend','colleague','other'].includes(relation)) throw new Error('Invalid person');
      db.prepare('UPDATE user_people SET display_name=?,notes=?,relation_type=?,updated_at=? WHERE id=?').run(name,notes,relation,Date.now(),id);
    }
    const after=db.prepare('SELECT * FROM user_people WHERE id=?').get(id)||null;
    const result=db.prepare('INSERT INTO memory_entity_revisions(entity_type,entity_id,before_json,after_json,created_at) VALUES (?,?,?,?,?)')
      .run('person',id,JSON.stringify(before),after?JSON.stringify(after):null,Date.now());
    return {person:after,entityRevisionId:Number(result.lastInsertRowid)};
  });
}
function undoEntity(db,id) {
  init(db);return transaction(db,()=>{
    const rev=db.prepare('SELECT * FROM memory_entity_revisions WHERE id=?').get(id);
    if(!rev || rev.undone_by || rev.entity_type!=='person') throw new Error('Revision unavailable');
    const current=db.prepare('SELECT * FROM user_people WHERE id=?').get(rev.entity_id)||null;
    if(JSON.stringify(current)!==rev.after_json && !(current===null && rev.after_json===null)) throw new Error('Person has newer changes');
    const before=JSON.parse(rev.before_json);
    const cols=['id','display_name','aliases_json','relation_type','notes','last_mentioned_at','source_message_id','created_at','updated_at'];
    db.prepare('INSERT OR REPLACE INTO user_people('+cols.join(',')+') VALUES ('+cols.map(()=>'?').join(',')+')').run(...cols.map(key=>before[key]));
    db.prepare('UPDATE memory_entity_revisions SET undone_by=? WHERE id=?').run(Date.now(),id);
    return {person:before};
  });
}
module.exports={init,upsert,edit,remove,undo,overview,row,editPerson,undoEntity};
