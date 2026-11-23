// The cooldown index is derived solely from delivered assistant speech.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { DAY } = require('./electron/brain/memory-validity');
const mentions = require('./electron/brain/memory-mentions');

const oldDb = new DatabaseSync(':memory:');
assert.equal(mentions.loadMentionPolicy(oldDb).hasCooling,false);
assert.equal(oldDb.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='memory_mentions'").get().n,0);
oldDb.close();

const root = path.resolve(__dirname,'../temp');
fs.mkdirSync(root,{recursive:true});
const temp = fs.mkdtempSync(path.join(root,'memory-mentions-'));
const previous = process.env.DAFEIYU_DATA_DIR;
process.env.DAFEIYU_DATA_DIR = temp;
const settings = require('./electron/brain/settings');
const originalLoad = settings.loadSettings;
settings.loadSettings = () => ({memory:{enabled:true,autoExtract:false,retentionDays:0}});
const memory = require('./electron/brain/memory');
const audit = require('./electron/brain/memory-audit');
const {storeEpisode} = require('./electron/brain/memory-episode-store');
const {upsertPerson} = require('./electron/brain/memory-people');
const originalTime = Date.now;
let now = Date.UTC(2031,2,14,12);
Date.now = () => now;
try {
  let db = memory.initMemory();
  mentions.initMentions(db);
  const say = (text,options) => mentions.recordDeliveredMentions(db,text,{now,...options});
  const policy = () => mentions.loadMentionPolicy(db,now);
  const fact = (factKey,factValue,category='other',options={}) => audit.upsert(db,{
    category,factKey,factValue,importance:4,...options});
  const recordText = text=>memory.saveChatTurn({userText:text,reply:'记录完成。',extract:false}).userMessageId;
  const value = '晨雾青瓷杯';
  const cup = fact('最珍惜的物件',value);
  const smaller = fact('首件瓷器','青瓷杯');
  const observe = () => ['facts','memory_fact_revisions','messages'].map(t=>db.prepare('SELECT * FROM '+t+' ORDER BY id').all());
  const original = observe();
  assert.equal(say('我听着呢。'),0);
  assert.equal(policy().coolingCount,0);
  assert.equal(say('你同事喜欢晨雾青瓷杯。'),0,'another person is not the owner');
  assert.equal(say('阿青喜欢晨雾青瓷杯。'),0);
  assert.equal(say('商店上新了晨雾青瓷杯。'),0,'a unique item appearing in the world is not a personal recollection');
  assert.equal(say(['你的晨雾青瓷杯真好看。','晚安。']),1);
  assert.equal(policy().isCooling('fact',cup),true);
  assert.equal(policy().isCooling('fact',smaller),false,'the full name wins over an embedded name');
  assert.equal(policy().mentionsCooling('你记得晨雾青瓷杯吗？'),true);
  assert.equal(mentions.wouldRepeatDeliveredMention(db,'你的青瓷杯呢？',{now}),false);
  assert.deepEqual(observe(),original,'delivery bookkeeping never touches source, fact or revisions');
  const contents = db.prepare('SELECT * FROM memory_mentions').all();
  assert.deepEqual(Object.keys(contents[0]).sort(),['item_id','kind','mentioned_at','version']);
  assert.ok(!JSON.stringify(contents).includes('青瓷'));

  const shared1 = fact('收藏','赤金线装书');
  const shared2 = fact('最想去找的','赤金线装书');
  assert.equal(say('你说过赤金线装书。'),0,'same anchor for two memories is ambiguous');
  assert.ok(!policy().isCooling('fact',shared1) && !policy().isCooling('fact',shared2));
  const tea = fact('喜欢：乌龙','乌龙','preference');
  assert.equal(say('你看乌龙院吗？'),0);
  assert.equal(say('你喜欢乌龙院吗？'),0,'a longer word cannot borrow the short preference');
  assert.equal(say('你妹妹喜欢乌龙。'),0);
  assert.equal(say('她喜欢乌龙。'),0);
  assert.equal(say('你不喜欢乌龙。'),0);
  assert.equal(say('你喜欢乌龙。'),1);
  assert.ok(policy().isCooling('fact',tea));
  assert.equal(policy().mentionsCooling('我喜欢乌龙。',{role:'user'}),true);

  const person = upsertPerson(db,{displayName:'小芒',aliases:['阿芒'],relationType:'friend',notes:'做陶艺'});
  assert.equal(say('小芒，早上好。'),0,'greetings do not count as personal references');
  assert.equal(say('你提到过的阿芒最近怎么样？'),1);
  assert.ok(policy().isCooling('person',person));
  assert.equal(policy().mentionsCooling('早安，小芒。'),false);
  audit.editPerson(db,person,{displayName:'小乔'});
  assert.equal(policy().isCooling('person',person),false,'a new identity is independent of the prior cooldown');
  assert.equal(say('你说过的阿芒最近如何？'),0,'retired aliases stay retired');
  audit.edit(db,cup,{factValue:'浮光果盘'});
  assert.equal(policy().isCooling('fact',cup),false,'current facts can be recalled after a correction');
  assert.equal(say('你的浮光果盘很精致。'),1);
  memory.closeMemory(); db=memory.initMemory(); mentions.initMentions(db);
  assert.ok(policy().isCooling('fact',cup),'delivery survives normal backend restart');
  now+=2*DAY-1;
  assert.ok(policy().isCooling('fact',cup));
  now++;
  assert.equal(policy().isCooling('fact',cup),false,'exact expiry unblocks the memory');

  const sourceText = '我参加了青瓷比赛';
  const sourceId = recordText(sourceText);
  const episode = storeEpisode(db,{topic:'青瓷比赛',gist:'比赛',status:'completed',
    factValue:sourceText,evidence:sourceText,importance:3},{sourceMessageId:sourceId,sessionId:'main'});
  assert.ok(episode);
  const later = '我收养了琥珀小狗';
  const otherSource = recordText(later);
  const dog = fact('宠物','琥珀小狗','other',{sourceMessageId:otherSource,evidence:later});
  assert.equal(say('你的琥珀小狗很可爱。',{sourceMessageId:sourceId}),0,'post-extraction pass uses the committed source');
  assert.equal(say('你的琥珀小狗很可爱。',{sourceMessageId:otherSource}),1);
  assert.ok(policy().isCooling('fact',dog));
  assert.ok(policy().isCoolingSource(otherSource));
  assert.equal(policy().isCoolingSource(sourceId),false);
  audit.edit(db,dog,{factValue:'黑背小狗'});
  assert.equal(policy().isCoolingSource(otherSource),false,'an edit releases the source along with the item');
  now+=7*DAY-100;
  assert.equal(say('之前的青瓷比赛还记得吗？'),1);
  now+=101;
  assert.ok(policy().isCooling('episode',episode),'natural fading of details does not create a new memory');
  assert.equal(policy().mentionsCooling('青瓷比赛'),false,'a forgotten specific title cannot trigger matching');
  assert.equal(policy().mentionsCooling('你上次那场比赛怎么样？'),true,'a grounded generic reference can still match the gist');
  const inactive = fact('等待提醒','日落车票','other',{factType:'temporary',expiresAt:now});
  assert.equal(say('你的日落车票在这。'),0);
  assert.ok(!policy().isCooling('fact',inactive));
  // Track rows crossing the SQLite boundary on a large, irrelevant archive.
  // A usual greeting requires zero SQL on a loaded policy; a possible repeat
  // still checks the other candidates, without loading the unrelated records.
  const seed = db.prepare(`INSERT INTO facts(category,fact_key,fact_value,importance,created_at,updated_at)
    VALUES('other',?,?,4,?,?)`);
  db.exec('BEGIN');
  for (let i=0;i<2500;i++) seed.run('摆设'+i,'珊瑚模型'+i,now,now);
  db.exec('COMMIT');
  assert.equal(say('你的浮光果盘很精致。'),1);
  let reads=0, rowsRead=0;
  const observedDb = {
    function: db.function.bind(db),
    prepare(sql) {
      const stmt=db.prepare(sql);
      reads++;
      return {get:stmt.get.bind(stmt),all(...args) {
        const rows=stmt.all(...args); rowsRead+=rows.length; return rows;
      }};
    }
  };
  const observedPolicy=mentions.loadMentionPolicy(observedDb,now);
  reads=0; rowsRead=0;
  assert.equal(observedPolicy.mentionsCooling('早安，窗外好暖和。'),false);
  assert.equal(reads,0);
  assert.equal(observedPolicy.mentionsCooling('你的浮光果盘呢？'),true);
  assert.equal(rowsRead,1,'only the one candidate row leaves SQLite');
  const insertMention=db.prepare("INSERT INTO memory_mentions VALUES('fact',?,'invalid',?)");
  db.exec('BEGIN');
  for(let i=0;i<1030;i++) insertMention.run(20000+i,now-1);
  db.exec('COMMIT');
  say('你的浮光果盘呢？');
  assert.equal(db.prepare('SELECT count(*) n FROM memory_mentions').get().n,1024);
  console.log('memory-mentions: PASS (delivered anchors, factual correction, ambiguity, age, limited source, explicit person identity, bounded content-free persistence and restart)');
} finally {
  memory.closeMemory();
  settings.loadSettings=originalLoad;
  Date.now=originalTime;
  if(previous===undefined) delete process.env.DAFEIYU_DATA_DIR;
  else process.env.DAFEIYU_DATA_DIR=previous;
  assert.equal(path.dirname(temp),root);
  fs.rmSync(temp,{recursive:true,force:true});
}
