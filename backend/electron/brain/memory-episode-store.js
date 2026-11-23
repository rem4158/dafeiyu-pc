// An episode is a versioned fact. The episode fields explain which experience a
// statement describes and whether the user actually reported an outcome.
const audit = require('./memory-audit');
const { DAY } = require('./memory-validity');
const followUpWindow = 30 * DAY;
const openStatuses = new Set(['planned', 'rescheduled']);
const closedStatuses = new Set(['completed', 'cancelled']);

function normalizedTopic(value) {
  return typeof value === 'string' ? value.trim().normalize('NFKC') : '';
}

function evidenceIsCurrent(db, topic, family, source) {
  // The original topic remains in the snapshots even when a person edits the
  // entry into a regular fact or removes it. A delayed job cannot recreate it.
  for (const snapshot of ['before_json', 'after_json']) {
    const name = `json_extract(${snapshot},'$.episode_topic')`;
    const broad = `json_extract(${snapshot},'$.episode_gist')`;
    const keywords = `json_extract(${snapshot},'$.keywords')`;
    const storedFamily = `CASE WHEN ${name} IS NOT NULL AND json_valid(${keywords}) THEN json_extract(${keywords},'$[1]') END`;
    const match = topic===family ? `(${name}=$topic OR ${broad}=$topic OR ${storedFamily}=$topic)` : `${name}=$topic`;
    const newer = db.prepare(`SELECT 1 FROM memory_fact_revisions
      WHERE ${match} AND (
        source_message_id=$id OR source_cutoff_id >= $id
        OR (actor='user' AND source_cutoff_id IS NULL AND created_at >= $at)
        OR (source_message_id>$id AND json_extract(${snapshot},'$.updated_at') >= $since)
        OR (json_extract(${snapshot},'$.updated_at') > $at)
      ) LIMIT 1`).get({topic, id:source.id, at:source.created_at, since:source.created_at-followUpWindow});
    if (newer) return false;
  }
  return true;
}

function possiblePredecessors(db, item, source) {
  const {topic, matchingGist, expiresAt, status} = item;
  // Allow “面试” to refer to a lone “木工面试”, but two explicit qualifications
  // never match solely because they share the same general subject.
  return db.prepare(`SELECT id,fact_key,episode_topic,episode_gist,importance FROM facts
    WHERE active=1 AND episode_status IS NOT NULL
    AND ($correction OR episode_status IN ('planned','rescheduled'))
    AND (episode_topic=$topic OR ($generic AND (episode_gist=$topic OR json_extract(keywords,'$[1]')=$topic)))
    AND updated_at <= $at AND max(updated_at,coalesce(expires_at,0)) >= $since
    AND ($guardFuture=0 OR expires_at IS NULL OR expires_at <= $near)
    AND ($correction OR $repeatedPlan=0 OR (episode_topic=$topic AND expires_at IS $due))
    ORDER BY id DESC LIMIT 2`).all({topic,generic:Number(topic===matchingGist),
      at:source.created_at,since:source.created_at-followUpWindow,near:source.created_at+DAY,
      guardFuture:Number(status==='completed' && topic===matchingGist && !item.correctsPrior && !/提前/.test(item.evidence)),
      repeatedPlan:Number(status==='planned'),correction:Number(item.correctsPrior===true),due:expiresAt});
}

function newFactKey(db, topic, sourceId) {
  // Keep commonly viewed keys readable. Source IDs disambiguate a second
  // occurrence and make later undo safe after a different occurrence ends.
  const base = '经历·' + topic;
  return db.prepare('SELECT 1 FROM facts WHERE fact_key=? LIMIT 1').get(base)
    ? base + ' #' + sourceId : base;
}

function episodeImportance(db, prior, suggested) {
  if (!prior) return suggested ?? 3;
  const manual = db.prepare(`SELECT json_extract(after_json,'$.importance') AS importance FROM memory_fact_revisions
    WHERE fact_id=? AND actor='user' AND operation='edit' AND undone_by IS NULL
      AND json_extract(before_json,'$.importance') <> json_extract(after_json,'$.importance')
    ORDER BY id DESC LIMIT 1`).get(prior.id);
  return manual?.importance ?? Math.max(prior.importance,suggested ?? 3);
}

function storeEpisode(db, candidate, {sourceMessageId, sessionId} = {}) {
  audit.init(db);
  const topic = normalizedTopic(candidate?.topic);
  const gist = normalizedTopic(candidate?.gist);
  const matchingGist = normalizedTopic(candidate?.matchingGist) || gist;
  if (!topic || !gist || topic.length>100 || gist.length>100 ||
      !Number.isSafeInteger(sourceMessageId) || sourceMessageId<1) return null;
  const {factValue, evidence, status} = candidate;
  if ((!openStatuses.has(status) && !closedStatuses.has(status)) ||
      typeof evidence !== 'string' || !evidence.trim() || typeof factValue !== 'string' ||
      !factValue.trim() || factValue.length>4000 || !evidence.includes(factValue)) return null;
  const expiresAt = openStatuses.has(status) && Number.isFinite(candidate.expiresAt) ? candidate.expiresAt : null;
  const source = db.prepare("SELECT id,session_id,created_at,content FROM messages WHERE role='user' AND id=?").get(sourceMessageId);
  if (!source || source.session_id!==sessionId || !source.content.includes(evidence)) return null;

  db.exec('SAVEPOINT memory_episode');
  try {
    let result = null;
    if (evidenceIsCurrent(db,topic,matchingGist,source)) {
      const separate = status === 'planned' && /另(?:外)?(?:一|有一)(?:场|项|次|份|个)|第二(?:场|项|次|份|个)/.test(evidence);
      const item = {...candidate,topic,gist,matchingGist,expiresAt,status};
      const matches = separate ? [] : possiblePredecessors(db,item,source);
      if (!separate && matches.length<2) {
        const {findLegacyPlans} = require('./memory-episode-legacy');
        matches.push(...findLegacyPlans(db,item,source,source.created_at-followUpWindow));
      }
      if (matches.length<=1 && !matches[0]?.blocked && (!candidate.linkOnly || matches.length===1)) {
        const prior = matches[0];
        const episode = {priorId:prior?.id, topic:prior?.episode_topic ?? topic, gist, status};
        const open = openStatuses.has(status);
        const category = open ? 'plan' : 'event';
        const collision = prior && db.prepare('SELECT 1 FROM facts WHERE active=1 AND id<>? AND category=? AND fact_key=? LIMIT 1')
          .get(prior.id,category,prior.fact_key);
        const factKey = prior && !collision ? prior.fact_key : newFactKey(db,topic,sourceMessageId);
        const importance = episodeImportance(db,prior,candidate.importance);
        result = audit.upsert(db, {
          category, factKey,
          factValue, factType:open ? 'temporary' : 'fleeting', importance, expiresAt,
          keywords: JSON.stringify([episode.topic,matchingGist,episode.gist]), sourceMessageId, evidence
        },episode);
      }
    }
    db.exec('RELEASE memory_episode');
    return result;
  } catch (error) {
    db.exec('ROLLBACK TO memory_episode; RELEASE memory_episode');
    throw error;
  }
}
module.exports = {storeEpisode};
