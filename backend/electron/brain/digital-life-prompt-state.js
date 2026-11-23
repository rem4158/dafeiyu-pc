// Old growth narratives could contain quoted dialogue. Preserve their archive;
// only the default or a reviewed narrative generated from state-only inputs
// may be reused by another model. The marker is not a second user fact store.
const { createHash } = require('node:crypto');
const DEFAULT_NARRATIVE = '我是一个温柔的AI伴侣，正在学习如何更好地理解和陪伴用户。';
const markerKey = 'cognition.state-only-narrative.v1';
function digest(version, prose) {
  return createHash('sha256').update(String(version) + ':' + prose).digest('hex');
}
function promptNarrative(db, row, fallback = DEFAULT_NARRATIVE) {
  const prose = row?.narrative_text;
  if (!prose || prose === DEFAULT_NARRATIVE) return fallback;
  const marker = db.prepare('SELECT value FROM meta WHERE key=?').get(markerKey);
  return marker?.value === digest(row.version, prose) ? prose : fallback;
}
function markReviewedNarrative(db, version, prose) {
  db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run(markerKey, digest(version, prose));
}
module.exports = { promptNarrative, markReviewedNarrative };
