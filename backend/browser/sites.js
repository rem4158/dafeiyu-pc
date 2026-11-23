'use strict';

// Only public feeds, text searches and identifiable post permalinks are entry points.
const sites = {
  xiaohongshu: {
    feed: 'https://www.xiaohongshu.com/explore',
    search: ['https://www.xiaohongshu.com/search_result', 'keyword'],
    pages: ['www.xiaohongshu.com', 'www.rednote.com', 'xiaohongshu.com', 'xhslink.com'],
    assets: ['xiaohongshu.com', 'xhscdn.com', 'rednote.com', 'xiaohongshu.net'],
    post: /^\/(?:explore|discovery\/item|search_result)\/[a-f\d]{16,32}\/?$/i,
    root: '#noteContainer, .note-container, .note-detail, article',
    body: '#detail-desc, .note-content, .note-text, .desc', title: '#detail-title, .note-title, h1',
    photos: '.note-slider-img, .swiper-slide img, .note-content img, article img',
  },
  tieba: {
    feed: 'https://tieba.baidu.com/', search: ['https://tieba.baidu.com/f/search/res?ie=utf-8', 'qw'],
    pages: ['tieba.baidu.com'], assets: ['tieba.baidu.com', 'tiebapic.baidu.com', 'tb1.bdstatic.com',
      'tb2.bdstatic.com', 'tiebac.baidu.com', 'tiebacdn.com', 'bdimg.com', 'bdstatic.com', 'passport.baidu.com', 'wappass.baidu.com'],
    challenges:['bioc-static.cdn.bcebos.com','bioc-static-standby.cdn.bcebos.com','bioc-captcha.cdn.bcebos.com',
      'bioc-captcha-su-standby.cdn.bcebos.com','hercules.cdn.bcebos.com','seccaptcha.baidu.com','seccaptcha-1.baidu.com'],
    post: /^\/p\/\d+\/?$/, root: '.l_post, .thread-content, article',
    body: '.d_post_content, .post-content', title: 'h1, .core_title_txt', photos: '.d_post_content img, article img',
  },
  hupu: {
    feed: 'https://m.hupu.com/bbs/bxj', search: ['https://m.hupu.com/search', 'q'],
    pages: ['bbs.hupu.com', 'm.hupu.com'], assets: ['hupu.com', 'hupucdn.com', 'hoopchina.com.cn', 'hoopchina.com'],
    post: /^\/(?:bbs\/)?\d+(?:-\d+)?\.html$/, root: '.hupu-bbs-post, .post-fst-floor, .floor-content, .main-post, article',
    primaryBody: '[class*="post-content_bbs-post-content__"] .bbs-thread-comp.main-thread > .thread-content-detail, .hupu-bbs-post .bbs-content-font',
    body: '.bbs-content, .post-thread-content, .thread-content, .post-content',
    title: '.bbs-header-title, h1, .bbs-title',
  },
  zhihu: {
    feed: 'https://www.zhihu.com/hot', search: ['https://www.zhihu.com/search?type=content', 'q'],
    login: 'https://www.zhihu.com/signin',
    pages: ['www.zhihu.com', 'zhuanlan.zhihu.com', 'zhihu.com'], assets: ['zhihu.com', 'zhimg.com'],
    challenges:['cstaticdun.126.net','c.dun.163.com'],
    challengeImages: ['necaptcha.nosdn.127.net', 'necaptcha-nosdn.126.net'],
    post: /^\/(?:question\/\d+(?:\/answer\/\d+)?|p\/\d+)\/?$/, root: '.AnswerItem, .Post-RichTextContainer, .QuestionHeader, article',
    body: '.RichContent-inner, .Post-RichText, .QuestionRichText, .RichText', title: 'h1, .QuestionHeader-title',
    photos: '.RichContent-inner img, .Post-RichText img, article img',
  },
  weibo: {
    feed: 'https://s.weibo.com/top/summary',
    login: 'https://passport.weibo.com/sso/signin?entry=miniblog',
    session: 'https://weibo.com/',
    pages: ['s.weibo.com', 'weibo.com', 'www.weibo.com'],
    loginHosts: ['passport.weibo.com', 'login.sina.com.cn', 'passport.sina.com.cn'],
    assets: ['weibo.com', 'sinaimg.cn', 'sinajs.cn', 'weibocdn.com', 'login.sina.com.cn', 'passport.sina.com.cn'],
    challenges: ['v2.qr.weibo.cn', 'i.sso.sina.com.cn', 'cstaticdun.126.net', 'static.geetest.com'],
  },
};

const siteNames = Object.freeze({ xiaohongshu: '小红书', tieba: '百度贴吧', hupu: '虎扑', zhihu: '知乎', weibo: '微博' });
const blockedAutonomousSites = settings => settings.browser?.autonomousBlockedSites || [];
const isAutonomousBlocked = (settings, site) => blockedAutonomousSites(settings).includes(site);
const autonomousSites = settings => Object.keys(sites).filter(site => sites[site].search && !isAutonomousBlocked(settings, site));
const siteForUrl = url => url && Object.keys(sites).find(site => sites[site].pages.includes(url.hostname));
const weiboVisitorPage = url => url.hostname === 'passport.weibo.com' && /^\/visitor(?:\/|$)/.test(url.pathname);

function secureUrl(input) {
  if (typeof input !== 'string' || input.length > 4096 || /[\s\\\x00-\x1f]/.test(input)) return null;
  try {
    const url = new URL(input);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null;
  } catch { return null; }
}
function challengeHost(site,host) { return sites[site].challenges?.includes(host) === true; }
// These hosts never enter Chrome's CONNECT allowlist, even in the manual window.
function challengeImageHost(site, host) { return sites[site].challengeImages?.includes(host) === true; }
function trustedHost(site, host, manual = false) {
  return sites[site].pages.includes(host) || sites[site].assets.some(base => host === base || host.endsWith('.' + base)) ||
    manual && challengeHost(site,host);
}
function loginHost(site, url) {
  if (!url) return false;
  return sites[site].pages.includes(url.hostname) && url.hostname !== 'xhslink.com' ||
    loginHosts(site).includes(url.hostname);
}
function loginHosts(site) {
  return sites[site].loginHosts || ({ tieba: ['passport.baidu.com', 'wappass.baidu.com'],
    hupu: ['passport.hupu.com', 'login.hupu.com'], zhihu: ['account.zhihu.com'] }[site] || []);
}
function isPost(site, url) {
  return url && sites[site].pages.includes(url.hostname) && Boolean(sites[site].post?.test(url.pathname));
}
function postUrl(site, url) {
  const safe = new URL(url.origin + url.pathname);
  // Search results on Xiaohongshu often require the transient note access parameter.
  if (site === 'xiaohongshu') for (const key of ['xsec_token', 'xsec_source']) {
    const val = url.searchParams.get(key);
    if (val && /^[\w.+=/-]{1,400}$/.test(val)) safe.searchParams.set(key, val);
  }
  return safe.href;
}
function targetFor(args) {
  const url = secureUrl(args?.url);
  const site = args?.site || siteForUrl(url);
  if (!Object.hasOwn(sites, site)) return null;
  if (args.entry !== undefined && !(site === 'xiaohongshu' && args.action === 'search' && args.entry === 'search_url'))
    return null;
  if (args.action === 'read') {
    if (isPost(site, url)) return { site, url: postUrl(site, url) };
    if (site === 'xiaohongshu' && url?.hostname === 'xhslink.com' && /^\/(?:[a-z]\/)?[A-Za-z\d]{4,24}\/?$/.test(url.pathname))
      return { site, url: url.origin + url.pathname };
    return null;
  }
  if (args.action === 'feed') return { site, url: sites[site].feed };
  if (args.action !== 'search' || !sites[site].search || typeof args.query !== 'string' ||
    !args.query.trim() || args.query.length > 160) return null;
  const [base, key] = sites[site].search;
  const target = new URL(base);
  target.searchParams.set(key, args.query.trim());
  return { site, url: target.href };
}

module.exports = { sites, siteNames, siteForUrl, secureUrl, trustedHost, challengeHost, challengeImageHost,
  loginHost, loginHosts, isPost, postUrl, targetFor, autonomousSites, blockedAutonomousSites, isAutonomousBlocked, weiboVisitorPage };
