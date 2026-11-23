'use strict';

const assert = require('node:assert/strict');
const { validateBudgetCommand } = require('./usage-budget-command');
let checks = 0;
function command(text, tokens = null, usd = null, extra = {}) {
  return { scope: 'daily', tokens, usd, evidence: text, ...extra };
}
function accepted(text, args) {
  assert.deepEqual(validateBudgetCommand(args, text), { scope: args.scope, tokens: args.tokens, usd: args.usd });
  checks += 1;
}
function rejected(text, args, code) {
  assert.throws(() => validateBudgetCommand(args, text), error => {
    assert.ok(['usage_budget_invalid', 'usage_budget_evidence', 'usage_budget_currency'].includes(error.code));
    if (code) assert.equal(error.code, code);
    assert.equal(error.message, error.code, 'error cannot reveal source text');
    return true;
  });
  checks += 1;
}

for (const [literal, tokens] of [
  ['20000 tokens', 20000], ['2万 token', 20000], ['20k tokens', 20000], ['两万令牌', 20000],
  ['二十万 tokens', 200000], ['一百万令牌', 1000000], ['两点五万令牌', 25000],
  ['2.5万 TOKENS', 25000], ['20,000 tokens', 20000], ['一亿二千万令牌', 120000000],
  ['十亿令牌', 1000000000], ['1 tokens', 1], ['一百零二令牌', 102],
]) {
  const text = '每天限制 ' + literal + '。';
  accepted(text, command(text, tokens, null, { token_text: literal }));
}
for (const [literal, usd] of [
  ['$0.25', .25], ['0.25 USD', .25], ['USD 1.5', 1.5], ['两点五美元', 2.5],
  ['一美金', 1], ['$0.000001', .000001], ['1百万美元', 1000000], ['US$2', 2],
]) {
  const text = '预算 ' + literal + '。';
  if (literal === '1百万美元') rejected(text, command(text, null, usd, { usd_text: literal }));
  else accepted(text, command(text, null, usd, { usd_text: literal }));
}
const both = '每天两万令牌，最多0.25美元。';
accepted(both, command(both, 20000, .25, { token_text: '两万令牌', usd_text: '0.25美元' }));
for (const scope of ['daily', 'per_task', 'task']) accepted('取消预算', command('取消预算', null, null, { scope }));
accepted('把每天预算设成 $1。', command('每天预算设成 $1', null, 1, { usd_text: '$1' }));
accepted('Daily maximum 2 tokens.', command('Daily maximum 2 tokens.', 2, null, { token_text: '2 tokens' }));
accepted('Daily maximum,2 tokens.', command('Daily maximum,2 tokens.', 2, null, { token_text: '2 tokens' }));
accepted('Daily maximum 2 tokens.', command('Daily maximum 2 tokens.', 2, null, { token_text: ' 2 tokens' }));
accepted('Daily maximum $1.', command('Daily maximum $1.', null, 1, { usd_text: '$1' }));

rejected('上限20 tokens', command('上限20 tokens', 21, null, { token_text: '20 tokens' }), 'usage_budget_evidence');
rejected('上限$0.25', command('上限$0.25', null, .5, { usd_text: '$0.25' }), 'usage_budget_evidence');
rejected('设两万令牌', command('设两万令牌', 20000, null, { token_text: '20000 tokens' }), 'usage_budget_evidence');
rejected('20 tokens', command('20 tokens', 20, null), 'usage_budget_evidence');
rejected('1.5 tokens', command('1.5 tokens', 1, null, { token_text: '1.5 tokens' }), 'usage_budget_evidence');
rejected('1e5 tokens', command('1e5 tokens', 100000, null, { token_text: '1e5 tokens' }), 'usage_budget_evidence');
rejected('20', command('20', 20, null, { token_text: '20' }), 'usage_budget_evidence');
for (const literal of ['5元', '人民币5', 'CNY 5', 'RMB 5', '￥5', '€5', '5', '$5元']) {
  rejected(literal, command(literal, null, 5, { usd_text: literal }), 'usage_budget_currency');
}
for (const text of ['人民币 $5', '$5人民币', '$5元', 'CNY $5']) {
  rejected(text, command(text, null, 5, { usd_text: '$5' }), 'usage_budget_currency');
}
for (const text of ['12 tokens', '-2 tokens', '- 2 tokens', '负两万令牌', '1.2 tokens', '1e2 tokens', '十二 tokens']) {
  const literal = text.includes('两万') ? '两万令牌' : text.includes('十二') ? '二 tokens' : '2 tokens';
  const tokens = literal.includes('两万') ? 20000 : 2;
  rejected(text, command(literal, tokens, null, { token_text: literal }), 'usage_budget_evidence');
}
for (const text of ['$10.25', '$0.2501', '10.25 USD', '-$0.25', '- $0.25']) {
  const literal = text.includes('USD') ? '0.25 USD' : text.includes('0.2501') ? '$0.25' : text.includes('10.25') ? '$10.25' : '$0.25';
  const usd = literal === '$10.25' ? .25 : .25;
  rejected(text, command(literal, null, usd, { usd_text: literal }), 'usage_budget_evidence');
}
rejected('取消预算', command('伪造的原文'), 'usage_budget_evidence');
rejected('', command('取消预算'), 'usage_budget_evidence');
rejected('   ', command('   '), 'usage_budget_evidence');
rejected('x'.repeat(1001), command('x'.repeat(1001)), 'usage_budget_evidence');
rejected('取消预算', command('取消预算', null, null, { token_text: '20 tokens' }), 'usage_budget_invalid');
rejected('取消预算', command('取消预算', null, null, { usd_text: '$1' }), 'usage_budget_invalid');
rejected('取消预算', command('取消预算', null, null, { amount_text: 'something' }), 'usage_budget_invalid');
rejected('取消预算', command('取消预算', null, null, { scope: 'all' }), 'usage_budget_invalid');
for (const tokens of [-1, 0, 1.5, 1000000001, NaN, Infinity, '20', undefined]) {
  rejected('20 tokens', command('20 tokens', tokens, null, { token_text: '20 tokens' }), 'usage_budget_invalid');
}
for (const usd of [-1, 0, 1000000.000001, .0000001, NaN, Infinity, '1', undefined]) {
  rejected('$1', { ...command('$1', null, 1, { usd_text: '$1' }), usd }, 'usage_budget_invalid');
}
rejected('1 tokens', { scope: 'daily', tokens: 1, evidence: '1 tokens', token_text: '1 tokens' }, 'usage_budget_invalid');
rejected('取消预算', Object.assign(Object.create({ private: true }), command('取消预算')), 'usage_budget_invalid');
rejected('取消预算', { ...command('取消预算'), [Symbol('extra')]: true }, 'usage_budget_invalid');
rejected('取消预算', null, 'usage_budget_invalid');
rejected('取消预算', [], 'usage_budget_invalid');
console.log('PASS usage-budget-command (' + checks + ' checks)');
