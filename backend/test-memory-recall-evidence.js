// Exercise the two extractors that feed committed turns. The provider returns
// plausible but deliberately misattributed fragments of the real input.
const assert = require('node:assert/strict');
const {extractFromUserMessage} = require('./electron/brain/extract');
const {extractMemoriesWithLLM} = require('./electron/brain/memory-extract-llm');

async function main() {
  let modelItems, calls=0;
  const originalFetch=global.fetch;
  const settings={provider:'cloud',cloud:{baseUrl:'http://fixture.invalid/v1',apiKey:'fixture',model:'fixture'}};
  global.fetch=async url => {
    assert.equal(url,settings.cloud.baseUrl+'/chat/completions');
    calls++;
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(modelItems)}}]}));
  };
  const extract=text=>extractFromUserMessage(text).facts;
  const proposal=(category,key,value,evidence)=>({category,key,value,evidence});
  async function infer(text,items) {
    modelItems=items;
    const result = await extractMemoriesWithLLM(text,'我推荐的茶是龙井。',settings);
    assert.ok(!result.failed);
    return result.facts;
  }
  try {
    for (const text of ['我喜欢哪种茶','你还记得我叫什么吗','给朋友推荐一款红茶','根据我的口味推荐红茶',
      '如果我喜欢红茶呢','你知道我喜欢红茶吗？','朋友问我喜欢什么','同事说：“我喜欢红茶”']) {
      const before = calls;
      assert.deepEqual(extract(text),[],text);
      assert.deepEqual(await infer(text,[proposal('preference','喜欢','茶','茶')]),[],text);
      assert.equal(calls,before,'a request/hypothetical does not call the extractor');
    }
    const likes = extract('我平时爱喝桂花乌龙茶，我也喜欢山水画。');
    for (const mixed of ['我喜欢桂花乌龙茶。你平时喝什么？','你喝什么？我喜欢桂花乌龙茶。','我喜欢桂花乌龙茶，你呢？',
      '朋友说：“我喜欢红茶。你呢？”；我喜欢桂花乌龙茶。','我喜欢桂花乌龙茶。朋友说：「我喜欢红茶。还喜欢咖啡。」',
      '朋友说：“我喜欢红茶。”，但我喜欢桂花乌龙茶，你最爱哪一种？']) {
      assert.deepEqual(extract(mixed).map(f=>f.factValue),['桂花乌龙茶'],mixed);
      assert.deepEqual((await infer(mixed,[proposal('preference','喜欢','桂花乌龙茶','我喜欢桂花乌龙茶'),
        proposal('preference','喜欢','红茶','我喜欢红茶')])).map(f=>f.factValue),['桂花乌龙茶']);
    }
    for (const unsupported of ['我朋友说：“你喝什么？我喜欢红茶。还有「我喜欢白茶」。”',
      '朋友说：“她问我什么？我喜欢红茶。','比如：\n我喜欢红茶。你呢？',
      '我们来玩角色扮演。我喜欢红茶。你呢？','同事说，今天没有咖啡。我喜欢红茶。你喝什么？',
      '如果有客人，我喜欢红茶，你觉得呢？','假设朋友说：“我喜欢白茶。”，而我喜欢红茶，你呢？',
      '我喜欢红茶，对吗？','我喜欢红茶。刚才是开玩笑的。']) {
      assert.deepEqual(extract(unsupported),[],unsupported);
      assert.deepEqual(await infer(unsupported,[proposal('preference','喜欢','红茶','我喜欢红茶')]),[]);
    }
    assert.deepEqual(likes.map(f=>[f.factKey,f.factValue]),[['喜欢','桂花乌龙茶'],['喜欢','山水画']]);
    assert.deepEqual(likes[0].legacyValues,['喝桂花乌龙茶']);
    assert.deepEqual(JSON.parse(likes[0].keywords),['@source-action:喝']);
    assert.equal(likes[1].evidence,'我也喜欢山水画');
    const habit = extract('我平时喝茉莉花茶。')[0];
    assert.equal(habit.category,'habit'); assert.equal(habit.factValue,'茉莉花茶');
    const change = extract('我以前喜欢喝焙茶，现在不再喜欢喝焙茶了。');
    assert.equal(change.length,1);
    assert.equal(change[0].operation,'retractPreference');
    assert.deepEqual(change[0].legacyValues,['喝焙茶']);
    assert.equal(change[0].factValue,'焙茶');
    assert.equal(extract('我不喜欢咖啡。')[0].factKey,'不喜欢');
    assert.deepEqual(await infer('我不再喜欢焙茶了。',[proposal('preference','讨厌','焙茶','焙茶')]),[]);
    assert.deepEqual(await infer('我平时喝茉莉花茶。',[proposal('preference','喜欢','茉莉花茶','茉莉花茶')]),[]);
    assert.deepEqual(await infer('我以前喜欢焙茶。',[proposal('preference','喜欢','焙茶','喜欢焙茶')]),[]);
    assert.deepEqual(await infer('我给朋友推荐了红茶。',[proposal('preference','喜欢','红茶','红茶')]),[]);
    assert.deepEqual(await infer('我朋友喜欢红茶。',[proposal('preference','喜欢','红茶','喜欢红茶')]),[]);
    assert.deepEqual(extract('我朋友喜欢红茶，我不喜欢红茶。').map(f=>f.factKey),['不喜欢']);
    const personal = await infer('我住在杭州，我朋友住在苏州。',[
      {...proposal('profile','城市','杭州','住在杭州'),keywords:['杭州','@source-action:喝']},
      proposal('profile','城市','苏州','住在苏州')]);
    assert.deepEqual(personal.map(f=>f.factValue),['杭州']);
    assert.deepEqual(JSON.parse(personal[0].keywords),['杭州']);
    assert.equal((await infer('杭州是我的常住地。',[proposal('profile','城市','杭州','杭州')])).length,1);
    assert.deepEqual(extract('我的现居城市是杭州。').map(f=>[f.factKey,f.factValue]),[['城市','杭州']]);
    assert.deepEqual(extract('我的现居地是清溪路八号。').filter(f=>f.factKey==='城市'),[]);
    assert.deepEqual(await infer('我在苏州上班。',[proposal('profile','现居城市','苏州','苏州')]),[]);
    assert.deepEqual(await infer('我住在北京路八号。',[proposal('other','现居地','北京','北京')]),[]);
    const moved = await infer('我从柳州搬到了昆明。',[proposal('profile','现居地','柳州','柳州'),
      proposal('profile','现居地','昆明','昆明')]);
    assert.deepEqual(moved.map(f=>f.factValue),['昆明']);
    assert.equal((await infer('I live in Boston.',[proposal('profile','城市','Boston','I live in Boston')])).length,1);
    assert.deepEqual(await infer('I work in Boston.',[proposal('profile','现居地','Boston','Boston')]),[]);
    assert.deepEqual(await infer('My friend lives in Boston.',[proposal('profile','城市','Boston','Boston')]),[]);
    console.log('memory-recall-evidence: PASS (implicit questions, recipient vs owner, habits, polarity, retraction, cropped model quotes and current evidence)');
  } finally {
    global.fetch=originalFetch;
  }
}
main().catch(err=>{console.error(err);process.exitCode=1;});
