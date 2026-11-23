// Real Nianan cognition + proactive gates, isolated database and fake model only.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
async function main() {
 const tempRoot=path.resolve(__dirname,'../temp');fs.mkdirSync(tempRoot,{recursive:true});
 const temp=fs.mkdtempSync(path.join(tempRoot,'companion-test-'));
 process.env.DAFEIYU_DATA_DIR=temp;
 const originalNow=Date.now,originalRandom=Math.random,originalFetch=global.fetch;
 // The simulated three-hour window stays on one date, even if run just before midnight.
 let clock=new Date().setHours(12,0,0,0);Date.now=()=>clock;Math.random=()=>0;
 let fetchCalls=0;
 global.fetch=async()=>{fetchCalls++;return new Response(JSON.stringify({choices:[{message:{content:'[]'}}]}),{headers:{'Content-Type':'application/json'}});};
 const config={provider:'cloud',cloud:{baseUrl:'http://127.0.0.1:1/v1',apiKey:'fake-key',model:'fake'},
   ownerName:'小沐',characterName:'肥鱼',cognition:{enabled:true},
   proactive:{enabled:true,idleMinutes:60,cooldownMinutes:1,maxPerDay:5,maxUnanswered:5,quietHoursStart:0,quietHoursEnd:0},
   memory:{enabled:true,autoExtract:false,retentionDays:0},personality:{dimensions:{archetype:'gentle'}}};
 fs.writeFileSync(path.join(temp,'brain-settings.json'),JSON.stringify(config));
 const memory=require('./electron/brain/memory');const db=memory.initMemory();
 const {createCompanionRuntime,normalizeSettings}=require('./companion-runtime');
 const memoryMarker='只用于长期记忆开关的仙人掌灯';
 const published=[],observed=[];
 let busy=false;
 let respond=async()=> '[{"text":"现在想和你聊聊。","delay":0}]';
 let runtime=createCompanionRuntime({db,getSettings:()=>config,isBusy:()=>busy,getSessionId:()=> 'main',now:()=>clock,
  publishAssistant:async value=>published.push(value),model:async(settings,messages,options)=>{observed.push(messages);return respond(options);},tickMs:3600000});
 try {
  require('./electron/brain/memory-audit').upsert(db,{category:'profile',factKey:'测试收藏',factValue:memoryMarker,importance:5});
  runtime.start();
  assert.equal((await runtime.tick()).sent,false,'wait for the first desktop presence');
  assert.equal(fetchCalls,0);assert.equal(observed.length,0);assert.equal(published.length,0);
  busy=true;
  runtime.setPresence({chat_open:true,busy:false,typing:true,voice_active:false,quiet:false});
  assert.equal((await runtime.tick()).sent,false,'the desktop can start while another operation is busy');
  busy=false;
  assert.equal((await runtime.tick()).sent,false,'typing alone blocks proactive generation');
  runtime.setPresence({typing:false,voice_active:true});
  assert.equal((await runtime.tick()).sent,false,'voice activity alone blocks proactive generation');
  assert.equal(observed.length,0,'temporary gates act before the model request');
  runtime.onPlaybackDone();
  const greeting=await runtime.tick();
  assert.equal(greeting.sent,true,JSON.stringify(greeting));
  assert.equal(published.length,1);assert.equal(published[0].source,'proactive');
  assert.ok(observed[0][0].content.includes('肥鱼'));
  assert.ok(observed[0][0].content.includes(memoryMarker),'enabled memory reaches proactive generation');
  runtime.setPresence({chat_open:true,typing:false});
  assert.equal((await runtime.tick()).sent,false,'a heartbeat is not a second startup');
  const block=runtime.beforeChat({userText:'今天很开心，谢谢你陪我',sessionId:'main'});
  assert.ok(block.includes('肥鱼'));assert.ok(!block.includes('莉莉安'));
  const before=db.prepare('SELECT COUNT(*) n FROM drift_log').get().n;
  const effect=runtime.afterChat({userText:'今天很开心，谢谢你陪我',reply:'我也很开心！',emotion:'开心',sessionId:'main',channel:'qq'});
  assert.ok(effect.emotionOutputs);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM drift_log').get().n,before+1);
  assert.ok(runtime.status().cognition.emotion);
  runtime.afterChat({userText:'你是谁？我的朋友莉莉安也很好奇。',reply:'我在慢慢了解自己的性格。',emotion:'开心',sessionId:'main',channel:'qq'});
  const deadline=performance.now()+2000;
  while(db.prepare('SELECT COUNT(*) n FROM metacognition_reflections').get().n===0 && performance.now()<deadline) {
    await new Promise(resolve=>global.setTimeout(resolve,5));
  }
  assert.ok(db.prepare('SELECT COUNT(*) n FROM metacognition_reflections').get().n>0,'real background metacognition records reflection');
  assert.ok(fetchCalls>0,'background reflection uses the cancellable model adapter');
  clock+=180000;
  assert.equal((await runtime.tick()).sent,false,'proactive delivery and QQ chat do not re-arm idle');
  assert.equal(observed.length,1);
  const completePc=()=>runtime.afterChat({userText:'我先去忙一会儿。',reply:'好。',sessionId:'main',channel:'pc'});
  completePc();
  clock+=179999;
  runtime.setPresence({chat_open:true});
  assert.equal((await runtime.tick()).sent,false,'default idle opportunity is not due before three minutes');
  assert.equal(observed.length,1);
  clock++;
  respond=async()=> '[]';
  const abstained=await runtime.tick();
  assert.equal(abstained.sent,false,JSON.stringify(abstained));
  assert.equal(observed.length,2,'the legacy desktop-idle setting does not replace the new three-minute chat gap');
  assert.equal(runtime.status().todayCount,1);assert.equal(published.length,1,'empty JSON never becomes a message');
  clock+=180000;
  assert.equal((await runtime.tick()).sent,false);
  assert.equal(observed.length,2,'an abstention consumes only the opportunity, not another model request');

  let modelStarted,modelSignal;
  const modelEntered=new Promise(resolve=>{modelStarted=resolve;});
  respond=async({signal})=>{
    modelSignal=signal;modelStarted();
    return new Promise((resolve,reject)=>signal.addEventListener('abort',
      ()=>reject(new DOMException('cancelled fake reply','AbortError')),{once:true}));
  };
  completePc();clock+=180000;
  const pendingReply=runtime.tick();
  await Promise.race([modelEntered,pendingReply.then(result=>{
    throw new Error('Expected a pending generation, got '+JSON.stringify(result));
  })]);
  runtime.onChatStart({channel:'pc'});
  assert.equal(modelSignal.aborted,true,'a new chat turn cancels the in-flight model, without browsing');
  assert.equal((await pendingReply).sent,false);
  clock+=180000;
  assert.equal((await runtime.tick()).sent,false,'an interruption does not re-arm the idle event');
  assert.equal(observed.length,3);assert.equal(published.length,1);

  const independentTopic='要是月亮是个煎饼，你会从哪边咬？';
  respond=async()=> JSON.stringify([{text:independentTopic,delay:0}]);
  completePc();clock+=180000;
  const sent=await runtime.tick();assert.equal(sent.sent,true,JSON.stringify(sent));
  assert.equal(observed.length,4);assert.equal(published.length,2);
  assert.equal(published.at(-1).text,independentTopic,'ordinary proactive content comes from the model');
  clock+=180000;
  assert.equal((await runtime.tick()).sent,false,'one completed PC turn has one idle opportunity');
  assert.equal(observed.length,4);
  assert.throws(()=>normalizeSettings(config,{proactive:{maxPerDay:1000}}));
  assert.throws(()=>normalizeSettings(config,{cognition:{enabled:'yes'}}));
  await runtime.close();
  assert.equal(runtime.status().lifecycle.tasks,0);assert.equal(runtime.status().lifecycle.timers,0);
  const saved=db.prepare('SELECT state_json FROM pc_companion_state').get();assert.ok(saved);
  runtime=createCompanionRuntime({db,getSettings:()=>config,publishAssistant:async x=>published.push(x),now:()=>clock,
    model:async(settings,messages)=>{observed.push(messages);return '[{"text":"想分享一点日常。","delay":0}]';},tickMs:3600000});
  runtime.start();assert.equal(runtime.status().todayCount,2,'daily quotas persist across restart');
  assert.equal(runtime.status().unanswered,1);
  assert.ok(runtime.status().cognition.emotion,'emotion state persists');
  config.memory.enabled=false;
  runtime.setPresence({chat_open:true,quiet:false});
  const withoutMemory=await runtime.tick();assert.equal(withoutMemory.sent,true,JSON.stringify(withoutMemory));
  assert.ok(!observed.at(-1).some(message=>message.content.includes(memoryMarker)),
    'disabled memory must not leak facts into proactive model context');
  config.proactive.enabled=false;
  completePc();clock+=180000;
  assert.equal((await runtime.tick()).sent,false);
  assert.equal(observed.length,5,'disabling proactive prevents model calls');
  await runtime.close();
  // Closing while voice enrichment is pending must cancel delivery, not count it.
  config.proactive.enabled=true;
  let announcePublish,deliverySignal;
  const publishing=new Promise(resolve=>{announcePublish=resolve;});
  runtime=createCompanionRuntime({db,getSettings:()=>config,now:()=>clock,tickMs:3600000,
    model:async()=>'[{"text":"想分享一点新的小事。","delay":0}]',
    publishAssistant:async(value,{signal})=>{
      deliverySignal=signal;announcePublish();
      return new Promise((resolve,reject)=>signal.addEventListener('abort',
        ()=>reject(new DOMException('cancelled fake speech','AbortError')),{once:true}));
    }});
  runtime.start();
  runtime.setPresence({chat_open:true,quiet:false});
  const pendingDelivery=runtime.tick();
  await Promise.race([publishing,pendingDelivery.then(result=>{
    throw new Error('Expected a pending delivery, got '+JSON.stringify(result));
  })]);
  assert.equal(deliverySignal.aborted,false);
  await runtime.close();
  assert.equal(deliverySignal.aborted,true);
  assert.equal((await pendingDelivery).reason,'stopped');
  assert.equal(runtime.status().todayCount,3,'cancelled voice delivery never consumes the daily allowance');
  let quietModelCalls=0;
  runtime=createCompanionRuntime({db,getSettings:()=>config,now:()=>clock,tickMs:3600000,
    model:async()=>{quietModelCalls++;return '[]';},
    publishAssistant:async x=>published.push(x)});
  runtime.start();
  runtime.setPresence({chat_open:true,quiet:true});
  assert.equal((await runtime.tick()).reason,'quiet_hours');
  runtime.setPresence({quiet:false});
  assert.equal((await runtime.tick()).sent,false,'opening during quiet mode does not leave a surprise greeting queued');
  config.proactive.maxPerDay=3;
  completePc();clock+=180000;
  assert.equal((await runtime.tick()).reason,'daily_limit');
  assert.equal(quietModelCalls,0);
  assert.equal(published.length,3);
  await runtime.close();

  let automatic=Promise.withResolvers();
  config.proactive.maxPerDay=5;
  let automaticCalls=0;
  runtime=createCompanionRuntime({db,getSettings:()=>config,now:()=>clock,tickMs:3600000,autoTickOnPresence:true,
    model:async()=>{automaticCalls++;return '[{"text":"随时可以来聊。"}]';},
    publishAssistant:async x=>automatic.resolve(x)});
  runtime.start();
  assert.equal(automaticCalls,0);
  async function waitForAutomatic(delivery) {
    let guard;
    try {
      const result=await Promise.race([delivery,new Promise((_,reject)=>{
        guard=setTimeout(()=>reject(new Error('Desktop presence did not wake the scheduler')),1000);
      })]);
      assert.equal(result.text,'随时可以来聊。');
    } finally {clearTimeout(guard);}
  }
  runtime.setPresence({chat_open:true,quiet:false});
  await waitForAutomatic(automatic.promise);
  automatic=Promise.withResolvers();
  runtime.onChatStart({channel:'pc'});
  runtime.afterChat({channel:'pc',userText:'回来啦。',reply:'嗯。',sessionId:'main',requestId:'auto-pc'});
  const receipt={session_id:'main',request_id:'auto-pc'};
  runtime.setPresence({chat_open:true,reply_completed:receipt});
  clock+=179999;runtime.setPresence({chat_open:true,reply_completed:receipt});
  assert.equal(automaticCalls,1,'before the gap is due, heartbeat does not start a second model request');
  clock++;runtime.setPresence({chat_open:true,reply_completed:receipt});
  await waitForAutomatic(automatic.promise);
  assert.equal(automaticCalls,2);
  console.log('companion-runtime: PASS (startup, PC idle, QQ separation, abstention, quiet/typing/voice gates, cancellation, cognition, memory, restart state)');
 } finally {
  await runtime.close();memory.closeMemory();global.fetch=originalFetch;Date.now=originalNow;Math.random=originalRandom;
  if(!temp.startsWith(tempRoot+path.sep))throw new Error('Unsafe test cleanup');fs.rmSync(temp,{recursive:true,force:true});
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
