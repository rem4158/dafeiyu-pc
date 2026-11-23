const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const backend = path.join(root, 'backend');
const browser = process.argv[2] === '--browser';
if (process.argv.length !== (browser ? 3 : 2)) {
  throw new Error('Usage: node scripts/test-backend.cjs [--browser]');
}

const browserServices = [
  'test-browser-service.js', 'test-background-browse-service.js', 'test-daily-life-service.js'
];
const liveChecks = new Set(['test-public.js', 'test-manual-resources.js']);
const cases = fs.readdirSync(browser ? path.join(backend, 'browser') : backend)
  .filter(name => /^test-.*\.js$/.test(name))
  .filter(name => !liveChecks.has(name))
  .filter(name => browser || !browserServices.includes(name))
  .sort()
  .map(name => path.join(browser ? 'browser' : '', name));
if (browser) cases.push(...browserServices);

const temp = path.join(root, 'temp');
fs.mkdirSync(temp, { recursive: true });
const work = fs.mkdtempSync(path.join(temp, 'public-tests-'));
const failed = [];
try {
  for (const file of cases) {
    const data = path.join(work, path.basename(file, '.js'));
    fs.mkdirSync(data);
    const env = { ...process.env, DAFEIYU_PC_ROOT: root, DAFEIYU_DATA_DIR: data };
    const result = spawnSync(process.execPath, [path.join(backend, file)], {
      cwd: root, env, stdio: 'inherit', windowsHide: true
    });
    if (result.error) throw result.error;
    if (result.status !== 0) failed.push(file);
  }
} finally {
  if (path.dirname(fs.realpathSync(work)) !== fs.realpathSync(temp)) {
    throw new Error('Unexpected test directory');
  }
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(`Passed ${cases.length - failed.length}/${cases.length} scripts.`);
if (failed.length) {
  console.error(failed.join('\n'));
  process.exitCode = 1;
}
