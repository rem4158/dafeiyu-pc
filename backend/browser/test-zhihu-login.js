'use strict';

// Real Chrome, an isolated profile and in-memory fixtures. No network or account.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createBrowserEngine } = require('./engine');
const { sites, trustedHost, challengeImageHost } = require('./sites');

const signin = 'https://www.zhihu.com/signin';
const feed = sites.zhihu.feed;
const foreign = 'https://zhuanlan.zhihu.com/signin';
const endpoints = ['/udid', '/sc-profiler'].map(name => new URL(name, signin).href);
const hosts = ['necaptcha.nosdn.127.net', 'necaptcha-nosdn.126.net'];
const images = hosts.map(host => 'https://' + host + '/fixture.png');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkvkAAAAASUVORK5CYII=', 'base64');
const article = 'https://www.zhihu.com/question/321';
const blank = '<!doctype html><meta charset="utf-8"><title>Fixture</title><body></body>';
const denied = { widths: [0, 0], posts: [false, false] };

// Executed in the page. A successful image has to be decoded by Chrome.
async function probe({ images, endpoints }) {
  const widths = await Promise.all(images.map(url => new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth);
    img.onerror = () => resolve(0);
    img.src = url;
    document.body.appendChild(img);
  })));
  const posts = await Promise.all(endpoints.map(url =>
    fetch(url, { method: 'POST', mode: 'no-cors' }).then(() => true, () => false)));
  return { widths, posts };
}

function resourcePolicy() {
  for (const host of hosts) {
    for (const site of Object.keys(sites)) {
      assert.equal(trustedHost(site, host, false), false);
      assert.equal(trustedHost(site, host, true), false, site + ' generic CONNECT: ' + host);
      assert.equal(challengeImageHost(site, host), site === 'zhihu');
    }
    for (const other of ['x.' + host, host + '.invalid']) {
      assert.equal(trustedHost('zhihu', other, true), false);
      assert.equal(challengeImageHost('zhihu', other), false);
    }
  }
}

async function verify(dir) {
  const profileDir = path.join(dir, 'browser-profile');
  const attempted = [], failed = [], served = [];
  const fixtures = new Map();
  let headless;
  let onPage;
  const pageReady = new Promise(resolve => { onPage = resolve; });
  const browserType = {
    async launchPersistentContext(location, options) {
      assert.equal(location, profileDir);
      assert.equal(options.offline, true);
      assert.equal(options.channel, 'chrome');
      headless = options.headless;
      const args = headless ? options.args :
        [...options.args, '--start-minimized', '--window-position=-12000,-12000'];
      const context = await chromium.launchPersistentContext(location, { ...options, args });
      context.on('request', req => attempted.push(req.method() + ' ' + req.url()));
      context.on('requestfailed', req => failed.push(req.method() + ' ' + req.url()));
      if (!headless) context.once('page', onPage);
      return context;
    }
  };
  // A present fixture is also a tripwire. A forbidden request must fail before it
  // reaches the handler, even if Chrome itself rejects its MIME type or CORS.
  function fixture(url, reply) {
    fixtures.set(url, req => {
      served.push(req.method() + ' ' + req.url());
      return typeof reply === 'function' ? reply(req) : reply;
    });
  }
  for (const img of images) fixture(img, { contentType: 'image/png', body: png });
  const redirectedImage = images[0] + '?redirect=1';
  const redirectDestination = new URL('/fixture-other-origin.png', signin).href;
  fixture(redirectedImage, { status: 302, headers: { location: redirectDestination }, body: '' });
  fixture(redirectDestination, { contentType: 'image/png', body: png });
  for (const url of endpoints) fixture(url, { contentType: 'text/plain', body: 'ok' });
  const unrelated = new URL('/udid-extra', signin).href;
  fixture(unrelated, { contentType: 'text/plain', body: 'unexpected' });
  fixture(foreign, blank);
  const inputs = { images, endpoints };
  fixture(signin, () => headless ? blank + '<script>(' + probe.toString() + ')(' +
    JSON.stringify(inputs) + ').then(result => parent.postMessage(result, location.origin))</script>' : blank);
  fixture(feed, () => headless ? blank + `
    <script>window.addEventListener('message', event => {
      if (event.origin !== location.origin) return;
      const link = document.createElement('a'); link.href = ${JSON.stringify(article)};
      link.textContent = JSON.stringify(event.data); document.body.appendChild(link);
    });</script><iframe src="/signin"></iframe>` : blank);
  const engine = createBrowserEngine({ profileDir, fixtures, browserType });
  const timeout = AbortSignal.timeout(45000);
  function count(list, method, url) { return list.filter(item => item === method + ' ' + url).length; }
  async function expectDenied(context, method, type, url, action) {
    const seen = count(attempted, method, url);
    const failures = count(failed, method, url);
    const hits = count(served, method, url);
    await Promise.all([context.waitForEvent('requestfailed', {
      timeout: 3500, predicate: req => req.url() === url && req.method() === method && req.resourceType() === type
    }), action()]);
    assert.equal(count(attempted, method, url), seen + 1, method + ' was not attempted: ' + url);
    assert.equal(count(failed, method, url), failures + 1, method + ' did not fail: ' + url);
    assert.equal(count(served, method, url), hits, method + ' reached fixture: ' + url);
  }
  async function denyFrom(frame) {
    await frame.waitForLoadState('domcontentloaded');
    const start = served.length;
    assert.deepEqual(await frame.evaluate(probe, inputs), denied, frame.url());
    const reached = served.slice(start);
    for (const url of [...images, ...endpoints])
      assert.ok(!reached.some(entry => entry.endsWith(' ' + url)), 'fixture reached from ' + frame.url());
  }
  let login;
  try {
    login = engine.openLogin('zhihu', { signal: timeout });
    const page = await Promise.race([pageReady, login.then(result => {
      throw new Error('window did not open: ' + JSON.stringify(result));
    })]);
    await page.waitForURL(signin, { waitUntil: 'domcontentloaded', timeout: 6000 });
    assert.equal(headless, false, 'openLogin must request a headed Chrome');
    assert.deepEqual(await page.evaluate(probe, inputs), { widths: [1, 1], posts: [true, true] });
    for (const url of images) assert.equal(count(served, 'GET', url), 1);
    for (const url of endpoints) assert.equal(count(served, 'POST', url), 1);
    assert.deepEqual(await page.evaluate(probe, { images: [redirectedImage], endpoints: [] }),
      { widths: [0], posts: [] });
    assert.equal(count(served, 'GET', redirectedImage), 1);
    assert.equal(count(attempted, 'GET', redirectDestination), 0, 'image redirect followed by Chrome');

    const context = page.context();
    const imageUrl = images[0];
    for (const [tag, type] of [['script', 'script'], ['iframe', 'document']]) {
      await expectDenied(context, 'GET', type, imageUrl, () => page.evaluate(({ tag, imageUrl }) => {
        const node = document.createElement(tag);
        node.src = imageUrl;
        document.body.appendChild(node);
      }, { tag, imageUrl }));
    }
    for (const [method, url] of [['POST', imageUrl], ['GET', imageUrl], ['DELETE', endpoints[0]], ['POST', unrelated]]) {
      await expectDenied(context, method, 'fetch', url, () => page.evaluate(({ method, url }) =>
        fetch(url, { method, mode: method === 'DELETE' ? 'same-origin' : 'no-cors' }).catch(() => {}), { method, url }));
    }
    const other = await context.newPage();
    await other.goto(signin);
    await expectDenied(context, 'GET', 'document', imageUrl, () => other.goto(imageUrl).catch(() => {}));
    await other.close();

    const [child] = await Promise.all([
      page.waitForEvent('framenavigated', frame => frame.url() === foreign),
      page.evaluate(url => { const f = document.createElement('iframe'); f.src = url; document.body.appendChild(f); }, foreign)
    ]);
    await denyFrom(child);
    // A sandboxed script has an opaque origin even when the parent is the login page.
    const [opaque] = await Promise.all([
      page.waitForEvent('framenavigated', frame => frame.url() === 'about:srcdoc'),
      page.evaluate(() => {
        const f = document.createElement('iframe');
        f.sandbox = 'allow-scripts';
        f.srcdoc = '<body>opaque frame</body>';
        document.body.appendChild(f);
      })
    ]);
    assert.equal(await opaque.evaluate(() => self.origin), 'null');
    await denyFrom(opaque);
    await page.goto(foreign);
    await denyFrom(page);
    await page.goto(feed);
    await denyFrom(page);
    await context.close();
    assert.equal((await login).result?.window_closed, true);

    const start = served.length;
    const result = await engine.browse({ site: 'zhihu', action: 'feed' }, { signal: timeout });
    assert.equal(headless, true);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.result.links, [{ url: article, title: JSON.stringify(denied) }]);
    for (const url of [...images, ...endpoints])
      assert.ok(!served.slice(start).some(item => item.endsWith(' ' + url)), 'headless fixture reached: ' + url);
  } finally {
    await engine.close();
    await login?.catch(() => {});
  }
}

async function main() {
  resourcePolicy();
  const temp = fs.realpathSync.native(path.join(__dirname, '../../temp'));
  const dir = fs.mkdtempSync(path.join(temp, 'browser-zhihu-login-'));
  try {
    await verify(dir);
  } finally {
    assert.equal(fs.realpathSync.native(dir), dir);
    assert.equal(path.dirname(dir), temp);
    assert.match(path.basename(dir), /^browser-zhihu-login-\w{6}$/);
    fs.rmSync(dir, { recursive: true, maxRetries: 10, retryDelay: 120 });
  }
  console.log('PASS Zhihu login: offline headed and headless Chrome, two decoded images, bounded login POSTs and origin guards');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
