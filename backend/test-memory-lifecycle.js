// Exercise automatic recall and the actual management read API on a private fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

async function main() {
  const tempRoot = path.resolve(__dirname, '../temp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tempRoot, 'memory-lifecycle-'));
  const previousDir = process.env.DAFEIYU_DATA_DIR;
  process.env.DAFEIYU_DATA_DIR = dir;
  const settings = require('./electron/brain/settings');
  const load = settings.loadSettings;
  settings.loadSettings = () => ({ memory: { enabled: true, autoExtract: false, retentionDays: 0 } });
  const memory = require('./electron/brain/memory');
  const audit = require('./electron/brain/memory-audit');
  const api = require('./memory-api');
  const originalNow = Date.now;
  const originalFetch = global.fetch;
  let networkCalls = 0;
  global.fetch = async () => { networkCalls++; throw Error('Network disabled in lifecycle test'); };
  const day = 86400000;
  const cutoff = Date.UTC(2030, 0, 1);
  let clock = cutoff;
  Date.now = () => clock;
  let db;
  try {
    // Open an actual pre-v2 fixture (no type, expiry or revision columns) through production migrations.
    const oldDb = new DatabaseSync(path.join(dir, 'companion-memory.db'));
    try {
      oldDb.exec(`CREATE TABLE facts (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL,
        fact_key TEXT NOT NULL, fact_value TEXT NOT NULL, importance INTEGER NOT NULL,
        source_message_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(category,fact_key))`);
      oldDb.prepare("INSERT INTO facts VALUES(1,'other','纪念物','amberkeepsake',5,NULL,?,?)")
        .run(cutoff - 2000 * day, cutoff - 2000 * day);
    } finally { oldDb.close(); }
    db = memory.initMemory();
    function add(marker, ageDays, importance, extra = {}) {
      clock = cutoff - ageDays * day;
      const userText = '隔离测试记录：' + marker;
      const { userMessageId } = memory.saveChatTurn({ userText, reply: '收到。', extract: false });
      return audit.upsert(db, { category: 'other', factKey: '项目' + marker, factValue: marker,
        importance, evidence: userText, sourceMessageId: userMessageId, ...extra });
    }
    function snapshot() {
      return ['facts', 'messages', 'memory_fact_revisions'].map(table =>
        db.prepare('SELECT * FROM ' + table + ' ORDER BY id').all());
    }
    function surfaces(marker) {
      return {
        search: memory.searchFacts(marker).map(f => f.factValue).includes(marker),
        important: memory.getImportantFacts(30).map(f => f.factValue).includes(marker),
        chat: memory.buildMemoryContext(marker, { tokenBudget: 1200 }).includes(marker),
        proactive: memory.buildMemoryContext('', { tokenBudget: 1200 }).includes(marker),
        brief: memory.buildCallMemoryBrief({ tokenBudget: 1000 }).includes(marker),
      };
    }
    const all = { search: true, important: true, chat: true, proactive: true, brief: true };
    const none = { search: false, important: false, chat: false, proactive: false, brief: false };
    const expired = add('saffronticket', 1, 5, { factType: 'temporary', expiresAt: cutoff });
    const unverified = add('undatedappointment', 1, 5, { factType: 'temporary', expiresAt: null });
    const faded = add('linenribbon', 99, 1);
    const oldImportant = add('violetmap', 364, 4);
    const stay = add('silvercompass', 31, 4);
    const inactive = add('retiredmemo', 2, 5);
    audit.remove(db, inactive);
    clock = cutoff - 1;
    const before = snapshot();
    assert.deepEqual(surfaces('undatedappointment'), none, 'missing deadlines do not turn temporary plans into current facts forever');
    assert.deepEqual(surfaces('saffronticket'), all, 'still usable just before its deadline');
    assert.deepEqual(surfaces('violetmap'), all, 'a 364-day important fact is still eligible');
    assert.ok(surfaces('linenribbon').search, 'ordinary fact just above the existing strength threshold');
    clock = cutoff;
    assert.deepEqual(surfaces('saffronticket'), none, 'meeting the deadline suppresses even importance 5');
    clock = cutoff + 2 * day;
    assert.deepEqual(surfaces('linenribbon'), none, 'once below threshold it no longer appears');
    assert.deepEqual(surfaces('violetmap'), none, 'the 365-day rule also applies before a restart');
    assert.deepEqual(surfaces('retiredmemo'), none, 'previously deactivated facts stay inactive');
    assert.deepEqual(surfaces('silvercompass'), all, 'younger important background survives');
    assert.deepEqual(surfaces('amberkeepsake'), all, 'very old, explicitly important migrated fact survives');
    assert.deepEqual(memory.getImportantFacts(1).map(f => f.id), [stay],
      'expired, more recently updated candidates must not consume the limit');
    assert.deepEqual(snapshot(), before, 'automatic reads leave evidence, audit, strength and active flags unchanged');
    memory.closeMemory();
    db = memory.initMemory();
    assert.deepEqual(surfaces('violetmap'), none);
    assert.deepEqual(surfaces('amberkeepsake'), all);
    const overview = await api.handle({ method: 'GET', path: '/memory', db });
    assert.equal(overview.status, 200);
    for (const id of [expired, unverified, faded, oldImportant, inactive]) {
      const archived = overview.body.facts.find(fact => fact.id === id);
      assert.equal(archived.active, id === inactive ? 0 : 1);
      assert.equal(archived.source_text, '隔离测试记录：' + archived.fact_value);
      assert.ok(overview.body.revisions.some(rev => rev.fact_id === id && rev.source_message_id === archived.source_message_id));
    }
    assert.deepEqual(snapshot(), before, 'reopening or listing the archive is not an automatic deletion or correction');
    assert.equal(networkCalls, 0);
    console.log('memory-lifecycle: PASS (expiry instant, decay, important background, same-process ageing, legacy migration/reopen, source + archive integrity; no network)');
  } finally {
    memory.closeMemory();
    Date.now = originalNow;
    global.fetch = originalFetch;
    settings.loadSettings = load;
    if (previousDir === undefined) delete process.env.DAFEIYU_DATA_DIR;
    else process.env.DAFEIYU_DATA_DIR = previousDir;
    assert.ok(path.dirname(dir) === tempRoot, 'unsafe fixture cleanup');
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
