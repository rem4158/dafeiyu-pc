const { DAY, REMEMBERED_SQL, RECALLABLE_FACT_SQL, makeSourceGuard } = require('./memory-validity');
const { recallLegacyGists } = require('./memory-episode-legacy');

// Unspecified continuations can use one recent thread. Ambiguous references
// should elicit a clarification, not a guess about which event took place.
function isContinuation(query) {
  const cue = query.replace(/[，。？！？、,!.?\s]/g,'').replace(/(?:吧|呢|呀|啊|啦|吗)+$/,'');
  return /^(?:我回来了|回来了|(?:那|我们)?(?:接着|继续)(?:聊天|聊聊|聊|说说|说)(?:(?:上次|昨天|之前)(?:的|说的|聊的)?(?:话题|那件事|事))?|(?:上次|昨天|刚才|前天|之前)(?:我们)?(?:那件事|那回事|说的那件事|说的事|说到哪|聊到哪)(?:怎么样了|怎样了|如何了|了)?)$/.test(cue);
}

const segmenter = new Intl.Segmenter('zh',{granularity:'word'});
const generalLead = /^(?:的|个|场|次|那个|那场|那次|这个|这次|那|这|我|我的|之前|上次|昨天|今天|明天|之前的|参加|参与|去|聊|说|提到|记得|记忆|关于|请问|准备|计划|安排|取消|结束|完成|还有|还有个)$/;
function differentNamedEvent(text, topic, gist) {
  if (topic === gist || text.includes(topic)) return false;
  const start = text.indexOf(gist);
  if (start <= 0) return false;
  const prefix = text.slice(0,start);
  const previous = [...segmenter.segment(prefix)].at(-1);
  return previous?.isWordLike && !generalLead.test(previous.segment) && !topic.includes(previous.segment);
}

function episodeLine(row) {
  const subject = row.topic || row.gist;
  const quotes = row.detail ? `（${new Date(row.observed).toLocaleDateString('zh-CN')}提到：${row.detail}）` :
    '（只记得大意，具体场次和细节已经记不清了。只谈能想起的部分，不推断聊天记录是否保存。）';
  switch (row.status) {
    case 'planned':
      return `曾计划${subject}，结果未确认${quotes}。`;
    case 'rescheduled':
      return `${subject}已改期，结果未确认${quotes}。`;
    case 'cancelled':
      return `${subject}已取消${quotes}。`;
    case 'completed':
      return `用户确认已发生：${subject}${quotes}。`;
    default:
      return '';
  }
}

function recallEpisodes(db, query, { tokens, limit, now, sessionId, policy, asked=false, proactive=false }) {
  const text = String(query || '').normalize('NFKC').toLowerCase().trim();
  if ((!text && !proactive) || limit <= 0) return [];
  if (/^(?:什么是|请解释)|(?:是什么意思|有何区别|是什么运动)/.test(text)) return [];
  const thirdParty = /(?:朋友|同事|同学|家人|妈妈|爸爸|别人|他|她)(?:[\p{Script=Han}]{0,6}的|在|也要|要|想|会|去|说)/u;
  if (thirdParty.test(text) && !/(?:而我|我自己|我那次|和我|我俩)/.test(text)) return [];

  // Once details fade, neither ranking nor output has access to the old
  // statement, specific topic or date. No chat text is needed for retrieval.
  const rows = db.prepare(`SELECT id,episode_status AS status,episode_gist AS gist,
    updated_at AS observed,source_message_id AS sourceId,
    expires_at AS deadline,CASE WHEN ${RECALLABLE_FACT_SQL} THEN episode_topic END AS topic,
    CASE WHEN ${RECALLABLE_FACT_SQL} THEN fact_value END AS detail,
    (SELECT session_id FROM messages WHERE id=facts.source_message_id) AS sourceSession
    FROM facts WHERE episode_status IS NOT NULL AND episode_gist<>'' AND ${REMEMBERED_SQL}
    ORDER BY updated_at DESC,id DESC`).all({recallNow:now});
  if (!rows.length) return recallLegacyGists(db,text,{limit,now,policy,asked});
  const sourceOK = makeSourceGuard(db,now);
  const terms = tokens.filter(term => term.length >= 2);
  const candidates = [];
  const recent = [];
  const continuation = isContinuation(text);
  for (const row of rows) {
    const subject = (row.topic || row.gist).normalize('NFKC').toLowerCase();
    const gist = row.gist.normalize('NFKC').toLowerCase();
    if (differentNamedEvent(text,subject,gist)) continue;
    const matches = terms.filter(term => subject.includes(term) || gist.includes(term));
    let score = matches.reduce((sum,term) => sum + term.length,0);
    if (text.includes(subject)) score += subject.length * 2;
    if (text.includes(gist)) score += gist.length;
    const open = ['planned','rescheduled'].includes(row.status) && row.deadline>now && row.detail;
    const continuing = now-row.observed <= 2*DAY && (continuation || (proactive && open));
    if ((!score && !continuing) || !sourceOK(row.sourceId,row.id)) continue;
    if (score) candidates.push({row,score});
    if (continuing) recent.push(row);
  }

  if (!candidates.length) {
    // Prefer the current conversation for a vague reference. In a fresh chat
    // recall only when there is one plausible recent event across conversations.
    const local = recent.filter(row => row.sourceSession === sessionId);
    const pool = local.length ? local : recent;
    if (pool.length === 1) {
      const explicitContinuation = continuation && !/^(?:我)?回来了/.test(text);
      if (!explicitContinuation && policy?.isCooling('fact',pool[0].id)) return [];
      return [episodeLine(pool[0])];
    }
    return pool.length ? [] : recallLegacyGists(db,text,{limit,now,policy,asked});
  }
  candidates.sort((a,b) => b.score-a.score || b.row.observed-a.row.observed);
  const best = candidates.filter(c => c.score === candidates[0].score);
  if (best.length > 1 && !/分别|哪些|哪几|都有哪些|各自/.test(text)) {
    return ['有多条相近经历，尚不能确定用户指的是哪一次，可以请用户说一下主题。'];
  }
  return best.filter(({row}) => asked || (row.topic && text.includes(row.topic.toLowerCase())) ||
    !policy?.isCooling('fact',row.id)).slice(0,limit).map(c => episodeLine(c.row));
}

module.exports = { recallEpisodes };
