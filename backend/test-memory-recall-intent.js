// Questions and rows use the PC extractor's current and older fact shapes.
const assert = require('node:assert/strict');
const {analyzeRecallIntent,legacyPreferenceValues} = require('./electron/brain/memory-recall-intent');

const facts = {
  tea:{category:'preference',factKey:'喜欢：桂花乌龙茶',factValue:'桂花乌龙茶'},
  habit:{category:'habit',factKey:'常喝：龙井',factValue:'龙井'},
  avoided:{category:'preference',factKey:'不喜欢：白桃花茶',factValue:'白桃花茶'},
  coffee:{category:'preference',factKey:'不喜欢',factValue:'喝榛果拿铁'},
  art:{category:'preference',factKey:'喜欢：山水画',factValue:'山水画',keywords:'["茶"]'},
  food:{category:'preference',factKey:'喜欢：牛肉拉面',factValue:'牛肉拉面'},
  sweet:{category:'preference',factKey:'喜欢：抹茶饼干',factValue:'抹茶饼干'},
  opaque:{category:'preference',factKey:'喜欢',factValue:'霜叶',keywords:'["茶"]'},
  namedTea:{category:'habit',factKey:'常喝',factValue:'老枞水仙',keywords:'["茶"]'},
  name:{category:'profile',factKey:'名字',factValue:'青禾'},
  city:{category:'profile',fact_key:'居住地',fact_value:'北京'},
  job:{category:'profile',factKey:'用户职业',factValue:'木匠'},
  friend:{category:'profile',factKey:'朋友的名字',factValue:'小田'},
  oldHome:{category:'profile',factKey:'曾居地',factValue:'上海'},
};
function selected(q) {
  const intent = analyzeRecallIntent(q);
  assert.equal(intent?.scope,'self',q);
  return Object.keys(facts).filter(k=>intent.matchesFact(facts[k]));
}
function expect(q,keys) { assert.deepEqual(selected(q),keys,q); }
expect('我平时喝什么？',['tea','habit','namedTea']);
for (const [query,verb] of [['我平时喝什么？','喝'],['我平时吃什么？','吃']]) {
  const {matchesFact} = analyzeRecallIntent(query);
  const sourced={category:'preference',factKey:'喜欢：岚七',factValue:'岚七',keywords:JSON.stringify(['@source-action:'+verb])};
  assert.ok(matchesFact(sourced));
  assert.ok(matchesFact({...sourced,keywords:JSON.stringify(['地方特产','@source-action:'+verb])}),
    'an explicit action survives a confirmation of a fact with older keywords');
  assert.equal(matchesFact({...sourced,keywords:JSON.stringify([verb])}),false,'a free-form legacy model keyword is insufficient');
}
expect('我偏爱哪种茶？',['tea']);
expect('推荐一杯适合我的咖啡。',['coffee']);
expect('帮我挑杯饮料吧。',['tea','habit','avoided','coffee','namedTea']);
expect('我最讨厌什么茶？',['avoided']);
expect('我喜欢白桃花茶吗？',['avoided']);
expect('我爱吃什么菜？',['food','sweet']);
expect('我平时有什么兴趣爱好？',['art']);
expect('我喜欢什么？',['tea','art','food','sweet','opaque']);
expect('我叫什么来着？',['name']);
expect('你平时怎么称呼我？',['name']);
expect('我的常住地在哪儿？',['city']);
expect('你还记得我做哪一行吗？',['job']);
expect('我住在哪座城市？',['city']);
expect('我在哪座城市工作？',[]);
expect('我的老家在哪里？',[]);
assert.ok(analyzeRecallIntent('我住哪里？').matchesFact({category:'other',factKey:'居住地',factValue:'潮州'}));
const door = {category:'profile',factKey:'现居地',factValue:'清溪路123号'};
assert.equal(analyzeRecallIntent('我住在哪座城市？').matchesFact(door),false);
assert.ok(analyzeRecallIntent('我家的详细地址是什么？').matchesFact(door));

for (const q of ['我朋友爱喝哪种茶？','小田平时喝什么？','我想知道阿青住哪里？','帮我给小吴推荐一杯饮料！','她以前住哪？','我朋友面试怎么样？']) {
  const intent=analyzeRecallIntent(q);
  assert.equal(intent?.scope,'external',q);
  assert.equal(intent.allowPeople,true,q);
  assert.ok(Object.values(facts).every(f=>!intent.matchesFact(f)),q);
}
for (const q of ['你平时爱喝什么？','茶和咖啡有什么区别？','你家在哪儿？','我怎么称呼你？','给我科普什么是乌龙茶。']) {
  const intent=analyzeRecallIntent(q);
  assert.equal(intent?.scope,'external',q);
  assert.equal(intent.allowPeople,false,q);
}
for (const q of ['','我明天要参加木雕面试。','接着聊那场比赛怎么样？','上次去哪里面试？','讲个故事。','今天喝过什么茶？']) {
  assert.equal(analyzeRecallIntent(q),null,q);
}
for (const [noun,forms] of [['桂花乌龙茶',['喝桂花乌龙茶']],['巧克力饼干',['吃巧克力饼干']],
  ['鸡',[]],['喝乌龙茶',[]],['咖啡杯',[]],['山水画',[]],['青禾',[]]]) {
  assert.deepEqual(legacyPreferenceValues(noun),forms,noun);
}
console.log('memory-recall-intent: PASS (self vs recipient, scoped grounded facts, positive/avoid/advice, lexical fallback and legacy food/drink actions)');
