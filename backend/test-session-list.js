// Exercise the PC session list against a disposable SQLite database and a loopback model.
const assert = require('node:assert/strict');
const { startFixture } = require('./test-alignment-e2e');

async function main() {
  const fixture = await startFixture();
  const { api } = fixture;
  const hide = id => api('POST', '/sessions/' + id + '/hide', {});
  const list = () => api('GET', '/sessions');
  const fresh = async () => (await api('POST', '/sessions', {})).session_id;
  const send = input => api('POST', '/chat', input);
  const history = id => api('GET', '/sessions/' + id);
  async function checkError(route, body, status, code) {
    const { url, token } = fixture.backend.descriptor;
    const response = await fetch(url + route, { method: 'POST', body: JSON.stringify(body),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code);
  }
  try {
    const source = '我住在北京。';
    const input = { session_id: 'main', request_id: 'original', text: source };
    const reply = await send(input);
    const archivedHistory = await history('main');
    const archivedMemory = (await api('GET', '/memory')).facts;
    assert.ok(archivedMemory.some(row => row.source_text === source && row.source_session_id === 'main'));

    const inactive = await fresh();
    const keep = await fresh();
    const presence = session_id => api('POST', '/companion/presence', { session_id, quiet: false });
    await presence('main');
    assert.equal((await hide(inactive)).next_session_id, 'main');
    const result = await hide('main');
    assert.equal(result.session_id, 'main');
    assert.equal(result.next_session_id, keep);
    assert.deepEqual(result.sessions.map(row => row.session_id), [keep]);
    assert.deepEqual(result.sessions, await list());
    assert.deepEqual(await history('main'), archivedHistory);
    assert.deepEqual((await api('GET', '/memory')).facts, archivedMemory);

    // A lagging PC heartbeat or cached request must leave the selected visible target alone.
    await presence('main');
    const requests = fixture.calls.length;
    assert.deepEqual(await send(input), reply);
    assert.equal(fixture.calls.length, requests);
    await checkError('/chat', { ...input, request_id: 'stale-send' }, 409, 'session_hidden');
    await checkError('/sessions/not-a-session/hide', {}, 404, 'session_not_found');
    assert.equal((await hide('main')).next_session_id, keep);

    const [last, retry] = await Promise.all([hide(keep), hide(keep)]);
    assert.deepEqual(last, retry);
    const next = last.next_session_id;
    assert.notEqual(next, keep);
    assert.deepEqual((await list()).map(row => row.session_id), [next]);
    assert.deepEqual((await history(next)).history, []);
    await fixture.restart();
    assert.deepEqual(await list(), last.sessions);
    assert.deepEqual(await history('main'), archivedHistory);
    assert.deepEqual((await api('GET', '/memory')).facts, archivedMemory);
    await presence('main');

    // Hold media enrichment to attempt hiding while a real request is still in progress.
    const media = require('./media');
    const enrich = media.enrichMessages;
    const reached = Promise.withResolvers(), release = Promise.withResolvers();
    let turn;
    try {
      media.enrichMessages = async (...args) => {
        reached.resolve();
        await release.promise;
        return enrich(...args);
      };
      turn = send({ session_id: next, request_id: 'recall', text: '还记得我住哪里吗？' });
      await Promise.race([turn, reached.promise]);
      await checkError('/sessions/' + next + '/hide', {}, 409, 'session_busy');
      assert.deepEqual(await list(), last.sessions);
    } finally {
      release.resolve();
      media.enrichMessages = enrich;
      if (turn) await turn;
    }
    const recall = fixture.calls.find(call => call.messages?.at(-1)?.content === '还记得我住哪里吗？');
    assert.ok(recall.messages[0].content.includes('北京'), 'source in a hidden session is still recalled');

    // A proactive delivery after a stale presence report belongs to the visible conversation.
    await api('POST','/companion/presence',{session_id:next,quiet:false,
      reply_completed:{session_id:next,request_id:'recall'}});
    await presence('main');
    fixture.advance(180000);
    const sent = await fixture.backend.companion.tick();
    assert.equal(sent.sent, true, sent.reason);
    const events = await api('GET', '/events?after=0');
    assert.equal(events.events.at(-1).session_id, next);
    assert.deepEqual(await history('main'), archivedHistory);
    console.log('session-list: PASS (visibility, retry, restart, history, grounded recall, busy turn, proactive routing)');
  } finally {
    await fixture.close();
    fixture.cleanup();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
