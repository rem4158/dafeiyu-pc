'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { sites, secureUrl, siteForUrl, trustedHost, challengeHost, challengeImageHost, loginHost, loginHosts, isPost, targetFor, weiboVisitorPage } = require('./sites');
const { inspectPage, collect, xhsSearchFieldSelector } = require('./page');
const { tryLogin } = require('./login');
const { openEgress } = require('./egress');
const { browsePublicPage, searchUrl } = require('./public-web');
const { readImage, readVerificationImage, imageType, maxBytes } = require('./post-images');
const { observeHupuComments, advanceHupuComments, sameHupuThread } = require('./hupu-comments');

const profiles = new Set();
const failure = (code, message, details) => ({ ok: false, error: { code, message, ...details } });
const busy = () => failure('browser_profile_busy', '专属浏览器正在使用，请待当前浏览或登录窗口结束。');
const abort = () => new DOMException('浏览已停止', 'AbortError');
const loginPath = /(?:\/(?:login|signin|passport|captcha|verify|security|account\/unhuman|wappass|wp)\/?|^\/v2\/)/i;
const readPost = /\/(?:homefeed|feed|search\/notes|search\/suggest|search\/hotlist|note\/detail|recommend\/list)\/?$/i;
const authPost = /\/(?:login|signin|sms|send[_-]?code|verify[_-]?code|captcha|passport|verification|challenge|qrcode)(?:[/.?_-]|$)/i;
// Restrict document navigation to public listing routes. A route says nothing
// about whether the visible notes answer the model's query.
const xhsPublicListing = /^\/(?:explore|search|search(?:\/results?|_result)(?:[_-][a-z\d]+)*)\/?$/i;
function canObserveXhsPage(url, gate) {
  return loginHost('xiaohongshu',url) && (xhsPublicListing.test(url.pathname) || isPost('xiaohongshu',url) ||
    Boolean(gate && loginPath.test(url.pathname)));
}
const privateSearchPage = () => failure('browser_navigation_blocked','网页跳转到了公开图文浏览范围以外。');
const statusTtlMs = 30000;
const loginRetryMs = 2 * 60000;
const hupuCommentBatchSize = 12;

function responseDetails(response) {
  if (!response) return null;
  const headers = response.headers?.();
  return { status:response.status(), retryAfter:headers?.['retry-after'],
    contentType:headers?.['content-type']?.split(';',1)[0].trim().toLowerCase() };
}

async function zhihuDenialCode(page, url) {
  return page.evaluate(expected => {
    if (location.href.split('#')[0] !== expected || document.contentType !== 'application/json') return null;
    const text = document.querySelector('body > pre')?.textContent || document.body?.textContent;
    if (!text || text.length > 4096) return null;
    try { return JSON.parse(text)?.error?.code === 40362 ? 40362 : null; }
    catch { return null; }
  }, url.href.split('#')[0]);
}

function trackZhihuDocuments(page, site) {
  if (site !== 'zhihu') return undefined;
  const documents = new Map();
  page.on('response', response => {
    const request = response.request();
    if (!request.isNavigationRequest() || request.resourceType() !== 'document' || response.frame() !== page.mainFrame()) return;
    const url = response.url().split('#')[0];
    documents.delete(url);
    if (documents.size >= 24) documents.delete(documents.keys().next().value);
    documents.set(url,responseDetails(response));
  });
  return documents;
}

function retryTime(header, now) {
  if (typeof header === 'string' && header.length <= 80) {
    const value = header.trim();
    const deadline = /^\d+$/.test(value) ? now + Number(value)*1000 :
      /^[A-Za-z]{3}, .+ GMT$/.test(value) ? Date.parse(value) : NaN;
    if (Number.isFinite(deadline) && deadline <= 8.64e15) return Math.max(now+1000,deadline);
  }
  return now + 5*60000;
}

function prepareProfile(profileDir) {
  if (!path.isAbsolute(profileDir) || !['browser-profile','profile'].includes(path.basename(profileDir))) throw new Error('专属资料目录无效');
  const parent = path.dirname(profileDir);
  if (path.relative(parent,fs.realpathSync.native(parent))) throw new Error('专属资料目录发生重定向');
  if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir);
  if (!fs.lstatSync(profileDir).isDirectory() || path.relative(profileDir,fs.realpathSync.native(profileDir))) throw new Error('专属资料目录无效');
}

function fromZhihuLogin(request) {
  const frame = request.frame();
  const top = frame.page().mainFrame();
  for (let current = frame; current; current = current.parentFrame()) {
    const url = secureUrl(current.url());
    if (url?.origin !== 'https://www.zhihu.com' || !['/signin', '/account/unhuman'].includes(url.pathname)) return false;
    if (current === top) return true;
  }
  return false;
}

async function serveVerificationImage(route, url, signal, fixtures) {
  const request = route.request();
  let reply;
  if (fixtures) {
    const fixture = fixtures.get(url.href);
    reply = typeof fixture === 'function' ? await fixture(request, signal) : fixture;
  } else {
    reply = await readVerificationImage(url.href, request.method(), signal, request.headers().origin);
  }
  const type = reply?.contentType;
  const head = request.method() === 'HEAD';
  if (!reply || signal.aborted || (reply.status !== undefined && reply.status !== 200) ||
      !['image/png','image/jpeg','image/webp'].includes(type) || !Buffer.isBuffer(reply.body) ||
      reply.body.length > maxBytes || (!head && imageType(reply.body) !== type)) return route.abort();
  const headers = { 'cache-control': 'no-store', 'content-type': type, 'x-content-type-options': 'nosniff' };
  const cors = reply.headers?.['access-control-allow-origin'];
  if (cors === '*' || cors === 'https://www.zhihu.com') headers['access-control-allow-origin'] = cors;
  const policy = reply.headers?.['cross-origin-resource-policy'];
  if (['cross-origin','same-site','same-origin'].includes(policy)) headers['cross-origin-resource-policy'] = policy;
  return route.fulfill({ status: 200, headers, body: head ? Buffer.alloc(0) : reply.body });
}

async function bindNetwork(context, target, fixtures, state, manual) {
  let requests = 0;
  await context.routeWebSocket('**/*', socket => socket.close());
  await context.route('**/*', async route => {
    try {
      const request = route.request();
      const url = secureUrl(request.url());
      const type = request.resourceType();
      if (++requests > (manual ? 1800 : 360) || !url ||
        ['media','websocket','eventsource','manifest'].includes(type) || /\.(?:mp4|webm|m3u8|m4s|flv|m3u)(?:$|\?)/i.test(url.href))
        return await route.abort();
      if (challengeImageHost(target.site, url.hostname)) {
        if (!manual || type !== 'image' || request.isNavigationRequest() ||
            !['GET', 'HEAD'].includes(request.method()) || !fromZhihuLogin(request)) return await route.abort();
        // A Chrome tunnel would also admit redirect hops that Playwright cannot intercept.
        return await serveVerificationImage(route, url, state.signal, fixtures);
      }
      if (!trustedHost(target.site,url.hostname,manual)) return await route.abort();
      const challengeAsset = manual && challengeHost(target.site,url.hostname);
      if (type === 'document' && !loginHost(target.site,url) && url.href !== target.url && !challengeAsset) return await route.abort();
      if (type === 'document' && state.hupuCommentThread && !sameHupuThread(state.hupuCommentThread,url.href)) return await route.abort();
      if (type === 'document' && !manual && url.href !== target.url && !isPost(target.site,url) &&
          !loginPath.test(url.pathname) && !(target.site === 'xiaohongshu' && xhsPublicListing.test(url.pathname)) &&
          !(target.site === 'weibo' && (weiboVisitorPage(url) || /^\/(?:newlogin|sso\/login)(?:[/.]|$)/i.test(url.pathname))))
        return await route.abort();
      if (!['GET','HEAD','OPTIONS'].includes(request.method())) {
        const zhihuLogin = target.site === 'zhihu' && url.hostname === 'www.zhihu.com' &&
          /^\/api\/v\d+\/(?:anticrawl\/|oauth\/|account\/(?:api|login)\/?$)/.test(url.pathname);
        const loginSetup = manual && target.site === 'zhihu' && url.origin === 'https://www.zhihu.com' &&
          ['/udid','/sc-profiler'].includes(url.pathname) && !url.search && ['xhr','fetch'].includes(type) &&
          request.headers().origin === url.origin && fromZhihuLogin(request);
        const baiduLogin = target.site === 'tieba' && ['passport.baidu.com','wappass.baidu.com'].includes(url.hostname) &&
          /^\/(?:cap\/|v2\/api\/?$)/.test(url.pathname);
        const allowedPost = target.site === 'weibo'
          ? manual && loginHost('weibo',url) && (weiboVisitorPage(url) || /^\/(?:sso|visitor|ajax\/login)(?:\/|$)/.test(url.pathname))
          : loginSetup || challengeAsset || readPost.test(url.pathname) || state.allowLogin && (baiduLogin || zhihuLogin) ||
            state.allowLogin && authPost.test(url.pathname) && !/cdn|bdimg|zhimg|hoopchina/.test(url.hostname);
        if (request.method() !== 'POST' || !allowedPost) return await route.abort();
      }
      if (fixtures) {
        const handler = fixtures.get(url.href);
        const reply = typeof handler === 'function' ? await handler(request, state.signal) : handler;
        if (!reply || state.signal.aborted) return await route.abort();
        return await route.fulfill(typeof reply === 'string' ? { contentType: 'text/html; charset=utf-8',body:reply } : reply);
      }
      return await route.continue();
    } catch { await route.abort().catch(() => {}); }
  });
}

function createBrowserEngine({ profileDir, fixtures, browserType, now = Date.now } = {}) {
  const closing = new AbortController();
  const pending = new Set();
  const signedLinks = new Map();
  const sessionChecks = new Map();
  const rateLimits = new Map();
  const loginAttempts = new Map();
  let manualTarget;
  function remember(url, signed) {
    signedLinks.delete(url);
    signedLinks.set(url,{ signed, time:Date.now() });
    if (signedLinks.size > 150) signedLinks.delete(signedLinks.keys().next().value);
  }

  function observeSession(site, snapshot, response) {
    const at = now();
    const status = response?.status;
    const statusKnown = Number.isInteger(status);
    const access = status === 429 ? 'rate_limited' : status === 403 || snapshot.denied ? 'access_denied' :
      statusKnown && status >= 200 && status < 300 ? 'ok' : 'unknown';
    let state = 'unknown', evidence = 'unconfirmed';
    if (status === 429) evidence = 'http_rate_limit';
    else if (access === 'access_denied') evidence = status === 403 ? 'http_access_denied' : 'access_notice';
    else if (status === 401) [state,evidence] = ['login_required','http_authentication_required'];
    else if (!snapshot.transition && (!statusKnown || status < 400)) {
      if (snapshot.gate === 'captcha') [state,evidence] = ['verification_required','verification_gate'];
      else if (snapshot.gate === 'login') [state,evidence] = ['login_required','login_gate'];
      else if (snapshot.account && access === 'ok') [state,evidence] = ['signed_in','account_menu'];
    }
    const report = {site, session_status:state, checked_at:new Date(at).toISOString(), access_status:access, evidence,
      ...(statusKnown && {http_status:status})};
    if (access === 'rate_limited') {
      const until = retryTime(response.retryAfter,at);
      report.retry_at = new Date(until).toISOString();
      rateLimits.set(site,{until, report});
      sessionChecks.delete(site);
    } else if (state !== 'unknown' && sessionChecks.get(site)?.report.session_status !== state) {
      sessionChecks.delete(site);
    }
    if (state === 'signed_in') {
      loginAttempts.delete(site);
    }
    return report;
  }

  function activeRateLimit(site) {
    const limit = rateLimits.get(site);
    if (limit?.until > now()) return limit.report;
    if (limit) rateLimits.delete(site);
    return null;
  }

  const rateLimited = report => failure('browser_rate_limited','站点限制了请求频率，稍后再试。',report);
  const accessDenied = report => failure('browser_access_denied',report.site_code === 40362
    ? '知乎返回 40362，当前页面未提供正文。登录状态需单独检查。'
    : '站点拒绝访问当前页面，无法据此判断登录是否失效。',report);

  function beginLogin(site) {
    if ((loginAttempts.get(site) || 0) > now()) return false;
    loginAttempts.set(site,now()+loginRetryMs);
    sessionChecks.delete(site);
    return true;
  }

  async function withPage(target, signal, manual, work, { backgroundWindow = false, offline = false } = {}) {
    signal.throwIfAborted();
    prepareProfile(profileDir);
    const key = process.platform === 'win32' ? profileDir.toLowerCase() : profileDir;
    if (profiles.has(key)) return busy();
    profiles.add(key);
    let network, context, onAbort, browserPid;
    try {
      if (!fixtures && !offline) network = await openEgress(target.site,manual);
      signal.throwIfAborted();
      const chromium = browserType || require('playwright-core').chromium;
      context = await chromium.launchPersistentContext(profileDir, {
        channel:'chrome', headless:!manual && !backgroundWindow, chromiumSandbox:true, timeout:20000,
        offline:!!fixtures || offline, ...(network ? {proxy:network.proxy} : {}), serviceWorkers:'block',
        acceptDownloads:false, locale:'zh-CN', permissions:[],
        args:['--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
          '--disable-session-crashed-bubble','--disable-background-networking','--disk-cache-size=1',
          '--media-cache-size=1','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
          ...(backgroundWindow ? ['--start-minimized','--window-position=-12000,-12000'] : [])]
      });
      if (manual) {
        const cdp = await context.browser().newBrowserCDPSession();
        try {
          const {processInfo} = await cdp.send('SystemInfo.getProcessInfo');
          browserPid = processInfo.find(proc=>proc.type === 'browser')?.id;
        } finally { await cdp.detach().catch(()=>{}); }
      }
      signal.throwIfAborted();
      const cancelled = new Promise((_resolve,reject) => {
        onAbort = () => reject(abort());
        signal.addEventListener('abort', onAbort, { once:true });
      });
      const task = async () => {
        const state = { allowLogin:manual, signal };
        await bindNetwork(context,target,fixtures,state,manual);
        const page = await context.newPage();
        for (const other of context.pages()) if (other !== page) await other.close().catch(() => {});
        if (!manual) context.on('page', popup => {
          if (popup === page) return;
          if (state.allowSearchPopup && !state.searchPage) state.searchPage = popup;
          else void popup.close().catch(() => {});
        });
        return work(page,state,context);
      };
      return await Promise.race([task(),cancelled]);
    } finally {
      if (onAbort) signal.removeEventListener('abort',onAbort);
      try {
        if (context) await context.close();
        // A user closing the last visible tab may emit 'close' while Windows Chrome
        // is still flushing this profile. Keep the lock until its own process exits.
        if (browserPid > 0) {
          const until = Date.now()+6000;
          for (;;) {
            try { process.kill(browserPid,0); } catch (e) { if (e.code==='ESRCH') break; throw e; }
            if (Date.now()>=until) throw Object.assign(new Error('Profile still closing'),{code:'browser_profile_busy'});
            await delay(65);
          }
        }
      } finally { if (network) await network.close(); profiles.delete(key); }
    }
  }

  async function collectPage(page, target, action, response, wantImages, search, zhihuDocuments) {
    const started = Date.now();
    const waitMs = action === 'session' ? (fixtures ? 300 : 2500) : search ? (fixtures ? 750 : 8000) : (fixtures ? 450 : 6500);
    const zhihuSettleUntil = zhihuDocuments ? started + (fixtures ? 900 : 2200) : started;
    let until = Math.max(started + waitMs,zhihuSettleUntil);
    let previousList, stableSince;
    for (;;) {
      const currentPage = search?.state.searchPage || page;
      if (search && currentPage.url() === 'about:blank' && Date.now() < until) {
        await delay(100,undefined,{signal:search.state.signal}); continue;
      }
      let snapshot;
      try { snapshot = await inspectPage(currentPage,target.site,action); }
      catch (error) {
        if (Date.now() < until && /Execution context was destroyed|Cannot find context with specified id|navigation/i.test(error.message)) {
          await delay(150); continue;
        }
        throw error;
      }
      const url = secureUrl(snapshot.url);
      if (!url || !loginHost(target.site,url)) return failure('browser_navigation_blocked','网页跳转到未开放的地址。');
      // Zhihu can briefly show /account/unhuman before it chooses a sign-in
      // page or displays a real challenge. Let that action settle once.
      const document = (search?.documentStatus || zhihuDocuments)?.get(snapshot.url.split('#')[0]) ?? response;
      // Zhihu can serve an HTML interstitial with 403 before its own script
      // reloads the document. Observe that navigation without issuing a retry.
      if (zhihuDocuments && document?.status === 403 && document.contentType === 'text/html' && Date.now() < zhihuSettleUntil) {
        await delay(120); continue;
      }
      if (snapshot.transition && ![403,429].includes(document?.status) && Date.now()-started < 3500) {
        until = Math.max(until,started+3800);
        await delay(180); continue;
      }
      // Same-origin redirects and pushState can reach account pages without
      // another intercepted request. Check access before exposing any observation.
      if (search && !canObserveXhsPage(url,snapshot.gate)) return privateSearchPage();
      if (action === 'session' && !snapshot.gate && !snapshot.weiboVisitor) {
        const expected = new URL(target.url);
        if (url.origin !== expected.origin || url.pathname.replace(/\/$/,'') !== expected.pathname.replace(/\/$/,''))
          return failure('browser_navigation_blocked','登录状态检查未停在预期的公开入口。');
      }
      const pendingLimit = activeRateLimit(target.site);
      if (pendingLimit) return action === 'session' ? {ok:true,result:pendingLimit} : rateLimited(pendingLimit);
      const report = observeSession(target.site,snapshot,document);
      if (snapshot.weiboVisitor && ![403,429].includes(document?.status)) {
        if (Date.now() < until) { await delay(150); continue; }
        const visitor = { ...report, evidence:'visitor_page', session_status:'unknown' };
        return action === 'session' ? {ok:true,result:visitor} : {gate:'login',report:visitor};
      }
      if (action === 'session') {
        if (report.session_status === 'unknown' && report.access_status === 'ok' && Date.now() < until) {
          await delay(150); continue;
        }
        return {ok:true,result:report};
      }
      if (report.access_status === 'rate_limited') return rateLimited(report);
      if (report.access_status === 'access_denied' && zhihuDocuments && document?.status === 403 &&
          document.contentType === 'application/json' && await zhihuDenialCode(currentPage,url).catch(() => null)) {
        return accessDenied({...report,site_code:40362,source_url:target.url});
      }
      if (report.access_status === 'access_denied') return accessDenied(report);
      if (report.session_status === 'login_required') return {gate:'login',report};
      if (report.session_status === 'verification_required') return {gate:'captcha',report};
      if (report.http_status >= 400) return failure('browser_http_error','站点返回 HTTP ' + report.http_status + '。',report);
      if (snapshot.transition) return failure('browser_session_unconfirmed','站点仍停在过渡页，未确认登录或验证状态。',report);
      if (target.site === 'weibo') {
        if (url.origin + url.pathname !== sites.weibo.feed)
          return failure('browser_navigation_blocked','当前页面不是微博热搜榜。',report);
        if (snapshot.topics?.length)
          return {ok:true,result:{ ...report, title:'微博热搜', source_url:sites.weibo.feed, links:snapshot.topics },assets:[]};
        if (Date.now() >= until)
          return failure('browser_no_content','这次没有读到微博热搜条目。',report);
        await delay(150); continue;
      }
      const { links,images } = collect(target.site,snapshot,remember);
      let observation;
      if (search) {
        const orderedUrls = JSON.stringify(links.map(link => link.url));
        const same = orderedUrls === search.before;
        const now = Date.now();
        if (previousList !== orderedUrls) {
          previousList = orderedUrls;
          stableSince = now;
        }
        // Let the page render after Enter, including SPAs that keep their URL.
        // At the deadline return what is actually on screen, even an unchanged feed.
        if (['pressed_enter','opened_search_url'].includes(search.action) && now < until &&
            (same || !links.length || now - stableSince < (fixtures ? 150 : 700))) {
          await delay(200,undefined,{signal:search.state.signal}); continue;
        }
        observation = {action:search.action, ...snapshot.observation};
        if (search.before !== undefined) observation.same_visible_links = same;
      }
      const detail = action === 'read';
      if (detail && !isPost(target.site,url)) return failure('browser_navigation_blocked','目标没有打开允许读取的帖子。',report);
      if (detail && target.site === 'zhihu') {
        const requestedPath = new URL(target.url).pathname.replace(/\/$/,'');
        if (/^(?:\/question\/\d+\/answer\/\d+|\/p\/\d+)$/.test(requestedPath) &&
            url.pathname.replace(/\/$/,'') !== requestedPath)
          return failure('browser_navigation_blocked','知乎跳转到了其他页面，未读到指定内容。',report);
      }
      if (detail && snapshot.video) return failure('browser_video_unsupported','这是一篇视频内容，当前只浏览图文。',report);
      const hupuPost = detail && target.site === 'hupu';
      const comments = hupuPost ? snapshot.comments || [] : [];
      const hasBody = Boolean(snapshot.text || images.length);
      if (detail && wantImages && !fixtures && !images.length && Date.now()-started < 2500) {
        await delay(250); continue;
      }
      // Comments may be visible before the author's post is rendered. Wait for
      // the body before reporting a partial result, and keep both fields distinct.
      if (hupuPost && !hasBody && Date.now() < until) {
        await delay(250); continue;
      }
      if (observation || (detail ? hasBody || comments.length : links.length)) {
        const source = new URL(url.origin + url.pathname);
        if (action === 'search') {
          const key = sites[target.site].search[1];
          if (url.searchParams.has(key)) source.searchParams.set(key,url.searchParams.get(key));
        }
        return { ok:true, result:{...report,source_url:source.href,
          title:snapshot.title, text:detail ? snapshot.text : '', links, images: detail ? images.map(({url,alt})=>({url,alt})) : [],
          truncated:detail && snapshot.truncated, ...(observation ? {observation} : {}),
          ...(hupuPost && { comments, body_status: snapshot.text ? 'text' : images.length ? 'image_only' : 'unavailable' })
        }, assets: detail ? images : [] };
      }
      if (Date.now() >= until) return failure('browser_no_content', detail ? '没有读取到可辨认的图文正文。' : '页面未返回可辨认的图文帖子链接。',report);
      await delay(250);
    }
  }

  async function searchXiaohongshu(page, state, target, args, documentStatus) {
    const direct = args.entry === 'search_url';
    const response = await page.goto(direct ? target.url : sites.xiaohongshu.feed,
      {waitUntil:'domcontentloaded',timeout:18000});
    const observe = (action, before) => collectPage(page,target,'search',responseDetails(response),false,
      {state, documentStatus, action, before});
    if (direct) return observe('opened_search_url');
    if (response?.status() >= 400) return observe('search_box_unavailable');

    const input = page.locator(`:is(${xhsSearchFieldSelector}):enabled:not([readonly],[aria-disabled=true],[aria-readonly=true])`).filter({visible:true}).first();
    if (!await input.waitFor({state:'visible',timeout:fixtures ? 100 : 5000}).then(()=>true,()=>false))
      return observe('search_box_unavailable');
    const snapshot = await inspectPage(page,target.site,'search');
    if (!canObserveXhsPage(secureUrl(snapshot.url),snapshot.gate)) return privateSearchPage();
    if (snapshot.gate || snapshot.denied) return observe('search_box_unavailable');
    const before = collect(target.site,snapshot,() => {}).links.map(link => link.url);
    state.allowSearchPopup = true;
    try {
      try {
        await input.fill(args.query.trim(),{timeout:3500});
        await input.press('Enter',{timeout:3500});
      } catch (error) {
        state.signal.throwIfAborted();
        if (error.name !== 'TimeoutError') throw error;
        return await observe('submission_unconfirmed',JSON.stringify(before));
      }
      return await observe('pressed_enter',JSON.stringify(before));
    } finally { state.allowSearchPopup = false; }
  }

  async function readTarget(args, options, target, signal, mayLogin) {
    return withPage(target,signal,false, async (page,state,context) => {
      const xhsSearch = args.action === 'search' && target.site === 'xiaohongshu';
      const documentStatus = new Map();
      const zhihuDocuments = trackZhihuDocuments(page,target.site);
      context.on('response', response => {
        const request = response.request();
        if (xhsSearch && request.resourceType() === 'document')
          documentStatus.set(response.url(),responseDetails(response));
        const url = response.status() === 429 ? secureUrl(response.url()) : null;
        if (loginHost(target.site,url) &&
            (state.allowLogin && (request.resourceType() === 'document' || request.method() === 'POST') ||
             xhsSearch && ['xhr','fetch'].includes(request.resourceType()) && /\/search\/notes\/?$/i.test(url.pathname) ||
             state.hupuCommentThread && request.resourceType() === 'document'))
          observeSession(target.site,{},responseDetails(response));
        if (state.hupuCommentThread && request.resourceType() === 'document' && request.isNavigationRequest() &&
            sameHupuThread(state.hupuCommentThread,response.url())) state.hupuCommentDocument = responseDetails(response);
      });
      const navigate = async () => {
        if (xhsSearch) {
          state.searchPage = null;
          return searchXiaohongshu(page,state,target,args,documentStatus);
        }
        const response = await page.goto(target.url,{waitUntil:'domcontentloaded',timeout:22000});
        if (args.action === 'search' && target.site === 'hupu' && response?.ok()) {
          const input = page.getByPlaceholder('搜我想看',{exact:true});
          if (await input.isVisible()) {
            // The official mobile search renders clickable sections rather than links.
            // Use only IDs in the site's response to this actual submitted UI search
            // and pair them with the displayed cards; never call a hidden search API.
            const reply = page.waitForResponse(r => {
              const u = secureUrl(r.url());
              return u && trustedHost('hupu',u.hostname) && u.pathname === '/api/v2/search2' &&
                u.searchParams.get('keyword') === args.query.trim();
            },{timeout:8000}).catch(()=>null);
            await input.fill(args.query,{timeout:3000}); await input.press('Enter',{timeout:3000});
            const results = await reply;
            if (results?.status() === 429) return rateLimited(observeSession(target.site,{},responseDetails(results)));
            if (results?.ok() && Number(results.headers()['content-length'] || 0) <= 512 * 1024) {
              const rows = (await results.json().catch(()=>null))?.data?.result?.data;
              if (Array.isArray(rows)) {
                const cards = page.locator('section[class*="search-result__"]');
                await cards.first().waitFor({state:'visible',timeout:2500}).catch(()=>{});
                const labels = await cards.allInnerTexts();
                const links = [];
                for (const row of rows.slice(0,30)) {
                  const label = String(row.title || '').replace(/<[^>]*>/g,'').trim();
                  if (/^\d{5,16}$/.test(String(row.id)) && label && labels.some(text=>text.includes(label))) {
                    links.push({url:'https://m.hupu.com/bbs/'+row.id+'.html',title:Array.from(label).slice(0,120).join('')});
                  }
                  if (links.length >= 18) break;
                }
                const actual = secureUrl(page.url());
                if (links.length && actual && actual.hostname === 'm.hupu.com' && actual.pathname === '/search') {
                  const source = new URL(actual.origin + actual.pathname);
                  if (actual.searchParams.get('q') === args.query.trim()) source.searchParams.set('q',args.query.trim());
                  const report = observeSession(target.site,await inspectPage(page,target.site,'session'),responseDetails(response));
                  if (report.session_status === 'login_required') return {gate:'login',report};
                  if (report.session_status === 'verification_required') return {gate:'captcha',report};
                  if (report.access_status === 'access_denied') return accessDenied(report);
                  return {ok:true,result:{...report,source_url:source.href,title:await page.title(),
                    text:'',links,images:[],truncated:false},assets:[]};
                }
              }
            }
            const snap = await inspectPage(page,target.site,'search');
            const report = observeSession(target.site,snap,responseDetails(response));
            if (report.session_status === 'login_required') return {gate:'login',report};
            if (report.session_status === 'verification_required') return {gate:'captcha',report};
            if (report.access_status === 'access_denied') return accessDenied(report);
            return failure('browser_search_unavailable','虎扑搜索页未能显示与本次输入对应的帖子。',report);
          }
        }
        return collectPage(page,target,args.action,responseDetails(response),options.includeImages,undefined,zhihuDocuments);
      };
      let content = await navigate();
      if (target.site !== 'weibo' && content.gate === 'login' && mayLogin && (options.getCredentials || options.requestCode) &&
          (loginAttempts.get(target.site) || 0) <= now()) {
        state.allowLogin = true;
        let submitted, attempted = false;
        const loginPage = state.searchPage && !state.searchPage.isClosed() ? state.searchPage : page;
        try {
          submitted = await tryLogin(loginPage,target.site,{...options,signal,
            onAttempt: () => (attempted = beginLogin(target.site)),
            mayContinue: () => !activeRateLimit(target.site)});
        } finally { state.allowLogin = false; }
        signal.throwIfAborted();
        const limit = activeRateLimit(target.site);
        if (limit) return rateLimited(limit);
        if (submitted) content = await navigate();
        else if (attempted && !loginPage.isClosed()) {
          const snapshot = await inspectPage(loginPage,target.site,'session');
          if (loginHost(target.site,secureUrl(snapshot.url)) && snapshot.gate === 'captcha' && !snapshot.transition)
            content = {gate:'captcha',report:observeSession(target.site,snapshot)};
        }
      }
      if (!content.ok) return content;
      const {assets, ...output} = content;
      if (options.includeImages && assets.length) {
        const start = Number.isSafeInteger(options.imageStart) && options.imageStart > 0 ? options.imageStart - 1 : 0;
        const reads = await Promise.allSettled(assets.slice(start,start+2).map(item => readImage(target.site,item,output.result.source_url,signal,fixtures)));
        output.imageInputs = reads.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
      }
      if (target.site === 'hupu' && args.action === 'read' && options.offerHupuComments &&
          sameHupuThread(target.url,page.url())) {
        await holdHupuComments(page,state,output,options.offerHupuComments,signal);
      }
      return output;
    }, { backgroundWindow: target.site === 'hupu' && args.action === 'read' });
  }

  async function holdHupuComments(page, state, output, offer, signal) {
    const threadUrl = page.url();
    let observation = await observeHupuComments(page,threadUrl).catch(() => {
      signal.throwIfAborted();
      return null;
    });
    if (!observation) return;
    const seen = new Set();
    const lease = new AbortController();
    const stop = AbortSignal.any([signal,lease.signal,AbortSignal.timeout(120000)]);
    const release = () => lease.abort();
    const onClose = () => release();
    const unseen = value => [...new Map(value.comments.map(item => [item.id,item])).values()].filter(item => !seen.has(item.id));
    function batch(value, progress) {
      const available = unseen(value);
      const rows = available.slice(0,hupuCommentBatchSize);
      rows.forEach(row => seen.add(row.id));
      const actions = [...value.actions];
      if (available.length > rows.length) actions.unshift({action:'more_visible',label:'继续读本页已显示的评论'});
      return { comments:rows.map(row => row.text), comment_navigation:{actions,
        position:{...value.position, atEnd:actions.length === 0}, total_read:seen.size, ...(progress && { progress })} };
    }
    Object.assign(output.result,batch(observation));
    if (!output.result.comment_navigation.actions.length) return;
    state.hupuCommentThread = threadUrl;
    page.once('close',onClose);
    try {
      offer(output, { release, advance: async action => {
        if (stop.aborted) return failure('browser_comment_cursor_expired','当前评论页已关闭，请重新打开帖子。');
        const limited = activeRateLimit('hupu');
        if (limited) return rateLimited(limited);
        if (!sameHupuThread(threadUrl,page.url())) return failure('browser_navigation_blocked','评论页已离开原帖。');
        observation = await observeHupuComments(page,threadUrl);
        if (!observation) return failure('browser_comment_unavailable','当前页无法继续观察评论。');
        let progress;
        if (action === 'more_visible') {
          if (!unseen(observation).length) return failure('browser_comment_action_unavailable','当前页面没有新的可见评论。');
        } else {
          if (!observation.actions.some(item => item.action === action))
            return failure('browser_comment_action_unavailable','当前页面没有这个评论操作。');
          const previousIds = new Set(observation.comments.map(item => item.id));
          state.hupuCommentDocument = null;
          let step;
          try { step = await advanceHupuComments(page,threadUrl,action,{signal:stop}); }
          catch (error) {
            stop.throwIfAborted();
            const limit = activeRateLimit('hupu');
            if (limit) return rateLimited(limit);
            return error.name === 'TimeoutError' ? failure('browser_timeout','等待虎扑评论页面超时。')
              : failure('browser_comment_navigation_failed','未能打开或滚动原帖的评论页。');
          }
          if (step.status === 'thread_changed')
            return failure('browser_navigation_blocked','评论操作未停在预期的原帖评论页。');
          const until = Date.now() + (fixtures ? 500 : 2000);
          for (;;) {
            const limit = activeRateLimit('hupu');
            if (limit) return rateLimited(limit);
            if (!sameHupuThread(threadUrl,page.url())) return failure('browser_navigation_blocked','评论操作未停在原帖。');
            const snapshot = await inspectPage(page,'hupu','session');
            const report = observeSession('hupu',snapshot,responseDetails(step?.response) || state.hupuCommentDocument);
            if (report.access_status === 'rate_limited') return rateLimited(report);
            if (report.access_status === 'access_denied') return accessDenied(report);
            if (report.session_status === 'login_required') return failure('browser_login_required','站点要求登录后继续阅读评论。',report);
            if (report.session_status === 'verification_required') return failure('browser_verification_required','站点要求验证后继续阅读评论。',report);
            if (report.http_status >= 400) return failure('browser_http_error','站点返回 HTTP ' + report.http_status + '。',report);
            observation = await observeHupuComments(page,threadUrl);
            if (!observation) return failure('browser_comment_unavailable','操作后无法观察到原帖评论。');
            const changed = observation.comments.some(item => !previousIds.has(item.id));
            if (changed || !step?.performed || Date.now() >= until) break;
            await delay(150,undefined,{signal:stop});
          }
          progress = unseen(observation).length ? 'comments_read' : 'no_new_comments';
        }
        stop.throwIfAborted();
        const source = new URL(page.url());
        return { ok:true,result:{site:'hupu',source_url:source.origin+source.pathname,...batch(observation,progress)} };
      } });
      await delay(120000,undefined,{signal:stop}).catch(error => {
        if (error.name !== 'AbortError') throw error;
      });
    } finally {
      release();
      page.removeListener('close',onClose);
    }
  }
  function run(signal, operation, timeoutMs, site) {
    const combined = AbortSignal.any([closing.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    const task = Promise.resolve().then(() => operation(combined)).catch(error => {
      if (closing.signal.aborted || signal?.aborted) throw abort();
      if (error.code === 'browser_profile_busy') return busy();
      if (combined.aborted || error.name === 'TimeoutError') return failure('browser_timeout','浏览或等待验证超时。');
      const authError = {
        browser_challenge_declined:'用户已取消这次登录验证。',
        browser_challenge_expired:'登录验证已过期，请重新发起浏览。',
        browser_challenge_busy:'另一个站点的验证正在进行。',
        browser_credentials_unavailable:'当前无法读取专属浏览账号，请在浏览器设置核对凭据或打开登录窗口。'
      };
      if (Object.hasOwn(authError,error.code)) return failure(error.code,authError[error.code]);
      const networkCode = /\bnet::(ERR_[A-Z0-9_]+)/.exec(String(error.message));
      if (networkCode) return failure('browser_network_error','站点连接失败（' + networkCode[1] + '）。');
      return failure('browser_unavailable','无法打开网页。请检查本机 Chrome、网络和专属浏览器资料是否可用。');
    }).then(output => output?.error && site && !output.error.site
      ? { ...output, error:{site,session_status:'unknown',...output.error} } : output);
    pending.add(task);
    return task.finally(() => pending.delete(task));
  }
  function checkSession(site, {signal, force = false} = {}) {
    if (!Object.hasOwn(sites,site)) return Promise.resolve(failure('browser_invalid_target','未知的登录站点。'));
    return run(signal, async stop => {
      stop.throwIfAborted();
      const limit = activeRateLimit(site);
      if (limit) return {ok:true,result:limit};
      const cached = sessionChecks.get(site);
      if (!force && cached?.until > now()) return {ok:true,result:cached.report};
      const target = {site,url:sites[site].session || sites[site].feed};
      return withPage(target,stop,false,async page => {
        const documents = trackZhihuDocuments(page,site);
        const response = await page.goto(target.url,{waitUntil:'domcontentloaded',timeout:22000});
        const output = await collectPage(page,target,'session',responseDetails(response),false,undefined,documents);
        if (output.ok && output.result.access_status !== 'rate_limited')
          sessionChecks.set(site,{report:output.result,until:now()+statusTtlMs});
        return output;
      });
    },35000,site);
  }
  function browse(args, options = {}) {
    const target = targetFor(args);
    if (!target) return Promise.resolve(failure('browser_invalid_target','仅支持四个站点的公开图文链接、推荐页和站内搜索。'));
    const saved = signedLinks.get(target.url);
    if (saved && saved.time + 20 * 60000 > Date.now()) target.url = saved.signed;
    let publish;
    const first = options.onHupuComments && target.site === 'hupu' && args.action === 'read'
      ? new Promise(resolve => { publish = resolve; }) : null;
    const readOptions = first ? {...options,offerHupuComments: (output,lease) => {
      options.onHupuComments({ advance:lease.advance, close:async () => {
        lease.release();
        await lifetime.catch(() => {});
      } });
      publish(output);
    }} : options;
    const lifetime = run(options.signal, async signal => {
      signal.throwIfAborted();
      const limit = activeRateLimit(target.site);
      if (limit) return rateLimited(limit);
      let output = await readTarget(args,readOptions,target,signal,true);
      if (!output.gate) return output;
      if (options.onManualChallenge) {
        // Release the headless instance before the user opens this same profile.
        if (manualTarget) return busy();
        manualTarget = {...target,kind:output.gate};
        let confirmation;
        try { confirmation = await options.onManualChallenge({site:target.site,kind:output.gate,signal}); }
        finally { manualTarget = null; }
        signal.throwIfAborted();
        if (confirmation !== false) {
          const limit = activeRateLimit(target.site);
          if (limit) return rateLimited(limit);
          sessionChecks.delete(target.site);
          output = await readTarget(args,readOptions,target,signal,false);
          if (!output.gate) return output;
        }
      }
      return output.gate === 'captcha'
        ? failure('browser_verification_required','站点要求人工验证，请在浏览器设置打开专属登录窗口完成。',output.report)
        : failure('browser_login_required', target.site === 'weibo'
          ? '这次未读到微博热搜，请在第三方账号中打开微博专属登录窗口。'
          : '站点要求登录，请在浏览器设置打开专属登录窗口或配置本次账号。',output.report);
    }, 15 * 60000,target.site);
    return first ? Promise.race([lifetime,first]) : lifetime;
  }
  function browsePublic({ url, query, engine }, { signal } = {}) {
    const searching = query !== undefined;
    return run(signal, async combined => {
      const output = await browsePublicPage(searching ? searchUrl(engine, query) : url,
        { signal: combined, fixtures, browserType, now });
      return searching && output.result
        ? { ...output, result: { ...output.result, search_engine: engine } }
        : output;
    }, 24000);
  }
  function openLogin(site, {signal, usePendingTarget = true} = {}) {
    if (!Object.hasOwn(sites,site)) return Promise.resolve(failure('browser_invalid_target','未知的登录站点。'));
    const target = usePendingTarget && manualTarget?.site === site && !(manualTarget.kind === 'login' && sites[site].login) &&
        !(site === 'xiaohongshu' && new URL(manualTarget.url).pathname === '/search_result')
      ? manualTarget : {site,url:sites[site].login || sites[site].feed};
    return run(signal, async stop => {
      stop.throwIfAborted();
      const limit = activeRateLimit(site);
      if (limit) return rateLimited(limit);
      const output = await withPage(target,stop,true,async (page,_state,context) => {
        sessionChecks.delete(site);
        const closed = context.waitForEvent('close',{timeout:0}).catch(() => {});
        const response = await page.goto(target.url,{waitUntil:'domcontentloaded',timeout:22000});
        if (response?.status() === 429) return rateLimited(observeSession(site,{},responseDetails(response)));
        await closed;
        return {ok:true,result:{site,window_closed:true}};
      });
      if (output.ok) sessionChecks.delete(site);
      return output;
    },15 * 60000,site);
  }
  function disconnect(site, {signal} = {}) {
    const roots = { xiaohongshu:['xiaohongshu.com','rednote.com','xhslink.com'], tieba:['baidu.com'],
      hupu:['hupu.com'], zhihu:['zhihu.com'], weibo:['weibo.com','weibo.cn','sina.com.cn'] };
    if (!Object.hasOwn(roots,site)) return Promise.resolve(failure('browser_invalid_target','未知的登录站点。'));
    return run(signal, async stop => {
      stop.throwIfAborted();
      if (fs.existsSync(profileDir)) {
        const cleared = await withPage({site,url:sites[site].feed},stop,false,async (page,_state,context) => {
          const escaped = roots[site].map(root => root.replaceAll('.', '\\.')).join('|');
          await context.clearCookies({ domain:new RegExp('(?:^|\\.)(?:'+escaped+')$','i') });
          const cdp = await context.newCDPSession(page);
          try {
            for (const host of new Set([...sites[site].pages,...loginHosts(site),...roots[site]])) {
              stop.throwIfAborted();
              await cdp.send('Storage.clearDataForOrigin',{origin:'https://'+host,storageTypes:'all'});
            }
          } finally { await cdp.detach().catch(()=>{}); }
          return {ok:true};
        },{offline:true});
        if (!cleared.ok) return cleared;
      }
      sessionChecks.delete(site);
      loginAttempts.delete(site);
      for (const key of signedLinks.keys()) if (siteForUrl(secureUrl(key)) === site) signedLinks.delete(key);
      return {ok:true,result:{site}};
    },30000,site);
  }
  async function close() {
    closing.abort();
    await Promise.allSettled([...pending]);
    signedLinks.clear();
    sessionChecks.clear();
    rateLimits.clear();
    loginAttempts.clear();
  }
  return { browse, browsePublic, checkSession, openLogin, disconnect, close };
}
module.exports = { createBrowserEngine };
