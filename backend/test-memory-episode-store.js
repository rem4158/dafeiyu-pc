// Exercise the single facts/revisions ledger with pre-episode data and distinct chats.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const DAY = 86400000;
const fixtureRoot = path.resolve(__dirname,'../temp');
fs.mkdirSync(fixtureRoot,{recursive:true});
const fixture = fs.mkdtempSync(path.join(fixtureRoot,'episode-store-'));
const priorData = process.env.DAFEIYU_DATA_DIR;
process.env.DAFEIYU_DATA_DIR = fixture;

function seedLegacy() {
  const db = new DatabaseSync(path.join(fixture,'companion-memory.db'));
  try {
    db.exec(`CREATE TABLE facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,category TEXT NOT NULL,fact_key TEXT NOT NULL,
      fact_value TEXT NOT NULL,importance INTEGER NOT NULL,fact_type TEXT NOT NULL,keywords TEXT,
      expires_at INTEGER,source_message_id INTEGER,active INTEGER,created_at INTEGER,updated_at INTEGER);
      INSERT INTO facts VALUES(1,'other','旧事实','新版本',3,'permanent','[]',NULL,NULL,1,1,1);
      CREATE TABLE memory_fact_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,fact_id INTEGER NOT NULL,operation TEXT NOT NULL,actor TEXT NOT NULL,
        before_json TEXT,after_json TEXT,source_message_id INTEGER,evidence TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,undo_of INTEGER,undone_by INTEGER,source_cutoff_id INTEGER)`);
    const after = db.prepare('SELECT * FROM facts WHERE id=1').get();
    db.prepare("INSERT INTO memory_fact_revisions(fact_id,operation,actor,before_json,after_json,created_at) VALUES(1,'edit','user',?,?,1)")
      .run(JSON.stringify({...after,fact_value:'旧版本'}),JSON.stringify(after));
  } finally { db.close(); }
}

const settings = require('./electron/brain/settings');
const originalLoad = settings.loadSettings;
settings.loadSettings = () => ({memory:{enabled:true,autoExtract:false,retentionDays:0}});
const memory = require('./electron/brain/memory');
const audit = require('./electron/brain/memory-audit');
const {storeEpisode} = require('./electron/brain/memory-episode-store');
const originalNow = Date.now;
let now = Date.now();
Date.now = () => now;
try {
  seedLegacy();
  let db = memory.initMemory();
  assert.equal(audit.undo(db,1).fact.fact_value,'旧版本','revision snapshots written before the new columns can be undone');
  const current = id => audit.row(db,id);
  const count = () => db.prepare('SELECT COUNT(*) n FROM memory_fact_revisions').get().n;
  function source(text,sessionId='outside') {
    const {userMessageId} = memory.saveChatTurn({sessionId,userText:text,reply:'收到。',extract:false});
    return {sourceMessageId:userMessageId,sessionId};
  }
  function episode(text,status,options={}) {
    return {status, topic:'木工面试',gist:'面试',factValue:text,evidence:text,importance:3,...options};
  }
  function save(item,sessionId) {return storeEpisode(db,item,source(item.evidence,sessionId));}
  const plan = episode('我明天参加木工面试','planned',{expiresAt:now+2*DAY});
  const firstSource = source(plan.evidence,'first');
  const id = storeEpisode(db,plan,firstSource);
  assert.ok(id); assert.equal(current(id).episode_status,'planned');
  assert.equal(current(id).source_message_id,firstSource.sourceMessageId);
  assert.equal(storeEpisode(db,plan,firstSource),null,'replay cannot create or refresh an episode');
  assert.equal(storeEpisode(db,plan,{...firstSource,sessionId:'wrong-chat'}),null);
  assert.equal(storeEpisode(db,{...plan,evidence:'这是助手编的'},firstSource),null);
  const oldConfirmation = episode('木工面试已结束','completed');
  const oldSource = source(oldConfirmation.evidence);
  const moved = episode('我的木工面试改期了，新的日期待定','rescheduled');
  assert.equal(save(moved,'second'),id);
  assert.equal(current(id).expires_at,null,'a move without a new date clears the old deadline');
  assert.equal(current(id).category,'plan');
  assert.equal(storeEpisode(db,oldConfirmation,oldSource),null,'an older failed extraction cannot undo rescheduling');
  const veryRecent = episode('面完了','completed',{topic:'面试',linkOnly:true});
  const otherId = audit.upsert(db,{category:'event',factKey:current(id).fact_key,factValue:'原有的独立活动',importance:3,factType:'fleeting'});
  now+=DAY;
  assert.equal(save(veryRecent,'third'),id);
  assert.equal(current(id).episode_status,'completed');
  assert.equal(current(id).episode_topic,'木工面试');
  assert.equal(current(id).category,'event');
  assert.notEqual(current(id).fact_key,current(otherId).fact_key,'moving a plan into event does not take an existing archival key');
  assert.equal(current(otherId).fact_value,'原有的独立活动');
  assert.equal(current(id).fact_type,'fleeting');
  const completedRevision = db.prepare('SELECT max(id) id FROM memory_fact_revisions WHERE fact_id=?').get(id).id;
  assert.equal(audit.undo(db,completedRevision).fact.episode_status,'rescheduled');
  const cancelled = episode('我的木工面试取消了','cancelled');
  assert.equal(save(cancelled,'fourth'),id);
  assert.equal(current(id).episode_status,'cancelled');
  const corrected = episode('更正一下，我的木工面试没有取消，昨天我通过了面试','completed',
    {correctsPrior:true,gist:'通过面试',matchingGist:'面试'});
  assert.equal(save(corrected),id,'an explicit correction can update a unique closed occurrence');
  assert.equal(current(id).episode_gist,'通过面试');
  const last = db.prepare('SELECT max(id) id FROM memory_fact_revisions WHERE fact_id=?').get(id).id;
  assert.equal(audit.undo(db,last).fact.episode_status,'cancelled');
  const newPlan = episode('我今天参加木工面试','planned',{expiresAt:now+DAY/2});
  const another = save(newPlan,'next');
  assert.notEqual(another,id,'separate occurrence after a closed one gets its own ID');
  const different = save(episode('我今天还有一场陶艺面试','planned',{topic:'陶艺面试',expiresAt:now+DAY/2}));
  assert.ok(different);
  const beforeAmbiguous = count();
  assert.equal(save(veryRecent),null,'underspecified follow-up across two open projects is not assigned to either');
  assert.equal(count(),beforeAmbiguous);
  assert.equal(current(another).episode_status,'planned');
  assert.equal(current(different).episode_status,'planned');
  assert.equal(save(episode('陶艺面试已经结束','completed',{topic:'陶艺面试'})),different);
  assert.equal(save(veryRecent),another);
  const edited = audit.edit(db,another,{factValue:'我亲自改的内容'});
  assert.equal(edited.fact.episode_status,null);
  assert.equal(edited.fact.episode_topic,null);
  assert.equal(edited.fact.episode_gist,null);
  assert.equal(audit.undo(db,edited.revisionId).fact.episode_status,'completed');
  const weighted = audit.edit(db,another,{importance:5});
  assert.equal(weighted.fact.episode_status,'completed','editing only importance does not change the claim');
  const removed = audit.remove(db,another);
  assert.equal(current(another).active,0);
  assert.equal(audit.undo(db,removed.revisionId).fact.episode_gist,'面试');
  const past = save({...plan,expiresAt:now+DAY});
  now += 40*DAY;
  assert.equal(save(veryRecent),null,'a vague report cannot complete a long-abandoned plan');
  assert.equal(current(past).episode_status,'planned');
  const nextMonth = save(episode('我的游泳比赛安排在下个月','planned',{topic:'游泳比赛',gist:'比赛',expiresAt:now+31*DAY}));
  assert.equal(save(episode('比完了','completed',{topic:'比赛',gist:'比赛',linkOnly:true})),null);
  assert.equal(current(nextMonth).episode_status,'planned','a vague report today cannot implicitly complete a specific plan still far in the future');
  const shared = source('我的陶艺巡展改期了。另外，我已经上完钢琴课。');
  const changed = episode('我的陶艺巡展改期了','rescheduled',{topic:'陶艺巡展',gist:'参展'});
  const finished = episode('我已经上完钢琴课','completed',{topic:'钢琴课',gist:'上课'});
  assert.ok(storeEpisode(db,changed,shared));
  assert.ok(storeEpisode(db,finished,shared),'an unresolved date in one clause cannot veto an independent claim in that same committed message');
  assert.equal(storeEpisode(db,finished,shared),null);
  memory.closeMemory(); db = memory.initMemory();
  assert.equal(current(id).episode_status,'cancelled');
  assert.equal(current(another).episode_gist,'面试');
  assert.ok(audit.overview(db).facts.some(f=>f.id===another && f.episode_status==='completed'));
  console.log('memory-episode-store: PASS (single ledger, cross-chat transitions, evidence gates, expiry, ambiguous/repeated events, edit/delete/undo, legacy migration and reopen)');
} finally {
  memory.closeMemory();
  Date.now = originalNow; settings.loadSettings = originalLoad;
  if (priorData === undefined) delete process.env.DAFEIYU_DATA_DIR; else process.env.DAFEIYU_DATA_DIR = priorData;
  if(path.dirname(fixture)!==fixtureRoot) throw new Error('Unsafe fixture path');
  fs.rmSync(fixture,{recursive:true,force:true});
}
