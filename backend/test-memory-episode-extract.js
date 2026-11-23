const assert = require('node:assert/strict');
const { extractEpisodeCandidates, broadKindsIn } = require('./electron/brain/memory-episode-extract');
const sent = new Date(2030,10,30,23,59).getTime();
const read = (text,hints=[]) => extractEpisodeCandidates(text,hints,sent);

function one(text, status, topic, gist, hints) {
  const rows = read(text,hints);
  assert.equal(rows.length,1,text);
  const item=rows[0];
  assert.equal(item.status,status,text);
  assert.equal(item.topic,topic,text);
  assert.equal(item.gist,gist,text);
  assert.ok(text.includes(item.evidence) && item.evidence.includes(item.factValue),'source chain: '+text);
  return item;
}

const plan=one('我明天要参加木工面试。','planned','木工面试','面试');
assert.equal(plan.expiresAt,new Date(2030,11,2).getTime());
assert.equal(plan.linkOnly,false);
const moved=one('我的木工面试改到后天了','rescheduled','木工面试','面试');
assert.equal(moved.expiresAt,new Date(2030,11,3).getTime());
assert.equal(one('木工面试改期了','rescheduled','木工面试','面试').expiresAt,null);
one('我把木工面试取消了','cancelled','木工面试','面试');
one('我明天不去木工面试了','cancelled','木工面试','面试');
assert.equal(one('面完了','completed','面试','面试').linkOnly,true);
assert.equal(one('更正一下，我的木工面试没有取消，昨天已经参加了。','completed','木工面试','面试').correctsPrior,true);
one('我明天要出差。你呢？','planned','出差','出差');
one('我约好了体检','planned','体检','体检');
one('我昨天在青瓦礼堂参加了陶艺比赛。','completed','陶艺比赛','比赛');
assert.equal(one('我通过了木工面试','completed','木工面试','通过面试').matchingGist,'面试');
one('我终于拿到了驾照！','completed','驾照','拿到驾照');
one('我收到了大学录取通知书。','completed','录取通知书','收到录取通知');
one('我第一次独自坐飞机了。','completed','乘机','第一次独自乘机');
one('我完成了土壤探测仪原型。','completed','土壤探测仪原型','原型');
const cloudText='我装订了第一本手工笔记本。';
const cloud={category:'event',factValue:'手工笔记本',evidence:cloudText.replace('。',''),episode:{topic:'手工笔记本',status:'completed'}};
one(cloudText,'completed','第一本手工笔记本','装订',[cloud]);
assert.equal(read(cloudText,[{...cloud,importance:1}])[0].importance,1);
assert.equal(read(cloudText,[{...cloud,evidence:'我装订了你的书稿'}]).length,0);
const open='我在工作室亲手雕好了一枚孔雀榫。';
const anchored={category:'event',factValue:'孔雀榫',evidence:open.slice(0,-1),episode:{topic:'孔雀榫',status:'completed'}};
one(open,'completed','孔雀榫','雕好',[anchored]);
assert.deepEqual(read(open,[{...anchored,evidence:'朋友说：'+open}]),[]);
assert.deepEqual(read(open,[{...anchored,episode:{topic:'不存在的榫头',status:'completed'}}]),[]);
assert.deepEqual(broadKindsIn('木工面试，假期又参加了陶艺比赛与木工面试。'),['面试','比赛']);

for (const text of ['我明天参加木工面试吗','明天我能参加木工面试吗？','假如我明天参加木工面试。今天我面完了。',
  '他说：“昨天我休息。我明天参加木工面试。”','我朋友取消了木工面试。','小明的木工面试取消了。',
  '我被告知他取消了比赛。','我在等他参加比赛。','我希望明天参加木工面试。','我的木工面试没有取消。',
  '我明天要取消木工面试。','我错过了陶艺比赛。','我昨天没有参加面试。','我明天参加了比赛。',
  '我明天要参加木工面试和陶艺比赛。','我的木工面试准备完成了。',
  '我喜欢《明天》这首歌。','【用户表情消息】我今天参加了陶艺比赛。',
  '我梦见自己拿到了驾照。','我刚看到小明收到了大学录取通知书。']) {
  assert.deepEqual(read(text),[],text);
}
console.log('memory-episode-extract: PASS (source-anchored state, local date, first-person milestones, coarse gist, corrections and absent/ambiguous evidence)');
