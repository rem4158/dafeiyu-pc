// Runs the actual migrated HTTP/chat/SQLite path against a local fake model only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-backend-test-'));
  process.env.DAFEIYU_DATA_DIR = dir;
  const observed = [];
  let slowStarted;
  let signalSlow;
  const fake = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    observed.push(body);
    const input = body.messages.at(-1).content;
    if (input === 'slow') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': waiting\n\n');
      signalSlow?.();
      return;
    }
    if (input === 'fail') { res.writeHead(500); res.end('secret-provider-body'); return; }
    const reply = input === 'first' ? '[{"text":"第一句。","delay":0},{"text":"第二句。","delay":25}]'
      : '[{"text":"我记得上一轮。","delay":0}]';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
  });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  let backend;
  try {
    const settings = require('./electron/brain/settings');
    const originalPersona = '你是大肥鱼，用户是主人。原有设定：你可以联网搜索并发送语音。保留这段原有性格描述。';
    settings.saveSettings({ stickers: { enabled: true, sourceRoot: require('./fixtures/sticker-library').createStickerLibrary(dir) }, memory: { autoExtract: false }, cognition: { enabled: false }, proactive: { enabled: false }, cloud: { baseUrl: `http://127.0.0.1:${fake.address().port}/v1`,
      apiKey: 'local-test-key', model: 'fake-model' }, systemPrompt: originalPersona });
    const { createBackend } = require('./service');
    backend = await createBackend();
    async function api(method, route, body, extra = {}) {
      const res = await fetch(backend.descriptor.url + route, { method,
        headers: { Authorization: 'Bearer ' + backend.descriptor.token, 'Content-Type': 'application/json', ...extra },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, data: await res.json() };
    }
    assert.equal((await api('GET', '/health')).data.configured, true);
    assert.equal((await api('GET', '/health', undefined, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await api('GET', '/health', undefined, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await api('GET', '/settings')).data.cloud.apiKey, '***');
    assert.equal((await api('PUT', '/settings', { cloud: { apiKey: '***' } })).status, 200);
    assert.equal(settings.loadSettings().cloud.apiKey, 'local-test-key');
    const id = (await api('POST', '/sessions')).data.session_id;
    const first = { session_id: id, request_id: 'one', text: 'first' };
    const [one, duplicate] = await Promise.all([api('POST', '/chat', first), api('POST', '/chat', first)]);
    assert.equal(one.status, 200);
    assert.deepEqual(one.data, duplicate.data);
    assert.equal(observed.length, 1, 'duplicate requests only call model once');
    assert.equal(one.data.messages.length, 2);
    assert.equal(one.data.messages[1].text, '第二句。');
    assert.ok(!JSON.stringify(observed[0]).includes('莉莉安'));
    assert.ok(JSON.stringify(observed[0]).includes('主人'));
    const system = observed[0].messages[0].content;
    assert.ok(system.startsWith(originalPersona + '\n\n角色名：大肥鱼。当前聊天对象：主人。\n只输出消息的 JSON 数组。'));
    assert.equal(settings.loadSettings().systemPrompt, originalPersona);
    assert.doesNotMatch(system, /【多条回复模式】|【接着聊天】/);
    assert.match(system, /"sticker"/);
    const categories = Object.keys(require('./stickers').getStickerMap(settings.loadSettings()));
    assert.ok(categories.length > 0, 'the default sticker library should expose categories');
    for (const category of categories) assert.ok(system.includes(category), 'missing sticker category ' + category);
    const tools = observed[0].tools.map(tool => tool.function);
    assert.ok(tools.some(tool => tool.name === 'browser_read_page'));
    assert.ok(!tools.some(tool => tool.name === 'qq_send'), 'public PC chat has no private messaging tool');
    assert.ok(!tools.some(tool => tool.name === 'pc_send'), 'PC sends ordinary replies locally');
    assert.equal((await api('POST', '/chat', { ...first, text: 'changed' })).status, 409);
    const second = await api('POST', '/chat', { session_id: id, request_id: 'two', text: 'second' });
    assert.equal(second.status, 200);
    assert.ok(observed[1].messages.some(m => m.role === 'assistant' && m.content === '第一句。\n第二句。'));
    assert.ok(observed[1].messages.some(m => m.role === 'user' && m.content === 'first'));
    const history = (await api('GET', '/sessions/' + id)).data.history;
    assert.deepEqual(history.map(row => row.content.message[0].text),
      ['first', '第一句。', '第二句。', 'second', '我记得上一轮。']);
    assert.equal((await api('POST', '/chat', { session_id: 'absent', request_id: 'no', text: 'first' })).status, 404);
    assert.equal((await api('POST', '/chat', { session_id: id, request_id: 'file', text: 'first', files: ['x'] })).status, 400);
    const failed = await api('POST', '/chat', { session_id: id, request_id: 'failed', text: 'fail' });
    assert.equal(failed.status, 502);
    assert.ok(!JSON.stringify(failed.data).includes('secret-provider-body'));
    assert.equal((await api('GET', '/sessions/' + id)).data.history.length, 5);
    slowStarted = new Promise(resolve => { signalSlow = resolve; });
    const slow = api('POST', '/chat', { session_id: id, request_id: 'slow', text: 'slow' });
    await slowStarted;
    assert.equal((await api('GET', '/sessions/' + id)).data.is_running, true);
    assert.equal((await api('POST', '/sessions/' + id + '/stop')).data.stopped, true);
    assert.equal((await slow).data.cancelled, true);
    assert.equal((await api('GET', '/sessions/' + id)).data.history.length, 5);
    const { DatabaseSync } = require('node:sqlite');
    const inspect = new DatabaseSync(path.join(dir, 'companion-memory.db'));
    assert.equal(inspect.prepare('SELECT count(*) n FROM facts').get().n, 0, 'no speculative facts are auto-written');
    inspect.close();
    await backend.close();
    assert.ok(!fs.existsSync(path.join(dir, 'backend.json')));
    backend = await createBackend();
    assert.equal((await api('GET', '/sessions/' + id)).data.history.length, 5);
    const count = observed.length;
    assert.deepEqual((await api('POST', '/chat', first)).data, one.data);
    assert.equal(observed.length, count, 'restart replay is persisted and never calls model again');
    const serialId = (await api('POST', '/sessions')).data.session_id;
    const serialStart = observed.length;
    const serialResults = await Promise.all([
      api('POST', '/chat', { session_id: serialId, request_id: 'serial-first', text: 'first' }),
      api('POST', '/chat', { session_id: serialId, request_id: 'serial-second', text: 'second' }),
    ]);
    assert.ok(serialResults.every(result => result.status === 200));
    assert.ok(observed[serialStart + 1].messages.some(m => m.role === 'assistant' && m.content === '第一句。\n第二句。'),
      'concurrent distinct requests in one session serialize before reading context');
    assert.equal((await api('GET', '/sessions/' + serialId)).data.history.length, 5);
    console.log('backend-service: PASS (auth, isolation, actual chat/parser, segmented persistence, context, idempotency, cancellation, failure, restart)');
  } finally {
    await backend?.close();
    fake.closeAllConnections();
    await new Promise(resolve => fake.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
