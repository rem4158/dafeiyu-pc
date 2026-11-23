// Preference corrections on the existing facts/revisions ledger. Original
// messages, the database, and all simulated legacy rows belong to this fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tempRoot = path.resolve(__dirname,'../temp');
fs.mkdirSync(tempRoot,{recursive:true});
const dir = fs.mkdtempSync(path.join(tempRoot,'preference-retraction-'));
const oldDir = process.env.DAFEIYU_DATA_DIR;
process.env.DAFEIYU_DATA_DIR = dir;
let memory;
try {
  memory = require('./electron/brain/memory');
  const audit = require('./electron/brain/memory-audit');
  let db = memory.initMemory();
  const save = text => memory.saveChatTurn({userText:text,reply:'好。',extract:false}).userMessageId;
  function write(source,value,kind='喜欢',extra={}) {
    const evidence = db.prepare('SELECT content FROM messages WHERE id=?').get(source).content;
    return audit.upsert(db,{category:'preference',factKey:kind+'：'+value,factValue:value,importance:4,
      evidence,sourceMessageId:source,...extra});
  }
  const retract = (source,value,extra={})=>write(source,value,'喜欢',{operation:'retractPreference',...extra});
  function legacy(key,value,source) {
    const at=db.prepare('SELECT created_at FROM messages WHERE id=?').get(source).created_at;
    return Number(db.prepare(`INSERT INTO facts(category,fact_key,fact_value,importance,source_message_id,created_at,updated_at)
      VALUES ('preference',?,?,4,?,?,?)`).run(key,value,source,at,at).lastInsertRowid);
  }
  const lastRevision = id => db.prepare('SELECT * FROM memory_fact_revisions WHERE fact_id=? ORDER BY id DESC LIMIT 1').get(id);
  const current = () => db.prepare('SELECT * FROM facts WHERE active=1 ORDER BY id').all();

  // Both spellings were possible before normalization. A single undo must
  // restore the exact preexisting state, even via the secondary revision.
  const a=save('我喜欢喝铁观音。'), b=save('我现在喜欢铁观音。');
  const alias=legacy('喜欢','喝铁观音',a), canonical=legacy('喜欢：铁观音','铁观音',b);
  const unrelated=legacy('喜欢','山水画',save('我喜欢山水画。'));
  const before=current();
  const correction=save('我不再喜欢铁观音，现在我喜欢薄荷糖。');
  const withdrawn=retract(correction,'铁观音');
  assert.equal(withdrawn,canonical);
  assert.deepEqual(current().map(f=>f.id),[unrelated]);
  const change=lastRevision(withdrawn);
  assert.equal(change.operation,'retract');
  assert.equal(change.source_message_id,correction);
  assert.ok(change.evidence.includes('不再喜欢'));
  const aliasChange=lastRevision(alias);
  assert.equal(aliasChange.group_revision_id,change.id);
  assert.equal(retract(correction,'铁观音'),null,'retry produced no duplicate revision');
  audit.undo(db,aliasChange.id);
  assert.deepEqual(current(),before,'undo restores old keys, both sources and the unrelated item');
  assert.equal(retract(correction,'铁观音'),null,'a manual undo bars an older job');
  const newer=save('我不再喜欢铁观音，现在我喜欢薄荷糖。');
  retract(newer,'铁观音',{evidence:'我不再喜欢铁观音'});
  assert.ok(write(newer,'薄荷糖','喜欢',{evidence:'现在我喜欢薄荷糖'}),'another clause in the correcting turn remains usable');
  assert.ok(!current().some(f=>f.fact_value.includes('铁观音')),'withdrawal did not become a negative preference');

  // A new explicit opposite polarity updates the original row rather than
  // leaving a stale “不喜欢” or “不喜欢：吃X” under a different key.
  const negative=legacy('不喜欢','吃桂花糕',save('我不喜欢吃桂花糕。'));
  const fresh=save('我喜欢吃桂花糕。');
  assert.equal(write(fresh,'桂花糕','喜欢',{legacyValues:['吃桂花糕']}),negative);
  const positive=audit.row(db,negative);
  assert.deepEqual([positive.fact_key,positive.fact_value,positive.source_message_id],['喜欢：桂花糕','桂花糕',fresh]);
  audit.undo(db,lastRevision(negative).id);
  assert.equal(audit.row(db,negative).fact_key,'不喜欢');
  const leaveDislike=save('我不再喜欢桂花糕。');
  retract(leaveDislike,'桂花糕',{legacyValues:['吃桂花糕']});
  assert.equal(audit.row(db,negative).active,1,'withdrawing a like cannot erase a dislike');

  const late=save('我喜欢喝紫苏茶。');
  const earlyWithdrawal=save('我不再喜欢紫苏茶。');
  const marker=retract(earlyWithdrawal,'紫苏茶');
  assert.equal(audit.row(db,marker).active,0);
  assert.equal(lastRevision(marker).source_message_id,earlyWithdrawal);
  memory.closeMemory(); db=memory.initMemory();
  assert.equal(write(late,'紫苏茶'),null,'a late extraction cannot invent a preference withdrawn before it ran');
  assert.equal(write(late,'喝紫苏茶'),null,'the persisted withdrawal also guards the older qualified key');
  assert.equal(retract(save('我不再喜欢紫苏茶。'),'紫苏茶'),marker,'repeated withdrawals reuse one item');
  assert.equal(write(save('我喜欢紫苏茶。'),'紫苏茶'),marker,'a later explicit statement can restore a preference');
  const futureRetry=save('我不喜欢紫苏茶。');
  audit.edit(db,marker,{factKey:'手选偏好',factValue:'手工修正'});
  assert.equal(write(futureRetry,'紫苏茶','不喜欢'),null,'newer manual rename protects the prior preference key');
  assert.equal(retract(save('我出门了。'),'山水画',{evidence:'我不再喜欢山水画'}),null,'withdrawals require their actual source');
  assert.equal(retract(save('我喜欢山水画。'),'山水画'),null,'quoting a positive statement cannot withdraw it');

  // A known location or art term is unnecessary: ground new action context
  // in exact user wording and retain ordinary keywords through confirm/edit/undo.
  const label='岚七', ordinary=['本地分类','保留这个词'];
  const item=write(save('我喜欢岚七。'),label,'喜欢',{keywords:JSON.stringify(ordinary)});
  const bogus=save('我喜欢岚七，可我的同事喜欢喝岚七。');
  write(bogus,label,'喜欢',{keywords:'["@source-action:喝"]'});
  assert.deepEqual(JSON.parse(audit.row(db,item).keywords),ordinary,'a third party cannot supply the action');
  const grounded=save('我喜欢喝岚七。');
  write(grounded,label,'喜欢',{keywords:'["@source-action:喝"]',legacyValues:['喝岚七']});
  const confirmed=lastRevision(item), tags=[...ordinary,'@source-action:喝'];
  assert.equal(confirmed.operation,'confirm');
  assert.deepEqual(JSON.parse(audit.row(db,item).keywords),tags);
  const edited=audit.edit(db,item,{factKey:'喜欢：岚八',factValue:'岚八'});
  assert.deepEqual(JSON.parse(edited.fact.keywords),ordinary);
  assert.deepEqual(JSON.parse(audit.undo(db,edited.revisionId).fact.keywords),tags);
  assert.deepEqual(JSON.parse(audit.undo(db,confirmed.id).fact.keywords),ordinary);
  const explicitEdit=audit.edit(db,item,{factValue:'果盘'});
  assert.equal(explicitEdit.fact.fact_key,'喜欢：果盘','a value-only management edit retains its polarity with the new spelling');
  const removal=audit.remove(db,item);
  legacy('不喜欢','果盘',save('我不喜欢果盘。'));
  assert.throws(()=>audit.undo(db,removal.revisionId),/duplicate/,'undo cannot reintroduce a contradiction over an independent newer record');
  assert.equal(audit.row(db,item).active,0);
  console.log('memory-preference-retraction: PASS (legacy spellings, grouped undo, polarity, mixed source, late retry, restart, manual edit and sourced action tags)');
} finally {
  memory?.closeMemory();
  if (oldDir===undefined) delete process.env.DAFEIYU_DATA_DIR; else process.env.DAFEIYU_DATA_DIR=oldDir;
  assert.equal(path.dirname(dir),tempRoot);
  fs.rmSync(dir,{recursive:true,force:true});
}
