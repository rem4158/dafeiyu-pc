// Whole local stack, isolated SQLite/media and loopback fake providers only.
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const http=require('node:http');
function wave(){const b=Buffer.alloc(3244);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(3200,40);return b;}
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAANklEQVR4nGMM2PLsPwMNARMtDQeBUQsIgtEgIghGg4ggGA0igmA0iAiC0SAiCEaDiCCgeRABAFNfAxnx/9kmAAAAAElFTkSuQmCC','base64');
// Ordinary turns expose the usage tool; background browsing and extraction do not.
function isOrdinaryChatRequest(body) {
 return body.messages?.[0]?.role === 'system' && body.messages.at(-1)?.role === 'user'
   && body.tools?.some(tool => tool.function?.name === 'usage_status');
}
async function startFixture(base){
 const tempRoot=path.resolve(__dirname,'../temp');fs.mkdirSync(tempRoot,{recursive:true});
 base=base||fs.mkdtempSync(path.join(tempRoot,'alignment-e2e-'));
 if(!path.resolve(base).startsWith(tempRoot+path.sep))throw new Error('Fixture must be inside project temp');
 const appRoot=path.join(base,'app');const data=path.join(appRoot,'data');fs.mkdirSync(data,{recursive:true});process.env.DAFEIYU_DATA_DIR=data;
 let clock=Date.now();const calls=[];const audio=wave();
 let proactiveText='今天有没有听到好听的歌？[表情:开心]';
 const fake=http.createServer(async(req,res)=>{try{
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);calls.push(body);
  const content=body.messages?.[0]?.content;const last=body.messages?.at(-1)?.content||'';
  let answer;
  if(Array.isArray(content))answer={choices:[{message:{content:'这是端到端识别文字'}}]};
  else if(body.model?.includes('tts')||body.audio)answer={choices:[{message:{audio:{data:audio.toString('base64')}}}]};
  else if(String(content).includes('记忆提取助手'))answer={choices:[{message:{content:JSON.stringify(String(last).includes('我住在北京')?[{category:'profile',key:'城市',value:'北京',evidence:'我住在北京'}]:[])}}]};
  else if(String(content).includes('人物关系提取助手'))answer={choices:[{message:{content:'[]'}}]};
  else answer={choices:[{message:{content:JSON.stringify(last==='还记得我住哪里吗？'?[{text:'你住在北京。',delay:0}]:[{text:'已经记住啦。',delay:0},{sticker:'happy',delay:0},{text:'今天也很开心。[表情:开心]',delay:0}])}}]};
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(answer));
 }catch(e){res.writeHead(500);res.end(JSON.stringify({error:'fake fixture failure'}));}});
 await new Promise(r=>fake.listen(0,'127.0.0.1',r));
 const packRoot=path.join(base,'memes');const pack=path.join(packRoot,'packs','e2e-pack');fs.mkdirSync(path.join(pack,'memes','happy'),{recursive:true});
 fs.writeFileSync(path.join(packRoot,'selection_rules.json'),JSON.stringify({rules:[{scope:'default',pack_ids:['e2e-pack']}]}));
 fs.writeFileSync(path.join(pack,'manifest.json'),JSON.stringify({name:'Isolated test pack',categories:{happy:{description:'开心'}}}));
 fs.writeFileSync(path.join(pack,'memes','happy','one.png'),PNG);
 const installed=require('./stickers').summary({stickers:{enabled:true,sourceRoot:packRoot}});
 assert.equal(installed.count,1);assert.equal(installed.packs[0].id,'e2e-pack');
 const settings=require('./electron/brain/settings');const url=`http://127.0.0.1:${fake.address().port}/v1`;
 settings.saveSettings({provider:'cloud',ownerName:'测试用户',characterName:'大肥鱼',systemPrompt:'你是大肥鱼，忠实于真实用户消息。',
  cloud:{baseUrl:url,apiKey:'fake-only',model:'fake-chat'},memory:{enabled:true,autoExtract:true,retentionDays:0,maxRecentMessages:30,tokenBudget:800},
  cognition:{enabled:true},proactive:{enabled:true,chatGapMinutes:3,cooldownMinutes:1,maxPerDay:2,maxUnanswered:2,quietHoursStart:0,quietHoursEnd:0},
  voice:{enabled:true,autoSpeak:true,autoSend:false,ttsFormat:'wav',ttsMode:'preset'},tts:{provider:'mimo',baseUrl:url,apiKey:'fake-only',models:{preset:'fake-tts',asr:'fake-asr'}},
  stickers:{enabled:true,sourceRoot:packRoot}});
 const {createBackend}=require('./service');const options={now:()=>clock,tickMs:3600000,autoTickOnPresence:false,
  model:async()=>JSON.stringify([{text:proactiveText,delay:0}])};
 let backend=await createBackend({companionOptions:options});
 async function api(method,route,body){const res=await fetch(backend.descriptor.url+route,{method,headers:{Authorization:'Bearer '+backend.descriptor.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await res.json();assert.ok(res.ok,`${method} ${route}: ${res.status} ${JSON.stringify(result)}`);return result;}
 return {base,appRoot,data,calls,audio,PNG,installed,api,get backend(){return backend;},advance(ms){clock+=ms;},
  setProactiveText(text){proactiveText=text;},
  async restart(){await backend.close();backend=await createBackend({companionOptions:options});},
  async close(){await backend?.close();fake.closeAllConnections();await new Promise(r=>fake.close(r));},
  cleanup(){if(!path.resolve(base).startsWith(tempRoot+path.sep))throw new Error('Unsafe fixture cleanup');fs.rmSync(base,{recursive:true,force:true});}};
}
async function main(){
 const f=await startFixture(process.argv[2]==='--serve'?process.argv[3]:undefined);
 if(process.argv[2]==='--serve'){
  fs.writeFileSync(path.join(f.base,'ready.json'),JSON.stringify({appRoot:f.appRoot,descriptor:f.backend.descriptor}));
  const lines=require('node:readline').createInterface({input:process.stdin});
  await new Promise(resolve=>{
   let serial=Promise.resolve();
   lines.on('line',line=>{serial=serial.then(async()=>{
    if(line==='close'){resolve();return;}
    if(line==='tick'){
     f.advance(180000);const result=await f.backend.companion.tick();
     fs.writeFileSync(path.join(f.base,'tick.json'),JSON.stringify(result));
    }
   }).catch(error=>{fs.writeFileSync(path.join(f.base,'tick.json'),JSON.stringify({error:error.message}));});});
   lines.once('close',()=>serial.finally(resolve));process.once('SIGTERM',resolve);
  });lines.close();await f.close();return;
 }
 try{
  const memory=require('./electron/brain/memory');const db=memory.initMemory();
  const driftBefore=db.prepare('SELECT COUNT(*) n FROM drift_log').get().n;
  const stateBefore=(await f.api('GET','/companion/status')).cognition;
  const userMessage='我住在北京。今天很开心，谢谢你陪我。请发条语音。';
  const first=await f.api('POST','/chat',{session_id:'main',request_id:'e2e-first',text:userMessage});
  assert.equal(first.messages.length,3);assert.equal(first.emotion,'开心');
  const voice=first.messages[0].parts.find(p=>p.type==='record');const sticker=first.messages[1].parts.find(p=>p.type==='image');
  assert.ok(voice&&sticker,'actual chat/parser must enrich voice and image-only segments');
  assert.equal(first.messages.flatMap(message=>message.parts).filter(part=>part.type==='record').length,1,'one turn synthesizes at most one voice segment');
  assert.equal(voice.transcript,first.messages[0].text);
  assert.deepEqual(Buffer.from((await f.api('GET','/media/'+voice.attachment_id)).data,'base64'),f.audio);
  assert.deepEqual(Buffer.from((await f.api('GET','/media/'+sticker.attachment_id)).data,'base64'),f.PNG);
  const memoryView=await f.api('GET','/memory');const city=memoryView.facts.find(x=>x.fact_key==='城市'&&x.active===1);
  assert.equal(city.fact_value,'北京');assert.equal(city.source_text,userMessage);
  assert.equal(db.prepare('SELECT role FROM messages WHERE id=?').get(city.source_message_id).role,'user');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM drift_log').get().n,driftBefore+1,'committed chat updates original cognition');
  const stateAfter=(await f.api('GET','/companion/status')).cognition;
  assert.notDeepEqual(stateAfter.emotion,stateBefore.emotion,'real emotion vector changes from dialogue');
  await f.api('POST','/chat',{session_id:'main',request_id:'e2e-second',text:'还记得我住哪里吗？'});
  const call=f.calls.find(x=>isOrdinaryChatRequest(x) && x.messages.at(-1).content==='还记得我住哪里吗？');
  assert.match(call.messages[0].content,/【当前情绪】[^\n]+\n【依恋状态】[^\n]+/);
  assert.ok(!call.messages[0].content.includes('【身份锚点】'), 'ordinary chat receives state only');
  assert.ok(call.messages[0].content.includes('北京'),'next turn prompt recalls saved fact');
  const asr=await f.api('POST','/voice/asr',{audio:f.audio.toString('base64'),mime:'audio/wav'});assert.equal(asr.text,'这是端到端识别文字');
  const history=await f.api('GET','/sessions/main');assert.equal(history.history.length,6);
  assert.ok(history.history[1].content.message.some(p=>p.type==='record'&&p.attachment_id===voice.attachment_id));
  assert.ok(history.history[2].content.message.some(p=>p.type==='image'&&p.attachment_id===sticker.attachment_id));
  const presence = fields => f.api('POST','/companion/presence',{session_id:'main',chat_open:true,busy:false,typing:false,voice_active:false,quiet:false,...fields});
  f.advance(180000);await presence({});
  assert.equal((await f.backend.companion.tick()).sent,false,'the HTTP response is not yet a displayed reply');
  await presence({reply_completed:{session_id:'main',request_id:'e2e-first'}});f.advance(180000);
  assert.equal((await f.backend.companion.tick()).sent,false,'a stale reply receipt cannot re-arm the previous turn');
  await presence({reply_completed:{session_id:'main',request_id:'e2e-second'}});
  f.advance(179999);
  assert.equal((await f.backend.companion.tick()).sent,false,'idle is timed from the desktop receipt');
  f.advance(1);await presence({quiet:true});
  assert.equal((await f.backend.companion.tick()).reason,'quiet_hours');
  await presence({});
  f.setProactiveText('想起刚才你说住在北京，希望你今天过得愉快。[表情:开心]');
  const sent=await f.backend.companion.tick();
  assert.equal(sent.sent,true,JSON.stringify(sent));
  const events=await f.api('GET','/events?after=0');assert.equal(events.events.length,1);assert.equal(events.events[0].source,'proactive');
  assert.ok(events.events[0].messages[0].text.includes('北京'),'the model reply is not vetoed by a repeated fact');
  assert.equal(events.events[0].session_id,'main');assert.ok(!events.events[0].messages[0].parts.some(p=>p.type==='record'),'proactive delivery shares the same voice cooldown');
  assert.equal((await f.api('GET','/events?after='+events.cursor)).events.length,0);
  await presence({reply_completed:{session_id:'main',request_id:'e2e-second'}});f.advance(180000);
  assert.equal((await f.backend.companion.tick()).sent,false,'resending a receipt does not schedule the same opportunity twice');
  const countBeforeRestart=f.calls.length;await f.restart();assert.equal(f.calls.length,countBeforeRestart,'restart does not call any model');
  assert.deepEqual(await f.api('POST','/chat',{session_id:'main',request_id:'e2e-first',text:userMessage}),first,'request/media replay persists');
  assert.equal((await f.api('GET','/events?after=0')).events[0].id,events.events[0].id);
  assert.equal((await f.api('GET','/companion/status')).todayCount,1);
  assert.equal((await f.api('GET','/memory')).facts.find(x=>x.fact_key==='城市'&&x.active===1).fact_value,'北京');
  assert.deepEqual(Buffer.from((await f.api('GET','/media/'+voice.attachment_id)).data,'base64'),f.audio);
  assert.equal((await f.api('GET','/sessions/main')).history.length,7);
  console.log('alignment-e2e: PASS (actual HTTP chat, sourced memory recall, mixed voice/sticker persistence, ASR, cognition change, proactive event cursor, restart)');
 }finally{await f.close();f.cleanup();}
}
module.exports={startFixture,isOrdinaryChatRequest};
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
