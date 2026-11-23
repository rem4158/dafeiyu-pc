'use strict';

// Installed Chrome, isolated profile, in-memory documents; no live sites/accounts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createBrowserEngine } = require('./engine');
const { sites } = require('./sites');

const zhihuPost = 'https://zhuanlan.zhihu.com/p/66234523';
const xhsAccount = 'https://www.xiaohongshu.com/user/profile/650000000000000000000001';
const login = '<div role="dialog">登录知乎<input autocomplete="username"><input type="password"><button>登录</button></div>';
const signedIn = '<header><button class="AppHeader-profile" aria-label="我的主页">private-fixture-account</button></header>';
const publicFeed = `<main><a href="${zhihuPost}">只是公开推荐</a></main>`;
const openPost = { action: 'read', url: zhihuPost };
const html = body => '<!doctype html><meta charset="utf-8">' + body;
const document = (status, body, headers) => ({ status, contentType: 'text/html; charset=utf-8', body: html(body), headers });

async function verify(profileDir) {
  let clock = Date.UTC(2026, 9, 1, 4), zhihuProbes = 0, postVisits = 0, authAttempts = 0, accountVisits = 0;
  let zhihuHome = html(publicFeed), article = document(403, '<main>访问受限</main>');
  let xhsHome = html('<main>公开发现</main>');
  const fixtures = new Map([
    [sites.zhihu.feed, () => { zhihuProbes++; return zhihuHome; }],
    [zhihuPost, () => { postVisits++; return article; }],
    [sites.xiaohongshu.feed, () => xhsHome],
    [xhsAccount, () => { accountVisits++; return html('<main>不应访问</main>'); }]
  ]);
  const engine = createBrowserEngine({ profileDir, fixtures, now: () => clock });
  async function status(site, force = true) {
    const output = await engine.checkSession(site, { force });
    assert.equal(output.ok, true, JSON.stringify(output));
    const result = output.result;
    assert.equal(result.site, site);
    assert.ok(Number.isFinite(Date.parse(result.checked_at)));
    assert.doesNotMatch(JSON.stringify(result), /private-fixture-account|只是公开推荐|zhuanlan|650000000000000000000001/);
    return result;
  }
  try {
    assert.equal((await status('zhihu')).session_status, 'unknown', 'a reachable public feed does not prove sign-in');
    zhihuHome = html(`<article>${signedIn}</article><div hidden>${signedIn}</div>` + publicFeed);
    assert.equal((await status('zhihu')).session_status, 'unknown', 'content and hidden account markers are not evidence');
    zhihuHome = html(signedIn + publicFeed);
    assert.equal((await status('zhihu')).session_status, 'signed_in');
    assert.equal((await status('xiaohongshu')).session_status, 'unknown', 'the signed-in account marker must not leak across sites');
    xhsHome = html(`<nav><a href="${xhsAccount}">我</a></nav><main>公开发现</main>`);
    assert.equal((await status('xiaohongshu')).session_status, 'signed_in');
    assert.equal(accountVisits, 0, 'read only the public page, not the account profile');

    const recovery = {
      getCredentials: async () => { authAttempts++; throw new Error('must not read configured credentials here'); },
      requestCode: async () => { authAttempts++; throw new Error('must not send a verification code here'); },
      onManualChallenge: async () => { authAttempts++; throw new Error('must not request manual verification here'); }
    };
    const denied = await engine.browse(openPost, recovery);
    assert.equal(denied.error.code, 'browser_access_denied');
    assert.equal(denied.error.http_status, 403);
    assert.ok(!['login_required','verification_required'].includes(denied.error.session_status));
    assert.equal(authAttempts, 0);

    // Even a recognizable form in a 429 document must not trigger auto-login.
    article = document(429, login, { 'retry-after': '120' });
    const limited = await engine.browse(openPost, recovery);
    assert.equal(limited.error.code, 'browser_rate_limited');
    assert.equal(limited.error.http_status, 429);
    assert.ok(Date.parse(limited.error.retry_at) >= clock + 120000);
    const afterLimit = { postVisits, zhihuProbes };
    assert.equal((await engine.browse(openPost, recovery)).error.code, 'browser_rate_limited');
    assert.equal((await status('zhihu')).access_status, 'rate_limited');
    assert.equal(postVisits, afterLimit.postVisits, 'cooldown must prevent repeated site requests');
    assert.equal(zhihuProbes, afterLimit.zhihuProbes, 'forcing a check may not bypass a cooldown');
    assert.equal((await status('xiaohongshu')).access_status, 'ok', 'one site may be checked while another is cooling down');
    assert.equal(authAttempts, 0);

    clock = Date.parse(limited.error.retry_at) + 1000;
    zhihuHome = document(401, '<main>请重新登录</main>');
    assert.equal((await status('zhihu')).session_status, 'login_required');
    zhihuHome = html('<main class="yidun_panel">请完成真人验证</main>');
    assert.equal((await status('zhihu')).session_status, 'verification_required');
    zhihuHome = html('<main>访问异常，暂时限制访问。</main>');
    assert.equal((await status('zhihu')).session_status, 'unknown', 'generic refusal alone is not a challenge or logout');
  } finally {
    await engine.close();
  }
}

async function main() {
  const temp = fs.realpathSync.native(path.join(__dirname, '../../temp'));
  const dir = fs.mkdtempSync(path.join(temp, 'browser-session-'));
  try {
    await verify(path.join(dir, 'browser-profile'));
  } finally {
    assert.equal(fs.realpathSync.native(dir), dir);
    assert.equal(path.dirname(dir), temp);
    assert.match(path.basename(dir), /^browser-session-[A-Za-z0-9]{6}$/);
    fs.rmSync(dir, { recursive: true, maxRetries: 8, retryDelay: 100 });
  }
  console.log('PASS browser sessions: site-specific evidence, private markers excluded, HTTP 403/429 separated, cooldown and verification gates');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
