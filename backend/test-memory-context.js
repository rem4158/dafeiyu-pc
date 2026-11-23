// Focused context-selection regression: isolated SQLite, no models or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const tempRoot = path.resolve(__dirname, '../temp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tempRoot, 'memory-context-'));
  const previousDataDir = process.env.DAFEIYU_DATA_DIR;
  process.env.DAFEIYU_DATA_DIR = dir;
  const originalFetch = global.fetch;
  let networkCalls = 0;
  global.fetch = async () => { networkCalls++; throw new Error('No network allowed in context tests'); };
  const settings = require('./electron/brain/settings');
  const originalLoad = settings.loadSettings;
  settings.loadSettings = () => ({ memory: { enabled: true, autoExtract: false, retentionDays: 0 } });
  const memory = require('./electron/brain/memory');
  const audit = require('./electron/brain/memory-audit');
  const people = require('./electron/brain/memory-people');
  let db;
  try {
    db = memory.initMemory();
    const tables = ['facts', 'memory_fact_revisions', 'messages', 'user_people', 'user_profile',
      'summaries', 'memory_people_sources', 'memory_entity_revisions'];
    function reset() {
      for (const table of tables) db.exec('DELETE FROM ' + table);
    }
    function addFact(key, value, options = {}) {
      const source = `${key}：${value}`;
      const { userMessageId } = memory.saveChatTurn({ userText: source, reply: '收到。', extract: false });
      return audit.upsert(db, { category: 'other', factKey: key, factValue: value, importance: 3,
        sourceMessageId: userMessageId, evidence: source, ...options });
    }
    function snapshot() {
      return Object.fromEntries(tables.map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY id').all()]));
    }
    function readOnly(check) {
      const before = snapshot();
      check();
      assert.deepEqual(snapshot(), before, 'recall must not rewrite facts, sources, revisions or history');
    }
    function context(query, options = {}) {
      const tokenBudget = options.tokenBudget ?? 800;
      const value = memory.buildMemoryContext(query, { tokenBudget, ...options });
      assert.ok(Math.ceil(value.length / 1.5) <= tokenBudget,
        'complete returned context, including headings and instructions, must fit its estimated budget');
      return value;
    }
    function occurrences(text, needle) { return text.split(needle).length - 1; }

    // Real lexical matches survive; feature-vector lookalikes must not be evidence.
    reset();
    const city = addFact('城市', '北京');
    const garden = addFact('常去的地方', '植物园');
    const editor = addFact('Editor', 'VSCode');
    const gift = addFact('纪念物', '珊瑚吊坠', { keywords: JSON.stringify(['生日礼物']) });
    readOnly(() => {
      assert.deepEqual(memory.searchFacts('香蕉'), [], 'unrelated text must not fall back to recent facts');
      assert.deepEqual(memory.searchFacts('北京').map(fact => fact.id), [city]);
      assert.deepEqual(memory.searchFacts('vscode').map(fact => fact.id), [editor]);
      assert.deepEqual(memory.searchFacts('生日礼物').map(fact => fact.id), [gift]);
      assert.ok(memory.searchFacts('我想先和你说说最近的一些生活安排以及周末去植物园的事情')
        .some(fact => fact.id === garden), 'a Chinese keyword near the end of a sentence must remain searchable');
      assert.deepEqual(new Set(memory.searchFacts('', 20).map(fact => fact.id)), new Set([city, garden, editor, gift]));
      assert.ok(memory.getMemoryOverview('main', 20).layers.relatedFacts.some(fact => fact.id === city),
        'memory overview still uses an explicit empty-query listing');
      const unrelatedContext = context('香蕉');
      assert.ok(!unrelatedContext.includes('北京') && !unrelatedContext.includes('珊瑚吊坠'));
    });

    reset();
    addFact('主题', '长期陪伴');
    readOnly(() => assert.deepEqual(memory.searchFacts('数据库迁移'), [],
      'similar statistical text features are not semantic evidence'));

    // Recalls keep inactive/expired records out without mutating their audit trail.
    reset();
    const live = addFact('保留记录', '有效锚点');
    const expired = addFact('临时计划', '过期面试', { factType: 'temporary', expiresAt: Date.now() - 1000 });
    const removed = addFact('旧住处', '南京');
    audit.remove(db, removed);
    readOnly(() => {
      assert.deepEqual(memory.searchFacts('过期面试'), []);
      assert.deepEqual(memory.searchFacts('南京'), []);
      const ids = memory.searchFacts('', 20).map(fact => fact.id);
      assert.ok(ids.includes(live) && !ids.includes(expired) && !ids.includes(removed));
      assert.ok(!context('过期面试 南京').includes('过期面试'));
    });

    // No recent-person fallback; explicit names, aliases and family terms still work.
    reset();
    people.upsertPerson(db, { displayName: '小明', aliases: ['阿明'], relationType: 'friend', notes: '朋友证据标记' });
    people.upsertPerson(db, { displayName: '妈妈', relationType: 'family', notes: '家人证据标记' });
    readOnly(() => {
      assert.equal(people.buildPeopleContextBlock(db, '今天去散步。'), '');
      assert.equal(people.buildPeopleContextBlock(db, ''), '');
      assert.ok(people.buildPeopleContextBlock(db, '小明最近怎么样？').includes('朋友证据标记'));
      assert.ok(people.buildPeopleContextBlock(db, '我想和阿明聊聊。').includes('朋友证据标记'));
      assert.ok(people.buildPeopleContextBlock(db, '我妈今天来。').includes('家人证据标记'));
      assert.ok(!context('今天去散步。').includes('朋友证据标记'));
    });

    // An oversized important item cannot discard all subsequent short items.
    reset();
    const longValue = '长内容不可切断'.repeat(200);
    const longId = addFact('超长重要记录', longValue, { importance: 5 });
    addFact('短重要记录', '短记忆锚点', { importance: 5 });
    db.prepare('UPDATE facts SET updated_at=? WHERE id=?').run(Date.now() + 1000, longId);
    readOnly(() => {
      const value = context('', { tokenBudget: 240, maxContextFacts: 4 });
      assert.ok(value.includes('短记忆锚点'), 'short important memory still fits after a long first item');
      assert.ok(!value.includes('长内容不可切断'), 'oversized fact is skipped, not partially quoted');
      assert.equal(occurrences(value, '短记忆锚点'), 1, 'a selected fact appears only once');
    });

    // A relevant important fact can use more than the general background allowance.
    reset();
    const mediumValue = '完整中段记录：' + '细'.repeat(210) + '中段锚点';
    addFact('中等长度记录', mediumValue, { importance: 5 });
    readOnly(() => {
      const value = context('中段锚点', { tokenBudget: 280, maxContextFacts: 2 });
      assert.ok(value.includes(mediumValue), 'a relevant fact can use the full remaining context budget');
      assert.equal(occurrences(value, mediumValue), 1);
    });

    // Explicit query matches take the fact slots before unrelated important background.
    reset();
    addFact('长期收藏', '无关重要珊瑚标记', { importance: 5 });
    addFact('旅行目的地', '植物园相关标记', { importance: 3 });
    readOnly(() => {
      const value = context('植物园', { maxContextFacts: 1 });
      assert.ok(value.includes('植物园相关标记'));
      assert.ok(!value.includes('无关重要珊瑚标记'), 'importance alone must not displace an explicit match');
    });

    // The accepted-item cap must not truncate the candidate list before budget checks.
    reset();
    addFact('石楠露营路线', '过长相关记录'.repeat(250));
    addFact('周末路线', '露营短记忆锚点');
    readOnly(() => {
      const value = context('石楠露营', { tokenBudget: 240, maxContextFacts: 1 });
      assert.ok(value.includes('露营短记忆锚点'), 'a long top candidate cannot hide a fitting lower-ranked candidate');
      assert.ok(!value.includes('过长相关记录'));
    });

    // maxContextFacts counts important and related facts together, independently of profile.
    reset();
    addFact('首条记录', '第一事实标记', { importance: 5 });
    addFact('次条记录', '第二事实标记');
    addFact('普通记录', '第三事实标记');
    readOnly(() => {
      const one = context('事实标记', { maxContextFacts: 1 });
      assert.equal(['第一事实标记', '第二事实标记', '第三事实标记'].filter(marker => one.includes(marker)).length, 1);
      const two = context('事实标记', { maxContextFacts: 2 });
      assert.equal(['第一事实标记', '第二事实标记', '第三事实标记'].filter(marker => two.includes(marker)).length, 2);
      assert.ok(context('', { maxContextFacts: 2 }).includes('事实标记'), 'proactive empty-query context retains important facts');
      assert.equal(context('事实标记', { maxContextFacts: 0 }), '');
      for (const budget of [0, 1, 20, 90, 180]) context('事实标记', { tokenBudget: budget });
    });
    addFact('名字', '上下文测试者', { category: 'profile' });
    memory.refreshGroundedProfile();
    readOnly(() => {
      const value = context('事实标记', { maxContextFacts: 0 });
      assert.ok(value.includes('上下文测试者'), 'disabling fact blocks does not disable the core profile');
      assert.ok(!value.includes('事实标记'));
    });

    // Summaries are admitted individually; a large summary cannot swallow a short one.
    reset();
    const longSummary = '超长摘要必须整条跳过'.repeat(150);
    for (const content of [longSummary, '短摘要保留标记']) {
      const {userMessageId} = memory.saveChatTurn({userText:content,reply:'收到。',extract:false});
      memory.insertSummary('main', userMessageId, userMessageId, '用户原话：'+content);
    }
    readOnly(() => {
      const value = context('', { tokenBudget: 240, maxContextFacts: 0 });
      assert.ok(value.includes('短摘要保留标记'));
      assert.ok(!value.includes('超长摘要必须整条跳过'));
    });

    // A recent user quote can phrase a fact differently from the delivered
    // reply. The source ID still identifies it in optional summaries/history.
    reset();
    const statement = '杭州是我的常住地。';
    const {userMessageId} = memory.saveChatTurn({userText:statement,reply:'知道啦。',extract:false});
    audit.upsert(db,{category:'profile',factKey:'城市',factValue:'杭州',importance:4,
      sourceMessageId:userMessageId,evidence:statement});
    memory.insertSummary('main',userMessageId,userMessageId,'用户原话：'+statement);
    assert.ok(context('').includes(statement));
    const mentions = require('./electron/brain/memory-mentions');
    assert.equal(mentions.recordDeliveredMentions(db,'记得你住在杭州。'),1);
    readOnly(() => {
      assert.ok(!context('').includes('杭州'),'neither a profile nor an optional summary should revive the topic');
      assert.ok(!memory.getPromptHistory('main',10,{proactive:true}).some(m=>m.content.includes('杭州')));
      assert.ok(memory.getPromptHistory('main',10).some(m=>m.content===statement),'ongoing conversation can continue normally');
    });
    addFact('喜欢：乌龙茶','乌龙茶',{category:'preference'});
    addFact('喜欢：山水画','山水画',{category:'preference'});
    assert.equal(mentions.recordDeliveredMentions(db,['你喜欢乌龙茶。','你喜欢山水画。']),2);
    readOnly(() => {
      const tea = context('我喜欢哪种茶？');
      assert.ok(tea.includes('乌龙茶') && !tea.includes('山水画'),'asking about tea does not reopen an unrelated cooled preference');
      const general = context('我喜欢什么？');
      assert.ok(general.includes('乌龙茶') && general.includes('山水画'));
    });

    // A single fact slot exposes whether recall can interpret a daily-life
    // question, without succeeding by printing the user's entire profile.
    reset();
    const home = addFact('城市','杭州',{category:'profile'});
    const favorite = addFact('喜欢：乌龙茶','乌龙茶',{category:'preference'});
    addFact('不喜欢：冰咖啡','冰咖啡',{category:'preference'});
    addFact('喜欢：山水画','山水画',{category:'preference',importance:5});
    addFact('收藏暗号','无关纪念品',{importance:5});
    const quote = '上一次聊到的私人物品。';
    const source = memory.saveChatTurn({userText:quote,reply:'嗯。',extract:false}).userMessageId;
    memory.insertSummary('main',source,source,'用户原话：'+quote);
    readOnly(() => {
      assert.deepEqual(memory.searchFacts('我平时喝什么？',1).map(f=>f.id),[favorite]);
      assert.deepEqual(memory.searchFacts('我住在哪儿？',1).map(f=>f.id),[home]);
      assert.deepEqual(memory.searchFacts('我朋友平时喝什么？'),[]);
      const drinks = context('给我推荐杯饮料吧。');
      assert.ok(drinks.includes('乌龙茶') && drinks.includes('冰咖啡'));
      assert.ok(!drinks.includes('山水画') && !drinks.includes('杭州') && !drinks.includes(quote));
      for (const question of ['我平时吃什么？','你平时喝什么？','绿茶和红茶有什么区别？']) {
        const answer = context(question);
        for (const privateValue of ['乌龙茶','冰咖啡','山水画','杭州',quote,'无关纪念品']) {
          assert.ok(!answer.includes(privateValue),question+' must not pull in '+privateValue);
        }
      }
    });

    assert.equal(networkCalls, 0, 'context selection never calls a model or embedding service');
    console.log('memory-context: PASS (lexical relevance, empty-query overview, named people, item budgets/caps, dedup/fallback, complete summaries, immutable sources/audit; no network)');
  } finally {
    memory.closeMemory();
    settings.loadSettings = originalLoad;
    global.fetch = originalFetch;
    if (previousDataDir === undefined) delete process.env.DAFEIYU_DATA_DIR;
    else process.env.DAFEIYU_DATA_DIR = previousDataDir;
    assert.ok(path.resolve(dir).startsWith(tempRoot + path.sep), 'unsafe fixture cleanup');
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
