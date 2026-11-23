// Verified official Standard USD rates, per million tokens, on 2026-11-06.
// https://developers.openai.com/api/docs/models/gpt-6.1-terra
// https://developers.openai.com/api/docs/guides/prompt-caching
// Unknown models/providers remain unpriced; no guessed or borrowed tariff.
const PRICE_VERSION = 'openai-2026-11-06';
const SOURCE = 'https://developers.openai.com/api/docs/models/gpt-6.1-terra';
const RATES = Object.freeze({
  'gpt-6.1-terra': { input: 1, cached: .05, output: 5, write30m: 1.25, write12h: 2.5,
    longThreshold: 272000, longInput: 2, longOutput: 1.5 },
});
const count = value => Number.isSafeInteger(value) && value >= 0;

function estimateCost(usage) {
  const unknown = { amount: null, currency: usage.provider === 'openai' ? 'USD' : null,
    price_version: null, source: null, estimated: true };
  if (usage.provider !== 'openai' || !Object.hasOwn(RATES, usage.model)) return unknown;
  const rate = RATES[usage.model];
  if (usage.cached_tokens === null || usage.cache_write_tokens === null) return unknown;
  const input = usage.input_tokens, output = usage.output_tokens;
  const cached = usage.cached_tokens ?? 0, writes = usage.cache_write_tokens ?? 0;
  let write30m = usage.cache_write_30m_tokens ?? 0, write12h = usage.cache_write_12h_tokens ?? 0;
  if (![input, output, cached, writes, write30m, write12h].every(count) || cached + writes > input) return unknown;
  // Missing retention breakdown is not enough to infer a cache-write price.
  if (write30m + write12h !== writes) return unknown;
  const tier = usage.service_tier || 'default';
  const tiers = { default: 1, standard: 1, auto: 1, flex: .5, priority: 2, fast: 2 };
  if (!Object.hasOwn(tiers, tier)) return unknown;
  const multiplier = tiers[tier];
  const long = input > rate.longThreshold;
  const inputCost = ((input - cached - writes) * rate.input + cached * rate.cached +
    write30m * rate.write30m + write12h * rate.write12h) * (long ? rate.longInput : 1);
  // Reasoning is already part of output_tokens; charging it again would double count.
  const amount = (inputCost + output * rate.output * (long ? rate.longOutput : 1)) * multiplier / 1e6;
  return { amount, currency: 'USD', price_version: PRICE_VERSION, source: SOURCE, estimated: true };
}

// Admission deliberately assumes every input token gets the highest supported
// cache-write tariff. Budgeted calls explicitly request Standard service tier.
function estimateUpperCost(usage) {
  const unknown = { amount: null, currency: null, price_version: null };
  if (usage.provider !== 'openai' || !Object.hasOwn(RATES, usage.model) ||
      !count(usage.input_tokens) || !count(usage.output_tokens)) return unknown;
  const rate = RATES[usage.model], long = usage.input_tokens > rate.longThreshold;
  const amount = (usage.input_tokens * Math.max(rate.input, rate.cached, rate.write30m, rate.write12h) * (long ? rate.longInput : 1) +
    usage.output_tokens * rate.output * (long ? rate.longOutput : 1)) / 1e6;
  return { amount: Math.ceil(amount * 1e12) / 1e12, currency: 'USD', price_version: PRICE_VERSION };
}

module.exports = { estimateCost, estimateUpperCost, PRICE_VERSION };
