const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');

async function main() {
  const temp = path.resolve(__dirname,'../temp');
  fs.mkdirSync(temp,{recursive:true});
  const dir = fs.mkdtempSync(path.join(temp,'episode-legacy-'));
  const oldDir = process.env.DAFEIYU_DATA_DIR;
  process.env.DAFEIYU_DATA_DIR = dir;
  const realNow = Date.now, realFetch = global.fetch;
  let clock = new Date(2030,5,3,10).getTime();
  Date.now = () => clock;
  global.fetch = () => { throw Error('network not allowed in legacy fixture'); };
  const settings = require('./electron/brain/settings'), realLoad = settings.loadSettings;
  settings.loadSettings = () => ({memory:{enabled:true,autoExtract:true,retentionDays:0}});
  const memory = require('./electron/brain/memory'), api = require('./memory-api');
  let db;
  try {
    // Existing Nianan facts with neither lifecycle columns nor revision history.
    const legacy = new DatabaseSync(path.join(dir,'companion-memory.db'));
    try {
      legacy.exec(`CREATE TABLE facts(id INTEGER PRIMARY KEY AUTOINCREMENT,category TEXT NOT NULL,
        fact_key TEXT NOT NULL,fact_value TEXT NOT NULL,importance INTEGER NOT NULL,
        source_message_id INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(category,fact_key));
        CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,role TEXT NOT NULL,
          content TEXT NOT NULL,emotion TEXT,created_at INTEGER NOT NULL)`);
      const add = (category,key,value,source) => {
        const saved = legacy.prepare("INSERT INTO messages(session_id,role,content,created_at) VALUES ('main','user',?,?)").run(source,clock);
        legacy.prepare('INSERT INTO facts(category,fact_key,fact_value,importance,source_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
          .run(category,key,value,4,saved.lastInsertRowid,clock,clock);
      };
      add('plan','应聘安排','我明天要参加木工面试','我明天要参加木工面试。铜铃只记在原档。');
      add('event','活动记录','我明天要参加登山比赛','我明天要参加登山比赛。');
      add('event','过去的比赛','昨天我在苔青馆参加了咖啡比赛','昨天我在苔青馆参加了咖啡比赛。');
      add('event','别人的事','同事小岚在蓝亭参加了书画展览','同事小岚在蓝亭参加了书画展览。');
      add('habit','工具习惯','用纸质尺子量窗帘','我用纸质尺子量窗帘。');
      add('plan','考试一','游泳考试','我明天参加游泳考试。');
      add('plan','考试二','驾驶考试','我明天参加驾驶考试。');
    } finally {legacy.close();}
    db = memory.initMemory();
    const memoryView = async () => (await api.handle({method:'GET',path:'/memory',db})).body;
    const getFact = key => db.prepare('SELECT * FROM facts WHERE fact_key=?').get(key);
    const prompt = query => memory.buildMemoryContext(query,{sessionId:'fresh',tokenBudget:1700});
    async function say(userText) {
      clock += 20;
      const sessionId='fresh';
      const {userMessageId}=memory.saveChatTurn({sessionId,userText,reply:'知道了。',extract:false});
      assert.equal((await memory.processCommittedTurn({sessionId,userText,userMessageId})).complete,true);
    }
    const interview = getFact('应聘安排');
    assert.equal(interview.episode_status,null);
    assert.ok(prompt('木工面试').includes(interview.fact_value));
    const count = () => db.prepare('SELECT COUNT(*) AS n FROM facts').get().n;
    const initialCount = count();
    const replayText = '我明天要参加木工面试。铜铃只记在原档。';
    await memory.processCommittedTurn({sessionId:'main',userText:replayText,userMessageId:interview.source_message_id,requestId:'resume-legacy'});
    assert.equal(count(),initialCount,'replaying a pre-upgrade source must not add another fact');
    assert.deepEqual(getFact('应聘安排'),interview);
    await say('我的考试取消了。');
    assert.equal(count(),initialCount,'a generic update shared by two legacy appointments cannot select one');
    assert.equal(getFact('考试一').episode_status,null);
    assert.equal(getFact('考试二').episode_status,null);
    // Some previous schemas recorded real future deadlines. A generic past
    // outcome cannot close a distinctly later scheduled appointment.
    db.prepare("UPDATE facts SET fact_type='temporary',expires_at=? WHERE fact_key IN ('考试一','考试二')").run(clock+8*86400000);
    const {findLegacyPlans} = require('./electron/brain/memory-episode-legacy');
    assert.deepEqual(findLegacyPlans(db,{topic:'考试',matchingGist:'考试',gist:'通过考试',status:'completed',evidence:'我考试通过了'},
      {id:100,created_at:clock},clock-30*86400000),[]);
    await say('我的木工面试取消了。');
    const cancelled = getFact('应聘安排');
    assert.equal(cancelled.id, interview.id);
    assert.equal(cancelled.episode_status,'cancelled');
    const current = prompt('木工面试后来怎么样了？');
    assert.match(current,/取消/);
    assert.ok(!current.includes(interview.fact_value));
    assert.ok(!prompt('').includes(interview.fact_value));
    assert.ok(!memory.buildCallMemoryBrief({tokenBudget:1000}).includes(interview.fact_value));
    assert.ok(!memory.searchFacts('木工面试').some(f=>f.factValue===interview.fact_value));
    const view = await memoryView();
    const revision = view.revisions.find(r=>r.fact_id===interview.id && r.operation==='update');
    assert.ok(revision);
    assert.equal(JSON.parse(revision.before_json).fact_value,interview.fact_value);
    const undo = await api.handle({method:'POST',path:'/memory/revisions/'+revision.id+'/undo',db});
    assert.equal(undo.status,200);
    assert.deepEqual(getFact('应聘安排'),interview,'undo restores the whole legacy row with original age/source');
    assert.ok(prompt('木工面试').includes(interview.fact_value));
    const contest=getFact('活动记录');
    await say('我的登山比赛改到后天了。');
    assert.equal(getFact('活动记录').episode_status,'rescheduled');
    assert.ok(!prompt('登山比赛').includes(contest.fact_value));
    assert.equal(getFact('过去的比赛').episode_status,null,'separate completed activity is preserved');
    assert.match(prompt('咖啡比赛'),/苔青馆/,'legacy recent detail still works');
    clock += 31*86400000;
    const old = prompt('还记得那次面试吗？');
    assert.match(old,/面试/,'retained sourced topic can be recalled once fine detail has faded');
    assert.doesNotMatch(old,/木工面试|铜铃/);
    for (const surface of [prompt('苔青馆'),prompt('展览'),prompt(''),memory.buildCallMemoryBrief({tokenBudget:1600})]) {
      assert.doesNotMatch(surface,/苔青馆|蓝亭|木工面试|铜铃/);
    }
    assert.ok(prompt('尺子').includes('纸质尺子'),'an unrelated habitual fact is unaffected');
    const archived = await memoryView();
    assert.ok(archived.facts.some(f => f.id === interview.id && f.source_text.includes('铜铃')));
    console.log('memory-episode-legacy: PASS (upgrade, matched legacy plan and event, no competing old prompts, undo, ordinary facts, fading and archive)');
  } finally {
    try {memory.closeMemory();} finally {
      settings.loadSettings=realLoad; Date.now=realNow; global.fetch=realFetch;
      if(oldDir===undefined)delete process.env.DAFEIYU_DATA_DIR;else process.env.DAFEIYU_DATA_DIR=oldDir;
      assert.equal(path.dirname(dir),temp);
      fs.rmSync(dir,{recursive:true,force:true});
    }
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
