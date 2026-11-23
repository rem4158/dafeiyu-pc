// Compare the old structured facts only. Opening a chat or examining archived
// message text would make forgotten details available again.
const { broadKindsIn, extractEpisodeCandidates } = require('./memory-episode-extract');
const { DAY, REMEMBERED_SQL, RECALLABLE_FACT_SQL, makeSourceGuard } = require('./memory-validity');

const otherPerson = /(?:我(?:的)?(?:朋友|同事|家人|同学)|同事|朋友|同学|爸爸|妈妈|室友|家人|别人|他说|她说|他的|她的|他们|她们)/;
const mixed = /(?:[？?、]|如果|假设|假如|举例|要是|以及|或者|和.{1,15}(?:比赛|面试|考试)|不确定|可能)/;
const closed = /取消|不再参加|没去|没参加|已完成|完成了|参加了|结束了|已结束|面完|考完|原本|原计划|上次|去年/;
const pending = /(?:^|我|用户)(?:明天|后天|下周|今天|准备|计划|打算|要参加|要去|预约)|(?:计划|打算|准备)(?:去|参加|完成|做)/;

function topicsOf(row) {
  const value = row.fact_value.trim();
  const key = row.fact_key.trim();
  if (otherPerson.test(value + key) || mixed.test(value) || closed.test(value)) return [];
  // An old event fact may describe a past achievement. Adopt it as an open
  // plan only when the stored value itself expresses an intention.
  if (row.category === 'event' && !pending.test(value)) return [];
  const interpreted = extractEpisodeCandidates(value,[],row.updated_at);
  if (interpreted.length) return interpreted
    .filter(e => e.status === 'planned' || e.status === 'rescheduled').map(e=>e.topic);
  // Older model-produced plan rows often have "安排" as their key and a bare
  // activity as their value. Allow only a short literal topic in this case.
  const clean = s => s.replace(/(?:的)?(?:计划|安排)$/,'').trim();
  const compact = s => s.length>=2 && s.length<=32 &&
    !/[，,。！？：:、\d]|^(?:我|用户|今天|明天|下周|准备|参加|在|去)|(?:暂定|或者|确认|通知|时间|地点)/.test(s);
  return [clean(value),clean(key)].filter(compact);
}

// Called inside storeEpisode's existing transaction. A unique old row is
// updated through audit.upsert so undo restores its original form in full.
function findLegacyPlans(db, item, source, since) {
  const {topic,gist,status,expiresAt,matchingGist=gist} = item;
  const candidates = db.prepare(`SELECT id,category,fact_key,fact_value,importance,expires_at,updated_at,source_message_id
    FROM facts WHERE active=1 AND episode_status IS NULL AND category IN ('plan','event')
    AND max(updated_at,coalesce(expires_at,0))>=?
    AND (instr(fact_key,?)>0 OR instr(fact_value,?)>0)`).all(since,topic,topic);
  const editedAfter = db.prepare(`SELECT 1 FROM memory_fact_revisions WHERE fact_id=? AND actor='user'
    AND (source_cutoff_id>=? OR (source_cutoff_id IS NULL AND created_at>=?)) LIMIT 1`);
  const matches = [];
  for (const row of candidates) {
    const topicFromPrior = topicsOf(row).find(t => t === topic ||
      (topic === matchingGist && t.endsWith(matchingGist) && broadKindsIn(t).includes(matchingGist)));
    if (!topicFromPrior) continue;
    if (row.source_message_id >= source.id || row.updated_at > source.created_at ||
      editedAfter.get(row.id,source.id,source.created_at)) return [{blocked:true}];
    if (status === 'planned' && (topicFromPrior !== topic || row.expires_at !== expiresAt)) continue;
    if (status === 'completed' && topic === matchingGist && !item.correctsPrior &&
      !/提前/.test(item.evidence) && row.expires_at > source.created_at + DAY) continue;
    matches.push({id:row.id,fact_key:row.fact_key,importance:row.importance,episode_topic:topicFromPrior,episode_gist:gist});
    if (matches.length === 2) break;
  }
  return matches;
}

function recallLegacyGists(db, query, { limit, now, policy, asked=false }) {
  if (!query || limit<=0 || otherPerson.test(query)) return [];
  // Search only for the coarse kind in the new message. A private title or
  // location cannot be used as a key to find forgotten legacy details.
  const kinds = [...new Set(broadKindsIn(query))];
  if (!kinds.length) return [];
  const rows = db.prepare(`SELECT id,category,fact_key,fact_value,source_message_id FROM facts
    WHERE category IN ('plan','event') AND episode_status IS NULL AND source_message_id IS NOT NULL
    AND ${REMEMBERED_SQL} AND NOT ${RECALLABLE_FACT_SQL}
    AND (instr(fact_key,$kind)>0 OR instr(fact_value,$kind)>0) ORDER BY updated_at DESC`);
  const sourceOK = makeSourceGuard(db,now);
  const lines = [];
  for (const kind of kinds) {
    const matched = rows.all({recallNow:now,kind}).some(row => {
      const description = row.fact_key + ' ' + row.fact_value;
      return !otherPerson.test(description) && !mixed.test(description) &&
        new Set(broadKindsIn(description)).size === 1 && sourceOK(row.source_message_id,row.id) &&
        (asked || !policy?.isCooling('fact',row.id));
    });
    if (matched) lines.push(`只记得提过${kind}，具体是哪一次、经过和结果都记不清。`);
    if (lines.length === limit) break;
  }
  return lines;
}
module.exports = {findLegacyPlans,recallLegacyGists};
