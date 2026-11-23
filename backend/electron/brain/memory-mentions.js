const { createHash } = require('node:crypto');
const { DAY, REMEMBERED_SQL, RECALLABLE_FACT_SQL, makeSourceGuard } = require('./memory-validity');

const COOLDOWN_MS = 2 * DAY;
const MAX_ENTRIES = 1024;
const registered = new WeakSet();

function initMentions(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_mentions (
    kind TEXT NOT NULL, item_id INTEGER NOT NULL, version TEXT NOT NULL,
    mentioned_at INTEGER NOT NULL, PRIMARY KEY (kind,item_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_memory_mentions_at ON memory_mentions(mentioned_at);`);
}

function fold(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().trim();
}

// Keep NFKC/letter case identical in the preliminary SQLite lookup and the
// final span matcher. This connection-local function does not change the DB.
function registerFold(db) {
  if (registered.has(db)) return;
  db.function('dafeiyu_mention_fold',{deterministic:true},fold);
  registered.add(db);
}

function signature(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

// For a faded episode neither the old title nor its statement is read for
// matching. An expired ordinary fact cannot acquire a new mention.
function factRows(db, now, onlyMentioned, spoken) {
  const recent = onlyMentioned ? `JOIN memory_mentions AS m ON m.kind='fact' AND m.item_id=f.id
    AND m.mentioned_at > $since AND m.mentioned_at <= $recallNow` : '';
  const params = onlyMentioned ? {recallNow:now,since:now-COOLDOWN_MS} : {recallNow:now};
  const match = spoken===undefined ? '' : `AND instr($spoken,dafeiyu_mention_fold(
    CASE WHEN status IS NULL THEN value ELSE coalesce(topic,gist) END))>0`;
  if (spoken!==undefined) params.spoken=spoken;
  return db.prepare(`SELECT f.id,category,source_message_id AS sourceId,importance,expires_at AS expires,
    episode_status AS status, episode_gist AS gist,
    CASE WHEN ${RECALLABLE_FACT_SQL} THEN fact_key END AS name,
    CASE WHEN ${RECALLABLE_FACT_SQL} THEN fact_value END AS value,
    CASE WHEN ${RECALLABLE_FACT_SQL} THEN episode_topic END AS topic,
    f.updated_at AS updatedAt ${onlyMentioned ? ',m.version AS recordedVersion' : ''}
    FROM facts f ${recent} WHERE ${REMEMBERED_SQL}
    AND (episode_status IS NOT NULL OR ${RECALLABLE_FACT_SQL}) ${match}`).all(params);
}

function factVersion(row) {
  // The transition from detail to gist is passive. Only new evidence or an edit
  // should release a recently delivered episode before the cooldown expires.
  if (row.status) return signature(['episode',row.sourceId,row.status,row.gist,row.expires,row.importance]);
  return signature([row.category,row.name,row.value,row.topic,row.status,row.gist,row.expires,row.importance]);
}

function peopleRows(db, now, onlyMentioned, spoken) {
  const join = onlyMentioned ? `JOIN memory_mentions AS m ON m.kind='person' AND m.item_id=p.id
    AND m.mentioned_at > $since AND m.mentioned_at <= $recallNow` : '';
  const params = onlyMentioned ? {since:now-COOLDOWN_MS,recallNow:now} : {};
  const match = spoken===undefined ? '' : `WHERE instr($spoken,dafeiyu_mention_fold(p.display_name))>0 OR
    EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(p.aliases_json) THEN p.aliases_json ELSE '[]' END)
      WHERE type='text' AND instr($spoken,dafeiyu_mention_fold(value))>0)`;
  if (spoken!==undefined) params.spoken=spoken;
  return db.prepare(`SELECT p.id,p.display_name AS name,p.relation_type AS relation,p.notes,
    p.aliases_json AS aliases,p.source_message_id AS sourceId,p.updated_at AS updatedAt
    ${onlyMentioned ? ',m.version AS recordedVersion' : ''} FROM user_people p ${join} ${match}`).all(params);
}

function personVersion(row) {
  return signature([row.name,row.relation,row.notes,row.aliases]);
}

// A read-only snapshot for one prompt. Older databases can be inspected with
// this function even before the application runs its additive migration.
function loadMentionPolicy(db, now = Date.now()) {
  const versions = new Map();
  const sources = new Set();
  const anchors = new Set();
  const include = (kind,row) => {
    versions.set(kind+'/'+row.id,row.recordedVersion);
    if (Number.isSafeInteger(row.sourceId) && row.sourceId>0) sources.add(row.sourceId);
    const terms = kind==='person' ? personNames(row,false) : [row.status ? row.topic || row.gist : row.value];
    for (const term of terms.map(fold)) if (term) anchors.add(term);
  };
  const latest = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_mentions'").get()
    && db.prepare('SELECT 1 FROM memory_mentions WHERE mentioned_at>? AND mentioned_at<=? LIMIT 1').get(now-COOLDOWN_MS,now);
  if (latest) {
    for (const row of factRows(db,now,true)) {
      if (factVersion(row) === row.recordedVersion) include('fact',row);
    }
    for (const row of peopleRows(db,now,true)) {
      if (personVersion(row) === row.recordedVersion) include('person',row);
    }
  }
  const coolingTerms = [...anchors];
  return {
    hasCooling: versions.size>0,
    coolingCount: versions.size,
    isCooling(kind,id) { return versions.has((kind==='episode'?'fact':kind)+'/'+id); },
    isCoolingSource(id) { return sources.has(id); },
    mentionsCooling(visibleTexts,{role='assistant'}={}) {
      if (!versions.size) return false;
      const clauses = splitClauses(visibleTexts,role);
      if (!clauses.some(c=>coolingTerms.some(term=>c.includes(term)))) return false;
      const items = mentionItems(db,now,clauses);
      for (const item of matchClauses(items,clauses)) {
        if (versions.get(item.kind+'/'+item.id)===item.version) return true;
      }
      return false;
    }
  };
}

function wouldRepeatDeliveredMention(db,visibleTexts,{now=Date.now()}={}) {
  return loadMentionPolicy(db,now).mentionsCooling(visibleTexts);
}

const generic = /^(?:好的|可以|明天|今天|昨天|最近|之前|以后|这里|那里|一个|那件事|一件事|工作|生活|事情|喜欢|不喜欢|其他|朋友|同事|同学|计划|活动|面试|考试|比赛|运动|学习|完成|开心|中国|项目|会议|演出|旅行|习惯|爱好|偏好|名字|宠物|猫咪)$/;
const thirdParty = /(?:朋友|同事|同学|家人|室友|爸妈|妈妈|爸爸|姐姐|妹妹|哥哥|弟弟|别人|他|她|小[\p{Script=Han}]{1,3})(?:[\p{Script=Han}]{0,4}(?:的|也爱|喜欢|讨厌|住在|去过|报名|参加|计划|取消|想吃|想喝|想要|改期))|我(?:自己|本人)?(?:喜欢|爱喝|爱吃|讨厌|住在|参加|计划|想去|想喝)/u;
const familyNames = /^(?:妈|爸|妈妈|爸爸|母亲|父亲|姐姐|哥哥|弟弟|妹妹|妻子|丈夫|女友|男友|老公|老婆|奶奶|爷爷|外婆|外公)$/;

function personNames(row, renamed) {
  // After a rename older aliases can remain on the archive card. Its current
  // display name remains authoritative; do not match retired aliases.
  if (renamed) return [row.name];
  try {
    const aliases = JSON.parse(row.aliases || '[]');
    return Array.isArray(aliases) ? [row.name,...aliases.filter(a=>typeof a==='string')] : [row.name];
  } catch {
    return [row.name];
  }
}

function ordinaryFactFits(row, clause, index, term) {
  const lead = clause.slice(0,index);
  const tail = clause.slice(index+term.length);
  if (thirdParty.test(clause)) return false;
  // Seeing the same distinctive item in a shop, or hearing that somebody else
  // likes it, says nothing about the user's memory of it.
  if (!/[你您]|(?:上次|之前|那回|那次)(?:说|提)|记得(?:那|这)?$/.test(lead) &&
      !/(?:还喜欢吗|最近怎么样|还在用吗|用得怎么样)/.test(tail)) return false;
  if (row.category==='profile' && /^(?:用户的?|我的?)?(?:姓名|名字|昵称|称呼)$/.test(row.name))
    return /(?:你(?:的名字|的昵称|的称呼|名字|昵称|叫)|称呼你)(?:是|为|叫)?$/.test(lead);
  if (row.category==='preference') {
    const negativeFact = /不喜欢|讨厌|不爱|不喝|不吃/.test(row.name);
    const negativeReply = /(?:不喜欢|不爱|讨厌|不喝|不吃|不太喜欢)(?:的|喝|吃)?$/.test(lead);
    if (negativeReply && !negativeFact) return false;
    if (!negativeReply && negativeFact && /喜欢|爱喝|爱吃/.test(lead)) return false;
  }
  if (term.length>=3 && !generic.test(term)) return true;
  // Short values (tea, a city, a one-character pet preference) need a
  // referential cue to avoid treating casual mentions as the user's memory.
  if (row.category==='preference') {
    const boundary = !/^\p{Script=Han}/u.test(tail) || /^(?:吧|呀|啦|呢|吗|啊|了|么|这种|这件|的话|对吗|才对)/.test(tail);
    return boundary && /(?:喜欢|爱喝|爱吃|偏爱|讨厌)(?:喝|吃|的)?$/.test(lead);
  }
  if (row.category==='profile') return /你.{0,6}(?:住|家在|来自|搬到|搬去|定居|叫|名字|职业|工作)/.test(lead);
  return row.name && row.name.length>=2 && lead.includes(fold(row.name));
}

function personFits(row,clause,index,term) {
  if (generic.test(term)) return false;
  const lead = clause.slice(0,index);
  if (familyNames.test(term) && !/你(?:的)?$/.test(lead)) return false;
  const relation = /你(?:的)?(?:好朋友|朋友|同学|同事|家人|室友|好友)$/.test(lead);
  if (relation) return true;
  // Merely calling someone by name, or greeting them, is not repeating a
  // memory about them. Require a personal reference around that name.
  return /(?:你(?:有)?提(?:到|过)(?:的)?|你说过(?:的)?|你和)$/.test(lead) ||
    /(?:上次|之前|近来|最近|曾经|后来|提到过|说过)/.test(clause.slice(index+term.length));
}

function episodesFit(row, clause, index, term) {
  if (thirdParty.test(clause) || /^(?:什么是|例如|假如|假设)/.test(clause)) return false;
  if (!generic.test(term) && term.length>=3) return true;
  // A category on its own is not proof of a reference to a personal event.
  return /(?:你(?:之前|上次|那场|那次|的|参加过的|说过的|提过的)|(?:上次|之前)(?:那场|那次|的)?|那场|那次)$/.test(clause.slice(0,index));
}

function containsWord(clause, term, at) {
  if (/^[a-z0-9_]/.test(term) && /[a-z0-9_]/.test(clause[at-1] || '')) return false;
  if (/[a-z0-9_]$/.test(term) && /[a-z0-9_]/.test(clause[at+term.length] || '')) return false;
  return true;
}

function matchClauses(items, clauses) {
  const matched = new Set();
  for (const clause of clauses) {
    const spans = [];
    for (const item of items) {
      for (const term of item.terms) {
        for (let at=clause.indexOf(term); at>=0; at=clause.indexOf(term,at+term.length)) {
          if (!containsWord(clause,term,at)) continue;
          spans.push({item,at,end:at+term.length,ok:item.accepts(clause,at,term)});
        }
      }
    }
    // A shared name, or a shorter value inside a more specific title, cannot
    // identify which record the assistant meant. Independent spans can both count.
    for (const span of spans) {
      if (!span.ok) continue;
      const ambiguous = spans.some(s => s.item!==span.item && s.at<=span.at && s.end>=span.end &&
        (s.ok || s.end-s.at>span.end-span.at));
      if (!ambiguous) matched.add(span.item);
    }
  }
  return matched;
}

function splitClauses(visibleTexts,role='assistant') {
  const texts = Array.isArray(visibleTexts) ? visibleTexts : [visibleTexts];
  return texts.filter(t=>typeof t==='string').flatMap(t=>fold(t).split(/[，,。！？!?；;\n]/))
    .filter(Boolean).map(t=>role==='user' ? t.replace(/我/g,'你') : t);
}

function mentionItems(db,now,clauses,sourceMessageId) {
  const items = [];
  const spoken = clauses.join('\n');
  registerFold(db);
  let sourceOK;
  for (const row of factRows(db,now,false,spoken)) {
    const term = fold(row.status ? row.topic || row.gist : row.value);
    if (!term || row.updatedAt>now) continue;
    if (row.status) sourceOK ??= makeSourceGuard(db,now);
    items.push({kind:'fact',id:row.id,sourceId:row.sourceId,version:factVersion(row),
      terms:[term],accepts:(clause,at) => row.status
        ? episodesFit(row,clause,at,term) && sourceOK(row.sourceId,row.id) : ordinaryFactFits(row,clause,at,term)});
  }
  const people = peopleRows(db,now,false,spoken);
  if (!people.length) return items;
  const renamed = db.prepare(`SELECT 1 FROM memory_entity_revisions WHERE entity_type='person' AND entity_id=?
    AND undone_by IS NULL AND json_extract(before_json,'$.display_name') IS NOT json_extract(after_json,'$.display_name') LIMIT 1`);
  const editedSince = db.prepare(`SELECT 1 FROM memory_entity_revisions WHERE entity_type='person'
    AND entity_id=? AND created_at>=? LIMIT 1`);
  for (const row of people) {
    if (row.updatedAt>now && !(sourceMessageId===row.sourceId && !editedSince.get(row.id,now))) continue;
    const names = [...new Set(personNames(row,Boolean(renamed.get(row.id))).map(fold))]
      .filter(n=>n.length>=2 && clauses.some(c=>c.includes(n)));
    if (!names.length) continue;
    items.push({kind:'person',id:row.id,sourceId:row.sourceId,version:personVersion(row),terms:names,
      accepts:(clause,at,term) => personFits(row,clause,at,term)});
  }
  return items;
}

function recordDeliveredMentions(db, visibleTexts, {now=Date.now(),sourceMessageId} = {}) {
  const clauses = splitClauses(visibleTexts);
  if (!clauses.length || !Number.isFinite(now) || (sourceMessageId!==undefined && !Number.isSafeInteger(sourceMessageId))) return 0;
  const items = mentionItems(db,now,clauses,sourceMessageId);
  const matches = [...matchClauses(items,clauses)].filter(item=>sourceMessageId===undefined || item.sourceId===sourceMessageId);
  if (!matches.length) return 0;
  db.exec('SAVEPOINT delivered_memory_mentions');
  try {
    const save = db.prepare(`INSERT INTO memory_mentions(kind,item_id,version,mentioned_at) VALUES(?,?,?,?)
      ON CONFLICT(kind,item_id) DO UPDATE SET version=excluded.version,mentioned_at=excluded.mentioned_at
      WHERE excluded.mentioned_at>=mentioned_at AND (version<>excluded.version OR mentioned_at<>excluded.mentioned_at)`);
    for (const item of matches) save.run(item.kind,item.id,item.version,now);
    db.prepare('DELETE FROM memory_mentions WHERE mentioned_at<=?').run(now-COOLDOWN_MS);
    db.prepare(`DELETE FROM memory_mentions WHERE (kind,item_id) IN (
      SELECT kind,item_id FROM memory_mentions ORDER BY mentioned_at DESC,kind,item_id LIMIT -1 OFFSET ?)`).run(MAX_ENTRIES);
    db.exec('RELEASE delivered_memory_mentions');
  } catch (error) {
    db.exec('ROLLBACK TO delivered_memory_mentions; RELEASE delivered_memory_mentions');
    throw error;
  }
  return matches.length;
}

module.exports = { initMentions, recordDeliveredMentions, loadMentionPolicy, wouldRepeatDeliveredMention };
