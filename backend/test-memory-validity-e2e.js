// Only loopback HTTP and a disposable SQLite fixture. Inspect the delivered prompt, not the model's canned answer.
const assert = require('node:assert/strict');
const { startFixture, isOrdinaryChatRequest } = require('./test-alignment-e2e');

async function main() {
  const originalNow = Date.now;
  const oldDataDir = process.env.DAFEIYU_DATA_DIR;
  let offset = 0, fixture;
  Date.now = () => originalNow() + offset;
  try {
    fixture = await startFixture();
    let seq = 0;
    async function chat(text) {
      const begin = fixture.calls.length;
      const reply = await fixture.api('POST', '/chat', { session_id: 'main', request_id: 'validity-' + (++seq), text });
      const calls = fixture.calls.slice(begin).filter(x => x.model === 'fake-chat' &&
        isOrdinaryChatRequest(x) && x.messages.at(-1).content === text);
      assert.equal(calls.length, 1, 'captured the actual chat model request');
      assert.match(calls[0].messages[0].content, /【当前情绪】[^\n]+\n【依恋状态】[^\n]+/);
      return { reply, messages: calls[0].messages, transmitted: JSON.stringify(calls[0]) };
    }
    const source = '我住在北京。说到这事，我心里很难过，窗边那颗青色玻璃珠还在。';
    const independent = '方格纸上的月牙是我刚画的。';
    await chat(source);
    const fact = (await fixture.api('GET', '/memory')).facts.find(f => f.active === 1 && f.fact_key === '城市');
    assert.equal(fact?.fact_value, '北京');
    assert.equal(fact.source_text, source, 'actual extractor grounds the fact in the committed HTTP turn');
    // Have the fixture actually deliver an explicit echo in a different turn.
    const recalled = await chat('还记得我住哪里吗？');
    assert.ok(recalled.messages[0].content.includes('北京'));
    assert.ok(recalled.reply.text.includes('你住在北京'));
    const preEdit = await chat(independent);
    assert.ok(preEdit.messages.some(m => m.role === 'assistant' && m.content.includes('你住在北京')),
      'positive control: the earlier echo really was part of HTTP history before correction');
    await fixture.api('PUT', '/memory/facts/' + fact.id, { factValue: '昆明' });
    const corrected = await chat('我居住的城市是哪里？');
    assert.ok(corrected.messages[0].content.includes('昆明'), 'corrected gist reaches the model');
    assert.ok(corrected.messages.some(m => m.role === 'user' && m.content === independent),
      'an unrelated short-term turn still reaches the model after correction');
    for (const obsolete of ['北京', '青色玻璃珠'])
      assert.ok(!corrected.transmitted.includes(obsolete), 'corrected detail leaked into the actual HTTP request: ' + obsolete);
    offset += 86400000 + 2000;
    fixture.advance(86400000 + 2000);
    const reminded = await chat('提醒你一下，我们之前聊过我居住的城市，你还能复述当时的原话吗？');
    assert.ok(reminded.messages[0].content.includes('昆明'));
    for (const archival of ['北京', '青色玻璃珠', '方格纸上的月牙', '我居住的城市是哪里？'])
      assert.ok(!reminded.transmitted.includes(archival), 'explicit reminder must not reopen old details: ' + archival);
    const saved = (await fixture.api('GET', '/memory')).facts.find(f => f.id === fact.id);
    assert.equal(saved.fact_value, '昆明');
    assert.equal(saved.source_text, source);
    const archived = await fixture.api('GET', '/sessions/main');
    assert.ok(JSON.stringify(archived.history).includes(independent), 'the original dialogue archive remains available to the user');
    console.log('memory-validity-e2e: PASS (actual HTTP source/extraction/edit, current gist, cognition + history, independent context, surviving archive, next-day reminder; fixture model only)');
  } finally {
    try { if (fixture) { try { await fixture.close(); } finally { fixture.cleanup(); } } }
    finally {
      Date.now = originalNow;
      if (oldDataDir === undefined) delete process.env.DAFEIYU_DATA_DIR;
      else process.env.DAFEIYU_DATA_DIR = oldDataDir;
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
