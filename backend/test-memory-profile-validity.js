// Read-time profile regression: one open SQLite handle; no chat, network or real data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const temp = path.resolve(__dirname, '../temp');
fs.mkdirSync(temp, { recursive: true });
const dir = fs.mkdtempSync(path.join(temp, 'memory-profile-validity-'));
process.env.DAFEIYU_DATA_DIR = dir;
const settings = require('./electron/brain/settings');
const originalLoad = settings.loadSettings;
settings.loadSettings = () => ({ memory: { enabled: true, autoExtract: false, retentionDays: 0 } });
const memory = require('./electron/brain/memory');
const { upsert, edit, remove, undo } = require('./electron/brain/memory-audit');
const profile = require('./electron/brain/memory-user-profile');
const originalNow = Date.now;

try {
  const db = memory.initMemory();
  const t0 = Date.now();
  let now = t0;
  Date.now = () => now;
  function add(category, factKey, factValue, extra = {}) {
    const text = factKey + '：' + factValue;
    const { userMessageId } = memory.saveChatTurn({ userText: text, reply: '收到。', extract: false });
    return upsert(db, { category, factKey, factValue, importance: 3, sourceMessageId: userMessageId,
      evidence: text, ...extra });
  }
  function block() {
    // With normal recall turned down to zero, only the profile can supply these facts.
    return memory.buildMemoryContext('', { tokenBudget: 1200, maxContextFacts: 0 });
  }

  const city = add('profile', '城市', '旧城');
  add('profile', '朋友姓名', '这不是用户名');
  add('profile', '以前的住址', '这不是用户现住址');
  add('preference', '点心', '抹茶年糕', { importance: 1 });
  add('plan', '周末安排', '看限定展', { factType: 'temporary', expiresAt: t0 + 100 });
  const name = add('profile', '姓名', '长久称呼', { importance: 5 });
  profile.saveUserProfile(db, {
    identity: { name: '未经证实名字', city: '旧城' }, recent: '看限定展', tone: '未核实推断',
    preferences: ['这条没有证据'],
  }, '旧画像混入的任意原话', { skipSimilarityCheck: true });
  const savedCache = profile.getUserProfile(db);
  assert.match(block(), /长久称呼/);
  assert.match(block(), /旧城/);
  assert.match(block(), /看限定展/);
  assert.match(block(), /抹茶年糕/);
  assert.doesNotMatch(block(), /未经证实|未核实推断|任意原话|没有证据|这不是/);

  // No refresh, restart, new message or profile rewrite at the expiry boundary.
  now = t0 + 100;
  assert.doesNotMatch(block(), /看限定展/);
  assert.doesNotMatch(memory.buildCallMemoryBrief({tokenBudget: 1000}), /看限定展/);
  edit(db, city, { factValue: '新城' });
  assert.match(block(), /新城/);
  assert.doesNotMatch(block(), /旧城/);
  const deletion = remove(db, name);
  assert.doesNotMatch(block(), /长久称呼/);
  undo(db, deletion.revisionId);
  assert.match(block(), /长久称呼/);
  assert.deepEqual(profile.getUserProfile(db), savedCache, 'reading live facts must preserve the stored snapshot');

  now = t0 + 360 * 86400000;
  assert.doesNotMatch(block(), /抹茶年糕|看限定展/);
  assert.match(block(), /长久称呼/);
  // Apply validity before limiting candidates: many more important but expired records
  // should not crowd a fresh, recallable lower-importance preference out of the profile.
  for (let i = 0; i < 36; i++) add('plan', '已到期' + i, '失效的计划' + i, {
    importance: 5, factType: 'temporary', expiresAt: now - 1000,
  });
  add('preference', '新近口味', '温热豆乳');
  assert.match(block(), /温热豆乳/);
  assert.doesNotMatch(block(), /失效的计划/);
  profile.updateProfileToneFromStyle(db, { complexity: 'simple', avgLength: 'short' });
  assert.match(block(), /语言简短直白/);
  assert.doesNotMatch(block(), /旧城|未经证实|任意原话/);
  memory.refreshGroundedProfile();
  assert.match(block(), /语言简短直白/, 'grounded refresh preserves the local style observation');
  console.log('memory-profile-validity: PASS (live projection, aging, expiry, edit/remove/undo, grounded identity, local tone and unchanged archive)');
} finally {
  Date.now = originalNow;
  memory.closeMemory();
  settings.loadSettings = originalLoad;
  assert.ok(dir.startsWith(temp + path.sep));
  fs.rmSync(dir, { recursive: true, force: true });
}
