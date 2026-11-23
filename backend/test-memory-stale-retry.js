// Exercise the actual failed-job/recovery path with committed turns and in-process fake responses.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '../temp');
fs.mkdirSync(root, { recursive: true });
const dir = fs.mkdtempSync(path.join(root, 'memory-retry-'));
process.env.DAFEIYU_DATA_DIR = dir;
const settings = require('./electron/brain/settings');
settings.loadSettings = () => ({
  provider:'cloud', cloud:{baseUrl:'http://fixture.invalid/v1', model:'fixture', apiKey:'test'},
  memory:{enabled:true, autoExtract:true, retentionDays:0},
});
const memory = require('./electron/brain/memory');
const audit = require('./electron/brain/memory-audit');
const originalFetch = global.fetch;
const originalNow = Date.now;
async function main() {
  let clock = Date.now(); Date.now = () => clock; // manual edit vs new input in the same millisecond
  let failing = false;
  global.fetch = async url => {
    assert.equal(url, 'http://fixture.invalid/v1/chat/completions');
    if (failing) throw new Error('expected fixture failure');
    return new Response(JSON.stringify({choices:[{message:{content:'[]'}}]}), {headers:{'content-type':'application/json'}});
  };
  const legacy = new DatabaseSync(path.join(dir, 'companion-memory.db'));
  try {
    legacy.exec(`CREATE TABLE memory_fact_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, fact_id INTEGER NOT NULL,
      operation TEXT NOT NULL,actor TEXT NOT NULL,before_json TEXT,after_json TEXT,source_message_id INTEGER,
      evidence TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,undo_of INTEGER,undone_by INTEGER)`);
  } finally { legacy.close(); }
  const db = memory.initMemory();
  assert.ok(db.prepare('PRAGMA table_info(memory_fact_revisions)').all().some(c=>c.name==='source_cutoff_id'));
  const save = text => memory.saveChatTurn({userText:text, reply:'收到。', extract:false}).userMessageId;
  const process = (text,id) => memory.processCommittedTurn({userText:text,userMessageId:id,requestId:'fixture-'+id});
  async function turn(text,fail=false) {
    const id=save(text); failing=fail;
    try { assert.equal((await process(text,id)).complete,!fail); } finally { failing=false; }
    return id;
  }
  const snapshot = () => ['facts','memory_fact_revisions'].map(t => db.prepare('SELECT * FROM '+t+' ORDER BY id').all());
  const active = key => db.prepare('SELECT * FROM facts WHERE active=1 AND fact_key=?').get(key);
  const revision = id => db.prepare('SELECT * FROM memory_fact_revisions WHERE fact_id=? ORDER BY id DESC LIMIT 1').get(id);
  async function recover(count) {
    const before = snapshot();
    assert.equal((await memory.resumePendingExtractions()).resumed,count);
    assert.deepEqual(snapshot(),before,'stale job completion must not mutate any fact, evidence or revision');
  }
  await turn('我叫南星。',true);
  await turn('我叫云川。');
  await turn('我喜欢焙茶。',true);
  await turn('我不喜欢焙茶。');
  await recover(2);
  assert.equal(active('名字').fact_value,'云川');
  assert.ok(active('不喜欢：焙茶'));assert.ok(!active('喜欢：焙茶'));

  const oldSource=await turn('我叫清晗。',true);
  const savedBeforeEdit=save('我叫青杏。');
  const nameId=active('名字').id;
  audit.edit(db,nameId,{factKey:'惯用称呼',factValue:'青禾'});
  assert.equal((await process('我叫青杏。',savedBeforeEdit)).complete,true);
  await recover(1);
  assert.equal(active('惯用称呼').fact_value,'青禾');assert.ok(!active('名字'));
  assert.equal(audit.upsert(db,{category:'other',factKey:'模型重试换了说法',factValue:'清晗',sourceMessageId:oldSource}),null);

  await turn('我喜欢手碟。',true);
  const removed=audit.remove(db,active('喜欢：手碟').id);
  await recover(1); assert.ok(!active('喜欢：手碟'));
  audit.undo(db,removed.revisionId);
  assert.ok(active('喜欢：手碟'),'manual undo still restores the record');
  audit.remove(db,active('喜欢：手碟').id);
  const fresh=await turn('我喜欢手碟。');
  assert.equal(active('喜欢：手碟').source_message_id,fresh,'new first-person evidence after deletion is allowed');
  const confirmedAtBefore=active('喜欢：手碟').updated_at;
  clock+=86400000;
  const undelivered=save('我不喜欢手碟。');
  const confirmation=await turn('我喜欢手碟。');
  const confirmed=active('喜欢：手碟');
  assert.equal(confirmed.source_message_id,confirmation);
  assert.equal(revision(confirmed.id).operation,'confirm');
  const before=snapshot();
  await process('我不喜欢手碟。', undelivered);
  assert.deepEqual(snapshot(),before,'late contrary evidence cannot undo a newer confirmation');
  audit.undo(db,revision(confirmed.id).id);
  assert.equal(active('喜欢：手碟').source_message_id,fresh);
  assert.equal(active('喜欢：手碟').updated_at,confirmedAtBefore,'undo restores accessibility as well as the value and source');
  const legacySource=save('我叫苍山。');
  const corrected=audit.edit(db,active('惯用称呼').id,{factKey:'新的称呼'});
  db.prepare('UPDATE memory_fact_revisions SET source_cutoff_id=NULL WHERE id=?').run(corrected.revisionId);
  assert.equal(audit.upsert(db,{category:'profile',factKey:'惯用称呼',factValue:'苍山',sourceMessageId:legacySource}),null,
    'unmigrated manual revisions use their original timestamps conservatively');

  // A failed extraction using a different residence label cannot override a
  // newer location or a management change made after its message was saved.
  const residence = () => memory.searchFacts('我现在住在哪座城市？').map(f=>f.factValue);
  const firstCity='柳州是我的居住地。', pendingCity=save(firstCity);
  await turn('我的现居城市是昆明。');
  assert.deepEqual(residence(),['昆明']);
  await process(firstCity,pendingCity);
  assert.deepEqual(residence(),['昆明']);
  const secondCity='我的常住地是泉州。', savedCity=save(secondCity);
  const removedCity=audit.remove(db,active('城市').id);
  await process(secondCity,savedCity);
  assert.deepEqual(residence(),[],'an older queued city is not restored after deletion');
  audit.undo(db,removedCity.revisionId);
  assert.deepEqual(residence(),['昆明']);
  await turn('我的常住城市是苏州。');
  assert.deepEqual(residence(),['苏州']);
  const priorHome = active('城市');
  const sameClockSource = save('我现居杭州。');
  const alias = audit.upsert(db,{category:'other',factKey:'现居地',factValue:'杭州',
    sourceMessageId:sameClockSource,evidence:'我现居杭州'});
  audit.edit(db,priorHome.id,{importance:5});
  assert.deepEqual(residence(),['杭州'],'adjusting an older record’s importance does not make its city current');
  const correction=audit.edit(db,alias,{factValue:'绍兴'});
  const reversal=audit.undo(db,correction.revisionId);
  assert.deepEqual(residence(),['杭州']);
  audit.undo(db,reversal.revisionId);
  assert.deepEqual(residence(),['绍兴'],'reversing the undo restores the city correction');
  console.log('memory-stale-retry: PASS (failed-job recovery, inverse preferences, renamed/deleted facts, manual cutoff, fresh confirmation and undo)');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
  memory.closeMemory();global.fetch=originalFetch;Date.now=originalNow;
  if(!path.resolve(dir).startsWith(root+path.sep)) throw new Error('Unsafe fixture cleanup');
  fs.rmSync(dir,{recursive:true,force:true});
});
