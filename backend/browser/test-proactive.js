'use strict';
// Real idle scheduler, provider tool loop and browser dispatch. Fake fetch and browser engine.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const temp = fs.realpathSync.native(path.join(__dirname, '../../temp'));
const dir = fs.mkdtempSync(path.join(temp, 'browser-proactive-'));
process.env.DAFEIYU_DATA_DIR = dir;
const memory = require('../electron/brain/memory');
const ledger = require('../usage-ledger');
const { createCompanionRuntime } = require('../companion-runtime');
const { createBrowserTurn } = require('./turn');

async function main() {
  const originalFetch = global.fetch, originalNow = Date.now, originalRandom = Math.random;
  let clock = new Date().setHours(10,0,0,0);
  Date.now = () => clock; Math.random = () => 0;
  const settings = { provider:'cloud',cloud:{baseUrl:'https://fixture.invalid/v1',model:'fixture',apiKey:'fake'},
    cognition:{enabled:true},memory:{enabled:false},browser:{enabled:true,proactive:true},
    proactive:{enabled:true,chatGapMinutes:3,cooldownMinutes:1,maxPerDay:3,maxUnanswered:3,quietHoursStart:0,quietHoursEnd:0} };
  const db = memory.initMemory(), published = [], browserCalls = [], bodies = [];
  let mode = 'send', notifyRead;
  const source = 'https://tieba.baidu.com/p/12345';
  const engine = { async browse(input,options) {
    browserCalls.push(input);
    assert.equal(options.requestCode,undefined); assert.equal(options.onManualChallenge,undefined);
    assert.equal(options.getCredentials,undefined);
    if (mode === 'hold') {
      notifyRead();
      return new Promise((_resolve,reject) => options.signal.addEventListener('abort',
        () => reject(new DOMException('cancelled','AbortError')),{once:true}));
    }
    return {ok:true,result:{source_url:source,text:'隔离观察记录',links:[],images:[]}};
  } };
  const runtime = createCompanionRuntime({ db, getSettings:()=>settings, now:()=>clock, tickMs:3600000,
    publishAssistant:async result=>published.push(result),
    createBrowserTurn:({signal})=>createBrowserTurn({engine,getSettings:()=>settings,signal,proactive:true})
  });
  function eligible() {
    runtime.afterChat({channel:'pc',userText:'我先忙一会儿。',reply:'好。',sessionId:'main'});
    clock += 180000;
  }
  global.fetch = async(url,init) => {
    assert.equal(url,'https://fixture.invalid/v1/chat/completions');
    const body = JSON.parse(init.body); bodies.push(body);
    const calls = body.tools?.length && body.messages.at(-1).role!=='tool';
    let text = '一起聊点日常。';
    if (body.messages.at(-1).role==='tool') {
      const page = JSON.parse(body.messages.at(-1).content);
      text = page.result.text+' '+page.result.source_url;
    }
    const message = calls ? {role:'assistant',content:null,tool_calls:[{id:'private_read',type:'function',
      function:{name:'browser_read_page',arguments:JSON.stringify({url:source})}}]} : {role:'assistant',content:text};
    return new Response(JSON.stringify({ choices:[{message,finish_reason:calls?'tool_calls':'stop'}],
      usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12} }),{headers:{'Content-Type':'application/json'}});
  };
  try {
    ledger.enableUsageLedger(); runtime.start(); assert.equal((await runtime.tick()).sent,false);
    runtime.setPresence({quiet:true,chat_open:true}); assert.equal((await runtime.tick()).reason,'quiet_hours');
    eligible(); runtime.setPresence({quiet:false,typing:true}); assert.equal((await runtime.tick()).sent,false);
    assert.equal(bodies.length,0); assert.equal(browserCalls.length,0); runtime.setPresence({typing:false});
    const sent = await runtime.tick();
    assert.equal(sent.sent,true,JSON.stringify(sent)); assert.ok(sent.text.includes(source));
    assert.equal(browserCalls.length,1); assert.equal(bodies.length,2); assert.equal(published.length,1);
    assert.ok(bodies[0].messages[0].content.includes('兴趣'));
    assert.ok(bodies[0].tools.every(tool=>tool.function.name.startsWith('browser_')));
    assert.equal(ledger.getUsageSummary(settings).today.by_purpose.proactive.total_tokens,24);
    assert.equal((await runtime.tick()).sent,false);
    assert.equal(bodies.length,2);
    mode='hold'; eligible();
    const read=new Promise(resolve=>{notifyRead=resolve;});
    const pending=runtime.tick();
    await Promise.race([read,pending.then(result=>{throw new Error('Expected a pending read: '+JSON.stringify(result));})]);
    runtime.onChatStart({channel:'pc'});
    const stopped=await pending;
    assert.equal(stopped.sent,false); assert.equal(bodies.length,3); assert.equal(published.length,1);
    assert.equal(runtime.status().todayCount,1);
    mode='send'; eligible(); settings.browser.proactive=false;
    const ordinary=await runtime.tick();
    assert.equal(ordinary.sent,true,JSON.stringify(ordinary)); assert.equal(browserCalls.length,2);
    assert.equal(bodies.at(-1).tools,undefined,'disabled idle browsing still permits ordinary proactive chat');
    console.log('browser-proactive: PASS (actual gated native tool loop, sourced result, same task usage, no background auth, user interruption, browser-off fallback)');
  } finally {
    await runtime.close(); memory.closeMemory(); ledger.closeUsageLedger();
    global.fetch=originalFetch; Date.now=originalNow; Math.random=originalRandom;
    const target=fs.realpathSync.native(dir);
    assert.equal(path.dirname(target),temp); assert.match(path.basename(target),/^browser-proactive-[a-zA-Z0-9]{6}$/);
    fs.rmSync(target,{recursive:true,maxRetries:5});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
