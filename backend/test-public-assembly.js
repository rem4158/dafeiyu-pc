const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

test('a backend copied without extensions keeps PC chat and protects old QQ records', async () => {
  const tempRoot = fs.realpathSync(path.resolve(__dirname, '../temp'));
  const app = fs.mkdtempSync(path.join(tempRoot, 'qq-assembly-'));
  const backendDir = path.join(app, 'backend');
  const dataDir = path.join(app, 'data');
  const previousDataDir = process.env.DAFEIYU_DATA_DIR;
  process.env.DAFEIYU_DATA_DIR = dataDir;
  fs.cpSync(__dirname, backendDir, { recursive: true, filter: filename => {
    const name = path.basename(filename);
    return !['node_modules', 'nianan'].includes(name) && !name.startsWith('test-');
  } });
  assert.equal(fs.existsSync(path.join(app, 'extensions', 'qq')), false);

  const observed = [];
  const model = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    observed.push(JSON.parse(raw));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '[{"text":"本地回复。","delay":0}]' } }] }));
  });
  const { createBackend } = require(path.join(backendDir, 'service'));
  const settings = require(path.join(backendDir, 'electron/brain/settings'));
  let backend;
  async function api(method, route, body) {
    const { url, token } = backend.descriptor;
    const response = await fetch(url + route, { method, headers: { Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  try {
    await new Promise((resolve, reject) => model.once('error', reject).listen(0, '127.0.0.1', resolve));
    settings.saveSettings({ cloud: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
      apiKey: 'fixture-model-key', model: 'fixture' } });
    const configPath = path.join(dataDir, 'brain-settings.json');
    const oldQQ = { enabled: true, accessToken: 'fixture-qq-token' };
    fs.writeFileSync(configPath, JSON.stringify({ ...settings.loadSettings(), qq: oldQQ }));

    backend = await createBackend();
    assert.equal((await api('GET', '/health')).data.configured, true);
    assert.equal(Object.hasOwn((await api('GET', '/settings')).data, 'qq'), false);
    assert.equal((await api('PUT', '/settings', { qq: { enabled: false } })).status, 404);
    assert.equal((await api('PUT', '/settings', { ownerName: '测试用户' })).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).qq, oldQQ);
    for (const [method, suffix] of [['GET', ''], ['POST', '/start'], ['POST', '/stop'], ['POST', '/send'], ['POST', '/test']]) {
      const result = await api(method, '/extensions/qq' + suffix, method === 'POST' ? {} : undefined);
      assert.equal(result.status, 404);
    }

    const [{ session_id: sessionId }] = (await api('GET', '/sessions')).data;
    const result = await api('POST', '/chat', { session_id: sessionId, request_id: 'fixture-pc', text: '你好' });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.text, '本地回复。');
    const turn = observed.find(value => value.tools?.some(tool => tool.function.name === 'usage_status'));
    assert.ok(turn);
    const tools = turn.tools.map(tool => tool.function.name);
    assert.ok(tools.includes('qq_music'));
    assert.deepEqual(tools.filter(name => name === 'pc_send' || name.startsWith('qq_')), ['qq_music']);
    assert.ok(!turn.messages[0].content.includes('QQ 通道'));

    const dbPath = path.join(dataDir, 'companion-memory.db');
    await backend.close();
    backend = undefined;
    const oldDb = new DatabaseSync(dbPath);
    try {
      assert.equal(oldDb.prepare("SELECT name FROM sqlite_master WHERE name='qq_events'").get(), undefined);
      oldDb.exec("CREATE TABLE qq_events (request_id TEXT, direction TEXT); INSERT INTO qq_events VALUES ('old-qq','inbound')");
      oldDb.prepare("INSERT INTO pc_requests(request_id,session_id,user_text,state,created_at,updated_at) VALUES('old-qq',?,'历史私聊','cancelled',1,1)").run(sessionId);
      oldDb.prepare("INSERT INTO pc_messages(session_id,request_id,role,parts_json,created_at) VALUES(?,'old-qq','user',?,1)")
        .run(sessionId, JSON.stringify([{ type: 'plain', text: '历史私聊' }]));
    } finally { oldDb.close(); }
    backend = await createBackend();
    const history = await api('GET', '/sessions/' + sessionId);
    assert.equal(history.status, 200);
    assert.ok(!JSON.stringify(history.data).includes('历史私聊'));
    assert.ok(JSON.stringify(history.data).includes('本地回复'));
  } finally {
    await backend?.close();
    model.closeAllConnections();
    if (model.listening) await new Promise(resolve => model.close(resolve));
    if (previousDataDir === undefined) delete process.env.DAFEIYU_DATA_DIR;
    else process.env.DAFEIYU_DATA_DIR = previousDataDir;
    assert.equal(path.dirname(fs.realpathSync(app)), tempRoot);
    fs.rmSync(app, { recursive: true, force: true });
  }
});
