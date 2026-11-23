// Saved and draft model probes: fake providers and isolated SQLite only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

async function main() {
  const tempRoot = path.resolve(__dirname, '../temp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(tempRoot, 'settings-test-'));
  process.env.DAFEIYU_DATA_DIR = dataDir;
  const calls = [];
  const failures = new Map([
    ['fail-model', { status: 401, code: 'invalid_api_key', expected: 'model_test_auth' }],
    ['access-model', { status: 403, code: 'permission_denied', expected: 'model_test_access' }],
    ['quota-model', { status: 429, code: 'insufficient_quota', expected: 'model_test_quota' }],
    ['rate-model', { status: 429, code: 'rate_limit_exceeded', expected: 'model_test_rate_limit' }],
    ['parameter-model', { status: 400, code: 'unsupported_parameter', expected: 'model_test_parameters' }],
    ['missing-model', { status: 404, code: 'model_not_found', expected: 'model_test_parameters' }],
    ['unprocessable-model', { status: 422, code: 'invalid_request_error', expected: 'model_test_parameters' }],
    ['server-model', { status: 500, code: 'server_error', expected: 'model_test_failed' }],
    ['malicious-code-model', { status: 500, code: 'private-provider-body-and-key', expected: 'model_test_failed' }],
  ]);
  let holdStarted;
  let release;
  const fake = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const input = JSON.parse(Buffer.concat(chunks));
    calls.push({ route: req.url, input, authorization: req.headers.authorization });
    const failure = failures.get(input.model);
    if (failure) {
      res.writeHead(failure.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: failure.code,
        message: 'private-provider-body-and-key', param: 'private-provider-body-and-key' } }));
      return;
    }
    if (input.model === 'network-model') {
      req.socket.destroy();
      return;
    }
    if (input.model === 'empty-model') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '' } }] }));
      return;
    }
    if (input.model.startsWith('gpt-6') && ('max_tokens' in input || 'temperature' in input)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'unsupported_parameter', message: 'strict fake OpenAI rejection' } }));
      return;
    }
    if (input.model === 'hold-model') {
      await new Promise(resolve => { release = resolve; holdStarted(); });
    }
    if (req.url === '/api/chat') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(JSON.stringify({ message: { content: 'OK' }, done: true }) + '\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
    }
  });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  const networkFetch = globalThis.fetch;
  const presetCalls = [];
  const proxyProbes = [];
  const appliedProxies = [];
  let backend;
  try {
    const { createBackend } = require('./service');
    const settings = require('./electron/brain/settings');
    const memory = require('./electron/brain/memory');
    const { MODEL_PRESETS } = require('./model-presets');
    const localProvider = `http://127.0.0.1:${fake.address().port}`;
    const routes = new Map(Object.entries(MODEL_PRESETS).map(([id, preset]) => [
      `${preset.baseUrl}/${id === 'openai' ? 'responses' : 'chat/completions'}`, id]));
    const fakePresetFetch = async (url, opts) => {
      const id = routes.get(url);
      if (!id) throw new Error('Unexpected model URL');
      const input = JSON.parse(opts.body);
      const authorization = opts.headers.Authorization;
      presetCalls.push({ id, input, authorization });
      assert.equal(opts.redirect, 'error');
      if (authorization === 'Bearer rejected-key')
        return Response.json({ error: { code: 'invalid_api_key', message: 'private-provider-body-and-key' } }, { status: 401 });
      const probe = input.tool_choice === 'none';
      if (id === 'openai') {
        const output = probe || input.input.some(item => item.type === 'function_call_output')
          ? [{ type: 'message', content: [{ type: 'output_text', text: probe ? 'OK' : '预设聊天通过' }] }]
          : [{ type: 'function_call', call_id: 'fake_tool', name: 'memory_list_teachings', arguments: '{}' }];
        return Response.json({ status: 'completed', output });
      }
      const message = probe || input.messages.some(item => item.role === 'tool')
        ? { content: probe ? 'OK' : '预设聊天通过' }
        : { content: null, reasoning_content: id === 'kimi' ? 'synthetic-reasoning' : undefined,
          tool_calls: [{ id: 'fake_tool', type: 'function', function: { name: 'memory_list_teachings', arguments: '{}' } }] };
      return Response.json({ choices: [{ message }] });
    };
    backend = await createBackend({
      applyProxy: async proxy => { appliedProxies.push(proxy); },
      createModelTestFetch: async proxy => { proxyProbes.push(proxy); return fakePresetFetch; },
    });
    globalThis.fetch = async (url, opts) => {
      if ([localProvider, backend.descriptor.url].includes(new URL(url).origin)) return networkFetch(url, opts);
      return fakePresetFetch(url, opts);
    };
    async function api(method, route, body, token = backend.descriptor.token) {
      const response = await fetch(backend.descriptor.url + route, { method,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    }
    assert.equal((await api('POST', '/settings/test', {})).data.code, 'not_configured');
    assert.equal((await api('POST', '/settings/test', {}, 'wrong')).status, 401);
    const defaultBrowser = (await api('GET','/settings')).data.browser;
    assert.equal(defaultBrowser.backgroundIntervalMinutes,5);
    assert.deepEqual(defaultBrowser.autonomousBlockedSites,[]);
    const savedBrowser = (await api('PUT','/settings',{browser:{backgroundIntervalMinutes:8}})).data.browser;
    assert.deepEqual(savedBrowser,{...defaultBrowser,backgroundIntervalMinutes:8});
    for (const invalid of [0,121,1.5,'5']) {
      assert.equal((await api('PUT','/settings',{browser:{backgroundIntervalMinutes:invalid}})).data.code,'invalid_browser_settings');
    }
    for (const invalid of ['tieba',['unregistered'],['tieba','tieba']]) {
      assert.equal((await api('PUT','/settings',{browser:{autonomousBlockedSites:invalid}})).data.code,'invalid_browser_settings');
    }
    assert.deepEqual((await api('GET','/settings')).data.browser,savedBrowser);
    settings.saveSettings({ cloud: { baseUrl: `http://127.0.0.1:${fake.address().port}/v1`,
      apiKey: 'fake-local-key', model: 'test-model' } });
    const db = memory.initMemory();
    const tables = ['messages', 'facts', 'events', 'summaries', 'user_profile', 'user_people', 'pc_messages', 'pc_requests'];
    const counts = () => tables.map(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    const before = counts();
    let saved = fs.readFileSync(path.join(dataDir, 'brain-settings.json'), 'utf8');
    assert.deepEqual(await api('POST', '/settings/test', {}), { status: 200, data: { ok: true, message: '连接成功' } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input.max_tokens, 16);
    assert.equal(calls[0].input.messages.length, 1);
    assert.equal(calls[0].route, '/v1/chat/completions');
    assert.equal(fs.readFileSync(path.join(dataDir, 'brain-settings.json'), 'utf8'), saved);
    assert.deepEqual(counts(), before, 'connection probes never create history or memory');

    settings.saveSettings({ cloud: { model: 'gpt-6.1-terra' } });
    saved = fs.readFileSync(path.join(dataDir, 'brain-settings.json'), 'utf8');
    assert.equal((await api('POST', '/settings/test', {})).status, 200,
      'saved GPT probes work against a provider which rejects legacy parameters');
    assert.equal(calls.at(-1).input.max_completion_tokens, 1024);
    assert.equal(calls.at(-1).input.messages.length, 1);
    assert.equal(fs.readFileSync(path.join(dataDir, 'brain-settings.json'), 'utf8'), saved);
    assert.deepEqual(counts(), before);

    for (const [model, { expected }] of [...failures,
      ['network-model', { expected: 'model_test_network' }], ['empty-model', { expected: 'model_test_empty' }]]) {
      settings.saveSettings({ cloud: { model } });
      saved = fs.readFileSync(path.join(dataDir, 'brain-settings.json'), 'utf8');
      const previousCalls = calls.length;
      const failure = await api('POST', '/settings/test', {});
      assert.equal(failure.status, 502, model);
      assert.equal(failure.data.code, expected, model);
      assert.ok(!JSON.stringify(failure).includes('private-provider-body-and-key'));
      assert.equal(calls.length, previousCalls + 1, 'failed probes never auto-retry');
      assert.equal(fs.readFileSync(path.join(dataDir, 'brain-settings.json'), 'utf8'), saved);
      assert.deepEqual(counts(), before, 'failed probes never create history or memory');
    }

    settings.saveSettings({ cloud: { model: 'hold-model' } });
    const started = new Promise(resolve => { holdStarted = resolve; });
    const first = api('POST', '/settings/test', {});
    await started;
    assert.equal((await api('POST', '/settings/test', {})).status, 409);
    assert.equal((await api('PUT', '/settings', { cloud: { model: 'changed' } })).status, 409);
    assert.equal((await api('POST', '/chat', { session_id: 'main', request_id: 'probe-busy', text: 'hello' })).status, 409);
    release();
    assert.equal((await first).status, 200);
    assert.equal(settings.loadSettings().cloud.model, 'hold-model');

    settings.saveSettings({ provider: 'ollama', ollama: {
      baseUrl: `http://127.0.0.1:${fake.address().port}`, model: 'test-model' } });
    saved = fs.readFileSync(path.join(dataDir, 'brain-settings.json'), 'utf8');
    assert.equal((await api('POST', '/settings/test', {})).status, 200);
    assert.equal(calls.at(-1).route, '/api/chat');
    assert.equal(calls.at(-1).input.options.num_predict, 16);
    assert.equal(fs.readFileSync(path.join(dataDir, 'brain-settings.json'), 'utf8'), saved);
    assert.deepEqual(counts(), before);

    const activate = (cloud, proxy) => api('POST', '/settings/model/activate', { provider: 'cloud', cloud, proxy });
    assert.equal((await api('POST', '/settings/model/activate', {}, 'wrong')).status, 401);
    assert.equal((await activate({ preset: 'deepseek' })).data.code, 'not_configured');
    assert.equal((await activate({ preset: 'deepseek', baseUrl: localProvider, apiKey: 'preset-key' })).status, 400);
    assert.equal(presetCalls.length, 0);
    const proxy = 'http://127.0.0.1:7888';
    const rejected = await activate({ preset: 'deepseek', apiKey: 'rejected-key' }, proxy);
    assert.equal(rejected.data.code, 'model_test_auth');
    assert.ok(!JSON.stringify(rejected).includes('private-provider-body-and-key'));
    assert.deepEqual(proxyProbes, [proxy]);
    assert.deepEqual(appliedProxies, []);
    assert.equal(fs.readFileSync(path.join(dataDir, 'brain-settings.json'), 'utf8'), saved);

    const expectedOptions = { deepseek: ['thinking', { type: 'disabled' }], qwen: ['enable_thinking', false],
      kimi: ['reasoning_effort', 'low'], openai: ['reasoning', { effort: 'none' }] };
    for (const [id, preset] of Object.entries(MODEL_PRESETS)) {
      const activation = await activate({ preset: id, apiKey: id + '-fake-key' }, id === 'deepseek' ? proxy : undefined);
      assert.equal(activation.status, 200, JSON.stringify(activation));
      assert.equal(activation.data.settings.cloud.model, preset.model);
      assert.equal(activation.data.settings.cloud.apiKey, '***');
      assert.ok(!JSON.stringify(activation).includes('-fake-key'));
      const probe = presetCalls.at(-1);
      const [option, value] = expectedOptions[id];
      assert.equal(probe.id, id);
      assert.equal(probe.authorization, `Bearer ${id}-fake-key`);
      assert.equal(probe.input.model, preset.model);
      assert.deepEqual(probe.input[option], value);
      assert.equal(probe.input.tool_choice, 'none');
      assert.equal((probe.input.input || probe.input.messages).length, 1);
    }
    assert.deepEqual(proxyProbes, [proxy, proxy]);
    assert.deepEqual(appliedProxies, [proxy]);
    assert.deepEqual(counts(), before, 'draft probes never write messages or memory');
    const activeCloudSettings = fs.readFileSync(path.join(dataDir, 'brain-settings.json'), 'utf8');
    assert.equal((await activate({ preset: 'qwen', apiKey: 'rejected-key' })).data.code, 'model_test_auth');
    assert.equal(fs.readFileSync(path.join(dataDir, 'brain-settings.json'), 'utf8'), activeCloudSettings);

    settings.saveSettings({ memory: { autoExtract: false }, cognition: { enabled: false } });
    for (const id of Object.keys(MODEL_PRESETS)) {
      assert.equal((await activate({ preset: id })).status, 200);
      assert.equal(presetCalls.at(-1).authorization, `Bearer ${id}-fake-key`);
      const start = presetCalls.length;
      const chat = await api('POST', '/chat', { session_id: 'main', request_id: `${id}-fake-chat`, text: '你好' });
      assert.equal(chat.status, 200, JSON.stringify(chat));
      assert.match(JSON.stringify(chat.data), /预设聊天通过/);
      const [firstTurn, secondTurn] = presetCalls.slice(start);
      assert.equal(firstTurn.id, id);
      assert.equal(secondTurn.id, id);
      if (id === 'openai') assert.ok(secondTurn.input.input.some(item => item.type === 'function_call_output'));
      else assert.ok(secondTurn.input.messages.some(item => item.role === 'tool'));
      if (id === 'kimi') assert.ok(secondTurn.input.messages.some(item => item.reasoning_content === 'synthetic-reasoning'));
    }
    assert.equal((await activate({ preset: 'custom', baseUrl: localProvider })).data.code, 'not_configured');
    assert.equal((await activate({ preset: 'custom', model: 'test-model' })).status, 200);
    assert.equal(calls.at(-1).authorization, 'Bearer fake-local-key');
    assert.equal(settings.loadSettings().cloud.model, 'test-model');
    console.log('settings-test: PASS (saved probes, four draft presets with tool chat, custom, proxy isolation, error privacy, busy lock)');
  } finally {
    globalThis.fetch = networkFetch;
    release?.();
    if (backend) await backend.close();
    fake.closeAllConnections();
    await new Promise(resolve => fake.close(resolve));
    if (!dataDir.startsWith(tempRoot + path.sep)) throw new Error('Unsafe temporary directory');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
