// User-visible person context after a correction, retraction or passage of time.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../temp');
fs.mkdirSync(root, { recursive: true });
const dir = fs.mkdtempSync(path.join(root, 'people-validity-'));
process.env.DAFEIYU_DATA_DIR = dir;
const settings = require('./electron/brain/settings');
settings.loadSettings = () => ({ memory: { autoExtract: false, retentionDays: 0 } });
const memory = require('./electron/brain/memory');
const people = require('./electron/brain/memory-people');
const audit = require('./electron/brain/memory-audit');
try {
  const db = memory.initMemory();
  const block = query => people.buildPeopleContextBlock(db, query);
  const log = (personId, sourceId, evidence) => db.prepare(
    'INSERT INTO memory_people_sources(person_id,source_message_id,evidence,created_at) VALUES (?,?,?,?)'
  ).run(personId, sourceId, evidence, Date.now());
  const commit = text => memory.saveChatTurn({ userText: text, reply: '收到。', extract: false }).userMessageId;
  function grounded(name, note, text, aliases = []) {
    const sourceId = commit(text);
    const payload = { displayName: name, notes: note, aliases, sourceMessageId: sourceId, evidence: text, relationType: 'friend' };
    const id = people.upsertPerson(db, payload);
    assert.ok(id); log(id, sourceId, text);
    return { id, sourceId, payload };
  }
  const friend = grounded('王小明', '住在甲城', '我朋友王小明，住在甲城。');
  const moved = grounded('王小明', '已搬到乙城', '王小明已搬到乙城。');
  const other = grounded('小明', '喜欢陶艺', '我另一位朋友小明，喜欢陶艺。', ['无依据的别名']);
  assert.equal(friend.id, moved.id); assert.notEqual(other.id, friend.id);
  assert.ok(!block('王小明怎么样？').includes('甲城'));
  assert.ok(block('王小明怎么样？').includes('已搬到乙城') && !block('王小明怎么样？').includes('喜欢陶艺'));
  assert.ok(block('小明呢？').includes('喜欢陶艺') && !block('小明呢？').includes('乙城'));
  assert.ok(block('小明和王小明').includes('喜欢陶艺') && block('小明和王小明').includes('乙城'));
  assert.equal(block('无依据的别名'), '');
  assert.match(people.getPersonById(db, friend.id).notes, /住在甲城/);

  const factId = audit.upsert(db, { category: 'relationship', factKey: '王小明的居所', factValue: '乙城',
    sourceMessageId: moved.sourceId, evidence: moved.payload.evidence });
  const corrected = audit.edit(db, factId, { factValue: '丙城' });
  assert.equal(block('王小明'), '', 'invalidated source cannot leak through a shorter separate person or the same card');
  audit.undo(db, corrected.revisionId);
  assert.match(block('王小明'), /乙城/);
  db.prepare('UPDATE facts SET fact_type=?,expires_at=? WHERE id=?').run('temporary', Date.now()-100, factId);
  assert.ok(!block('王小明').includes('乙城'), 'temporary fact expiry removes the linked person detail at read time');

  const manual = audit.editPerson(db, friend.id, { notes: '只保留本人确认的备注', displayName: '阿成' });
  assert.ok(block('阿成').includes('只保留本人确认的备注'));
  assert.equal(people.upsertPerson(db, moved.payload), null, 'a retry cannot restore the retired name or old note');
  assert.ok(!block('王小明').includes('阿成'));
  assert.equal(audit.undoEntity(db, manual.entityRevisionId).person.display_name, '王小明');
  assert.ok(!block('王小明').includes('乙城'));
  const deleted = audit.editPerson(db, other.id, {}, true);
  assert.equal(people.upsertPerson(db, other.payload), null, 'replaying the original source cannot recreate a user-deleted person');
  audit.undoEntity(db, deleted.entityRevisionId);
  assert.match(block('小明'), /喜欢陶艺/);

  const future = Date.now() + 310 * 86400000;
  const old = people.matchPeopleInText(db, '小明', 4, future);
  assert.equal(old.length, 1); assert.equal(old[0].notes, '', 'routine details fade while the named relationship remains');
  assert.equal(people.getPersonById(db, other.id).notes, '喜欢陶艺');
  people.upsertPerson(db, { displayName: '甲同学', aliases: ['小树'], notes: '一号' });
  people.upsertPerson(db, { displayName: '乙同学', aliases: ['小树'], notes: '二号' });
  assert.equal(block('小树'), '');
  assert.equal(people.upsertPerson(db, { displayName: '小树', notes: '未知' }), null);
  people.upsertPerson(db, { displayName: '妈妈', relationType: 'family', notes: '家人备注' });
  assert.ok(block('我的妈妈').includes('家人备注'));
  assert.equal(block('朋友的妈妈来了'), '');
  people.upsertPerson(db,{displayName:'林初',aliases:['小鹿','老同桌'],notes:'在做木工'});
  const insertFiller=db.prepare('INSERT INTO user_people(display_name,last_mentioned_at,created_at,updated_at) VALUES(?,?,?,?)');
  for(let i=0;i<105;i++)insertFiller.run('样例人物'+i,Date.now()+10,Date.now(),Date.now());
  assert.ok(block('林初最近怎么样？').includes('在做木工'));
  assert.ok(block('还记得小鹿吗？').includes('在做木工'));
  assert.equal(block('我今天出门了'),'');
  people.upsertPerson(db,{displayName:'高原',aliases:['老同桌'],notes:'在制陶'});
  assert.equal(block('老同桌呢？'),'','a recent alias cannot mask the other older holder');
  const member = grounded('阿元', '', '我的朋友阿元来了。');
  const changedText = '阿元现在是我的同事。';
  const changedSource = commit(changedText);
  people.upsertPerson(db, { displayName: '阿元', relationType: 'colleague', sourceMessageId: changedSource });
  log(member.id, changedSource, changedText);
  assert.match(block('阿元'), /同事/);
  audit.editPerson(db, member.id, { relationType: 'friend' });
  const laterText = '同事阿元正在赶路。';
  const laterSource = commit(laterText);
  people.upsertPerson(db, { displayName: '阿元', relationType: 'colleague', sourceMessageId: laterSource });
  log(member.id, laterSource, laterText);
  assert.match(block('阿元'), /朋友/, 'manual relationship correction takes priority over model output');
  console.log('memory-people-validity: PASS (separate people, latest grounded notes, correction/expiry/undo, replay, fading, archive)');
} finally {
  memory.closeMemory();
  if (!path.resolve(dir).startsWith(root + path.sep)) throw new Error('Unsafe fixture cleanup');
  fs.rmSync(dir, { recursive: true, force: true });
}
