// Public prompt builders and management routes: the conversation archive is not automatic recall.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const root = path.resolve(__dirname, '../temp');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'memory-source-guard-'));
  const previous = process.env.DAFEIYU_DATA_DIR;
  process.env.DAFEIYU_DATA_DIR = dir;
  const settings = require('./electron/brain/settings'), load = settings.loadSettings;
  settings.loadSettings = () => ({ memory: { enabled: true, autoExtract: false, retentionDays: 0 } });
  const mem = require('./electron/brain/memory'), audit = require('./electron/brain/memory-audit');
  const api = require('./memory-api'), { semanticText } = require('./sticker-semantics');
  const oldNow = Date.now, oldFetch = global.fetch, day = 86400000;
  let clock = Date.UTC(2030, 1, 10), calls = 0;
  Date.now = () => clock;
  global.fetch = async () => { calls++; throw Error('No network in source guard test'); };
  try {
    const db = mem.initMemory(), sessionId = 'source-guard';
    const history = () => mem.getPromptHistory(sessionId, 40).map(m => m.content).join('\n');
    const cityContext = () => mem.buildMemoryContext('你还记得我住哪里吗？能把那段原话再讲一遍吗？',{sessionId,tokenBudget:1400});
    const blocks = () => [
      mem.buildMemoryContext('能把我们刚聊的那段原话再讲一遍吗？', { sessionId, tokenBudget: 1400 }),
      mem.buildMemoryContext('', { sessionId, tokenBudget: 1200 }),
      mem.buildCallMemoryBrief({ sessionId, tokenBudget: 1000 }),
    ];
    function turn(userText, reply) {
      clock += 10;
      return mem.saveChatTurn({ sessionId, userText, reply, extract: false }).userMessageId;
    }
    const quote = value => '用户原话：' + value;
    const summary = (start, end, lines) => mem.insertSummary(sessionId, start, end, lines.map(quote).join('\n'));
    function excludes(items, values, message) {
      for (const item of items) for (const value of values)
        assert.ok(!item.includes(value), message + ': ' + value);
    }
    async function route(method, routePath, body) {
      clock += 10;
      const result = await api.handle({ method, path: routePath, db, body });
      assert.equal(result.status, 200);
      return result.body;
    }
    const ancient = '古早原话薄荷钟', ancientId = turn(ancient, '古早回声霓虹灯');
    summary(ancientId, ancientId, [ancient]);
    clock += day + 100;
    const source = '我住在潮州，窗边放着蓝色玻璃瓶。', city = turn(source, '第一轮回声琥珀塔');
    const factId = audit.upsert(db, { category: 'other', factKey: '居住地', factValue: '潮州',
      importance: 5, sourceMessageId: city, evidence: source });
    const other = '我刚发现了紫藤花。', independentId = turn(other, '没有来源引用的回声：潮州的橙色大桥。');
    const stickerMarker = '分类注解海鸥酥', sticker = semanticText({ semantic: { name: '测试图',
      text: stickerMarker, meaning: '图片上的文字', tone: '不确定', usage: '闲聊', cautions: '仅图片', confidence: 'high' } });
    const stickerId = turn(sticker, '表情回复铜铃');
    const otherSession = 'unrelated-dialogue';
    clock += 10;
    mem.saveChatTurn({ sessionId: otherSession, userText: '我们在做纸模型。', reply: '先把底座折好。', extract: false });
    // Legacy ranges can contain a mixture of safe sources, corrected facts, synthetic input and unrelated prose.
    summary(city, stickerId, [source, other, sticker, '伪造摘录椰子树']);
    mem.insertSummary(sessionId, null, null, '无来源旧摘要橄榄枝');
    assert.ok(history().includes(source));
    assert.ok(cityContext().includes('潮州') && !cityContext().includes(other),
      'the current conversation has its verified quotes; a targeted fact lookup excludes unrelated summary lines');
    for (const block of blocks()) {
      assert.ok(block.includes(other), 'keep the independent recent excerpt in each prompt builder');
      assert.ok(block.includes(quote(source)), 'original recent and verified excerpt is initially allowed');
    }
    excludes([history(), ...blocks()], [ancient, '古早回声霓虹灯', '无来源旧摘要橄榄枝', '伪造摘录椰子树'], 'no archival/forged prose');
    assert.ok(history().includes('【用户表情消息】') && history().includes(stickerMarker),
      'short-term dialogue preserves the explicit metadata marker, as opposed to claiming it as user testimony');
    excludes(blocks(), [stickerMarker], 'sticker metadata must not appear as a recalled fact or a user quotation');

    const edit = await route('PUT', '/memory/facts/' + factId, { factValue: '昆明' });
    assert.ok(mem.getPromptHistory(otherSession, 10).some(m => m.role === 'assistant' && m.content === '先把底座折好。'),
      'an edit elsewhere does not truncate unrelated assistant dialogue');
    const recentAfterEdit = '我们来聊点别的。';
    turn(recentAfterEdit, '这是订正之后的新回复。');
    excludes([history(), ...blocks()], ['潮州', '蓝色玻璃瓶', '第一轮回声琥珀塔', '橙色大桥'], 'correction excludes old quotations and disconnected assistant echoes');
    assert.ok(history().includes(recentAfterEdit) && history().includes('订正之后的新回复'));
    assert.ok(cityContext().includes('昆明') && !cityContext().includes('潮州'));
    for (const block of blocks()) {
      assert.ok(block.includes('昆明'), 'current fact replaces stale detail');
      assert.ok(block.includes(other), 'one invalidated line must not discard a whole mixed summary');
    }
    await route('POST', '/memory/revisions/' + edit.revisionId + '/undo');
    for (const block of blocks()) {
      assert.ok(block.includes(quote(source)), 'undo restores still-recent, source-supported facts');
      assert.ok(!block.includes('昆明'));
    }
    const removed = await route('DELETE', '/memory/facts/' + factId);
    excludes([history(), ...blocks()], ['潮州', '蓝色玻璃瓶', '橙色大桥'], 'deleted fact is not replayed');
    for (const block of blocks()) assert.ok(block.includes(other));
    await route('POST', '/memory/revisions/' + removed.revisionId + '/undo');
    assert.ok(history().includes(source));
    clock += day + 100;
    assert.equal(history(), '', 'no verbatim past turns fetched on explicit reminder once the conversation window ends');
    assert.ok(cityContext().includes('潮州') && !cityContext().includes('蓝色玻璃瓶'));
    const oldBlocks = blocks();
    excludes(oldBlocks, ['蓝色玻璃瓶', other, '橙色大桥', stickerMarker, ancient], 'no raw archive or summary detail');
    for (const block of oldBlocks) assert.ok(block.includes('潮州'), 'the supported important gist remains');
    const management = await route('GET', '/memory');
    assert.equal(management.facts.find(f => f.id === factId).source_text, source);
    assert.ok(management.summaries.some(s => s.summary.includes(stickerMarker) && s.summary.includes(other)));
    assert.ok(management.summaries.some(s => s.summary === '无来源旧摘要橄榄枝'));
    assert.equal(db.prepare('SELECT content FROM messages WHERE id=?').get(independentId).content, other);
    // A real extraction pass builds only current, attributable summary lines.
    // No model is configured. An all-media window must not stall later text.
    settings.loadSettings = () => ({memory:{enabled:true,autoExtract:true,retentionDays:0}});
    const batchSid = 'summary-window';
    const old = mem.saveChatTurn({sessionId:batchSid,userText:'旧归档锚点',reply:'好',extract:false});
    mem.insertSummary(batchSid,old.userMessageId,old.userMessageId,'旧归档锚点');
    clock += day + 100;
    for (let i=0;i<10;i++) mem.saveChatTurn({sessionId:batchSid,userText:sticker,reply:'图已收到',extract:false});
    const currentText = '我刚借到一本书。';
    const current = mem.saveChatTurn({sessionId:batchSid,userText:currentText,reply:'好',extract:false});
    await mem.processCommittedTurn({sessionId:batchSid,userText:currentText,userMessageId:current.userMessageId});
    const latest = db.prepare('SELECT summary FROM summaries WHERE session_id=? ORDER BY id DESC LIMIT 1').get(batchSid).summary;
    assert.equal(latest,quote(currentText));

    // Natural expiry has no latest-edit timestamp; a later unrelated turn can still echo the old fact.
    const soonGone = '白鹭港口通行证';
    const ticketId = turn('临时计划是办' + soonGone + '。', '这件事先记着。');
    audit.upsert(db, { category: 'plan', factKey: '本周临时计划', factValue: soonGone, importance: 4,
      factType: 'temporary', expiresAt: clock + 100, sourceMessageId: ticketId, evidence: soonGone });
    turn('我想换个话题。', '等办完' + soonGone + '再来聊。');
    assert.ok(history().includes('等办完' + soonGone));
    clock += 101;
    excludes([history(), ...blocks()], [soonGone], 'unattributed assistant echo in another turn after natural expiry');
    assert.equal(calls, 0);
    console.log('memory-source-guard: PASS (history, mixed/legacy summaries, corrections/deletion/undo, echoes, sticker metadata, ageing, preserved archive; no network)');
  } finally {
    mem.closeMemory();
    Date.now = oldNow;
    global.fetch = oldFetch;
    settings.loadSettings = load;
    if (previous === undefined) delete process.env.DAFEIYU_DATA_DIR;
    else process.env.DAFEIYU_DATA_DIR = previous;
    assert.equal(path.dirname(dir), root, 'unsafe fixture cleanup');
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
