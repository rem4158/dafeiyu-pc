// Grounded memory integration: isolated SQLite and a loopback fake extraction model.
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const http=require('node:http');
async function main(){
  const temp=path.resolve(__dirname,'../temp');fs.mkdirSync(temp,{recursive:true});
  const dir=fs.mkdtempSync(path.join(temp,'memory-test-'));process.env.DAFEIYU_DATA_DIR=dir;
  let calls=0;let failOnce=false;
  const fake=http.createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;const input=JSON.parse(text);calls++;
    if(failOnce){failOnce=false;res.writeHead(502);res.end('provider-private-error');return;}
    const prompt=input.messages.at(-1).content;let output=[];
    if(prompt.includes('relationType')){
      if(prompt.includes('小明'))output=[{name:'小明',relationType:'friend',notes:'喜欢画画',evidence:'我朋友叫小明，他喜欢画画'}];
    } else if(prompt.includes('木工面试'))output=[{category:'plan',key:'面试',value:'木工面试',type:'temporary',expiresAt:'2099-01-01',evidence:'明天参加木工面试'}];
    else if(prompt.includes('北京'))output=[{category:'profile',key:'城市',value:'北京',evidence:'我住在北京'}];
    else if(prompt.includes('南京'))output=[{category:'profile',key:'城市',value:'南京',evidence:'我住在南京'}];
    else if(prompt.includes('上海'))output=[{category:'profile',key:'城市',value:'上海',evidence:'我现在住在上海'}];
    else if(prompt.includes('喜欢猫'))output=[{category:'preference',key:'喜欢',value:'猫',evidence:'我喜欢猫'},
      {category:'profile',key:'宠物',value:'狗',evidence:'我养狗'}];
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}]}));
  });
  await new Promise(resolve=>fake.listen(0,'127.0.0.1',resolve));
  const settings=require('./electron/brain/settings');
  const config={provider:'cloud',cloud:{baseUrl:`http://127.0.0.1:${fake.address().port}/v1`,apiKey:'fake',model:'fake'},
    memory:{enabled:true,autoExtract:true,retentionDays:0,maxRecentMessages:30},ownerName:'测试用户',characterName:'测试角色'};
  const originalLoad=settings.loadSettings;settings.loadSettings=()=>config;
  const memory=require('./electron/brain/memory');const audit=require('./electron/brain/memory-audit');
  const api=require('./memory-api');let db;
  try{
    db=memory.initMemory();
    async function turn(text,requestId){
      const saved=memory.saveChatTurn({sessionId:'main',userText:text,reply:'助手建议你养狗',extract:false});
      await memory.processCommittedTurn({sessionId:'main',userText:text,reply:'助手建议你养狗',userMessageId:saved.userMessageId,requestId});
      return saved.userMessageId;
    }
    const firstId=await turn('我住在北京。','city-one');
    let city=db.prepare("SELECT * FROM facts WHERE fact_key='城市' AND active=1").get();
    assert.equal(city.fact_value,'北京');assert.equal(city.source_message_id,firstId);
    const secondId=await turn('我现在住在上海。','city-two');
    city=db.prepare("SELECT * FROM facts WHERE fact_key='城市' AND active=1").get();
    assert.equal(city.fact_value,'上海');assert.equal(city.source_message_id,secondId);
    let revisions=db.prepare('SELECT * FROM memory_fact_revisions WHERE fact_id=? ORDER BY id DESC').all(city.id);
    assert.equal(JSON.parse(revisions[0].before_json).fact_value,'北京');
    const callCount=calls;await memory.processCommittedTurn({sessionId:'main',userText:'我现在住在上海。',userMessageId:secondId,requestId:'city-two'});
    assert.equal(calls,callCount,'replayed commit must not re-extract');
    await turn('我喜欢猫。','like-cat');
    assert.ok(!db.prepare("SELECT * FROM facts WHERE fact_key='宠物'").get(),'assistant-only claim is not a fact');
    await turn('我朋友叫小明，他喜欢画画。','friend');
    const person=db.prepare("SELECT * FROM user_people WHERE display_name='小明'").get();assert.ok(person);
    assert.equal(db.prepare('SELECT source_message_id FROM memory_people_sources WHERE person_id=?').get(person.id).source_message_id,
      db.prepare("SELECT id FROM messages WHERE role='user' AND content LIKE '%小明%'").get().id);
    const personEdited=await api.handle({method:'PUT',path:'/memory/people/'+person.id,body:{notes:'用户手动纠正'},db});
    assert.equal(personEdited.status,200);
    assert.equal((await api.handle({method:'POST',path:'/memory/entity-revisions/'+personEdited.body.entityRevisionId+'/undo',db})).status,200);
    assert.equal(db.prepare('SELECT notes FROM user_people WHERE id=?').get(person.id).notes,person.notes);
    const edited=await api.handle({method:'PUT',path:'/memory/facts/'+city.id,body:{factValue:'广州'},db});assert.equal(edited.status,200);
    assert.equal(memory.getUserProfile().profile.identity.city,'广州');
    const deleted=await api.handle({method:'DELETE',path:'/memory/facts/'+city.id,db});assert.equal(deleted.status,200);
    assert.equal(db.prepare('SELECT active FROM facts WHERE id=?').get(city.id).active,0);
    assert.equal((await api.handle({method:'POST',path:'/memory/revisions/'+deleted.body.revisionId+'/undo',db})).status,200);
    assert.equal((await api.handle({method:'POST',path:'/memory/revisions/'+edited.body.revisionId+'/undo',db})).status,200);
    assert.equal(db.prepare('SELECT fact_value FROM facts WHERE id=?').get(city.id).fact_value,'上海');
    const overview=await api.handle({method:'GET',path:'/memory',db});
    assert.ok(overview.body.facts.some(f=>f.source_text==='我现在住在上海。'));
    assert.ok(overview.body.revisions.length>=4);
    const newSession=require('node:crypto').randomUUID();
    const newTurn=memory.saveChatTurn({sessionId:newSession,userText:'新会话记录植物园参观计划。',reply:'好的。',extract:false});
    const lastId=db.prepare('SELECT MAX(id) AS id FROM messages WHERE session_id=?').get(newSession).id;
    memory.insertSummary(newSession,newTurn.userMessageId,lastId,'UUID 新会话的植物园参观摘要');
    memory.insertSummary('main',firstId,secondId,'主对话的城市摘要');
    const allSessions=await api.handle({method:'GET',path:'/memory',db});
    assert.equal(allSessions.status,200);
    const newSummary=allSessions.body.summaries.find(item=>item.session_id===newSession);
    assert.ok(newSummary,'new UUID chat summary must be reachable from the memory page API');
    assert.equal(newSummary.summary,'UUID 新会话的植物园参观摘要');
    assert.equal(newSummary.startMessageId,newTurn.userMessageId);
    assert.equal(newSummary.endMessageId,lastId);
    assert.ok(allSessions.body.summaries.some(item=>item.session_id==='main'));
    assert.deepEqual(allSessions.body.layers.summaries,allSessions.body.summaries);
    // Hypothetical/quoted first-person statements must not be taken as direct rules.
    assert.deepEqual(require('./electron/brain/extract').extractFromUserMessage('举例：我叫假名字').facts,[]);
    assert.deepEqual(require('./electron/brain/extract').extractFromUserMessage('你觉得我喜欢狗吗？').facts,[]);
    const priorQuestionCalls=calls;await turn('你觉得我喜欢狗吗？','question');assert.equal(calls,priorQuestionCalls);
    failOnce=true;await turn('我住在南京。','retry-city');
    assert.equal(db.prepare("SELECT state FROM memory_extraction_jobs WHERE request_id='retry-city'").get().state,'failed');
    assert.equal((await memory.resumePendingExtractions()).resumed,1);
    assert.equal(db.prepare("SELECT fact_value FROM facts WHERE fact_key='城市' AND active=1").get().fact_value,'南京');
    const realNow=Date.now;
    try {
      const receivedAt=new Date(2030,10,30,23,59).getTime();
      const nextDayEnd=new Date(2030,11,2,0,0).getTime();
      Date.now=()=>receivedAt+120000; // reply committed on a different calendar date
      const userText='我明天参加木工面试。';
      const {userMessageId}=memory.saveChatTurn({userText,reply:'好。',userCreatedAt:receivedAt,extract:false});
      failOnce=true;
      const attempt=await memory.processCommittedTurn({userText,userMessageId,requestId:'relative-retry'});
      assert.equal(attempt.complete,false);
      Date.now=()=>nextDayEnd+60000;
      assert.equal((await memory.resumePendingExtractions()).resumed,1);
      const plan=db.prepare("SELECT expires_at,updated_at FROM facts WHERE episode_topic='木工面试'").get();
      assert.equal(plan.expires_at,nextDayEnd,'deadline comes from original local calendar date, not retry time or model-proposed date');
      assert.equal(plan.updated_at,receivedAt);
      assert.equal(memory.searchFacts('木工面试').length,0);
    } finally {Date.now=realNow;}
    config.memory.autoExtract=false;
    const saved=memory.saveChatTurn({userText:'我喜欢香蕉。',reply:'好的',extract:false});
    await memory.processCommittedTurn({userText:'我喜欢香蕉。',userMessageId:saved.userMessageId,requestId:'off'});
    assert.ok(!db.prepare("SELECT * FROM facts WHERE fact_value='香蕉'").get());
    console.log('memory-alignment: PASS (per-turn source, evidence gate, profile/people, revisions, edit/delete/undo, replay, disabled)');
  }finally{
    await memory.flushPendingExtractionsOnQuit();memory.closeMemory();settings.loadSettings=originalLoad;
    fake.closeAllConnections();await new Promise(resolve=>fake.close(resolve));
    if(!dir.startsWith(temp+path.sep))throw new Error('Unsafe temp path');fs.rmSync(dir,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1});
