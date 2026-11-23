'use strict';

function atomic(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = operation();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function createDailyLifeStore(db) {
  const tableExists = name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  atomic(db, () => {
    const existing = tableExists('pc_daily_schedule');
    db.exec(`CREATE TABLE IF NOT EXISTS pc_daily_schedule (
      day TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL CHECK(status IN ('planned','empty','plan_failed')),
      report_json TEXT, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS pc_daily_schedule_entry (
      day TEXT NOT NULL REFERENCES pc_daily_schedule(day), slot INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('browse','rest')),
      status TEXT NOT NULL CHECK(status IN ('scheduled','running','done','missed','failed')),
      intent TEXT NOT NULL, reason TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
      moved_from INTEGER, started_at INTEGER, summary TEXT, sources_json TEXT, report_json TEXT, updated_at INTEGER NOT NULL,
      PRIMARY KEY(day,slot), CHECK(start_at < end_at),
      CHECK((summary IS NULL AND sources_json IS NULL) OR
        (status IN ('done','failed') AND summary IS NOT NULL AND sources_json IS NOT NULL))
    ) STRICT;`);
    if (!existing && tableExists('pc_daily_life')) {
      const report = db.prepare('PRAGMA table_info(pc_daily_life)').all().some(column => column.name === 'report_json')
        ? 'report_json' : 'NULL';
      db.exec(`INSERT INTO pc_daily_schedule(day,status,report_json,updated_at)
        SELECT day, CASE WHEN intent IS NULL THEN status ELSE 'planned' END,
        CASE WHEN intent IS NULL THEN ${report} ELSE NULL END, updated_at FROM pc_daily_life;
        INSERT INTO pc_daily_schedule_entry(day,slot,kind,status,intent,reason,start_at,end_at,summary,sources_json,report_json,updated_at)
        SELECT day,1,'browse',status,intent,reason,start_at,end_at,summary,sources_json,${report},updated_at
        FROM pc_daily_life WHERE intent IS NOT NULL;`);
    }
  });

  const dayRow = db.prepare('SELECT * FROM pc_daily_schedule WHERE day=?');
  const entriesFor = db.prepare('SELECT * FROM pc_daily_schedule_entry WHERE day=? ORDER BY start_at,slot');
  const insertDay = db.prepare('INSERT INTO pc_daily_schedule(day,status,report_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(day) DO NOTHING');
  const insertEntry = db.prepare(`INSERT INTO pc_daily_schedule_entry(day,slot,kind,status,intent,reason,start_at,end_at,updated_at)
    VALUES(?,?,?,'scheduled',?,?,?,?,?)`);
  const claimEntry = db.prepare(`UPDATE pc_daily_schedule_entry SET status='running', started_at=?,updated_at=?
    WHERE day=? AND slot=? AND kind='browse' AND status='scheduled' AND start_at<=? AND end_at>?`);
  const finishEntry = db.prepare(`UPDATE pc_daily_schedule_entry SET status=?,summary=?,sources_json=?,report_json=?,updated_at=?
    WHERE day=? AND slot=? AND status='running'`);
  const moveEntry = db.prepare(`UPDATE pc_daily_schedule_entry AS item SET moved_from=start_at,start_at=?,end_at=?,updated_at=?
    WHERE day=? AND slot=? AND status='scheduled' AND start_at>? AND moved_from IS NULL AND NOT EXISTS (
      SELECT 1 FROM pc_daily_schedule_entry AS other WHERE other.day=item.day AND other.slot<>item.slot
        AND other.start_at<? AND other.end_at>?
    )`);
  const expire = db.prepare(`UPDATE pc_daily_schedule_entry SET status=CASE kind WHEN 'rest' THEN 'done' ELSE 'missed' END, updated_at=?
    WHERE status='scheduled' AND end_at<=?`);
  const recover = db.prepare(`UPDATE pc_daily_schedule_entry SET status='failed',updated_at=?,
    report_json='{"outcome":"interrupted","actions":[]}' WHERE status='running'`);
  const history = db.prepare(`SELECT day,summary,sources_json FROM pc_daily_schedule_entry
    WHERE day<=? AND summary IS NOT NULL ORDER BY day DESC,updated_at DESC,slot DESC LIMIT ?`);

  function readDay(day) {
    const row = dayRow.get(day);
    if (!row) return null;
    const entries = entriesFor.all(day).map(item => ({
      id:item.slot, kind:item.kind, status:item.status, intent:item.intent, reason:item.reason,
      startAt:item.start_at, endAt:item.end_at, movedFrom:item.moved_from, startedAt:item.started_at, updatedAt:item.updated_at,
      experience:item.summary === null ? null : { summary:item.summary, sources:JSON.parse(item.sources_json) },
      report:item.report_json ? JSON.parse(item.report_json) : null,
    }));
    return { day, status:row.status, entries, report:row.report_json ? JSON.parse(row.report_json) : null, updatedAt:row.updated_at };
  }

  function savePlan(day, entries, now) {
    return atomic(db, () => {
      if (!insertDay.run(day, entries.length ? 'planned' : 'empty', null, now).changes) return false;
      entries.forEach((entry, index) => insertEntry.run(day, index + 1, entry.kind, entry.intent, entry.reason,
        entry.startAt, entry.endAt, now));
      return true;
    });
  }

  function finish(day, id, status, experience, now, report = null, adjustment = null) {
    return atomic(db, () => {
      if (!finishEntry.run(status, experience?.summary ?? null, experience ? JSON.stringify(experience.sources) : null,
        report ? JSON.stringify(report) : null, now, day, id).changes) return false;
      if (adjustment) {
        const { id:target, startAt, endAt } = adjustment;
        moveEntry.run(startAt, endAt, now, day, target, now, endAt, startAt);
      }
      return true;
    });
  }

  return {
    readDay, savePlan, finish,
    claim: (day, id, now) => Boolean(claimEntry.run(now, now, day, id, now, now).changes),
    failPlan: (day, now, outcome) => insertDay.run(day, 'plan_failed', JSON.stringify({ outcome, actions:[] }), now),
    recoverInterrupted: now => recover.run(now),
    expireScheduled: now => expire.run(now, now),
    recentExperiences: (day, limit) => history.all(day, limit)
      .map(row => ({ day:row.day, summary:row.summary, sources:JSON.parse(row.sources_json) })),
  };
}

module.exports = { createDailyLifeStore };
