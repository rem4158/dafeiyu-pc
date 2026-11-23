'use strict';

// Authenticated local HTTP, the real model tool loop and SQLite ledger.
// Browser pages are offline fixtures and every model response is in memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { sites } = require('./browser/sites');

const xhsPost = 'https://www.xiaohongshu.com/explore/650000000000000000000001';
const xhsFollowup = 'https://www.xiaohongshu.com/explore/650000000000000000000002';
const externalPost = 'https://tieba.baidu.com/p/12345';
const originalFetch = global.fetch;
const call = (name,args,id) => ({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const tools = (...calls) => ({role:'assistant',content:null,tool_calls:calls});
const finish = value => ({role:'assistant',content:JSON.stringify(value)});
const reply = text => finish([{text,delay:0}]);
const decision = (kind,share = null,sources = []) => finish({decision:kind,share,sources});

async function main() {
  const temp = fs.realpathSync.native(path.join(__dirname,'../temp'));
  const dir = fs.mkdtempSync(path.join(temp,'background-browse-service-'));
  const previousDataDir = process.env.DAFEIYU_DATA_DIR;
  process.env.DAFEIYU_DATA_DIR = dir;
  const startText = '让大肥鱼在后台继续逛小红书和知乎。';
  const invalidText = '我们先聊聊天。';
  const budgetText = '让大肥鱼在后台持续逛小红书，这个任务最多100 tokens。';
  const intervalMs = 15 * 60 * 1000;
  const shorterIntervalMs = 5 * 60 * 1000;
  let now = Date.now();
  let backend;
  let batch = 0;
  let xhsLoads = 0, zhihuLoads = 0, outsideLoads = 0;
  let receivedInvalidEvidence = false;
  let budgetGenerations = 0, budgetBackgroundGenerations = 0;
  const modelRecords = [];
  const fixturePost = text => '<!doctype html><meta charset="utf-8"><article id="noteContainer">'+
    '<h1>湖边公开记录</h1><div id="detail-desc">'+text+'</div></article>';
  const fixtures = new Map([
    [sites.xiaohongshu.feed, () => `<main><a href="${batch === 1 ? xhsPost : xhsFollowup}">湖边摄影</a></main>`],
    [sites.zhihu.feed, () => {zhihuLoads++; return '<div role="dialog">请登录后查看</div>';}],
    [externalPost, () => {outsideLoads++; return '<article>应被拒绝的其他站点</article>';}],
    [xhsPost, () => {xhsLoads++; return fixturePost('午后看到一只水鸟。');}],
    [xhsFollowup, () => {xhsLoads++; return fixturePost('雨后树枝上出现两只白鹭。');}],
  ]);

  global.fetch = async (url,options = {}) => {
    const address = new URL(String(url));
    if (address.protocol === 'http:' && address.hostname === '127.0.0.1') return originalFetch(url,options);
    if (address.origin === 'https://api.openai.com') {
      const request = JSON.parse(options.body);
      assert.equal(request.model,'gpt-6.1-terra');
      const json = value => new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
      if (address.pathname === '/v1/responses/input_tokens') return json({input_tokens:20});
      assert.equal(address.pathname,'/v1/responses');
      const background = JSON.stringify(request.input).includes('【持续浏览任务】');
      budgetGenerations++;
      if (background) budgetBackgroundGenerations++;
      const functionCall = (name,args) => ({type:'function_call',name,call_id:'budget-'+name,arguments:JSON.stringify(args)});
      const finishResponse = value => ({type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(value)}]});
      const output = background ? [finishResponse({decision:'continue',share:null,sources:[]})] : budgetGenerations === 1 ? [
        functionCall('usage_budget_set',{scope:'task',tokens:100,usd:null,token_text:'100 tokens',usd_text:null,evidence:budgetText}),
        functionCall('background_browse_start',{site:'xiaohongshu',evidence:budgetText}),
      ] : [finishResponse([{text:'已设置任务额度。',delay:0}])];
      const outputTokens = background ? 20 : 5;
      return json({status:'completed',usage:{input_tokens:20,output_tokens:outputTokens,total_tokens:20+outputTokens,
        input_tokens_details:{cached_tokens:0,cache_write_tokens:0},output_tokens_details:{reasoning_tokens:0}},output});
    }
    assert.equal(address.href,'https://fixture.invalid/v1/chat/completions');
    const body = JSON.parse(options.body);
    const background = body.messages.some(item => item.role === 'system' && item.content.includes('【持续浏览任务】'));
    const userIndex = body.messages.findLastIndex(item => item.role === 'user');
    const outputs = body.messages.slice(userIndex+1).filter(item => item.role === 'tool').map(item => JSON.parse(item.content));
    modelRecords.push({background,tools:body.tools?.map(item => item.function.name) || []});
    let message;
    if (background) {
      assert.ok(body.tools?.length);
      assert.ok(body.tools.every(item => item.function.name.startsWith('browser_')),
        'background model cannot control the task, read credentials, set budgets or send QQ messages');
      if (!outputs.length) batch++;
      if (batch === 1) {
        if (!outputs.length) message = tools(call('browser_feed',{site:'zhihu'},'zhihu-1'),
          call('browser_feed',{site:'xiaohongshu'},'xhs-feed-1'));
        else if (outputs.length === 2) {
          assert.equal(outputs[0].error.code,'browser_login_required');
          assert.ok(outputs[1].result.links.some(item => item.url === xhsPost));
          message = tools(call('browser_read_page',{url:xhsPost},'xhs-post-1'));
        } else {
          assert.match(outputs.at(-1).result.text,/水鸟/);
          message = decision('continue');
        }
      } else if (batch === 2) {
        if (!outputs.length) message = tools(call('browser_feed',{site:'zhihu'},'zhihu-held'),
          call('browser_read_page',{url:externalPost},'outside-scope'),
          call('browser_read_page',{url:xhsFollowup},'unobserved-post'),
          call('browser_feed',{site:'xiaohongshu'},'xhs-feed-2'));
        else if (outputs.length === 4) {
          assert.equal(outputs[0].ok,false,'site held for login is no longer available to model tools');
          assert.equal(outputs[1].ok,false,'out-of-task site is never opened');
          assert.equal(outputs[2].error.code,'background_browse_unobserved');
          assert.ok(outputs[3].result.links.some(item => item.url === xhsFollowup));
          message = tools(call('browser_read_page',{url:xhsFollowup},'xhs-post-2'));
        } else {
          assert.match(outputs.at(-1).result.text,/白鹭/);
          message = decision('continue','看到有人拍到了雨后的白鹭。',[xhsFollowup]);
        }
      } else if (batch === 3) {
        assert.equal(outputs.length,0);
        message = decision('stop');
      } else assert.fail('a stopped task must not request another model batch');
    } else {
      const user = body.messages[userIndex].content;
      if (!outputs.length && (user === invalidText || user === startText))
        message = tools(call('background_browse_start',{site:'both',evidence:startText},'start-task'));
      else if (user === invalidText) {
        assert.equal(outputs[0].ok,false,'another message cannot serve as authorization');
        receivedInvalidEvidence = true;
        message = reply('先聊聊天。');
      } else if (user === startText) {
        assert.equal(outputs[0].ok,true,JSON.stringify(outputs[0]));
        message = reply('我会在后台逛这两站。');
      } else message = reply('收到。');
    }
    return new Response(JSON.stringify({choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}],
      usage:{prompt_tokens:18,completion_tokens:4,total_tokens:22}}),{headers:{'Content-Type':'application/json'}});
  };

  try {
    const settings = require('./electron/brain/settings');
    settings.saveSettings({provider:'cloud',cloud:{baseUrl:'https://fixture.invalid/v1',
      apiKey:'fixture-no-network',model:'fixture-background-browser'},memory:{enabled:false,autoExtract:false},
      cognition:{enabled:false},proactive:{enabled:false},browser:{enabled:true,proactive:true,backgroundIntervalMinutes:15},voice:{enabled:false},
      stickers:{enabled:false}});
    backend = await require('./service').createBackend({browserOptions:{fixtures},
      backgroundBrowseOptions:{now:()=>now,pollMs:24*60*60*1000}});
    const runtime = backend.backgroundBrowse;
    const api = async (method,route,body,expected = 200) => {
      const response = await originalFetch(backend.descriptor.url+route,{method,
        headers:{Authorization:'Bearer '+backend.descriptor.token,'Content-Type':'application/json'},
        ...(body === undefined ? {} : {body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
      const data = await response.json();
      assert.equal(response.status,expected,`${method} ${route}: ${JSON.stringify(data)}`);
      return data;
    };
    const sessionId = (await api('POST','/sessions',{},201)).session_id;
    const presence = extra => api('POST','/companion/presence',{session_id:sessionId,chat_open:false,typing:false,
      voice_busy:false,quiet:false,desktop_visible:true,...extra});
    const chat = (id,text) => api('POST','/chat',{session_id:sessionId,request_id:id,text});
    await presence({});
    await chat('missing-user-evidence',invalidText);
    assert.ok(receivedInvalidEvidence);
    assert.equal(runtime.status().task,null);
    const receipt = await chat('persistent-browse-request',startText);
    assert.match(receipt.text,/后台/);
    assert.deepEqual(await chat('persistent-browse-request',startText),receipt,'HTTP replay preserves the start receipt');
    const taskId = runtime.status().task.taskId;
    assert.equal(taskId,'persistent-browse-request');
    await presence({typing:true});
    now += intervalMs;
    await runtime.tick();
    assert.equal(batch,0,'typing prevents due work from beginning');
    await presence({});
    await runtime.tick();
    assert.equal(batch,1);
    const quiet = await api('GET','/events?after=0');
    assert.equal(quiet.browser_challenge,null);
    assert.ok(!quiet.events.some(item => item.text?.includes('水鸟')));
    assert.equal(xhsLoads,1); assert.equal(zhihuLoads,1);

    const updated = await api('PUT','/settings',{browser:{backgroundIntervalMinutes:5}});
    assert.equal(updated.browser.backgroundIntervalMinutes,5);
    const scheduled = await api('GET','/browser/background');
    assert.equal(scheduled.task.taskId,taskId,'the interval edit preserves the running task');
    assert.equal(scheduled.nextEligibleAt,now+shorterIntervalMs);
    now += shorterIntervalMs-1;
    await runtime.tick();
    assert.equal(batch,1,'the shortened interval still waits until it is due');
    now++;
    await runtime.tick();
    assert.equal(batch,2);
    assert.equal(xhsLoads,2); assert.equal(zhihuLoads,1); assert.equal(outsideLoads,0);
    const shared = await api('GET',`/events?after=${quiet.cursor}`);
    assert.equal(shared.browser_challenge,null);
    assert.equal(shared.events.filter(item => item.text?.includes('雨后的白鹭')).length,1);
    assert.match(JSON.stringify(shared.events),new RegExp(xhsFollowup));

    now += intervalMs;
    await runtime.tick();
    assert.equal(batch,3);
    assert.equal(runtime.status().task.status,'stopped');
    now += intervalMs;
    await runtime.tick();
    assert.equal(batch,3);

    const ledger = new DatabaseSync(path.join(dir,'usage-ledger.db'),{readOnly:true});
    try {
      const rows = ledger.prepare("SELECT task_id,total_tokens FROM model_usage WHERE channel='background'").all();
      assert.equal(rows.length,modelRecords.filter(item => item.background).length);
      assert.ok(rows.length>=3);
      assert.ok(rows.every(item => item.task_id === taskId && item.total_tokens === 22),
        'all settled background model calls share the initiating chat task ledger ID');
    } finally {ledger.close();}

    await chat('settings-stop-task',startText);
    const beforeLocalStop = modelRecords.length;
    const stale = await api('POST','/browser/background/stop',{task_id:taskId},409);
    assert.equal(stale.code,'background_browse_task_changed');
    assert.equal((await api('GET','/browser/background')).task.status,'active');
    await api('PUT','/settings',{browser:{autonomousBlockedSites:['zhihu']}});
    const paused = await api('GET','/browser/background');
    assert.equal(paused.task.status,'paused');
    assert.equal(paused.reason,'site_blacklisted');
    assert.equal(paused.task.taskId,'settings-stop-task');
    await api('PUT','/settings',{browser:{autonomousBlockedSites:[]}});
    assert.equal((await api('GET','/browser/background')).task.status,'paused');
    const stopped = await api('POST','/browser/background/stop',{task_id:'settings-stop-task'});
    assert.equal(stopped.task.status,'stopped');
    assert.equal(modelRecords.length,beforeLocalStop,'local stop does not need the model');

    settings.saveSettings({cloud:{baseUrl:'https://api.openai.com/v1',apiKey:'fixture-no-network',model:'gpt-6.1-terra'}});
    await chat('budget-browse-task',budgetText);
    assert.equal(runtime.status().task.taskId,'budget-browse-task');
    await presence({});
    now += intervalMs;
    await runtime.tick();
    assert.equal(budgetBackgroundGenerations,1);
    now += intervalMs;
    await runtime.tick();
    assert.equal(runtime.status().task.status,'paused');
    assert.equal(runtime.status().task.budgetError,'usage_budget_exceeded');
    assert.equal(budgetBackgroundGenerations,1,'the shared task cap blocks the second batch before generation');
    console.log('background-browse-service: PASS (native authorization, live interval edit, typing priority, quiet/share/stop, public sites, local stop and shared budget)');
  } finally {
    await backend?.close();
    global.fetch = originalFetch;
    if (previousDataDir === undefined) delete process.env.DAFEIYU_DATA_DIR;
    else process.env.DAFEIYU_DATA_DIR = previousDataDir;
    const target = fs.realpathSync.native(dir);
    assert.equal(path.dirname(target),temp);
    assert.match(path.basename(target),/^background-browse-service-[\w]{6}$/);
    fs.rmSync(target,{recursive:true,maxRetries:8,retryDelay:100});
  }
}

main().catch(error => {console.error(error);process.exitCode = 1;});
