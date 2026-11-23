// All dates are local by construction. No model, database, network, or wall-clock access.
const assert = require('node:assert/strict');
const { groundTemporalFact } = require('./electron/brain/memory-time');

const at = (year, month, day, hour = 0, minute = 0) => new Date(year, month - 1, day, hour, minute).getTime();
const sent = at(2026, 11, 30, 23, 59);
function ground(evidence, value, { category = 'plan', factType = 'temporary', sourceAt = sent } = {}) {
  return groundTemporalFact({ category, factType, factValue: value, expiresAt: at(2099, 1, 1) }, evidence, sourceAt);
}
const meeting = '我明天参加木工面试。';
const realNow = Date.now;
try {
  Date.now = () => at(2026, 12, 2, 15); // Simulates a retry long after the message, even beyond the deadline.
  assert.equal(ground(meeting, '木工面试').expiresAt, at(2026, 12, 2));
  assert.equal(ground(meeting, '木工面试', { factType: 'permanent' }).factType, 'temporary');
  assert.equal(ground('我下周参加展会', '展会', { sourceAt: at(2023, 12, 31, 22) }).expiresAt, at(2024, 1, 8));
  assert.equal(ground('我下周三去做体检', '体检', { sourceAt: at(2023, 12, 31) }).expiresAt, at(2024, 1, 4));
  assert.equal(ground('我月底整理书架', '整理书架').expiresAt, at(2026, 12, 1));
  assert.equal(ground('我下个月去杭州', '杭州').expiresAt, at(2027, 1, 1));
  assert.equal(ground('我下个月15号去杭州', '杭州').expiresAt, at(2026, 12, 16));
  assert.equal(ground('我明年1月5号去杭州', '杭州').expiresAt, at(2027, 1, 6));
  assert.equal(ground('我在2028年2月29日参加茶会', '茶会').expiresAt, at(2028, 3, 1));
  assert.equal(ground('报名截止到明天下午三点半', '报名').expiresAt, at(2026, 12, 1, 15, 30));
  assert.equal(ground('报名截止到明晚九点一刻', '报名').expiresAt, at(2026, 12, 1, 21, 15));
  assert.equal(ground('我这周三15:45前报名', '报名').expiresAt, at(2026, 12, 2, 15, 45));
  assert.equal(ground('报名将在明天之前截止', '报名').expiresAt, at(2026, 12, 1));
  assert.equal(ground('明天15:45我去参加面试', '面试').expiresAt, at(2026, 12, 2), 'an appointment start is not its finish');
  for (const [evidence, value] of [
    ['我有一场考试，时间还没定', '考试'],
    ['时间待定的考试', '考试'],
    ['我计划12月2日或12月3日参加考试', '考试'],
    ['我计划2026-02-30参加茶会', '茶会'],
    ['我准备在2月30日参加茶会', '茶会'],
    ['我计划明天25:09前报名', '报名'],
    ['我计划明天12:30:45之前报名', '报名'],
    ['我计划明年月底再报名', '报名'],
    ['我计划下下个月去舞会', '舞会'],
    ['我计划农历五月十五日去舞会', '舞会'],
    ['我明天起准备出差一周', '出差'],
    ['我明天去参加为期一周的舞会', '舞会'],
    ['我明天去看展，搬家还在计划里', '搬家'],
    ['我计划去看《明天》这部电影', '电影'],
    ['我每周一锻炼', '锻炼'],
    ['我明天参加的茶会取消了', '茶会'],
    ['我准备2026年11月中旬参加讲座', '讲座'],
  ]) assert.equal(ground(evidence, value), null, 'no inferred deadline: ' + evidence);
  const fact = {category: 'profile', factType: 'permanent', factValue: '北京'};
  assert.equal(groundTemporalFact(fact, '我明天去看展。我常住北京。', sent), fact);
  for (const [category, factType, factValue, evidence] of [
    ['preference', 'permanent', '《明天》', '我喜欢《明天》这首歌'],
    ['habit', 'permanent', '锻炼', '我每周一锻炼'],
    ['event', 'fleeting', '完成作品', '我昨天完成作品'],
  ]) {
    const item = { category, factType, factValue };
    assert.equal(groundTemporalFact(item, evidence, sent), item);
  }
  assert.equal(groundTemporalFact({ category: 'plan', factValue: '面试' }, meeting, null), null);
  console.log('memory-time: PASS (source-local calendar, exclusive end, retry, week/month/year, explicit time, evidence scope, rejected guesses)');
} finally {
  Date.now = realNow;
}
