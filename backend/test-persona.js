// Persona alignment uses isolated local config/SQLite and a fake loopback model only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

async function main() {
  const tempRoot = path.resolve(__dirname, '../temp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(tempRoot, 'persona-test-'));
  process.env.DAFEIYU_DATA_DIR = dataDir;
  const observed = [];
  const fake = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    observed.push(JSON.parse(Buffer.concat(chunks)));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '[{"text":"收到。","delay":0}]' } }] }));
  });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  let backend;
  try {
    const settings = require('./electron/brain/settings');
    const userData = require('./electron/user-data');
    const { createBackend } = require('./service');
    // Missing settings reads remain pure and retain the previous default persona behavior.
    assert.equal(settings.loadSettings().personality.dimensions, null);
    assert.ok(!fs.existsSync(path.join(dataDir, 'brain-settings.json')));
    const originalPersona = '  我是莉莉安。原有人格文字与空白完整保留。\n';
    settings.saveSettings({ memory: { autoExtract: false }, cognition: { enabled: false }, proactive: { enabled: false }, cloud: {
      baseUrl: `http://127.0.0.1:${fake.address().port}/v1`, apiKey: 'fake-private-key', model: 'local-fake',
    }, systemPrompt: originalPersona });
    backend = await createBackend();
    const file = path.join(dataDir, 'brain-settings.json');
    const stableId = userData.getActiveUserId();
    async function api(method, route, body) {
      const res = await fetch(backend.descriptor.url + route, { method,
        headers: { Authorization: 'Bearer ' + backend.descriptor.token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, data: await res.json() };
    }
    const dimensions = { languageStyle: 'playful', archetype: 'gentle', verbosity: 0.1, humor: 0.9 };
    const saved = await api('PUT', '/settings', {
      characterName: ' 小鲸 ', ownerName: ' 阿沐 ', personality: { dimensions },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.characterName, '小鲸');
    assert.equal(saved.data.ownerName, '阿沐');
    assert.equal(saved.data.cloud.apiKey, '***');
    assert.ok(!JSON.stringify(saved.data).includes('fake-private-key'));
    assert.deepEqual(saved.data.personality.dimensions, dimensions);
    assert.ok(saved.data.personality.prompt.includes('网络俏皮'));
    assert.ok(saved.data.personality.prompt.includes('温柔体贴'));
    assert.ok(saved.data.personality.prompt.includes('简短利落'));
    assert.equal(saved.data.systemPrompt, originalPersona);
    assert.equal(settings.loadSettings().cloud.apiKey, 'fake-private-key');
    assert.equal(settings.loadSettings().ownerId, 'local');
    assert.equal(userData.getActiveUserId(), stableId);

    const id = (await api('POST', '/sessions')).data.session_id;
    assert.equal((await api('POST', '/chat', { session_id: id, request_id: 'persona-first', text: '你好' })).status, 200);
    const outgoing = observed[0].messages[0].content;
    // Keep a literal copy of the tested wire contract, independent of the production builder.
    const format = '只输出消息的 JSON 数组。文字项为 {"text":"消息内容","delay":0}，delay 是相对上一条的毫秒数，第一项为 0。';
    const core = originalPersona + '\n\n' + saved.data.personality.prompt + '\n\n角色名：小鲸。当前聊天对象：阿沐。\n' + format;
    assert.ok(outgoing.startsWith(core), 'the full persona, personality, names and message format precede runtime context');
    assert.equal(outgoing.split('【性格设定】').length - 1, 1, 'personality is appended exactly once');
    assert.doesNotMatch(outgoing, /【多条回复模式】|【接着聊天】/);
    assert.doesNotMatch(outgoing.slice(core.length), /莉莉安|主人|你是大肥鱼/);

    // Model-only saves preserve persona, and persona-only saves preserve all model credentials.
    const before = settings.loadSettings();
    assert.equal((await api('PUT', '/settings', { cloud: { model: 'another-fake' } })).status, 200);
    const afterModel = settings.loadSettings();
    assert.deepEqual(afterModel.personality, before.personality);
    assert.equal(afterModel.ownerName, before.ownerName);
    assert.equal(afterModel.systemPrompt, originalPersona);
    assert.equal((await api('PUT', '/settings', { personality: { dimensions: { warmth: 0.1 } } })).status, 200);
    assert.equal(settings.loadSettings().personality.dimensions.languageStyle, 'playful');
    assert.equal(settings.loadSettings().personality.dimensions.warmth, 0.1);
    assert.equal(settings.loadSettings().cloud.model, 'another-fake');
    assert.equal(settings.loadSettings().cloud.apiKey, 'fake-private-key');

    const invalid = [
      { characterName: '' }, { ownerName: 'bad\nname' }, { ownerName: 'x'.repeat(61) },
      { ownerId: 'different-user' }, { personality: { prompt: 'injected stale prompt' } },
      { personality: { dimensions: { humor: 2 } } }, { personality: { dimensions: { humor: '0.5' } } },
      { personality: { dimensions: { languageStyle: 'unknown' } } },
      { personality: { dimensions: { unknownDimension: 0.5 } } }, { personality: { dimensions: [] } },
    ];
    for (const value of invalid) {
      const bytes = fs.readFileSync(file, 'utf8');
      assert.equal((await api('PUT', '/settings', value)).status, 400);
      assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'invalid input must not change configuration');
    }
    assert.equal((await api('PUT', '/settings', { ownerName: '新称呼', personality: { dimensions: null } })).status, 200);
    const reset = settings.loadSettings();
    assert.equal(reset.personality.dimensions, null);
    assert.equal(reset.personality.prompt, '');
    assert.equal(reset.systemPrompt, originalPersona);
    assert.equal(reset.ownerId, 'local');
    assert.equal(userData.getActiveUserId(), stableId);
    assert.equal((await api('POST', '/chat', { session_id: id, request_id: 'persona-second', text: '继续聊' })).status, 200);
    assert.ok(observed[1].messages.some(item => item.role === 'assistant' && item.content === '收到。'));
    const afterRename = observed[1].messages[0].content;
    assert.ok(afterRename.startsWith(originalPersona + '\n\n角色名：小鲸。当前聊天对象：新称呼。\n' + format));
    assert.doesNotMatch(afterRename, /【性格设定】|【多条回复模式】|【接着聊天】/);
    assert.equal((await api('GET', '/sessions/' + id)).data.history.length, 4);
    console.log('persona-test: PASS (original dimensions, partial saves, dynamic names, stable identity/history, one personality block, validation)');
  } finally {
    if (backend) await backend.close();
    fake.closeAllConnections();
    await new Promise(resolve => fake.close(resolve));
    if (!dataDir.startsWith(tempRoot + path.sep)) throw new Error('Unsafe test path');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
