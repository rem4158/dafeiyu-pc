// On-demand access to the pet's existing Python weather client and saved cities.
// No shell, extra provider, persistent worker or separate weather configuration.
const path = require('node:path');
const { pcPython } = require('./pc-python');
const { spawn } = require('node:child_process');
const { getUserDataRoot } = require('./electron/user-data');

const MESSAGES = {
  weather_disabled: '天气功能已在桌宠设置中关闭，请在设置中开启后再查询',
  weather_city_required: '还没选天气城市，请在右键天气城市菜单添加城市，或说明要查询的城市',
  weather_config_unavailable: '暂时无法读取桌宠的天气设置，请检查设置是否已成功保存',
  weather_invalid_arguments: '天气查询参数不正确，请只提供要查询的城市或省略城市',
  weather_query_failed: '天气查询失败，请检查城市或网络后重试',
  weather_timeout: '天气查询超时，请稍后再试',
  weather_unavailable: '天气查询暂时不可用，请检查随附 Python 运行环境',
};
function failure(code) { return { ok: false, error: { code, message: MESSAGES[code] } }; }
function reading(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return failure('weather_query_failed');
  if (raw.ok === false) return failure(Object.hasOwn(MESSAGES, raw.error?.code)
    ? raw.error.code : 'weather_query_failed');
  const value = raw.result;
  if (raw.ok !== true || !value || value.scope !== 'current') return failure('weather_query_failed');
  const result = {};
  for (const key of ['city', 'condition', 'temperature', 'wind', 'humidity', 'source',
    'observed_at', 'detail', 'requested_city', 'fetched_at']) {
    if (typeof value[key] !== 'string' || value[key].length > 800) return failure('weather_query_failed');
    result[key] = value[key];
  }
  if (!result.city.trim() || !result.temperature.trim() || !result.source.trim()
      || !result.requested_city.trim() || !Number.isFinite(Date.parse(result.fetched_at)))
    return failure('weather_query_failed');
  return { ok: true, result: { ...result, scope: 'current' } };
}

function createWeatherService({ root = process.env.DAFEIYU_PC_ROOT || path.resolve(__dirname, '..'),
  dataRoot = getUserDataRoot(), spawnWorker = spawn, timeoutMs = 25_000 } = {}) {
  const active = new Set();
  let closed = false;
  async function query({ city, signal } = {}) {
    signal?.throwIfAborted();
    if (closed) return failure('weather_unavailable');
    if (city !== undefined && (typeof city !== 'string' || !city.trim() || city.length > 24))
      return failure('weather_invalid_arguments');
    let child;
    try {
      child = spawnWorker(pcPython(root),
        ['-B', path.join(root, 'desktop_bridge', 'weather_query.py'),
          path.join(dataRoot, 'pet-appdata', 'dsh-pet-standalone', 'config.json')],
        { cwd: root, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
          windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { return failure('weather_unavailable'); }
    let stopResult, timer, finished = false, bytes = 0;
    const chunks = [];
    const task = {};
    const promise = new Promise((resolve, reject) => {
      function stop(result) {
        if (finished || stopResult) return;
        stopResult = result;
        // Only this call's direct, fixed Python child is owned here.
        try { child.kill('SIGKILL'); } catch { /* close/error will settle the child. */ }
      }
      const abort = () => stop(failure('weather_query_failed'));
      task.stop = () => stop(failure('weather_unavailable'));
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', chunk => {
        if (stopResult) return;
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += data.length;
        if (bytes > 16_384) stop(failure('weather_query_failed'));
        else chunks.push(data);
      });
      child.stderr.resume(); // Never retain provider diagnostics or configuration data.
      child.stdin.on('error', () => stop(failure('weather_query_failed')));
      child.once('error', () => stop(failure('weather_unavailable')));
      child.once('close', code => {
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        active.delete(task);
        if (signal?.aborted) { reject(signal.reason || new Error('Weather query aborted')); return; }
        if (stopResult) { resolve(stopResult); return; }
        if (code !== 0) { resolve(failure('weather_query_failed')); return; }
        try { resolve(reading(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
        catch { resolve(failure('weather_query_failed')); }
      });
      timer = setTimeout(() => stop(failure('weather_timeout')), timeoutMs);
      if (signal?.aborted) abort();
      else {
        try { child.stdin.end(JSON.stringify(city === undefined ? {} : { city })); }
        catch { stop(failure('weather_query_failed')); }
      }
    });
    task.promise = promise;
    active.add(task);
    return promise;
  }
  async function close() {
    closed = true;
    const tasks = [...active];
    for (const task of tasks) task.stop();
    await Promise.allSettled(tasks.map(task => task.promise));
  }
  return { query, close };
}
module.exports = { createWeatherService };
