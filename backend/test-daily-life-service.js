'use strict';

// Uses the real service, SQLite and model tool loop. Model and browser inputs are offline fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { setTimeout: delay } = require('node:timers/promises');
const { sites } = require('./browser/sites');

const originalFetch = global.fetch;
const post = 'https://www.xiaohongshu.com/explore/650000000000000000000001';
const unseenPost = 'https://www.xiaohongshu.com/explore/650000000000000000000002';
const deniedPost = 'https://zhuanlan.zhihu.com/p/1000000000000000003';
const hupuPost = 'https://m.hupu.com/bbs/654321234.html';
const memoryMarker = '雨后芦苇荡摄影';
const summary = '我读到一篇雨后拍到白鹭的记录。';
const experience = { day: '2026-11-09', summary, sources: [post] };
const plan = { kind:'browse', intent: '看看芦苇荡摄影的图文', reason: '好奇雨后的景色', startTime: '14:05', endTime: '14:30' };
const fullSchedule = [
  { ...plan, intent:'上午看摄影', startTime:'09:20', endTime:'09:45' },
  { ...plan, kind:'rest', intent:'中午休息', startTime:'12:00', endTime:'13:00' },
  { ...plan, intent:'下午读帖子' },
  { ...plan, intent:'晚上看讨论', startTime:'20:10', endTime:'20:45' },
];
const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const call = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const toolCalls = (...calls) => ({ role: 'assistant', content: null, tool_calls: calls });
const answer = value => ({ role: 'assistant', content: JSON.stringify(value) });

async function main() {
  const temp = fs.realpathSync.native(path.join(__dirname, '../temp'));
  const dir = fs.mkdtempSync(path.join(temp, 'daily-life-service-'));
  const previousDataDir = process.env.DAFEIYU_DATA_DIR;
  process.env.DAFEIYU_DATA_DIR = dir;
  let now = at(9, 14);
  let backend;
  let feeds = 0, reads = 0, unseenReads = 0;
  let recalled = false;
  let fixtureFailure;
  const requests = [];
  const fixtures = new Map([
    [sites.xiaohongshu.feed, () => { feeds++; return `<main><a href="${post}">湖边摄影</a></main>`; }],
    [post, () => {
      reads++;
      return '<!doctype html><meta charset="utf-8"><article id="noteContainer">' +
        '<h1>湖边摄影</h1><div id="detail-desc">雨后树枝上出现两只白鹭。</div></article>';
    }],
    [unseenPost, () => { unseenReads++; return '<article>不应打开的帖子</article>'; }],
    [sites.zhihu.feed, `<main><a href="${deniedPost}">摄影图文</a></main>`],
    [deniedPost, { status:403, contentType:'application/json', body:JSON.stringify({ error:{ code:40362 } }) }],
    [sites.hupu.feed, `<main><a href="${hupuPost}">球场活动记录</a></main>`],
    [hupuPost, '<article class="hupu-bbs-post"><h1>球场活动</h1><div class="bbs-content-font">球场周末开放，帖子记录了第一场友谊赛。</div></article>'],
  ]);

  async function fixtureFetch(url, options = {}) {
    assert.equal(String(url), 'https://fixture.invalid/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'fixture-daily-life');
    const context = body.messages.find(item => item.role === 'system')?.content || '';
    const kind = context.includes('【大肥鱼的一天：计划】') ? 'plan'
      : context.includes('【大肥鱼的一天：活动】') ? 'activity' : 'chat';
    const availableTools = body.tools?.map(item => item.function.name) || [];
    const userIndex = body.messages.findLastIndex(item => item.role === 'user');
    const input = body.messages[userIndex].content;
    const outputs = body.messages.slice(userIndex + 1).filter(item => item.role === 'tool')
      .map(item => JSON.parse(item.content));
    const day = new Date(now).getDate();
    requests.push({ kind, day });
    let message;

    if (kind === 'plan') {
      assert.deepEqual(availableTools, [], 'planning cannot launch browser or send messages');
      const planner = JSON.parse(input);
      assert.equal(planner.day, `2026-11-${String(day).padStart(2, '0')}`);
      assert.match(planner.memory, new RegExp(memoryMarker));
      if (day < 16) assert.deepEqual(planner.experiences, day === 9 ? [] : [experience]);
      if (day === 17) {
        assert.equal(planner.experiences[0].day, '2026-11-16');
        assert.equal(planner.experiences[0].summary, summary);
      }
      message = answer(day === 10 || day === 17 ? null : { entries: day === 16 ? fullSchedule : [plan] });
    } else if (kind === 'activity') {
      assert.deepEqual(availableTools.sort(), ['browser_feed', 'browser_read_page']);
      const activity = JSON.parse(input);
      if (day === 9 || day === 15 || (day === 16 && activity.plan.id === 1)) {
        if (!outputs.length) message = toolCalls(call('browser_feed', { site: 'xiaohongshu' }, 'feed'));
        else if (outputs.length === 1) {
          assert.ok(outputs[0].result?.links.some(item => item.url === post), JSON.stringify(outputs[0]));
          message = toolCalls(call('browser_read_page', { url: post }, 'post'));
        } else {
          assert.match(outputs[1].result?.text, /雨后树枝上出现两只白鹭/);
          assert.equal(outputs[1].result.source_url, post);
          const adjustment = day === 16 ? { id:3, startTime:'15:00', endTime:'15:25' } : null;
          message = answer(day === 15 ? null : { summary, sources: [outputs[1].result.source_url], adjustment });
        }
      } else if (day === 18) {
        if (!outputs.length) message = toolCalls(call('browser_feed', { site:'zhihu' }, 'zhihu-feed'));
        else if (outputs.length === 1) {
          assert.ok(outputs[0].result.links.some(item => item.url === deniedPost));
          message = toolCalls(call('browser_read_page', { url:deniedPost }, 'zhihu-post'));
        } else if (outputs.length === 2) {
          assert.equal(outputs[1].error?.code, 'browser_access_denied');
          message = toolCalls(call('browser_feed', { site:'hupu' }, 'hupu-feed'));
        } else if (outputs.length === 3) {
          assert.equal(body.tool_choice, 'auto', 'the alternate feed is not the last permitted action');
          assert.equal(outputs[2].remaining_actions, 2);
          assert.ok(outputs[2].result.links.some(item => item.url === hupuPost));
          message = toolCalls(call('browser_read_page', { url:hupuPost }, 'hupu-post'));
        } else {
          assert.equal(outputs.length, 4);
          assert.match(outputs[3].result.text, /第一场友谊赛/);
          message = answer({ summary:'我读了球场开放后的友谊赛记录。', sources:[hupuPost] });
        }
      } else if (day === 12 || day === 14 || day === 16) {
        assert.equal(outputs.length, 0);
        if (day === 16) assert.equal(activity.experiences[0].day, '2026-11-16');
        message = answer(null);
      } else {
        assert.equal(day, 11, 'a day marked for rest cannot launch an activity');
        if (!outputs.length) message = toolCalls(call('browser_read_page', { url: unseenPost }, 'unseen'));
        else {
          assert.equal(outputs[0].error?.code, 'daily_life_unobserved');
          message = answer({ summary: '没有读过的伪造记录。', sources: [unseenPost] });
        }
      }
    } else {
      assert.equal(input, '你昨天下午在做什么？');
      assert.ok(availableTools.includes('daily_life_recall'));
      assert.doesNotMatch(context, /雨后拍到白鹭/, 'the model chooses when to recall the separate experience');
      if (!outputs.length) message = toolCalls(call('daily_life_recall', {}, 'recall'));
      else {
        assert.equal(outputs[0].ok, true);
        assert.deepEqual(outputs[0].result?.experiences, [experience]);
        recalled = true;
        message = answer([{ text: summary, delay: 0 }]);
      }
    }

    return new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 18, completion_tokens: 4, total_tokens: 22 } }),
    { headers: { 'Content-Type': 'application/json' } });
  }
  global.fetch = async (...args) => {
    try { return await fixtureFetch(...args); }
    catch (error) { fixtureFailure ??= error; throw error; }
  };

  try {
    const settings = require('./electron/brain/settings');
    settings.saveSettings({ provider: 'cloud', cloud: { baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-no-network',
      model: 'fixture-daily-life' }, cognition: { enabled: false }, memory: { enabled: true, autoExtract: false },
    proactive: { enabled: true, quietHoursStart: 0, quietHoursEnd: 0 }, browser: { enabled: true, proactive: true },
    voice: { enabled: false }, stickers: { enabled: false } });
    const openBackend = (pollMs = 86400000) => require('./service').createBackend({ browserOptions: { fixtures },
      dailyLifeOptions: { now: () => now, pollMs } });
    const api = async (method, route, body, expected = 200) => {
      const response = await originalFetch(backend.descriptor.url + route, { method,
        headers: { Authorization: 'Bearer ' + backend.descriptor.token, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
      const data = await response.json();
      assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}`);
      return data;
    };
    backend = await openBackend();
    const memory = require('./electron/brain/memory');
    assert.ok(require('./electron/brain/memory-audit').upsert(memory.initMemory(), {
      category: 'preference', factKey: '摄影主题', factValue: memoryMarker, importance: 5,
    }));
    const sessionId = (await api('POST', '/sessions', {}, 201)).session_id;
    const presence = extra => api('POST', '/companion/presence', { session_id: sessionId, chat_open: false,
      typing: false, quiet: false, desktop_visible: true, ...extra });
    const tick = () => backend.dailyLife.tick();
    const today = () => backend.dailyLife.today();
    const slot = (index = 0) => today()?.entries[index];
    const eventsBefore = await api('GET', '/events?after=0');
    await tick();
    assert.equal(requests.length, 0, 'waits for desktop presence');
    await presence();
    await tick();
    assert.deepEqual(requests, [{ kind: 'plan', day: 9 }]);
    assert.equal(slot().status, 'scheduled');
    assert.equal(slot().intent, plan.intent);
    assert.equal(slot().startAt, at(9, 14, 5));
    assert.equal(slot().endAt, at(9, 14, 30));
    assert.deepEqual(backend.dailyLife.recentExperiences(), []);

    now = at(9, 14, 5) - 1;
    await tick();
    assert.equal(requests.length, 1, 'no call before the model-selected time');
    now++;
    await presence({ typing: true });
    await tick();
    assert.equal(requests.length, 1, 'typing takes precedence even at the scheduled time');
    await presence();
    await tick();
    assert.equal(slot().status, 'done');
    assert.equal(slot().startedAt, at(9, 14, 5));
    assert.deepEqual(slot().report.actions.map(item => item.outcome), ['opened', 'read']);
    assert.deepEqual(backend.dailyLife.recentExperiences(), [experience]);
    assert.deepEqual(requests.map(item => item.kind), ['plan', 'activity', 'activity', 'activity']);
    assert.deepEqual([feeds, reads, unseenReads], [1, 1, 0]);
    await tick();
    assert.equal(requests.length, 4, 'completed activity does not repeat');
    assert.deepEqual(await api('GET', `/events?after=${eventsBefore.cursor}`), { ...eventsBefore, events: [] });

    await backend.close();
    now = at(10, 14);
    backend = await openBackend();
    assert.deepEqual(backend.dailyLife.recentExperiences(), [experience], 'experience survives backend restart');
    await presence();
    await tick();
    assert.equal(today().status, 'empty');
    now = at(10, 14, 30);
    await tick();
    assert.deepEqual(requests.filter(item => item.day === 10), [{ kind: 'plan', day: 10 }]);
    assert.deepEqual([feeds, reads, unseenReads], [1, 1, 0]);
    const chat = await api('POST', '/chat', { session_id: sessionId, request_id: 'daily-life-recall-chat',
      text: '你昨天下午在做什么？' });
    assert.equal(chat.text, summary);
    assert.equal(recalled, true, 'normal chat can fetch the actual prior experience');

    now = at(11, 14);
    await presence();
    await tick();
    now = at(11, 14, 5);
    await tick();
    assert.equal(slot().status, 'failed');
    assert.equal(slot().experience, null);
    assert.deepEqual(backend.dailyLife.recentExperiences(), [experience], 'forged source is not recorded');
    assert.deepEqual([feeds, reads, unseenReads], [1, 1, 0]);

    now = at(12, 14);
    await presence();
    await tick();
    now = at(12, 14, 5);
    await tick();
    await tick();
    assert.equal(slot().status, 'done');
    assert.equal(slot().experience, null, 'a deliberate stop has no invented note');
    assert.deepEqual(requests.filter(item => item.day === 12), [{ kind: 'plan', day: 12 }, { kind: 'activity', day: 12 }]);
    assert.deepEqual([feeds, reads, unseenReads], [1, 1, 0]);

    now = at(13, 14);
    await presence();
    await tick();
    now = at(13, 14, 30);
    await tick();
    assert.equal(slot().status, 'missed');
    assert.equal(slot().experience, null);
    assert.deepEqual(requests.filter(item => item.day === 13), [{ kind: 'plan', day: 13 }]);

    await backend.close();
    now = at(14, 14);
    backend = await openBackend(25);
    const waitForState = async status => {
      const deadline = Date.now() + 4000;
      while (slot()?.status !== status && !fixtureFailure && Date.now() < deadline) await delay(10);
      assert.equal(slot()?.status, status, 'the normal timer reaches the expected state without a manual tick');
    };
    await presence();
    await waitForState('scheduled');
    now = at(14, 14, 5);
    await waitForState('done');
    assert.deepEqual(requests.filter(item => item.day === 14), [{ kind: 'plan', day: 14 }, { kind: 'activity', day: 14 }]);

    now = at(15, 14);
    await presence();
    await waitForState('scheduled');
    now = at(15, 14, 5);
    await waitForState('done');
    assert.equal(slot().report.outcome, 'no_note');
    assert.match(slot().experience.summary, /雨后树枝上出现两只白鹭/);
    assert.deepEqual(slot().experience.sources, [post]);
    assert.deepEqual((await api('GET', '/companion/status')).dailyLife, today());

    await backend.close();
    now = at(16, 9);
    backend = await openBackend();
    await presence();
    await tick();
    assert.equal(today().entries.length, 4);
    now = at(16, 9, 20);
    await tick();
    assert.equal(slot().status, 'done');
    assert.equal(slot(2).movedFrom, at(16, 14, 5));
    assert.equal(slot(2).startAt, at(16, 15));
    now = at(16, 12);
    await tick();
    assert.equal(requests.filter(item => item.day === 16).length, 4, 'rest never calls the model');
    now = at(16, 14, 5);
    await tick();
    assert.equal(slot(1).status, 'done');
    assert.equal(slot(1).experience, null);
    assert.equal(slot(2).status, 'scheduled', 'old time cannot start a moved activity');
    await backend.close();
    backend = await openBackend();
    await presence();
    now = at(16, 15);
    await tick();
    assert.equal(slot(2).status, 'done');
    now = at(16, 20, 10);
    await tick();
    assert.equal(slot(3).status, 'done');
    assert.equal(requests.filter(item => item.day === 16).length, 6, 'one plan and three independent execution windows');
    now = at(17, 9);
    await tick();
    assert.equal(today().status, 'empty');

    now = at(18, 14);
    await presence();
    await tick();
    now = at(18, 14, 5);
    await tick();
    assert.equal(slot().status, 'done');
    assert.deepEqual(slot().report.actions.map(({ site, outcome }) => [site,outcome]),
      [['zhihu','opened'],['zhihu','browser_access_denied'],['hupu','opened'],['hupu','read']]);
    assert.deepEqual(slot().experience.sources, [hupuPost]);

    const ledger = new DatabaseSync(path.join(dir, 'usage-ledger.db'), { readOnly: true });
    try {
      const rows = ledger.prepare("SELECT task_id, total_tokens FROM model_usage WHERE channel='background'").all();
      assert.deepEqual(rows.map(item => item.task_id).sort(), requests.filter(item => item.kind !== 'chat')
        .map(item => `daily-life-2026-11-${String(item.day).padStart(2, '0')}`).sort());
      assert.ok(rows.every(item => item.total_tokens === 22));
    } finally { ledger.close(); }

    if (fixtureFailure) throw fixtureFailure;
    console.log('daily-life-service: PASS (memory, timer and missed windows, priority, observed browsing, quiet persistence, rest, chat recall and usage)');
  } catch (error) {
    throw fixtureFailure ?? error;
  } finally {
    await backend?.close();
    global.fetch = originalFetch;
    if (previousDataDir === undefined) delete process.env.DAFEIYU_DATA_DIR;
    else process.env.DAFEIYU_DATA_DIR = previousDataDir;
    const target = fs.realpathSync.native(dir);
    assert.equal(path.dirname(target), temp);
    assert.match(path.basename(target), /^daily-life-service-[\w]{6}$/);
    fs.rmSync(target, { recursive: true, maxRetries: 8, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
