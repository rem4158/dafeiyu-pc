'use strict';

const { secureUrl } = require('./sites');
const { openPublicEgress, publicHostname } = require('./egress');

const searchEngines = {
  baidu: ['https://www.baidu.com/s', 'wd'],
  bing: ['https://www.bing.com/search', 'q'],
  so: ['https://www.so.com/s', 'q'],
};
const privateParameter = /^(?:authorization|(?:access|refresh|id|auth|session|csrf|xsec)[_-]?token|token|password|passwd|secret|api[_-]?key|session[_-]?id|otp|verification[_-]?code)$/i;
const textLimit = 8000;
const linkLimit = 36;

function searchUrl(engine, query) {
  const [base, key] = searchEngines[engine];
  const url = new URL(base);
  url.searchParams.set(key, query.trim());
  return url.href;
}

function publicUrl(input) {
  const url = secureUrl(input);
  return url && publicHostname(url.hostname) && ![...url.searchParams.keys()].some(key => privateParameter.test(key))
    ? url : null;
}

// Only page structure is observed here. The model chooses a source or next action.
function observeDocument({ maxText, maxLinks }) {
  const trim = (value, limit) => (value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const root = document.querySelector('main, [role="main"]') || document.body;
  const text = (root?.innerText || document.body?.innerText || '').trim();
  const links = [];
  const seen = new Set();
  for (const link of (root || document).querySelectorAll('a[href]')) {
    if (!link.getClientRects().length || getComputedStyle(link).visibility !== 'visible') continue;
    const title = trim(link.innerText || link.getAttribute('aria-label'), 220);
    const url = link.href;
    if (!title || !url.startsWith('https://') || url.length > 4096 || seen.has(url)) continue;
    seen.add(url);
    links.push({ title, url });
    if (links.length >= maxLinks) break;
  }
  return { title: trim(document.title, 220), text: text.slice(0, maxText),
    text_truncated: text.length > maxText, url: location.href, links };
}

const failure = (code, message, result) => ({ ok: false, error: { code, message }, ...(result && { result }) });

async function browsePublicPage(input, { signal, fixtures, browserType, now }) {
  const target = publicUrl(input);
  if (!target) return failure('browser_invalid_public_url', '请输入公开的 HTTPS 网页地址，网址不能带访问凭据。');
  const chromium = browserType?.launch ? browserType : require('playwright-core').chromium;
  let network, browser, onAbort;
  try {
    if (!fixtures) network = await openPublicEgress();
    signal.throwIfAborted();
    browser = await chromium.launch({
      channel: 'chrome', headless: true, chromiumSandbox: true, timeout: 10000,
      ...(network && { proxy: network.proxy }),
      args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--disable-background-networking', '--no-referrers',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
    });
    signal.throwIfAborted();
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const load = async () => {
      const context = await browser.newContext({
        offline: !!fixtures, serviceWorkers: 'block', acceptDownloads: false, locale: 'zh-CN',
      });
      let requests = 0;
      await context.routeWebSocket('**/*', socket => socket.close());
      await context.route('**/*', async route => {
        try {
          const request = route.request();
          const url = secureUrl(request.url());
          const kind = request.resourceType();
          if (++requests > 220 || !url || !publicHostname(url.hostname) ||
            !['GET', 'HEAD'].includes(request.method()) ||
            ['image', 'font', 'media', 'eventsource', 'manifest'].includes(kind))
            return await route.abort();
          if (!fixtures) return await route.continue();
          const fixture = fixtures.get(url.href);
          const reply = typeof fixture === 'function' ? await fixture(request, signal) : fixture;
          if (!reply || signal.aborted) return await route.abort();
          return await route.fulfill(typeof reply === 'string' ? { contentType: 'text/html; charset=utf-8', body: reply } : reply);
        } catch { await route.abort().catch(() => {}); }
      });
      const page = await context.newPage();
      context.on('page', popup => { void popup.close().catch(() => {}); });
      let documentResponse;
      page.on('response', response => {
        const request = response.request();
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentResponse = response;
      });
      await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 13000 });
      await page.waitForLoadState('load', { timeout: 1500 }).catch(() => {});
      await page.waitForFunction(() => !!document.body?.innerText.trim(), undefined, { timeout: 2500 }).catch(() => {});
      const { url: observed, links, ...pageData } = await page.evaluate(observeDocument, { maxText: textLimit, maxLinks: linkLimit });
      const source = publicUrl(observed);
      if (!source) return failure('browser_navigation_blocked', '网页跳转到了无法读取的地址。');
      const status = documentResponse && new URL(documentResponse.url()).origin === source.origin ? documentResponse.status() : null;
      const publicLinks = [];
      let remaining = 6500;
      for (const link of links) {
        if (!publicUrl(link.url) || link.url.length + link.title.length > remaining) continue;
        remaining -= link.url.length + link.title.length;
        publicLinks.push(link);
      }
      const result = { ...pageData, source_url: source.href, checked_at: new Date(now()).toISOString(),
        http_status: status, links: publicLinks };
      if (status === 429) return failure('browser_rate_limited', '网页限制了请求频率。', result);
      if (status === 401 || status === 403) return failure('browser_access_denied', '网页拒绝了本次访问。', result);
      if (status >= 400) return failure('browser_http_error', '网页返回 HTTP ' + status + '。', result);
      if (!result.text && !result.links.length) return failure('browser_no_content', '这次没有读到可见文字或链接。', result);
      return { ok: true, result };
    };
    return await Promise.race([load(), cancelled]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    try { if (browser) await browser.close(); }
    finally { if (network) await network.close(); }
  }
}

module.exports = { browsePublicPage, searchUrl };
