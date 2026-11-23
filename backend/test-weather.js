// Isolated worker protocol/lifecycle checks; the only real helper calls are offline.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createWeatherService } = require('./weather');

const sample = { ok: true, result: { city: '苏家屯', condition: '晴', temperature: '0.5℃',
  wind: '北风 2级', humidity: '25%', source: '中国天气网', observed_at: '10:00', detail: '测试日期',
  requested_city: '苏家屯', scope: 'current', fetched_at: '2026-11-06T02:00:00+00:00' } };
function workerHarness(work) {
  const workers = [], invocations = [];
  function spawnWorker(...args) {
    invocations.push(args);
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.closed = false; child.kills = 0;
    child.finish = (value, code = 0) => {
      if (child.closed) return;
      child.closed = true;
      if (value !== undefined) child.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
      child.stdin.destroy(); child.stdout.end(); child.stderr.end(); child.emit('close', code);
    };
    child.kill = () => { child.kills++; setImmediate(() => child.finish(undefined, null)); return true; };
    let input = '';
    child.stdin.on('data', chunk => { input += chunk; });
    child.stdin.on('end', () => work(child, JSON.parse(input)));
    workers.push(child);
    return child;
  }
  return { spawnWorker, workers, invocations };
}
async function main() {
  const root = path.resolve(__dirname, '..');
  const tempRoot = path.join(root, 'temp');
  const dir = fs.mkdtempSync(path.join(tempRoot, 'weather-worker-test-'));
  const services = [];
  const create = options => { const value = createWeatherService({ root, dataRoot: dir, ...options }); services.push(value); return value; };
  try {
    const inputs = [];
    const ok = workerHarness((child, input) => { inputs.push(input); child.finish(sample); });
    const service = create(ok);
    assert.deepEqual(await service.query(), sample);
    assert.deepEqual(await service.query({ city: '沈阳' }), sample);
    assert.deepEqual(inputs, [{}, { city: '沈阳' }]);
    assert.equal(ok.invocations.length, 2, 'new calls must reread current menu settings');
    const [executable, args, options] = ok.invocations[0];
    assert.equal(executable, require('./pc-python').pcPython(root));
    assert.deepEqual(args, ['-B', path.join(root, 'desktop_bridge', 'weather_query.py'),
      path.join(dir, 'pet-appdata', 'dsh-pet-standalone', 'config.json')]);
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, undefined);
    assert.ok(!args.includes('沈阳'), 'model city is data on stdin, never process arguments');
    for (const city of ['', ' ', 3, '城'.repeat(25)]) {
      assert.equal((await service.query({ city })).error.code, 'weather_invalid_arguments');
    }
    assert.equal(ok.invocations.length, 2);
    for (const output of ['not JSON', '{}', { ...sample, result: { ...sample.result, temperature: 1 } },
      { ...sample, result: { ...sample.result, scope: 'forecast' } },
      { ok: false, error: { code: 'secret-code', message: 'private config/provider content' } }]) {
      const h = workerHarness(child => child.finish(output));
      const result = await create(h).query();
      assert.equal(result.error.code, 'weather_query_failed');
      assert.ok(!JSON.stringify(result).includes('private'));
    }
    for (const code of ['weather_disabled', 'weather_city_required', 'weather_config_unavailable', 'weather_query_failed']) {
      const h = workerHarness(child => child.finish({ ok: false, error: { code, message: 'untrusted detail' } }));
      const result = await create(h).query();
      assert.equal(result.error.code, code);
      assert.ok(!JSON.stringify(result).includes('untrusted'));
    }
    const large = workerHarness(child => child.stdout.write('x'.repeat(16_385)));
    assert.equal((await create(large).query()).error.code, 'weather_query_failed');
    assert.equal(large.workers[0].kills, 1);
    assert.equal(large.workers[0].closed, true);
    const hung = workerHarness(() => {});
    assert.equal((await create({ ...hung, timeoutMs: 20 }).query()).error.code, 'weather_timeout');
    assert.equal(hung.workers[0].closed, true, 'timeout waits for child closure');
    const cancelled = workerHarness(() => {}), controller = new AbortController();
    const pending = create(cancelled).query({ signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(cancelled.workers[0].closed, true, 'cancel reaps its own Python child');
    const before = new AbortController(); before.abort();
    await assert.rejects(() => service.query({ signal: before.signal }), { name: 'AbortError' });
    assert.equal(ok.invocations.length, 2);
    const stopping = workerHarness(() => {}), owned = create(stopping);
    const stoppedQuery = owned.query();
    await owned.close();
    assert.equal((await stoppedQuery).error.code, 'weather_unavailable');
    assert.equal(stopping.workers[0].closed, true);
    assert.equal((await owned.query()).error.code, 'weather_unavailable');
    const unavailable = create({ spawnWorker() { throw new Error('private path'); } });
    assert.equal((await unavailable.query()).error.code, 'weather_unavailable');
    const spawnError = workerHarness(child => child.emit('error', new Error('private path')));
    assert.equal((await create(spawnError).query()).error.code, 'weather_unavailable');
    const failedExit = workerHarness(child => child.finish(sample, 1));
    assert.equal((await create(failedExit).query()).error.code, 'weather_query_failed');

    // Exercise the actual fixed Python entry, config path and UTF-8 protocol.
    // Disabled and unconfigured fixtures cannot issue any weather network request.
    const config = path.join(dir, 'pet-appdata', 'dsh-pet-standalone', 'config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const disabled = JSON.stringify({ weather_enabled: false, weather_city: '苏家屯', private: 'fixture-only-secret' });
    fs.writeFileSync(config, disabled);
    const real = create();
    assert.equal((await real.query()).error.code, 'weather_disabled');
    assert.equal(fs.readFileSync(config, 'utf8'), disabled);
    fs.writeFileSync(config, '{}');
    assert.equal((await real.query()).error.code, 'weather_city_required');
    fs.writeFileSync(config, '{');
    assert.equal((await real.query()).error.code, 'weather_config_unavailable');
    fs.unlinkSync(config);
    assert.equal((await real.query()).error.code, 'weather_config_unavailable');
    console.log('weather-worker: PASS (fixed Python protocol, shared config, safe errors, bounds, timeout, cancel, cleanup; no external network)');
  } finally {
    await Promise.allSettled(services.map(service => service.close()));
    assert.ok(path.resolve(dir).startsWith(path.resolve(tempRoot) + path.sep)
      && path.basename(dir).startsWith('weather-worker-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
