// Two real service conversations share one disposable user's memory. Only
// requests seen by the loopback chat provider count as prompt evidence.
const assert = require('node:assert/strict');
const http = require('node:http');
const { startFixture, isOrdinaryChatRequest } = require('./test-alignment-e2e');

// Exercise the ordinary extraction path as well as the local fallback: the
// provider sometimes returns ordinary plan/event facts about the same claim.
async function startEpisodeProvider() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push(body);
    const first = body.messages[0].content;
    const last = body.messages.at(-1).content;
    let value = [{text:'知道啦。',delay:0}];
    if (first.includes('记忆提取助手')) {
      value = [];
      if (last.includes('我的木工面试改到后天了')) {
        value.push({category:'plan',key:'面试安排',value:'木工面试',type:'temporary',importance:4,
          evidence:'我的木工面试改到后天了'});
      } else if (last.includes('我的木工面试取消了')) {
        value.push({category:'event',key:'面试',value:'木工面试',type:'fleeting',importance:4,
          evidence:'我的木工面试取消了'});
      }
    } else if (first.includes('人物关系提取助手')) value = [];
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}));
  });
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {calls,url:`http://127.0.0.1:${server.address().port}/v1`,
    close:async () => {server.closeAllConnections();await new Promise(resolve => server.close(resolve));}};
}

async function main() {
  const realNow = Date.now;
  const previousDataDir = process.env.DAFEIYU_DATA_DIR;
  const day = 86400000;
  let clock = new Date(2030, 4, 6, 9, 15).getTime();
  Date.now = () => clock;
  let fixture, provider;
  try {
    fixture = await startFixture();
    const api = fixture.api;
    provider = await startEpisodeProvider();
    await api('PUT', '/settings', {cloud:{baseUrl:provider.url},voice:{enabled:false},stickers:{enabled:false}});
    let sequence = 0;
    const session = async () => (await api('POST', '/sessions', {})).session_id;
    async function turn(id, text) {
      clock += 20;
      fixture.advance(20);
      const begin = provider.calls.length;
      await api('POST', '/chat', {session_id:id,request_id:'episode-' + (++sequence),text});
      const calls = provider.calls.slice(begin).filter(c => c.model === 'fake-chat'
        && isOrdinaryChatRequest(c) && c.messages.at(-1).content === text);
      assert.equal(calls.length, 1, 'captured the full chat request through the running PC service');
      return calls[0].messages;
    }
    // Query from a clean UUID so a match cannot come from its short-term history
    // or from the query itself. Keep all system and cognition sections visible.
    async function recall(text) {
      const input = await turn(await session(), text);
      return input.slice(0,-1).map(m => m.content).join('\n');
    }
    function advance(days) {clock += days * day; fixture.advance(days * day);}
    const facts = async () => (await api('GET','/memory')).facts;
    async function findSource(source, status) {
      const live = (await facts()).filter(f => f.active && f.source_text === source && f.episode_status === status);
      assert.equal(live.length, 1, 'one current sourced episode for ' + source + ' (' + status + ')');
      return live[0];
    }

    const first = await session();
    const plan = '我明天要参加木工面试。';
    await turn(first, plan);
    const interview = await findSource(plan, 'planned');
    advance(1);
    const resumed = await recall('接着聊上次那件事吧。');
    assert.match(resumed,/木工面试/, 'a single recent unfinished event can be resumed in a fresh chat');
    assert.match(resumed,/计划|打算|安排|准备/, 'planned is not automatically presented as done');
    assert.doesNotMatch(await recall('棉布和亚麻有什么区别？'), /木工面试/, 'an unrelated question does not bring up the plan');
    assert.doesNotMatch(await recall('接着聊量子力学吧。'), /木工面试/, 'a named new topic is not a vague continuation');
    assert.doesNotMatch(await recall('软件面试后来如何了？'), /木工面试/, 'different named experiences are not linked by their shared kind');
    assert.doesNotMatch(await recall('同事小岚的木工面试进展如何？'), /木工面试/,
      'a named colleague sharing the topic must not inherit the user’s personal episode');

    const pending = '我明天要参加摄影考试。';
    await turn(first, pending);
    await findSource(pending, 'planned');
    const ambiguous = await recall('接着聊上次那件事吧。');
    assert.doesNotMatch(ambiguous,/木工面试|摄影考试/,'two plausible events need a more specific cue');

    const reschedule = '我的木工面试改到后天了。';
    await turn(await session(), reschedule);
    const changed = await findSource(reschedule, 'rescheduled');
    assert.equal(changed.id, interview.id);
    assert.ok(changed.expires_at > interview.expires_at);
    const changedPrompt = await recall('我的木工面试是怎么安排的？');
    assert.match(changedPrompt,/改期|改到/);
    assert.ok(!changedPrompt.includes(plan.slice(0,-1)));
    const cancel = '我的木工面试取消了。';
    await turn(first, cancel);
    assert.equal((await findSource(cancel, 'cancelled')).id, interview.id);
    const shadows = (await facts()).filter(f => f.active && f.id!==interview.id
      && [plan,reschedule,cancel].includes(f.source_text) && ['plan','event'].includes(f.category));
    assert.equal(shadows.length,0,'the cloud extractor cannot create a second live copy of the same event');
    const cancelled = await recall('我的木工面试后来怎样了？');
    assert.match(cancelled,/取消/);
    assert.ok(!cancelled.includes(reschedule.slice(0,-1)) && !cancelled.includes(plan.slice(0,-1)));

    advance(3);
    await fixture.restart();
    const unknown = await recall('还记得我那次摄影考试吗？');
    assert.match(unknown,/摄影考试|考试/);
    assert.match(unknown,/未确认|未知|不清楚|不确定|没有确认/,'an expired plan has no known outcome');
    assert.ok(!unknown.includes(pending.slice(0,-1)),'do not tell the user that an expired plan is still tomorrow');

    const clayPlan = '我明天要参加陶艺比赛。';
    await turn(first,clayPlan);
    const plannedContest = await findSource(clayPlan,'planned');
    advance(2);
    const done = '我昨天在青瓦礼堂参加了陶艺比赛。';
    await turn(first, done);
    const completed = await findSource(done,'completed');
    assert.equal(completed.id,plannedContest.id,'the user explicitly confirmed completing that planned event');
    const recent = await recall('陶艺比赛是怎么回事？');
    assert.match(recent,/陶艺比赛/);
    assert.match(recent,/青瓦礼堂/,'positive control for a detail that later fades');
    assert.match(recent,/已完成|已发生|已参加|参加了|已结束/,'the user reported a past event');
    for (const text of ['假如我明天要参加编织比赛，那该多好。','我朋友明天要参加拼图比赛。']) {
      await turn(first,text);
      assert.ok(!(await facts()).some(f => f.episode_status && f.source_text === text), 'not a personal experience: '+text);
    }
    advance(31);
    const faded = await recall('你还记得陶艺比赛吗？请复述我当时的原话。');
    assert.match(faded,/比赛/,'the dated detail faded but a supported topic survived');
    assert.doesNotMatch(faded,/青瓦礼堂|我昨天在/,'even an explicit reminder only gets the gist');
    assert.ok(JSON.stringify((await api('GET','/sessions/'+first)).history).includes(done),'archive preserves the source');

    const edit = await api('PUT','/memory/facts/'+completed.id, {factKey:'个人活动',factValue:'用户手动改成了草编交流会'});
    const corrected = await recall('能说说我那个草编交流会吗？');
    assert.match(corrected,/草编交流会/);
    assert.doesNotMatch(corrected,/陶艺比赛|青瓦礼堂/,'the edited record cannot keep its old derived detail');
    await api('POST','/memory/revisions/'+edit.revisionId+'/undo',{});
    const deleted = await api('DELETE','/memory/facts/'+completed.id, {});
    const afterDelete = await recall('还记得我的陶艺比赛吗？');
    assert.doesNotMatch(afterDelete,/比赛|青瓦礼堂/);
    assert.ok(!(await facts()).some(f => f.id===completed.id && f.active));
    await api('POST','/memory/revisions/'+deleted.revisionId+'/undo',{});
    assert.match(await recall('还记得陶艺比赛吗？'),/比赛/,'undo restores the eligible gist');
    await api('PUT','/settings',{memory:{enabled:false}});
    const disabled = await recall('还记得我的木工面试吗？');
    assert.doesNotMatch(disabled,/木工面试|青瓦礼堂|陶艺比赛/);
    const suppressed = '我今天参加了象棋比赛。';
    await turn(first,suppressed);
    assert.ok(!(await facts()).some(f => f.episode_status && f.source_text===suppressed));
    console.log('memory-episode-e2e: PASS (cross-session continuity, reschedule/cancel, unknown outcome, completed event, faded gist, management and restart; actual loopback prompts)');
  } finally {
    try {
      try {
        if (fixture) {try {await fixture.close();} finally {fixture.cleanup();}}
      } finally {if (provider) await provider.close();}
    } finally {
      Date.now = realNow;
      if (previousDataDir === undefined) delete process.env.DAFEIYU_DATA_DIR;
      else process.env.DAFEIYU_DATA_DIR = previousDataDir;
    }
  }
}
main().catch(error => {console.error(error);process.exitCode=1;});
