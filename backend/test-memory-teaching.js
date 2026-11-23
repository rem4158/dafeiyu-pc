// The same model's teaching tools stage changes until the real user turn commits.
// Isolated SQLite only: no QQ, model, production settings, or network calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const root = path.resolve(__dirname, '../temp');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'memory-teaching-'));
  const oldDir = process.env.DAFEIYU_DATA_DIR, oldFetch = global.fetch, oldNow = Date.now;
  process.env.DAFEIYU_DATA_DIR = dir;
  const settings = require('./electron/brain/settings'), oldLoad = settings.loadSettings;
  let memoryEnabled = true, calls = 0, now = Date.UTC(2030, 1, 10);
  settings.loadSettings = () => ({memory:{enabled:memoryEnabled,autoExtract:false,retentionDays:0}});
  global.fetch = async () => { calls++; throw new Error('No network in teaching test'); };
  Date.now = () => now;
  const memory = require('./electron/brain/memory'), audit = require('./electron/brain/memory-audit');
  const teaching = require('./electron/brain/memory-teaching'), api = require('./memory-api');
  try {
    const db = memory.initMemory(), sessionId = 'teaching-test';
    const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(x=>x.name);
    const initialTables = tables();
    const facts = () => db.prepare('SELECT * FROM facts ORDER BY id').all();
    const session = (userText, overrides={}) => teaching.createTeachingSession({
      db,getSettings:settings.loadSettings,userText,sessionId,requestId:'test-'+now,...overrides,
    });
    function turn(userText, sid=sessionId) {
      now += 10;
      return memory.saveChatTurn({sessionId:sid,userText,reply:'测试回复',extract:false}).userMessageId;
    }
    function finish(staged, userText, sid=sessionId) {
      db.exec('BEGIN');
      try {
        const sourceMessageId = turn(userText,sid), result = staged.commit({sourceMessageId});
        db.exec('COMMIT');
        return {sourceMessageId,result};
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    const context = (query='劳烦给那边捎句话',options={}) => memory.buildMemoryContext(query,{
      sessionId:'new-session',tokenBudget:1400,...options,
    });

    const source = '以后我让你用QQ给我报个平安时，直接调用QQ发送工具，不用让我照固定句式说话。';
    const instruction = '用户请求通过QQ给本人传话时，判断语义后调用QQ发送工具，无需固定命令句式。';
    const staged = session(source);
    assert.equal(staged.hasChanges(),false);
    assert.equal(staged.execute('save',{topic:'QQ传话',instruction,evidence:source}).state,'pending_commit');
    assert.equal(staged.hasChanges(),true);
    assert.equal(facts().length,0,'tool planning never persists before delivered turn');
    assert.equal(staged.execute('list',{}).teachings.length,0);
    const saved = finish(staged,source), factId = saved.result.teachings[0].id;
    assert.equal(staged.hasChanges(),true,'committed teaching turn must still skip automatic extraction');
    assert.deepEqual(staged.commit({sourceMessageId:saved.sourceMessageId}),saved.result,'idempotent commit');
    const fact = audit.row(db,factId);
    assert.equal(fact.category,'other');
    assert.equal(fact.fact_key,'交互教导：QQ传话');
    assert.equal(fact.fact_value,instruction);
    assert.equal(fact.source_message_id,saved.sourceMessageId);
    const revision = db.prepare('SELECT * FROM memory_fact_revisions WHERE fact_id=? ORDER BY id DESC').get(factId);
    assert.equal(revision.actor,'user');
    assert.equal(revision.evidence,source);
    assert.equal(revision.source_message_id,saved.sourceMessageId);
    assert.deepEqual(tables(),initialTables,'no separate learning table/database');
    const reader = session('我们换个话题');
    assert.equal(reader.execute('get',{id:factId}).teaching.instruction,instruction);
    assert.equal(reader.execute('list',{}).teachings[0].id,factId);
    reader.discard();
    assert.ok(context().includes(instruction),'different wording/new session sees semantic candidates');
    assert.ok(context('我喜欢喝什么茶？').includes(instruction),'targeted recall branch still includes teaching');
    assert.equal((context().match(/\[教导#/g)||[]).length,1,'no duplicate important/search fact injection');
    assert.ok(!JSON.stringify(require('./electron/brain/memory-user-profile').buildHeuristicProfile(db)).includes(instruction),
      'interaction teaching is not user biography/preference');
    assert.ok(teaching.buildTeachingContext({db,tokenBudget:500}).includes(instruction));
    assert.equal(teaching.buildTeachingContext({db,tokenBudget:1}),'');
    assert.equal(teaching.buildTeachingContext({db,maxItems:0}),'');
    assert.equal(context('',{tokenBudget:0}),'');
    assert.ok(!context('',{maxContextFacts:0}).includes(instruction));
    for (const budget of [1,100,180,300]) assert.ok(Math.ceil(context('',{tokenBudget:budget}).length/1.5)<=budget);

    // Actual current user evidence is required, without hard-coded teaching phrases.
    assert.throws(()=>session('向南走').execute('save',{topic:'编造',instruction:'永久事实',evidence:'助手自行总结'}),
      /teaching_evidence_mismatch/);
    const freeform = '那条指令就是我想表达的，记下。';
    const arbitrary = session(freeform);
    arbitrary.execute('save',{topic:'自由措辞',instruction:'用户可用自己的措辞表达请求。',evidence:freeform});
    arbitrary.discard();
    assert.equal(facts().length,1,'discarded/cancelled turn has no writes');
    assert.throws(()=>arbitrary.commit({sourceMessageId:saved.sourceMessageId}),/teaching_session_closed/);
    const mismatched = session('正确来源');
    mismatched.execute('save',{topic:'源校验',instruction:'必须有当前用户依据',evidence:'正确来源'});
    assert.throws(()=>mismatched.commit({sourceMessageId:saved.sourceMessageId}),/teaching_source_mismatch/);
    mismatched.discard();

    const correction = '刚才那条要改：正文不明确时先问我想发什么。';
    const revisedInstruction = '用户请求QQ传话时可调用工具；正文不明确时先询问正文。';
    const revising = session(correction);
    revising.execute('revise',{id:factId,instruction:revisedInstruction,evidence:correction});
    const revised = finish(revising,correction);
    assert.equal(facts().length,1,'revise keeps original row');
    assert.equal(audit.row(db,factId).source_message_id,revised.sourceMessageId,'revised provenance follows correction');
    assert.ok(context().includes(revisedInstruction) && !context().includes(instruction),'obsolete teaching no longer injected');
    const correctionRevision = db.prepare('SELECT * FROM memory_fact_revisions WHERE fact_id=? ORDER BY id DESC').get(factId);
    assert.equal(correctionRevision.evidence,correction);
    assert.equal(correctionRevision.source_message_id,revised.sourceMessageId);
    const overview = await api.handle({method:'GET',path:'/memory',db});
    assert.equal(overview.status,200);
    assert.ok(JSON.stringify(overview.body).includes(revisedInstruction),'existing management shows teaching + source + revisions');

    // Management changes supersede an in-flight model plan, atomically with its chat turn.
    const staleSource = '改成总是先问一句';
    const stale = session(staleSource);
    stale.execute('revise',{id:factId,instruction:'已过时的模型计划',evidence:staleSource});
    audit.edit(db,factId,{factValue:'手工修订后的教导'});
    const beforeMessages = db.prepare('SELECT count(*) AS n FROM messages').get().n;
    assert.throws(()=>finish(stale,staleSource),/teaching_conflict/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get().n,beforeMessages,'failed turn rolled back');
    assert.ok(context().includes('手工修订后的教导'));
    const manualRevision = db.prepare('SELECT id FROM memory_fact_revisions WHERE fact_id=? ORDER BY id DESC').get(factId).id;
    audit.undo(db,manualRevision);
    assert.ok(context().includes(revisedInstruction),'existing undo restores teaching');
    assert.equal(audit.row(db,factId).source_message_id,revised.sourceMessageId);

    const withdraw = '撤回这条QQ教导，以后别再参考它。';
    const retracting = session(withdraw);
    retracting.execute('retract',{id:factId,evidence:withdraw});
    const retracted = finish(retracting,withdraw);
    assert.equal(audit.row(db,factId).active,0);
    assert.ok(!context().includes(revisedInstruction));
    assert.equal(teaching.getTeaching({db,id:factId}),null);
    assert.deepEqual(teaching.listTeachings({db}),[]);
    const retractRevision = db.prepare('SELECT * FROM memory_fact_revisions WHERE fact_id=? ORDER BY id DESC').get(factId);
    assert.equal(retractRevision.source_message_id,retracted.sourceMessageId);
    assert.equal(retractRevision.evidence,withdraw);
    assert.ok(!context().includes(instruction),'ordinary reads do not revive withdrawn teaching');
    const renewalText = '我现在重新教你：QQ传话还是按语义理解，记录这一版。';
    const renewing=session(renewalText);
    renewing.execute('save',{topic:'QQ传话',instruction:'重新教导的QQ传话版本',evidence:renewalText});
    assert.ok(!context().includes('重新教导的QQ传话版本'),'renewal is staged until current turn commit');
    const renewedId=finish(renewing,renewalText).result.teachings[0].id;
    assert.notEqual(renewedId,factId,'withdrawn version remains archived');
    assert.equal(audit.row(db,factId).active,0);
    assert.ok(context().includes('重新教导的QQ传话版本'));
    audit.remove(db,renewedId);

    // Expiry and normal manager deletion share the exact existing validity policy.
    const agingSource = '这条普通教导可以随时间淡忘。';
    const aging = session(agingSource);
    aging.execute('save',{topic:'时效',instruction:'普通教导短句',evidence:agingSource});
    const agedId = finish(aging,agingSource).result.teachings[0].id;
    now += 366*86400000;
    assert.equal(teaching.getTeaching({db,id:agedId}),null);
    assert.ok(!context().includes('普通教导短句'));
    const refreshText='现在我重新告诉你这条时效教导。', refreshing=session(refreshText);
    refreshing.execute('save',{topic:'时效',instruction:'新证据续记教导',evidence:refreshText});
    const refreshedId=finish(refreshing,refreshText).result.teachings[0].id;
    assert.equal(refreshedId,agedId,'expired active row can be confirmed against fresh user evidence');
    assert.ok(context().includes('新证据续记教导') && !context().includes('普通教导短句'));
    audit.remove(db,refreshedId);
    const managedSource = '这条教导等会从管理界面撤回。', managed = session(managedSource);
    managed.execute('save',{topic:'管理撤回',instruction:'管理撤回标记',evidence:managedSource});
    const managedId = finish(managed,managedSource).result.teachings[0].id;
    const deletion = await api.handle({method:'DELETE',path:'/memory/facts/'+managedId,db});
    assert.equal(deletion.status,200);
    assert.ok(!context().includes('管理撤回标记'));

    const enabledSource = '先暂存，记忆关闭后不得写入', disabled = session(enabledSource);
    disabled.execute('save',{topic:'开关',instruction:'开关测试标记',evidence:enabledSource});
    memoryEnabled = false;
    assert.throws(()=>teaching.listTeachings({db}),/memory_disabled/);
    assert.throws(()=>teaching.getTeaching({db,id:factId}),/memory_disabled/);
    assert.throws(()=>session(source).execute('save',{topic:'已关闭',instruction,evidence:source}),/memory_disabled/);
    assert.throws(()=>finish(disabled,enabledSource),/memory_disabled/);
    assert.equal(teaching.buildTeachingContext({db}),'');
    assert.ok(!context().includes('[教导#'));
    disabled.discard(); memoryEnabled = true;

    // Count and total budget are shared with normal facts, not added outside them.
    const countSource='这个示例只保留一条教导', counting=session(countSource);
    counting.execute('save',{topic:'条数',instruction:'共享预算教导',evidence:countSource});
    finish(counting,countSource);
    const normalSource=turn('另一个独立事实');
    audit.upsert(db,{category:'other',factKey:'普通事实',factValue:'共享预算事实',importance:4,sourceMessageId:normalSource});
    const one=context('',{maxContextFacts:1});
    assert.ok(one.includes('共享预算教导') && !one.includes('共享预算事实'));
    const two=context('',{maxContextFacts:2});
    assert.ok(two.includes('共享预算教导') && two.includes('共享预算事实'));

    // Two queued/concurrent model plans cannot overwrite a teaching changed
    // since either model read it, even when their sources are both genuine.
    const concurrentText='并发修改的正确来源', countingId=teaching.listTeachings({db})[0].id;
    const first=session(concurrentText),second=session(concurrentText);
    first.execute('revise',{id:countingId,instruction:'并发先提交版本',evidence:concurrentText});
    second.execute('revise',{id:countingId,instruction:'并发过时版本',evidence:concurrentText});
    finish(first,concurrentText);
    assert.throws(()=>finish(second,concurrentText),/teaching_conflict/);
    assert.equal(audit.row(db,countingId).fact_value,'并发先提交版本');
    second.discard();
    const newTopicText='并发创建同主题',creatorA=session(newTopicText),creatorB=session(newTopicText);
    for(const creator of [creatorA,creatorB]) creator.execute('save',{
      topic:'并发新主题',instruction:'并发创建内容',evidence:newTopicText,
    });
    finish(creatorA,newTopicText);
    assert.throws(()=>finish(creatorB,newTopicText),/teaching_conflict/);
    creatorB.discard();
    // An older received utterance remains old evidence even if its delayed
    // model reads the new row and only then receives a newer messages.id.
    const delayedText='较早收到的另一会话教导', receivedAt=now-100;
    const delayed=session(delayedText,{sessionId:'delayed-session'});
    delayed.execute('revise',{id:countingId,instruction:'不得覆盖的新旧顺序',evidence:delayedText});
    db.exec('BEGIN');
    const delayedSource=memory.saveChatTurn({sessionId:'delayed-session',userText:delayedText,
      userCreatedAt:receivedAt,reply:'延迟回复',extract:false}).userMessageId;
    assert.throws(()=>delayed.commit({sourceMessageId:delayedSource}),/teaching_stale_source/);
    db.exec('ROLLBACK'); delayed.discard();
    const beforeManager=now;
    now+=100;
    audit.edit(db,countingId,{factValue:'管理修改先于延迟提交'});
    const oldInput='在管理操作之前已收到的请求',oldPlan=session(oldInput);
    oldPlan.execute('save',{topic:'条数',instruction:'不得覆盖管理修订',evidence:oldInput});
    db.exec('BEGIN');
    const oldSource=memory.saveChatTurn({sessionId,userText:oldInput,userCreatedAt:beforeManager,
      reply:'延迟回复',extract:false}).userMessageId;
    assert.throws(()=>oldPlan.commit({sourceMessageId:oldSource}),/teaching_stale_source/);
    db.exec('ROLLBACK');oldPlan.discard();
    // If the containing transaction fails after the inner savepoint released,
    // neither the chat turn nor teaching leaks; discard invalidates cached commit.
    const rollbackText='外层失败不要记住',rollback=session(rollbackText);
    rollback.execute('save',{topic:'外层回滚',instruction:'不得泄漏的教导',evidence:rollbackText});
    db.exec('BEGIN');
    rollback.commit({sourceMessageId:turn(rollbackText)});
    db.exec('ROLLBACK'); rollback.discard();
    assert.ok(!context().includes('不得泄漏的教导'));
    assert.throws(()=>rollback.commit({sourceMessageId:1}),/teaching_session_closed/);
    function addTeaching(topic,instruction) {
      const source=topic+'。'+instruction, plan=session(source);
      plan.execute('save',{topic,instruction,evidence:source});
      return finish(plan,source).result.teachings[0].id;
    }
    const oldRule='听我讲完再讨论方案。', oldTopic='疲惫时的陪伴';
    const oldId=addTeaching(oldTopic,oldRule);
    for(let i=0;i<5;i++)addTeaching('练字格式'+i,'按格子列出示范。');
    const paraphrase=context('已经彻底没电啦。',{teachingLookup:true});
    assert.ok(paraphrase.includes('#'+oldId+' '+oldTopic)&&!paraphrase.includes(oldRule),'semantic topic handle outside the four detailed rules');
    assert.ok(!context('已经彻底没电啦。').includes(oldTopic),'no unreadable handles without lookup tools');
    for(let i=5;i<105;i++)addTeaching('练字格式'+i,'按格子列出示范。');
    const lookup=session('让我缓一缓。');
    assert.ok(context('忙完很疲惫',{maxContextFacts:1}).includes(oldRule),'query ranks across the full valid archive');
    const page=lookup.execute('list',{query:'疲惫 陪伴'});
    assert.equal(page.teachings[0].id,oldId);assert.equal(page.nextOffset,null);
    assert.deepEqual(lookup.execute('list',{query:'飞机起落架'}),{teachings:[],nextOffset:null});
    const ids=[];
    let offset=0;
    do {
      const next=lookup.execute('list',{offset});
      ids.push(...next.teachings.map(t=>t.id));offset=next.nextOffset;
    } while(offset!==null);
    assert.ok(ids.indexOf(oldId)>=100 && new Set(ids).size===ids.length,'unfiltered pages reach old records once');
    audit.remove(db,oldId);
    assert.ok(!context('忙完很疲惫',{teachingLookup:true}).includes(oldTopic));
    assert.equal(lookup.execute('list',{query:'疲惫'}).teachings.length,0);
    assert.throws(()=>lookup.execute('list',{offset:-1}),/invalid_offset/);
    lookup.discard();
    assert.equal(calls,0);
    console.log('memory-teaching: PASS (staging/real evidence/shared facts+revisions/semantic catalog/revise/withdraw/management/undo/expiry/disabled/conflicts/budget; no network)');
  } finally {
    memory.closeMemory(); settings.loadSettings=oldLoad; Date.now=oldNow; global.fetch=oldFetch;
    if(oldDir===undefined) delete process.env.DAFEIYU_DATA_DIR; else process.env.DAFEIYU_DATA_DIR=oldDir;
    assert.equal(path.dirname(dir),root,'unsafe fixture cleanup');
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
