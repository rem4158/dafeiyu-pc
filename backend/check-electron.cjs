// An optional local Electron integration check using a loopback model fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

async function main() {
  const electronPath = process.argv[2] || path.resolve(__dirname, '../runtime/electron/electron.exe');
  if (!electronPath || !fs.existsSync(electronPath)) throw new Error('Pass the Electron runtime executable path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-electron-test-'));
  const observed = [];
  const model = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks));
    observed.push(input);
    const text = input.tool_choice === 'none' ? 'OK'
      : '[{"text":"你好，主人。","delay":0},{"text":"我在这里。","delay":10}]';
    if (input.stream === false) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: [DONE]\n\n');
    }
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  let child;
  let done;
  let errorOutput = '';
  try {
    fs.writeFileSync(path.join(dir, 'brain-settings.json'), JSON.stringify({ provider: 'cloud', memory: { autoExtract: false }, cognition: { enabled: false }, proactive: { enabled: false },
      cloud: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fake-local-key', model: 'fake-local-model' } }));
    child = spawn(electronPath, [__dirname], { windowsHide: true,
      env: { ...process.env, DAFEIYU_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.on('data', data => { errorOutput += data.toString(); });
    done = new Promise(resolve => child.once('exit', code => resolve(code)));
    const descriptorPath = path.join(dir, 'backend.json');
    for (let i = 0; i < 100 && !fs.existsSync(descriptorPath); i++) {
      if (child.exitCode !== null) throw new Error('Electron exited during startup: ' + errorOutput.slice(-500));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
    async function api(method, route, body) {
      const res = await fetch(descriptor.url + route, { method,
        headers: { Authorization: 'Bearer ' + descriptor.token, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined });
      const data = await res.json();
      assert.ok(res.ok, JSON.stringify(data));
      return data;
    }
    assert.equal((await api('GET', '/health')).configured, true);
    const activation = await api('POST', '/settings/model/activate', { provider: 'cloud',
      cloud: { preset: 'custom', model: 'fake-local-model' }, proxy: 'http://127.0.0.1:7888' });
    assert.equal(activation.settings.proxy, 'http://127.0.0.1:7888');
    assert.equal(activation.settings.cloud.apiKey, '***');
    assert.equal(observed.shift().tool_choice, 'none');
    const id = (await api('POST', '/sessions')).session_id;
    for (const [request_id, text] of [['first', '你好'], ['second', '刚才你说了什么']]) {
      const reply = await api('POST', '/chat', { session_id: id, request_id, text });
      assert.equal(reply.messages.length, 2);
    }
    assert.ok(observed[1].messages.some(m => m.role === 'assistant' && m.content === '你好，主人。\n我在这里。'));
    assert.ok(!JSON.stringify(observed).includes('莉莉安'));
    assert.equal((await api('GET', '/sessions/' + id)).history.length, 6);
    await api('POST', '/shutdown', {});
    let timer;
    let exit;
    try {
      exit = await Promise.race([done, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Shutdown timeout')), 10000);
      })]);
    } finally { clearTimeout(timer); }
    assert.equal(exit, 0);
    assert.ok(!fs.existsSync(descriptorPath));
    console.log('electron-backend: PASS (real Electron no-window process, Chromium fetch, local native/streaming model fixture, multi-turn/history, shutdown)');
  } finally {
    if (child && child.exitCode === null) { child.kill(); await done; }
    model.closeAllConnections();
    await new Promise(resolve => model.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
