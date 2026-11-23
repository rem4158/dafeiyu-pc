// Configuration for restored Nianan capabilities; no application state is written on load.
const DEFAULTS = {
  memory: { enabled: true, autoExtract: true, retentionDays: 0, maxRecentMessages: 30,
    maxContextFacts: 8, maxContextEvents: 5, tokenBudget: 800 },
  cognition: { enabled: true },
  proactive: { enabled: true, cooldownMinutes: 30, maxPerDay: 3, quietHoursStart: 23,
    quietHoursEnd: 7, idleMinutes: 60, chatGapMinutes: 3, maxUnanswered: 3 },
};
function mergeSettings(parsed = {}) {
  return Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) =>
    [key, { ...value, ...(parsed[key] || {}), ...(key === 'memory' ? { retentionDays: 0 } : {}) }]));
}
const ranges = {
  maxRecentMessages: [2, 200], maxContextFacts: [1, 50], maxContextEvents: [1, 30], tokenBudget: [200, 12000],
  maxUnanswered: [1, 20], cooldownMinutes: [1, 1440], maxPerDay: [0, 100], quietHoursStart: [0, 23], quietHoursEnd: [0, 23], idleMinutes: [1, 1440], chatGapMinutes: [1, 1440],
};
function normalizeSettings(current, partial) {
  const result = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (partial[key] === undefined) continue;
    const values = partial[key];
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('功能设置格式不正确');
    result[key] = { ...DEFAULTS[key], ...current[key] };
    for (const [name, value] of Object.entries(values)) {
      if (!(name in DEFAULTS[key])) throw new Error('未知功能设置');
      if (typeof DEFAULTS[key][name] === 'boolean') {
        if (typeof value !== 'boolean') throw new Error('开关必须为布尔值');
      } else if (name === 'retentionDays') {
        if (value !== 0) throw new Error('聊天原文保留不能在此自动清理');
      } else {
        const [low, high] = ranges[name];
        if (!Number.isInteger(value) || value < low || value > high) throw new Error('设置数值超出范围');
      }
      result[key][name] = value;
    }
  }
  return result;
}
module.exports = { DEFAULTS, mergeSettings, normalizeSettings };
