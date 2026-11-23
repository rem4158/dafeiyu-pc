// Actual service/SQLite/native-tool loop with a loopback model and weather worker doubles.
// The fixture chooses its tools explicitly: this does not test real-model understanding.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { DatabaseSync } = require('node:sqlite');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(10);
  }
}
const tool = (id, args = {}) => ({ id, type: 'function',
  function: { name: 'weather_current', arguments: JSON.stringify(args) } });
const answer = text => ({ role: 'assistant', content: JSON.stringify([{ text, delay: 0 }]) });
function currentTurn(body) {
  const index = body.messages.findLastIndex(item => item.role === 'user');
  return { input: body.messages[index]?.content,
    results: body.messages.slice(index + 1).filter(item => item.role === 'tool') };
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(root, 'temp', 'weather-tools-e2e-'));
  process.env.DAFEIYU_DATA_DIR = dir;
  const observed = [], workers = [], queries = [];
  const configPath = path.join(dir, 'pet-appdata', 'dsh-pet-standalone', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const config = { weather_enabled: true, weather_city: '苏家屯',
    weather_city_list: ['苏家屯', '沈阳'], weather_city_codes: { 苏家屯: '101070104', 沈阳: '101070101' },
    unrelated_private_field: 'fixture-do-not-send-this-setting' };
  fs.writeFileSync(configPath, JSON.stringify(config));
  let backend, inspect, mode = 'success';
  const held = new Set();
  const actions = new Map([
    ['我准备出门了，帮我看看怎么穿。', {}],
    ['换个地方看一眼。', { city: '沈阳' }],
    ['extra arguments fixture', { city: '沈阳', url: 'https://example.invalid/private' }],
    ['empty city fixture', { city: ' ' }],
    ['long city fixture', { city: '市'.repeat(25) }],
    ['disabled memory fixture', {}],
    ['isolated weather failure fixture', {}],
    ['cancel weather worker fixture', {}],
    ['fail after weather result fixture', {}],
    ['duplicate weather fixture', {}],
  ]);
  const provider = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); observed.push(body);
    const { input, results } = currentTurn(body);
    if (results.length && input === 'fail after weather result fixture') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'isolated-model-secret-error' } })); return;
    }
    let message;
    if (results.length) {
      const output = JSON.parse(results.at(-1).content);
      message = answer(output.ok
        ? `${output.result.city}现在${output.result.temperature}，出门穿厚一点。`
        : '这次没查到，暂时不能确定。');
    } else if (actions.has(input)) {
      const calls = [tool('weather-fixture', actions.get(input))];
      if (input === 'duplicate weather fixture') calls.push(tool('weather-fixture-second', {}));
      message = { role: 'assistant', content: null, tool_calls: calls };
    } else message = answer('好呀，想聊哪个游戏？');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message,
      finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));

  function options() {
    return { weatherOptions: { spawnWorker(executable, args, spawnOptions) {
      const child = new EventEmitter(); workers.push({ executable, args, spawnOptions, child });
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      let input = '', finished = false;
      function close(code) {
        if (finished) return;
        finished = true; held.delete(child);
        child.stdin.destroy(); child.stdout.end(); child.stderr.end();
        setImmediate(() => child.emit('close', code));
      }
      child.kill = () => { child.killed = true; close(null); return true; };
      child.stdin.on('data', chunk => { input += chunk.toString('utf8'); });
      child.stdin.on('end', () => {
        const request = JSON.parse(input); queries.push(request);
        if (mode === 'hold') { held.add(child); return; }
        const snapshot = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const city = request.city || snapshot.weather_city;
        const output = mode === 'failure'
          ? { ok: false, error: { code: 'weather_query_failed', message: '天气查询失败，请稍后重试' } }
          : { ok: true, result: { city, requested_city: city, scope: 'current',
            condition: '晴', temperature: '0.5℃', wind: '北风 2级', humidity: '25%',
            source: '中国天气网', observed_at: '16:00', detail: '2026-11-06',
            fetched_at: '2026-11-06T08:01:00+00:00' } };
        setImmediate(() => { child.stdout.write(JSON.stringify(output)); close(0); });
      });
      return child;
    } } };
  }
  try {
    const settings = require('./electron/brain/settings');
    const persona = 'Fixture shared weather persona: speak naturally from returned evidence.';
    settings.saveSettings({ memory: { enabled: true, autoExtract: false }, cognition: { enabled: false },
      proactive: { enabled: false }, voice: { enabled: false }, stickers: { enabled: false },
      systemPrompt: persona,
      cloud: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
        apiKey: 'fixture-local-provider-key', model: 'fixture-weather-model' } });
    let settingsSnapshot = fs.readFileSync(path.join(dir, 'brain-settings.json'), 'utf8');
    const menuSnapshot = fs.readFileSync(configPath, 'utf8');
    backend = await require('./service').createBackend(options());
    inspect = new DatabaseSync(path.join(dir, 'companion-memory.db'), { readOnly: true });
    async function api(method, route, body) {
      const response = await fetch(backend.descriptor.url + route, { method,
        headers: { Authorization: 'Bearer ' + backend.descriptor.token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    }
    const sessionId = (await api('POST', '/sessions', {})).data.session_id;
    const chat = (requestId, text) => api('POST', '/chat', { session_id: sessionId, request_id: requestId, text });
    const history = () => inspect.prepare('SELECT count(*) n FROM pc_messages WHERE session_id=?').get(sessionId).n;

    const ordinary = await chat('no-keyword-route', '今天天气不错，我们聊聊游戏。');
    assert.equal(ordinary.status, 200); assert.equal(workers.length, 0,
      'Weather words alone cannot trigger a query without the model native tool call');
    const firstBody = observed.at(-1);
    assert.equal(firstBody.tool_choice, 'auto');
    assert.ok(firstBody.tools.some(item => item.function.name === 'weather_current'));
    assert.ok(firstBody.messages[0].content.startsWith(persona));

    const before = observed.length;
    const body = { request_id: 'model-decides-default', text: '我准备出门了，帮我看看怎么穿。' };
    const result = await chat(body.request_id, body.text);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.text, '苏家屯现在0.5℃，出门穿厚一点。');
    assert.equal(workers.length, 1); assert.deepEqual(queries[0], {});
    assert.equal(workers[0].spawnOptions.windowsHide, true);
    assert.equal(workers[0].spawnOptions.shell, undefined);
    assert.equal(workers[0].args.at(-1), configPath, 'Worker reads the isolated copy of the existing menu settings');
    assert.equal(observed.length, before + 2, 'The same model chooses a tool then answers from its result');
    assert.ok(observed.slice(before).every(item => item.model === 'fixture-weather-model'));
    const continuation = observed.at(-1);
    const output = JSON.parse(currentTurn(continuation).results[0].content);
    assert.equal(output.ok, true); assert.equal(output.result.city, '苏家屯');
    assert.equal(output.result.source, '中国天气网'); assert.equal(output.result.observed_at, '16:00');
    assert.equal(output.result.scope, 'current');
    assert.ok(continuation.messages.some(item => item.role === 'assistant'
      && item.tool_calls?.[0].function.name === 'weather_current'));
    assert.ok(!JSON.stringify(continuation).includes(config.unrelated_private_field));
    assert.deepEqual((await chat(body.request_id, body.text)).data, result.data);
    assert.equal(workers.length, 1); assert.equal(observed.length, before + 2,
      'Replaying a committed request does not query or call the model again');

    assert.equal((await chat('explicit-city', '换个地方看一眼。')).data.text, '沈阳现在0.5℃，出门穿厚一点。');
    assert.deepEqual(queries.at(-1), { city: '沈阳' });
    assert.equal(fs.readFileSync(configPath, 'utf8'), menuSnapshot, 'Explicit queries never change the selected menu city');
    const beforeDuplicates = workers.length;
    assert.equal((await chat('duplicate-weather', 'duplicate weather fixture')).status, 200);
    assert.equal(workers.length, beforeDuplicates + 1, 'Identical same-turn native calls share a weather result');
    const duplicateOutputs = currentTurn(observed.at(-1)).results.map(item => JSON.parse(item.content));
    assert.equal(duplicateOutputs.length, 2); assert.deepEqual(duplicateOutputs[0], duplicateOutputs[1]);
    for (const [id, text] of [['extra', 'extra arguments fixture'], ['empty', 'empty city fixture'],
      ['long', 'long city fixture']]) {
      const count = workers.length;
      assert.equal((await chat(id, text)).status, 200);
      assert.equal(workers.length, count, 'Invalid model arguments must be rejected before starting a worker');
      assert.equal(JSON.parse(currentTurn(observed.at(-1)).results[0].content).error.code, 'invalid_tool_arguments');
    }
    assert.equal(fs.readFileSync(path.join(dir, 'brain-settings.json'), 'utf8'), settingsSnapshot);

    assert.equal((await api('PUT', '/settings', { memory: { enabled: false } })).status, 200);
    settingsSnapshot = fs.readFileSync(path.join(dir, 'brain-settings.json'), 'utf8');
    assert.equal((await chat('memory-off', 'disabled memory fixture')).status, 200);
    const memoryOffBody = observed.at(-1);
    assert.ok(memoryOffBody.tools.some(item => item.function.name === 'weather_current'));
    assert.ok(!memoryOffBody.tools.some(item => item.function.name.startsWith('memory_')));
    assert.ok(require('./chat-tools').chatTools({ channel: 'qq', memoryEnabled: false })
      .some(item => item.function.name === 'weather_current'), 'The shared QQ model receives the same weather capability');
    mode = 'failure';
    const failedQueries = workers.length;
    assert.equal((await chat('weather-error', 'isolated weather failure fixture')).data.text, '这次没查到，暂时不能确定。');
    assert.equal(workers.length, failedQueries + 1, 'A failed query is not retried automatically');
    const failure = JSON.parse(currentTurn(observed.at(-1)).results[0].content);
    assert.equal(failure.ok, false); assert.equal(failure.error.code, 'weather_query_failed');

    mode = 'hold';
    const countBeforeStop = history();
    const cancel = chat('cancel-weather', 'cancel weather worker fixture');
    await until(() => held.size === 1, 'The fixture worker was not started');
    const heldChild = [...held][0];
    assert.equal((await api('POST', `/sessions/${sessionId}/stop`, {})).data.stopped, true);
    assert.equal((await cancel).data.cancelled, true); assert.equal(heldChild.killed, true);
    assert.equal(history(), countBeforeStop, 'Cancelled weather turns do not save partial chat history');

    mode = 'success';
    const beforeModelFailure = history();
    const failedModel = await chat('failed-after-weather', 'fail after weather result fixture');
    assert.equal(failedModel.status, 502); assert.equal(history(), beforeModelFailure);
    assert.ok(!JSON.stringify(failedModel).includes('isolated-model-secret-error'));
    assert.equal(inspect.prepare('SELECT count(*) n FROM facts').get().n, 0);
    const stored = inspect.prepare('SELECT role,content FROM messages WHERE session_id=?').all(sessionId);
    assert.ok(stored.every(item => ['user', 'assistant'].includes(item.role)));
    assert.ok(!stored.some(item => item.content.includes('weather_current') || item.content.includes('fetched_at')),
      'Tool transcripts and weather snapshots are transient, not separate saved messages');
    assert.equal(fs.readFileSync(configPath, 'utf8'), menuSnapshot);
    assert.equal(fs.readFileSync(path.join(dir, 'brain-settings.json'), 'utf8'), settingsSnapshot);
    const workersBeforeRestart = workers.length, requestsBeforeRestart = observed.length;
    await backend.close(); backend = await require('./service').createBackend(options());
    assert.deepEqual((await chat(body.request_id, body.text)).data, result.data);
    assert.equal(workers.length, workersBeforeRestart); assert.equal(observed.length, requestsBeforeRestart);
    console.log('weather-tools-e2e: PASS (native model decision, default/explicit city, same-model continuation, argument validation, memory independence, failures, cancellation, replay, isolated persistence)');
  } finally {
    await backend?.close(); inspect?.close();
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    // dir is the explicit mkdtemp workspace path created above; never touch real data.
    const cleanupPath = path.resolve(dir);
    assert.equal(path.dirname(cleanupPath), path.resolve(root, 'temp'));
    assert.ok(path.basename(cleanupPath).startsWith('weather-tools-e2e-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
