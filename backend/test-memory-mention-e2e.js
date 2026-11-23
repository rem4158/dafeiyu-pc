// Inspect the real service's outbound chat requests and committed message parts.
// The provider, clock, SQLite database and all sessions belong to this fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { isOrdinaryChatRequest } = require('./test-alignment-e2e');

async function main() {
  const temp = path.resolve(__dirname,'../temp');
  fs.mkdirSync(temp,{recursive:true});
  const data = fs.mkdtempSync(path.join(temp,'memory-mention-e2e-'));
  const oldDir = process.env.DAFEIYU_DATA_DIR;
  const oldNow = Date.now;
  const hour = 3600000;
  let now = new Date(2030,4,8,9,0).getTime();
  Date.now = () => now;
  process.env.DAFEIYU_DATA_DIR = data;
  const tea = '桂花乌龙茶', editedTea = '栀子红茶';
  const neutral = '知道啦。';
  const calls = [];
  let nextReply = neutral, beforeProactiveReply, failNext = false;
  const fake = http.createServer(async (req,res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const {messages} = body;
      const system = messages[0].content;
      const proactive = system.includes('【主动陪伴】');
      let output = [];
      if (isOrdinaryChatRequest(body) || proactive) {
        calls.push({messages,proactive});
        if (failNext) {
          failNext = false;
          res.writeHead(503); res.end('unavailable');
          return;
        }
        if (proactive && beforeProactiveReply) await beforeProactiveReply();
        output = nextReply === null ? [] : [{text:nextReply,delay:0}];
        nextReply = neutral;
      }
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}]}));
    } catch {
      res.writeHead(500); res.end('fixture failure');
    }
  });
  let backend;
  try {
    await new Promise((resolve,reject) => { fake.once('error',reject); fake.listen(0,'127.0.0.1',resolve); });
    const endpoint = 'http://127.0.0.1:'+fake.address().port+'/v1';
    const settings = require('./electron/brain/settings');
    settings.saveSettings({provider:'cloud',cloud:{baseUrl:endpoint,apiKey:'local-fixture',model:'test-chat'},
      memory:{enabled:true,autoExtract:true,retentionDays:0},cognition:{enabled:true},
      proactive:{enabled:true,chatGapMinutes:3,cooldownMinutes:1,maxPerDay:5,maxUnanswered:4,quietHoursStart:0,quietHoursEnd:0},
      browser:{proactive:false},
      voice:{enabled:false},stickers:{enabled:false}});
    const {createBackend} = require('./service');
    const options = {companionOptions:{now:()=>now,tickMs:hour,autoTickOnPresence:false}};
    backend = await createBackend(options);
    async function request(method,route,body,wanted=200) {
      const res = await fetch(backend.descriptor.url+route,{method,
        headers:{Authorization:'Bearer '+backend.descriptor.token,'Content-Type':'application/json'},
        body:body===undefined?undefined:JSON.stringify(body)});
      const result = await res.json();
      if (wanted===200) assert.ok(res.ok,method+' '+route+': '+res.status);
      else assert.equal(res.status,wanted,route);
      return result;
    }
    let seq = 0;
    const session = async () => (await request('POST','/sessions',{})).session_id;
    async function chat(text,reply=neutral,{wantFailure=false,sid}={}) {
      const input = {session_id:sid || await session(),request_id:'mention-'+(++seq),text};
      nextReply = reply;
      if (wantFailure) failNext = true;
      const start = calls.length;
      const result = await request('POST','/chat',input,wantFailure?502:200);
      const seen = calls.slice(start).filter(c => !c.proactive && c.messages.at(-1).content === text);
      assert.equal(seen.length,1,'actual chat provider received this turn');
      return {input,result,prompt:seen[0].messages.slice(0,-1).map(m=>m.content).join('\n')};
    }
    async function background() {
      return (await chat('讲个短故事吧。')).prompt;
    }
    const evidence = async () => {
      const v = await request('GET','/memory');
      const fact = v.facts.find(f=>f.fact_value===tea && f.active===1);
      return {fact,revisions:v.revisions.filter(r=>r.fact_id===fact.id)};
    };
    async function proactive(reply,expected='sent') {
      const sid = await session();
      const {input} = await chat('等我一下。',neutral,{sid});
      const presence = (fields) => request('POST','/companion/presence',{session_id:sid,...fields});
      await presence({quiet:false,busy:false,chat_open:true,typing:false,voice_active:false,
        reply_completed:{session_id:sid,request_id:input.request_id}});
      now += 3*60000;
      const before = calls.length;
      nextReply = reply;
      if (expected==='blocked') beforeProactiveReply = () => presence({typing:true});
      let decision;
      try { decision=await backend.companion.tick(); }
      finally { beforeProactiveReply=undefined; }
      assert.equal(decision.sent,expected==='sent',JSON.stringify(decision));
      const seen = calls.slice(before).filter(c=>c.proactive);
      assert.equal(seen.length,1,'actual proactive provider received this turn');
      const events = (await request('GET','/events?after=0')).events.filter(e=>e.session_id===sid);
      assert.equal(events.length,expected==='sent'?1:0,'generated text counts only after publication');
      if (expected==='sent') assert.ok(events[0].messages.some(m=>m.parts.some(p=>p.type==='plain' && p.text===reply)));
      await presence({typing:false});
      return seen[0].messages.slice(0,-1).map(m=>m.content).join('\n');
    }

    const source = '我喜欢'+tea+'。';
    await chat(source);
    const original = await evidence();
    assert.equal(original.fact.source_text,source);
    assert.ok((await background()).includes(tea),'first fresh chat sees the preference');
    assert.ok((await background()).includes(tea),'unused prompt evidence remains available');
    await chat('换个小故事吧。',neutral,{wantFailure:true});
    assert.ok((await background()).includes(tea),'failed model calls do not start a cooldown');
    assert.ok((await proactive('你喜欢'+tea+'。','blocked')).includes(tea),'generated but unpublished proactive saw the available fact');
    assert.ok((await background()).includes(tea),'the discarded proactive reply did not mark it mentioned');
    const said = await chat('窗外起风了。','记得你喜欢'+tea+'。');
    assert.ok(said.prompt.includes(tea));
    assert.ok(said.result.messages[0].parts.some(p=>p.type==='plain' && p.text.includes(tea)),
      'this memory was in the customer-visible reply');
    const ordinaryMentionAt = now;
    assert.ok(!(await background()).includes(tea),'delivered fact must cool in a fresh ordinary chat, including the profile');
    assert.ok((await chat('我喜欢哪种茶？')).prompt.includes(tea),'a direct question retrieves the cooled preference');
    assert.ok(!(await proactive(null,'abstained')).includes(tea),'the cooled fact is omitted even if the model then decides to stay quiet');
    const callsAfterAbstention=calls.length;
    const immediateRetry=await backend.companion.tick();
    assert.equal(immediateRetry.sent,false,'an abstention is not regenerated on the next tick');
    assert.equal(calls.length,callsAfterAbstention,'a completed opportunity does not make another provider call');
    assert.ok(!(await proactive('看看窗外的云。')).includes(tea),'cooldown reaches a real proactive request');
    assert.deepEqual(await evidence(),original,'mentioning does not reinforce the fact or alter evidence and revisions');

    now = ordinaryMentionAt+47*hour;
    await backend.close(); backend=await createBackend(options);
    const beforeReplay=calls.length;
    assert.deepEqual(await request('POST','/chat',said.input),said.result);
    assert.equal(calls.length,beforeReplay,'same request replay returns the recorded reply');
    assert.ok(!(await background()).includes(tea),'cooldown survives restart');
    now = ordinaryMentionAt+48*hour+1;
    assert.ok((await background()).includes(tea),'a replay did not extend the 48-hour cooldown');
    assert.ok((await proactive('今天想起你喜欢'+tea+'。')).includes(tea));
    assert.ok(!(await background()).includes(tea),'a delivered proactive mention also cools ordinary chat');
    await request('PUT','/memory/facts/'+original.fact.id,{factKey:'喜欢：'+editedTea,factValue:editedTea});
    const corrected = await background();
    assert.ok(corrected.includes(editedTea) && !corrected.includes(tea),'a correction immediately supersedes the cooled version');
    await request('PUT','/settings',{memory:{enabled:false}});
    const off=await chat('给我讲一件好玩的事。','你喜欢'+editedTea+'。');
    assert.ok(!off.prompt.includes(editedTea),'long-term memory was off for this reply');
    await request('PUT','/settings',{memory:{enabled:true}});
    assert.ok((await background()).includes(editedTea),'a reply with memory off did not start a cooldown');

    const topic='木雕面试';
    await chat('我明天要参加'+topic+'。',neutral);
    now += hour;
    assert.ok((await proactive('祝你的'+topic+'顺利。')).includes(topic),
      'the one upcoming plan is available for a first proactive follow-up and its reply is published');
    now += hour;
    assert.ok(!(await proactive('窗外的树叶在晃呢。')).includes(topic),
      'a later proactive no longer receives the same upcoming plan');
    assert.ok(!(await chat('我回来了。')).prompt.includes(topic),
      'a greeting leaves the just-mentioned unfinished episode out of the model input');
    assert.ok((await chat('接着聊上次那件事吧。')).prompt.includes(topic),
      'an explicit continuation can pick the one unfinished episode even during cooldown');
    assert.ok((await chat('我的木雕面试原先怎么安排的？')).prompt.includes(topic),
      'explicitly revisiting an episode still brings back its current state');
    const secondTea='薄荷茉莉茶';
    await chat('我喜欢'+secondTea+'。','记得了，你喜欢'+secondTea+'。');
    assert.ok(!(await background()).includes(secondTea),'the first reply acknowledging a just-extracted preference also counts');
    assert.ok((await chat('我喜欢薄荷茉莉茶吗？')).prompt.includes(secondTea));
    console.log('memory-mention-e2e: PASS (delivered vs offered, ordinary/proactive, publication gate, explicit recall, new evidence, restart, replay, expiry, edit and memory switch; actual loopback HTTP)');
  } finally {
    try {if (backend) await backend.close();}
    finally {
      if (fake.listening) {fake.closeAllConnections();await new Promise(resolve=>fake.close(resolve));}
      Date.now=oldNow;
      if (oldDir===undefined) delete process.env.DAFEIYU_DATA_DIR; else process.env.DAFEIYU_DATA_DIR=oldDir;
      assert.equal(path.dirname(data),temp);
      fs.rmSync(data,{recursive:true,force:true});
    }
  }
}
main().catch(err=>{console.error(err);process.exitCode=1;});
