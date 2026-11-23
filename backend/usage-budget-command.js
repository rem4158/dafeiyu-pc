'use strict';

// This validates current-user numeric evidence only. The calling model decides
// intent/scope; source authorization and tool-result boundaries belong upstream.
const KEYS = new Set(['scope', 'tokens', 'usd', 'token_text', 'usd_text', 'evidence']);
const DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const SMALL_UNITS = { 十: 10, 百: 100, 千: 1000 };
const UNSUPPORTED_CURRENCY = /人民币|[元圓圆]|\b(?:CNY|RMB|EUR|GBP|JPY|HKD|CAD|AUD)\b|[¥￥€£]/i;
const NUMBER_CHAR = /[0-9A-Za-z零〇一二两兩三四五六七八九十百千万萬亿億兆点點負负+\-−]/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function smallChinese(text) {
  if (!text || !/^[零〇一二两三四五六七八九十百千]+$/.test(text)) return null;
  if (/^[零〇一二两三四五六七八九]+$/.test(text)) {
    return BigInt([...text].map(char => DIGITS[char]).join(''));
  }
  let result = 0;
  let pending = null;
  let previousUnit = 10000;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (Object.hasOwn(DIGITS, char)) {
      const digit = DIGITS[char];
      if (pending !== null) return null;
      if (digit !== 0) pending = digit;
    } else {
      const unit = SMALL_UNITS[char];
      if (unit >= previousUnit) return null;
      if (pending === null && !(index === 0 && unit === 10)) return null;
      result += (pending === null ? 1 : pending) * unit;
      pending = null;
      previousUnit = unit;
    }
  }
  return BigInt(result + (pending === null ? 0 : pending));
}

function chineseInteger(text) {
  let total = 0n;
  let section = '';
  let previousUnit = 1000000000;
  for (const char of text) {
    if (char !== '万' && char !== '亿') { section += char; continue; }
    const unit = char === '万' ? 10000 : 100000000;
    const number = smallChinese(section);
    if (unit >= previousUnit || number === null || number <= 0n) return null;
    total += number * BigInt(unit);
    section = '';
    previousUnit = unit;
  }
  if (!section) return total === 0n ? null : total;
  const rest = smallChinese(section);
  return rest === null ? null : total + rest;
}

// Rational arithmetic avoids rounding a fractional token or seventh USD decimal
// into a permitted amount. No scientific notation, sign, or currency conversion.
function quantity(text) {
  const scaled = text.match(/^(.*?)([kKmM万亿])?$/);
  const suffix = scaled[2] || '';
  const scale = { k: 1000n, m: 1000000n, 万: 10000n, 亿: 100000000n }[suffix.toLowerCase()] || 1n;
  const body = scaled[1];
  let numerator;
  let denominator = 1n;
  if (/^(?:(?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.\d+)?$/.test(body) || /^\.\d+$/.test(body)) {
    const parts = body.replace(/,/g, '').split('.');
    const fraction = parts[1] || '';
    numerator = BigInt((parts[0] || '0') + fraction);
    denominator = 10n ** BigInt(fraction.length);
  } else if (body.includes('点')) {
    const parts = body.split('点');
    if (parts.length !== 2 || !/^[零〇一二两三四五六七八九]+$/.test(parts[1])) return null;
    const integer = chineseInteger(parts[0]);
    if (integer === null) return null;
    const fraction = [...parts[1]].map(char => DIGITS[char]).join('');
    denominator = 10n ** BigInt(fraction.length);
    numerator = integer * denominator + BigInt(fraction);
  } else {
    // Whole Chinese quantities can contain both 亿 and 万; do not apply the
    // trailing magnitude twice (一亿二千万 is 120000000).
    numerator = chineseInteger(text);
    if (numerator !== null) return { numerator, denominator: 1n };
    return null;
  }
  return { numerator: numerator * scale, denominator };
}

function literalIsWhole(userText, start, literal) {
  const before = userText.slice(0, start + literal.length - literal.trimStart().length);
  const after = userText.slice(start + literal.trimEnd().length);
  if (before && NUMBER_CHAR.test(before.at(-1))) return false;
  // A space separates ordinary words/numbers, but must not hide a minus sign.
  if (/[+\-−負负]$/.test(before.trimEnd())) return false;
  if (/[0-9零〇一二两兩三四五六七八九十百千万萬亿億兆][.,，]$/.test(before)) return false;
  if (after && /[0-9A-Za-z零〇一二两兩三四五六七八九十百千万萬亿億兆点點負负]/.test(after[0])) return false;
  if (/^[.,，]\d/.test(after)) return false;
  return true;
}

function groundedLiteral(userText, evidence, literal, checkCurrency = false) {
  if (typeof literal !== 'string' || !literal.trim() || literal.length > 80 || !evidence.includes(literal)) {
    fail('usage_budget_evidence');
  }
  let evidenceStart = userText.indexOf(evidence);
  while (evidenceStart !== -1) {
    let literalStart = evidence.indexOf(literal);
    while (literalStart !== -1) {
      const start = evidenceStart + literalStart;
      if (literalIsWhole(userText, start, literal)) {
        if (checkCurrency) {
          const before = userText.slice(0, start).trimEnd();
          const after = userText.slice(start + literal.length).trimStart();
          if (/(?:人民币|CNY|RMB|EUR|GBP|JPY|HKD|CAD|AUD|[¥￥€£])$/i.test(before) ||
              /^(?:人民币|[元圓圆]|CNY\b|RMB\b|EUR\b|GBP\b|JPY\b|HKD\b|CAD\b|AUD\b|[¥￥€£])/i.test(after)) {
            fail('usage_budget_currency');
          }
        }
        return literal.trim();
      }
      literalStart = evidence.indexOf(literal, literalStart + 1);
    }
    evidenceStart = userText.indexOf(evidence, evidenceStart + 1);
  }
  fail('usage_budget_evidence');
}

function validateBudgetCommand(args, userText) {
  if (!args || typeof args !== 'object' || Array.isArray(args) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(args)) ||
      Reflect.ownKeys(args).some(key => typeof key !== 'string' || !KEYS.has(key)) ||
      ['scope', 'tokens', 'usd', 'evidence'].some(key => !Object.hasOwn(args, key)) ||
      !['daily', 'per_task', 'task'].includes(args.scope)) fail('usage_budget_invalid');
  const { scope, tokens, usd, evidence } = args;
  if (tokens !== null && (!Number.isInteger(tokens) || tokens < 1 || tokens > 1000000000)) fail('usage_budget_invalid');
  if (usd !== null && (!Number.isFinite(usd) || usd <= 0 || usd > 1000000 || Number(usd.toFixed(6)) !== usd)) fail('usage_budget_invalid');
  if (typeof userText !== 'string' || !userText.trim() || typeof evidence !== 'string' ||
      !evidence.trim() || evidence.length > 1000 || !userText.includes(evidence)) fail('usage_budget_evidence');
  if (tokens === null && args.token_text !== undefined && args.token_text !== null && args.token_text !== '') fail('usage_budget_invalid');
  if (usd === null && args.usd_text !== undefined && args.usd_text !== null && args.usd_text !== '') fail('usage_budget_invalid');
  if (tokens !== null) {
    const literal = groundedLiteral(userText, evidence, args.token_text);
    const match = literal.match(/^(.+?)\s*(?:tokens?|令牌)$/i);
    const amount = match && quantity(match[1].trim());
    if (!amount || amount.numerator <= 0n || amount.numerator % amount.denominator !== 0n ||
        amount.numerator / amount.denominator !== BigInt(tokens)) fail('usage_budget_evidence');
  }
  if (usd !== null) {
    const literal = groundedLiteral(userText, evidence, args.usd_text, true);
    // 美元 itself contains 元; remove supported names before checking others.
    if (UNSUPPORTED_CURRENCY.test(literal.replace(/美元|美金/g, ''))) fail('usage_budget_currency');
    const match = literal.match(/^(?:USD\s*|(?:US)?\$\s*)(.+)$/i) ||
      literal.match(/^(.+?)\s*(?:USD|美元|美金|\$)$/i);
    if (!match) fail('usage_budget_currency');
    const amount = quantity(match[1].trim());
    if (!amount || amount.numerator <= 0n || (amount.numerator * 1000000n) % amount.denominator !== 0n ||
        Number(amount.numerator) / Number(amount.denominator) !== usd) fail('usage_budget_evidence');
  }
  return { scope, tokens, usd };
}

module.exports = { validateBudgetCommand };
