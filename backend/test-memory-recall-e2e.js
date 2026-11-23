// Exercise one disposable user's memory through the PC HTTP entry points.
// The assertions inspect the input received by the loopback provider.
const assert = require('node:assert/strict');
const { startFixture, isOrdinaryChatRequest } = require('./test-alignment-e2e');

async function main() {
  const originalNow = Date.now;
  const originalDir = process.env.DAFEIYU_DATA_DIR;
  let now = new Date(2030, 4, 6, 9, 15).getTime();
  Date.now = () => now;
  let fixture;
  try {
    fixture = await startFixture();
    const api = fixture.api;
    await api('PUT','/settings',{voice:{enabled:false},stickers:{enabled:false},proactive:{enabled:false}});
    let seq = 0;
    const fresh = async () => (await api('POST','/sessions',{})).session_id;
    const facts = async () => (await api('GET','/memory')).facts;
    function advance(ms) { now+=ms; fixture.advance(ms); }
    async function turn(text, sessionId) {
      advance(50);
      const firstCall = fixture.calls.length;
      const reply = await api('POST','/chat',{session_id:sessionId || await fresh(),request_id:'recall-'+(++seq),text});
      const requests = fixture.calls.slice(firstCall).filter(c=>isOrdinaryChatRequest(c) && c.messages.at(-1).content===text);
      assert.equal(requests.length,1,'one actual chat request for '+text);
      // The last message contains the question. It cannot be evidence of recall.
      return {prompt:requests[0].messages.slice(0,-1).map(m=>m.content).join('\n'), reply};
    }
    async function check(text, present, absent) {
      const {prompt} = await turn(text);
      for (const word of present) assert.ok(prompt.includes(word),text+' should recall '+word);
      for (const word of absent) assert.ok(!prompt.includes(word),text+' should exclude '+word);
      return prompt;
    }

    const home = await fresh();
    const tea = '桂花乌龙茶', dislikedTea = '白桃花茶', coffee = '榛果拿铁';
    const hobby = '山水画', name = '青禾', city = '北京';
    const sources = [
      [tea,'我喜欢'+tea+'。你平时喝什么？'], [dislikedTea,'我不喜欢'+dislikedTea+'。'], [coffee,'我不喜欢'+coffee+'。'], [hobby,'我喜欢'+hobby+'。'],
      [name,'我叫'+name+'。'], [city,'我住在'+city+'。'],
    ];
    for (const [,source] of sources) await turn(source,home);
    await turn('我朋友叫鹿白。鹿白有一只猫。',home);
    const originalMemory = await api('GET','/memory');
    const before = originalMemory.facts;
    for (const [value,source] of sources) {
      assert.ok(before.some(f=>f.active===1 && f.fact_value===value && f.source_text===source
        && f.source_session_id===home),'committed fact is grounded in its actual chat: '+value);
    }

    await check('我平时喝什么？',[tea],[dislikedTea,coffee,hobby,name,city]);
    const advice = await check('帮我挑杯饮料吧。',[tea,dislikedTea,coffee],[hobby,name,city]);
    assert.match(advice,/不喜欢[^\n。；]{0,8}榛果拿铁/,'a recommendation gets the negative preference with its polarity');
    await check('我偏爱哪种茶？',[tea],[dislikedTea,coffee,hobby,name,city]);
    await check('我不喜欢哪种茶？',[dislikedTea],[tea,coffee,hobby,name,city]);
    await check('你平时怎么称呼我？',[name],[hobby,tea,coffee,city]);
    for (const query of ['我朋友平时喝什么？','你平时爱喝什么？','茶和咖啡有什么区别？','我爱吃什么菜？']) {
      await check(query,[],[tea,dislikedTea,coffee,hobby,name,city]);
    }
    await check('我朋友鹿白养了什么宠物？',['鹿白','有一只猫'],[tea,coffee,hobby,name,city]);
    await turn('我喜欢喝什么');
    await turn('我叫什么来着');
    await turn('我朋友爱喝什么');
    const afterQuestions = await api('GET','/memory');
    assert.deepEqual(afterQuestions.facts,before,'questions do not add, rewrite or reinforce user facts, even without punctuation');
    assert.deepEqual(afterQuestions.people,originalMemory.people,'asking about a friend must not create a person named after the question');

    // The fixture actually replies with this city. First prove that its
    // delivery triggered the cooldown, then reopen it with a different phrase.
    const said = await turn('还记得我住哪里吗？');
    assert.ok(said.prompt.includes(city) && said.reply.text.includes('你住在'+city));
    await fixture.restart();
    await check('讲个小故事吧。',[],[city]);
    await check('我的常住地在哪儿？',[city],[name,tea,coffee,hobby]);
    const storedCity = before.find(f=>f.fact_value===city);
    const newCity = '昆明';
    await api('PUT','/memory/facts/'+storedCity.id,{factValue:newCity});
    await check('我的常住地在哪儿？',[newCity],[city,hobby]);
    await api('PUT','/settings',{memory:{enabled:false}});
    await check('我的常住地在哪儿？',[],[newCity,city,tea]);
    await api('PUT','/settings',{memory:{enabled:true}});

    // The same user has an ordinary experience as well as a stable preference.
    // A later direct reminder can still find the gist, without reopening the
    // archived venue or the original utterance when the details have faded.
    const plan = '我明天要参加陶艺比赛。', venue = '青瓦礼堂';
    const completed = '我昨天在'+venue+'参加了陶艺比赛。';
    await turn(plan,home);
    const planned = (await facts()).find(f=>f.active && f.source_text===plan && f.episode_status==='planned');
    assert.ok(planned);
    await check('接着聊上次那件事吧。',['陶艺比赛'],[venue]);
    const day = 86400000;
    advance(2*day);
    await turn(completed,home);
    assert.ok((await facts()).some(f=>f.id===planned.id && f.episode_status==='completed' && f.source_text===completed));
    await check('那次陶艺比赛怎么样了？',[venue],[]);
    advance(31*day);
    await fixture.restart();
    const faded = await check('我提醒你是陶艺比赛，能复述我当时的原话吗？',['比赛'],[venue,'陶艺比赛',completed]);
    assert.match(faded,/大意|记不清|无法确认/);
    assert.ok(JSON.stringify((await api('GET','/sessions/'+home)).history).includes(completed));
    await check('我偏爱哪种茶？',[tea],[venue,coffee,hobby,city]);
    console.log('memory-recall-e2e: PASS (real HTTP paraphrases, scoped and grounded preferences, questions, correction, cooldown, restart, memory switch and faded episode; fixture provider)');
  } finally {
    try { if (fixture) {try {await fixture.close();} finally {fixture.cleanup();}} }
    finally {
      Date.now = originalNow;
      if (originalDir===undefined) delete process.env.DAFEIYU_DATA_DIR;
      else process.env.DAFEIYU_DATA_DIR=originalDir;
    }
  }
}
main().catch(error=>{console.error(error); process.exitCode=1;});
