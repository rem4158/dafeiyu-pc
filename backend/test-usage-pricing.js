const assert = require('node:assert/strict');
const { estimateCost, PRICE_VERSION } = require('./usage-pricing');
const base = { provider: 'openai', model: 'gpt-6.1-terra', input_tokens: 1000, output_tokens: 200,
  cached_tokens: 400, cache_write_tokens: 300, cache_write_30m_tokens: 200, cache_write_12h_tokens: 100,
  reasoning_tokens: 180, service_tier: 'default' };
const expected = (300 + 400 * .05 + 200 * 1.25 + 100 * 2.5 + 200 * 5) / 1e6;
assert.equal(estimateCost(base).amount, expected);
assert.equal(estimateCost(base).price_version, PRICE_VERSION);
assert.equal(estimateCost({ ...base, reasoning_tokens: 0 }).amount, expected, 'reasoning is an output subset');
assert.equal(estimateCost({ ...base, service_tier: 'priority' }).amount, expected * 2);
assert.equal(estimateCost({ ...base, service_tier: 'flex' }).amount, expected / 2);
const long = { ...base, input_tokens: 272001 };
assert.equal(estimateCost(long).amount, ((272001 - 400 - 300 + 400 * .05 + 200 * 1.25 + 100 * 2.5) * 2 + 200 * 5 * 1.5) / 1e6);
assert.equal(estimateCost({ ...base, input_tokens: 272000 }).amount,
  (272000 - 400 - 300 + 400 * .05 + 200 * 1.25 + 100 * 2.5 + 200 * 5) / 1e6);
for (const overrides of [
  { provider: 'compatible' }, { provider: 'deepseek' }, { model: 'unverified-model' },
  { service_tier: 'scale' }, { service_tier: 'constructor' }, { input_tokens: 600 },
  { cache_write_12h_tokens: 0 }, { output_tokens: NaN }, { input_tokens: null },
]) assert.equal(estimateCost({ ...base, ...overrides }).amount, null, JSON.stringify(overrides));
console.log('usage-pricing: PASS (verified rates, cache writes, reasoning subset, long context, tiers, unknowns)');
