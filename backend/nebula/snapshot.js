// Build a local view without running migrations, extraction, or any model.
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { DAY, REMEMBERED_SQL, RECALLABLE_FACT_SQL, makeSourceGuard } = require('../electron/brain/memory-validity');
const { listPeople, projectPerson, RELATION_LABELS } = require('../electron/brain/memory-people');

const states = {planned:'曾计划，结果未确认', rescheduled:'已改期，结果未确认', completed:'已发生', cancelled:'已取消'};
const categories = {profile:'个人信息', preference:'偏好', habit:'习惯', relationship:'关系', opinion:'看法', plan:'安排', event:'经历', other:'事实'};

function readNodes(db, now) {
  const nodes = [];
  const validSource = makeSourceGuard(db, now);
  const rows = db.prepare(`SELECT id, category, importance, updated_at, source_message_id,
      episode_status, episode_gist,
      CASE WHEN ${RECALLABLE_FACT_SQL} THEN fact_key END AS label,
      CASE WHEN ${RECALLABLE_FACT_SQL} THEN fact_value END AS detail,
      CASE WHEN ${RECALLABLE_FACT_SQL} THEN episode_topic END AS topic
    FROM facts WHERE ${REMEMBERED_SQL} ORDER BY id`).all({recallNow:now});
  for (const row of rows) {
    const teaching = row.category === 'other' && row.label?.startsWith('交互教导：');
    const episode = Boolean(row.episode_status);
    if ((episode || teaching) && !validSource(row.source_message_id, row.id)) continue;
    const gistOnly = episode && row.detail == null;
    if (gistOnly ? !row.episode_gist : row.detail == null) continue;
    const layer = teaching ? 'teaching' : episode || ['event','plan'].includes(row.category) ? 'episode' : 'semantic';
    let title = teaching ? row.label.slice(5) : row.topic || row.label;
    if (gistOnly) title = row.episode_gist;
    const status = states[row.episode_status] || '';
    nodes.push({key:'f'+row.id, layer, title, text:gistOnly ? row.episode_gist : row.detail,
      type:teaching?'用户教导':status || categories[row.category] || '事实', gist:gistOnly,
      at:gistOnly ? null : row.updated_at, importance:row.importance,
      source:gistOnly || !row.source_message_id || !validSource(row.source_message_id) ? null : row.source_message_id});
  }
  for (const person of listPeople(db,-1)) {
    const card = projectPerson(db,person,validSource,now);
    if (card) nodes.push({key:'p'+person.id,layer:'semantic',title:card.displayName,
      text:[RELATION_LABELS[card.relationType],card.notes].filter(Boolean).join(' · '),
      type:'人物',at:card.updatedAt,importance:3,gist:false,
      source:card.sourceMessageId && validSource(card.sourceMessageId) ? card.sourceMessageId : null});
  }
  const pcFields = db.prepare('PRAGMA table_info(pc_requests)').all().map(row=>row.name);
  if (pcFields.includes('source_channel') && pcFields.includes('source_message_id')) {
    const recent=db.prepare(`SELECT m.id,m.created_at,m.content FROM messages m WHERE m.role='user'
      AND m.created_at BETWEEN ? AND ? AND EXISTS(SELECT 1 FROM pc_requests r WHERE r.source_message_id=m.id
        AND r.source_channel='pc' AND r.state='complete') ORDER BY m.id`).all(now-DAY,now);
    for (const m of recent) {
      const text=m.content.trim();
      if (!text || text.startsWith('【用户表情消息】') || !validSource(m.id)) continue;
      nodes.push({key:'m'+m.id,layer:'working',title:text.slice(0,32),text,type:'近 24 小时 · PC 发言',
        at:m.created_at,importance:2,gist:false,source:m.id});
    }
  }
  return nodes;
}

function snapshot(filename, now=Date.now()) {
  if (!fs.existsSync(filename)) return {status:'empty',nodes:[]};
  const db = new DatabaseSync(filename,{readOnly:true});
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const nodes=readNodes(db,now);
    db.exec('COMMIT');
    return {status:nodes.length?'ready':'empty',nodes};
  } finally { db.close(); }
}
module.exports={snapshot};
