'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { createBackgroundBrowse } = require('./background-browse');
const { createBrowserTurn } = require('./browser/turn');

const intervalMs = 15 * 60 * 1000;
const xhs = 'https://www.xiaohongshu.com/explore/650000000000000000000001';
const zhihu = 'https://www.zhihu.com/question/1234';
const create = runtime => runtime.createTask({taskId:'owner-request',sessionId:'pc-session',
  sites:['xiaohongshu','zhihu'],instruction:'看看公开的摄影帖子'});

function harness(db, options = {}) {
  let time = Date.UTC(2026,10,8,4);
  let busy = false;
  const settings = {browser:{enabled:true}};
  const runtime = createBackgroundBrowse({db,getSettings:()=>settings,isBusy:()=>busy,isConfigured:()=>true,
    now:()=>time,intervalMs,pollMs:24 * 60 * 60 * 1000,runBatch:async()=>({}),publish:async()=>{},...options});
  runtime.start();
  return { runtime, settings, advance(ms) {time += ms;}, busy(value) {busy = value;} };
}

test('a new blacklist entry aborts and durably pauses an active task until explicit resume', {timeout:10000}, async () => {
  const db = new DatabaseSync(':memory:');
  let began, shares = 0;
  const begun = new Promise(resolve => { began = resolve; });
  const {runtime, settings} = harness(db, {
    runBatch:async (_task,{signal}) => {
      await new Promise(resolve => {
        signal.addEventListener('abort',resolve,{once:true});
        began();
      });
      return {summary:'已取消的浏览结果'};
    },
    publish:async()=>{ shares++; },
  });
  let restarted;
  try {
    create(runtime);
    const work = runtime.tick();
    await begun;
    settings.browser.autonomousBlockedSites = ['zhihu'];
    await Promise.all([runtime.refreshSitePolicy(),work]);
    assert.equal(shares,0);
    assert.equal(runtime.status().reason,'site_blacklisted');
    assert.equal(runtime.status().task.batches,0);
    assert.throws(()=>runtime.resumeTask(),{code:'browser_site_blacklisted'});
    await runtime.close();
    restarted = harness(db).runtime;
    assert.equal(restarted.status().task.status,'paused');
    assert.equal(restarted.resumeTask().task.taskId,'owner-request');
    assert.equal(restarted.status().task.status,'active');
  } finally {
    await restarted?.close();
    await runtime.close();
    db.close();
  }
});

test('site blacklist is rechecked for autonomous feeds, links, and cached results; foreground can read', async () => {
  const settings = {browser:{enabled:true,autonomousBlockedSites:[]}};
  const calls = [];
  const engine = {browse:async input => {calls.push(input);return {ok:true,result:{links:[]}};}};
  const options = {engine,auth:{},getSettings:()=>settings,signal:new AbortController().signal};
  const auto = createBrowserTurn({...options,proactive:true});
  const chat = createBrowserTurn(options);
  const feed = {name:'browser_feed',arguments:{site:'zhihu'}};
  const read = {name:'browser_read_page',arguments:{url:zhihu}};
  assert.equal((await auto.executeTool(feed)).ok,true);
  settings.browser.autonomousBlockedSites = ['zhihu'];
  for (const call of [feed,read])
    assert.equal((await auto.executeTool(call)).error.code,'browser_site_blacklisted');
  assert.equal(calls.length,1);
  assert.equal((await chat.executeTool(read)).ok,true);
  assert.equal(calls.length,2);
  await Promise.all([auto.close(),chat.close()]);
});

test('one durable task keeps its ID and observed progress without running missed batches', {timeout:10000}, async () => {
  const temp = fs.realpathSync.native(path.join(__dirname,'../temp'));
  const dir = fs.mkdtempSync(path.join(temp,'background-browse-unit-'));
  const file = path.join(dir,'task.sqlite');
  let db = new DatabaseSync(file);
  let runtime;
  const observations = [], shared = [];
  const options = {
    runBatch:async task => {
      observations.push({id:task.taskId,urls:[...task.recentUrls]});
      if (observations.length === 1) return {recentUrls:[xhs+'?xsec_token=fixture-private','https://example.invalid/private']};
      if (observations.length === 2) return {recentUrls:[zhihu],summary:'看到了两条摄影记录。'};
      return observations.length === 3 ? {} : {stop:true};
    },
    publish:async (task,summary)=>shared.push([task.taskId,summary]),
  };
  try {
    const first = harness(db,options);
    runtime = first.runtime;
    create(runtime);
    first.busy(true);
    first.advance(intervalMs);
    await runtime.tick();
    assert.equal(observations.length,0,'foreground work keeps a due task waiting');
    first.busy(false);
    await runtime.tick();
    assert.deepEqual(observations,[{id:'owner-request',urls:[]}]);
    assert.deepEqual(shared,[],'a quiet batch produces no notification');
    await runtime.tick();
    assert.equal(observations.length,1,'polls in the same interval do not start another batch');
    first.advance(intervalMs);
    await runtime.tick();
    assert.deepEqual(observations[1],{id:'owner-request',urls:[xhs]});
    assert.deepEqual(shared,[['owner-request','看到了两条摄影记录。']]);
    await runtime.close();
    db.close();

    db = new DatabaseSync(file);
    let restoredAt = Date.UTC(2026,10,8,4) + 10 * intervalMs;
    const second = harness(db,{...options,now:()=>restoredAt});
    runtime = second.runtime;
    assert.equal(runtime.status().task.taskId,'owner-request');
    assert.deepEqual(runtime.status().task.recentUrls,[zhihu,xhs]);
    await runtime.tick();
    assert.deepEqual(observations[2],{id:'owner-request',urls:[zhihu,xhs]});
    await runtime.tick();
    assert.equal(observations.length,3,'reopening does not replay missed batches');
    restoredAt += intervalMs;
    await runtime.tick();
    assert.equal(runtime.status().task.status,'stopped','the model may stop the task after a batch');
    restoredAt += 10 * intervalMs;
    await runtime.tick();
    assert.equal(observations.length,4);
  } finally {
    await runtime?.close();
    db.close();
    const target = fs.realpathSync.native(dir);
    assert.equal(path.dirname(target),temp);
    assert.match(path.basename(target),/^background-browse-unit-[\w]{6}$/);
    fs.rmSync(target,{recursive:true,maxRetries:5});
  }
});

test('foreground interruption suppresses a late share and disabling browsing blocks work', {timeout:10000}, async () => {
  const db = new DatabaseSync(':memory:');
  let calls = 0, notifications = 0, began;
  const begun = new Promise(resolve => {began = resolve;});
  const setup = harness(db,{
    runBatch:async (_task,{signal}) => {
      calls++;
      if (calls !== 1) return {};
      await new Promise(resolve => {
        signal.addEventListener('abort',resolve,{once:true});
        began();
      });
      return {summary:'不应发送的晚到结果'};
    },
    publish:async()=>{notifications++;},
  });
  const {runtime} = setup;
  try {
    create(runtime);
    setup.settings.browser.enabled = false;
    setup.advance(intervalMs);
    await runtime.tick();
    assert.equal(calls,0);
    setup.settings.browser.enabled = true;
    setup.advance(intervalMs);
    const work = runtime.tick();
    await begun;
    assert.equal(runtime.isWorking(),true);
    setup.busy(true);
    await Promise.all([runtime.interrupt(),work]);
    assert.equal(runtime.isWorking(),false);
    assert.equal(notifications,0);
    assert.equal(runtime.status().task.status,'active');
    await runtime.tick();
    assert.equal(calls,1);
    setup.busy(false);
    setup.advance(intervalMs);
    await runtime.tick();
    assert.equal(calls,2,'the same task can continue when foreground work is finished');
  } finally {
    await runtime.close();
    db.close();
  }
});

test('login and rate limits hold only the affected site and budget exhaustion pauses the task', {timeout:10000}, async () => {
  const db = new DatabaseSync(':memory:');
  const visited = [];
  const setup = harness(db,{
    runBatch:async task => {
      visited.push([...task.availableSites]);
      if (visited.length === 1) return {siteBlocks:[{site:'zhihu',kind:'login_required'}]};
      if (visited.length === 2) return {siteBlocks:[{site:'xiaohongshu',kind:'rate_limited',retryAt:Date.UTC(2026,10,8,6)}]};
      throw Object.assign(new Error('fixture budget exhausted'),{code:'usage_budget_exceeded'});
    },
  });
  const {runtime} = setup;
  try {
    create(runtime);
    await runtime.tick();
    setup.advance(intervalMs);
    await runtime.tick();
    assert.deepEqual(visited,[['xiaohongshu','zhihu'],['xiaohongshu']]);
    setup.advance(intervalMs);
    await runtime.tick();
    assert.equal(visited.length,2,'no batch runs while both sites are unavailable');
    runtime.clearSiteBlock('zhihu');
    setup.advance(intervalMs);
    await runtime.tick();
    assert.deepEqual(visited[2],['zhihu']);
    assert.equal(runtime.status().task.status,'paused');
    setup.advance(10 * intervalMs);
    await runtime.tick();
    assert.equal(visited.length,3,'a paused budget does not repeatedly request the model');
    assert.equal(runtime.resumeTask('owner-request').task.status,'active');
    assert.equal(runtime.stopTask('owner-request').task.status,'stopped');
    setup.advance(intervalMs);
    await runtime.tick();
    assert.equal(visited.length,3,'a user-stopped task stays stopped');
  } finally {
    await runtime.close();
    db.close();
  }
});

test('the live interval applies to scheduled and interrupted batches', {timeout:10000}, async () => {
  const db = new DatabaseSync(':memory:');
  const startedAt = Date.UTC(2026,10,8,4);
  let calls = 0, began;
  const begun = new Promise(resolve => {began = resolve;});
  const setup = harness(db,{
    intervalMs:undefined,
    runBatch:async (_task,{signal}) => {
      calls++;
      if (calls === 1) setup.advance(10000);
      if (calls === 2) await new Promise(resolve => {
        signal.addEventListener('abort',resolve,{once:true});
        began();
      });
      return {};
    },
  });
  const {runtime,settings} = setup;
  try {
    create(runtime);
    await runtime.tick();
    const finishedAt = startedAt + 10000;
    assert.equal(runtime.status().nextEligibleAt,finishedAt + 5 * 60000);
    setup.advance(2 * 60000);
    settings.browser.backgroundIntervalMinutes = 15;
    assert.equal(runtime.status().task.nextAt,finishedAt + 15 * 60000);
    assert.equal((await runtime.tick()).reason,'scheduled');
    settings.browser.backgroundIntervalMinutes = 1;
    assert.equal(runtime.status().reason,'ready');
    const pending = runtime.tick();
    await begun;
    settings.browser.backgroundIntervalMinutes = 4;
    assert.equal((await runtime.tick()).reason,'reading');
    await Promise.all([runtime.interrupt(),pending]);
    assert.equal(runtime.status().nextEligibleAt,finishedAt + 6 * 60000);
    assert.equal((await runtime.tick()).reason,'scheduled');
    setup.advance(4 * 60000);
    await runtime.tick();
    assert.equal(calls,3);
    assert.equal((await runtime.tick()).reason,'scheduled');
  } finally {
    await runtime.close();
    db.close();
  }
});

test('a legacy 15-minute deadline adapts to the setting and persists across reopen', {timeout:10000}, async () => {
  const db = new DatabaseSync(':memory:');
  const batchAt = Date.UTC(2026,10,8,4);
  const settings = {browser:{enabled:true,backgroundIntervalMinutes:30}};
  let now = batchAt + 2 * 60000;
  let calls = 0;
  let runtime;
  function reopen() {
    runtime = createBackgroundBrowse({db,getSettings:()=>settings,now:()=>now,runBatch:async()=>{calls++;}});
    runtime.start();
  }
  try {
    reopen();
    await runtime.close();
    db.prepare('INSERT INTO pc_background_browse(id,state_json) VALUES(1,?)').run(JSON.stringify({
      taskId:'owner-request',sessionId:'pc-session',sites:['zhihu'],instruction:'',createdAt:batchAt,
      status:'active',nextAt:batchAt + intervalMs,updatedAt:batchAt,batches:1,recentUrls:[],siteBlocks:[],
    }));
    reopen();
    assert.equal(runtime.status().nextEligibleAt,batchAt + 30 * 60000);
    await runtime.close();
    now = batchAt + 20 * 60000;
    reopen();
    assert.equal(runtime.status().nextEligibleAt,batchAt + 30 * 60000);
    assert.equal((await runtime.tick()).reason,'scheduled');
    settings.browser.backgroundIntervalMinutes = 5;
    await runtime.tick();
    assert.equal(calls,1);
    assert.equal((await runtime.tick()).reason,'scheduled');
  } finally {
    await runtime?.close();
    db.close();
  }
});
