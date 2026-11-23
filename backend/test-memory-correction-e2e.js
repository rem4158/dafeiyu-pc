// Verify what the PC actually sends to a provider when a returning user has
// two old residence keys, moves again and later withdraws a preference.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { isOrdinaryChatRequest } = require('./test-alignment-e2e');

async function main() {
  const temp=path.resolve(__dirname,'../temp');
  fs.mkdirSync(temp,{recursive:true});
  const dir=fs.mkdtempSync(path.join(temp,'memory-correction-e2e-'));
  const originalDir=process.env.DAFEIYU_DATA_DIR, originalNow=Date.now;
  let now=new Date(2031,5,4,10,0).getTime();
  Date.now=()=>now;
  process.env.DAFEIYU_DATA_DIR=dir;
  const calls=[], neutral='收到啦。';
  let answer=neutral;
  const originalCity='柳州', previousCity='昆明', newCity='苏州';
  const oldStatement='我住在柳州。桌上有青釉书签。';
  const legacyStatement='我的现居地是昆明。';
  const move='我现在住在苏州。';
  const cityCandidates=new Map([
    [oldStatement,{key:'城市',value:originalCity,evidence:'我住在柳州',importance:5}],
    [move,{key:'常住地',value:newCity,evidence:'我现在住在苏州',importance:4}],
  ]);
  const fake=http.createServer(async(req,res)=>{
    try {
      let raw='';for await(const chunk of req) raw+=chunk;
      const body=JSON.parse(raw);
      const {messages}=body;
      const system=messages[0].content, user=messages.at(-1).content;
      let output=[];
      if (system.includes('记忆提取助手')) {
        for(const [statement,candidate] of cityCandidates) {
          if(user.includes('用户: '+statement)) output=[{category:'profile',...candidate}];
        }
      } else if (isOrdinaryChatRequest(body) || system.includes('【主动陪伴】')) {
        calls.push(messages);output=[{text:answer,delay:0}];answer=neutral;
      }
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}]}));
    } catch {
      res.writeHead(500);res.end('fixture request failed');
    }
  });
  let backend;
  try {
    await new Promise((resolve,reject)=>{fake.once('error',reject);fake.listen(0,'127.0.0.1',resolve);});
    const settings=require('./electron/brain/settings');
    settings.saveSettings({provider:'cloud',cloud:{baseUrl:'http://127.0.0.1:'+fake.address().port+'/v1',apiKey:'fixture',model:'test'},
      memory:{enabled:true,autoExtract:true,retentionDays:0,maxRecentMessages:45},cognition:{enabled:true},
      proactive:{enabled:true,chatGapMinutes:3,cooldownMinutes:1,maxPerDay:3,maxUnanswered:3,quietHoursStart:0,quietHoursEnd:0},
      voice:{enabled:false},stickers:{enabled:false}});
    const {createBackend}=require('./service');
    const options={companionOptions:{now:()=>now,tickMs:3600000,autoTickOnPresence:false}};
    backend=await createBackend(options);
    async function api(method,route,body) {
      const res=await fetch(backend.descriptor.url+route,{method,headers:{
        Authorization:'Bearer '+backend.descriptor.token,'Content-Type':'application/json'},
        body:body===undefined?undefined:JSON.stringify(body)});
      const result=await res.json();assert.ok(res.ok,method+' '+route+' '+res.status);return result;
    }
    const fresh=async()=>(await api('POST','/sessions',{})).session_id;
    const view=()=>api('GET','/memory');
    const undo=id=>api('POST','/memory/revisions/'+id+'/undo',{});
    let seq=0;
    async function chat(text,sid) {
      now+=1000;
      const before=calls.length;
      await api('POST','/chat',{session_id:sid||await fresh(),request_id:'correction-'+(++seq),text});
      assert.equal(calls.length,before+1);
      assert.equal(calls[before].at(-1).content,text);
      return calls[before].slice(0,-1);
    }
    function expect(messages,present,absent) {
      const prompt=messages.map(m=>m.content).join('\n');
      for (const s of present) assert.ok(prompt.includes(s),'expected in transmitted prompt: '+s);
      for (const s of absent) assert.ok(!prompt.includes(s),'obsolete in transmitted prompt: '+s);
    }
    const history=await fresh(), memory=require('./electron/brain/memory');
    const oldTea='桂花乌龙茶',newTea='栀子红茶';
    await chat('我平时喜欢喝'+oldTea+'。',history);
    const correction='我不再喜欢喝'+oldTea+'了，现在喜欢'+newTea+'。';
    await chat(correction,history);
    const corrected=await view();
    assert.ok(corrected.facts.some(f=>f.active && f.fact_value===newTea && f.source_text===correction));
    assert.ok(!corrected.facts.some(f=>f.active && f.fact_value.includes(oldTea)));
    expect(await chat('我偏爱哪种茶？'),[newTea],[oldTea]);
    expect(await chat('我不喜欢哪种茶？'),[],[oldTea,newTea]);
    const withdrawn=corrected.revisions.find(r=>r.operation==='retract' && r.evidence.includes(oldTea));
    assert.ok(withdrawn,'the explicit withdrawal has a sourced revision');
    await undo(withdrawn.id);
    expect(await chat('我喜欢哪种茶？'),[oldTea,newTea],[]);
    expect(await chat('我偏爱哪种茶？',history),[oldTea,newTea],[correction,'不再喜欢喝'+oldTea]);

    await chat(oldStatement,history);
    const first=(await view()).facts.find(f=>f.active && f.fact_value===originalCity);
    assert.ok(first,'first residence reached the archive from the HTTP turn');
    assert.equal(first.source_text,oldStatement);
    memory.insertSummary(history,first.source_message_id,first.source_message_id,'用户原话：'+oldStatement);
    // Simulate an old installation without mention metadata: this actual
    // assistant reply was sent while long-term memory was disabled.
    await api('PUT','/settings',{memory:{enabled:false}});
    answer='你说你住在柳州。';await chat('再和我说一句吧。',history);
    await api('PUT','/settings',{memory:{enabled:true}});
    const before=await chat('讲一个小故事。',history);
    expect(before,[originalCity,'用户原话：'+oldStatement],[]);
    assert.ok(before.some(m=>m.role==='assistant' && m.content.includes(originalCity)));

    // Old releases stored both independently. Bypass current write-side
    // unification only here. Both sources and the independent turn are real
    // HTTP chat rows; the older value is intentionally more important.
    await chat(legacyStatement,history);
    const db=memory.initMemory();
    const legacySource=db.prepare('SELECT id,created_at FROM messages WHERE session_id=? AND role=? AND content=?')
      .get(history,'user',legacyStatement);
    const inserted=db.prepare('INSERT INTO facts(category,fact_key,fact_value,importance,source_message_id,active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)')
      .run('profile','现居地',previousCity,4,legacySource.id,legacySource.created_at,legacySource.created_at);
    const duplicateId=Number(inserted.lastInsertRowid);
    const independent='窗边的植物今天发芽了。';
    await chat(independent,history);
    await backend.close();backend=await createBackend(options);

    expect(await chat('我平时住哪儿？'),[previousCity],[originalCity]);
    expect(await chat('聊个小故事吧。'),[previousCity],[originalCity]);
    const live=await chat('接着聊聊。',history);
    expect(live,[previousCity,independent],[originalCity,'青釉书签']);
    await api('POST','/companion/presence',{session_id:history,quiet:false,chat_open:true,busy:false,voice_active:false,
      reply_completed:{session_id:history,request_id:'correction-'+seq}});
    now+=180000;
    const count=calls.length;
    assert.ok((await backend.companion.tick()).sent);
    assert.equal(calls.length,count+1);
    assert.ok(calls[count][0].content.includes('【主动陪伴】'));
    expect(calls[count],[previousCity],[originalCity,'青釉书签']);

    const edited=await api('PUT','/memory/facts/'+duplicateId,{factValue:'泉州'});
    expect(await chat('我现在住在哪？',history),['泉州'],[originalCity,previousCity,'青釉书签']);
    await undo(edited.revisionId);
    expect(await chat('我住在哪儿？'),[previousCity],[originalCity,'泉州']);
    const deletion=await api('DELETE','/memory/facts/'+duplicateId,{});
    expect(await chat('我住在哪里？',history),[],[previousCity,originalCity,'青釉书签']);
    await undo(deletion.revisionId);
    expect(await chat('我住在哪里？'),[previousCity],[originalCity]);
    await chat(move,history);
    const afterMove=await view();
    const moved=afterMove.facts.find(f=>f.active && f.fact_value===newCity);
    assert.ok(moved,'the new residence was extracted from the move');
    assert.equal(moved.source_text,move);
    expect(await chat('我的常住地在哪？',history),[newCity],[originalCity,previousCity,'青釉书签']);
    expect(await chat('咱们聊点轻松的。'),[newCity],[originalCity,previousCity]);
    const revision=afterMove.revisions.find(r=>r.fact_id===moved.id && r.source_message_id===moved.source_message_id);
    assert.ok(revision,'the move is linked to its actual new source');
    await undo(revision.id);
    expect(await chat('我的常住地在哪？',history),[previousCity],[originalCity,newCity,'青釉书签']);
    expect(await chat('咱们聊点轻松的。'),[previousCity],[originalCity,newCity]);
    assert.equal(moved.fact_key,'城市','new sourced residence uses the canonical field');
    const archive=JSON.stringify((await api('GET','/sessions/'+history)).history);
    for(const statement of [oldStatement,legacyStatement,move]) assert.ok(archive.includes(statement));

    console.log('memory-correction-e2e: PASS (legacy residence aliases, prompt/profile/history/proactive, delete/undo, committed new address and neutral preference withdrawal; actual loopback HTTP)');
  } finally {
    try {if(backend) await backend.close();}
    finally {
      if(fake.listening){fake.closeAllConnections();await new Promise(r=>fake.close(r));}
      Date.now=originalNow;
      if(originalDir===undefined) delete process.env.DAFEIYU_DATA_DIR;else process.env.DAFEIYU_DATA_DIR=originalDir;
      assert.equal(path.dirname(dir),temp);fs.rmSync(dir,{recursive:true,force:true});
    }
  }
}
main().catch(err=>{console.error(err);process.exitCode=1;});
