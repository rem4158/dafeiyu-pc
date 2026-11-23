'use strict';

const { sites, secureUrl, isPost, postUrl, trustedHost, weiboVisitorPage } = require('./sites');

const loginSelectors = '.login-container,.login-modal,.login-box,.SignFlow,.LoginModal,.tang-pass-login,.pass-login-pop,.passport-login';
const modalSelector = loginSelectors + ',[role=dialog]';
const captchaSelector = '.geetest_panel,.geetest_widget,.yidun_popup,.yidun_panel,.vaptcha-init-main,.verify-slider,.captcha-box,#captcha_container,.tcaptcha-transform';
const searchFields = 'input:is(:not([type]),[type=text i],[type=search i]):is(#search-input,.search-input,[type=search i],[role=searchbox],[placeholder*=搜索]), textarea[role=searchbox], .search-input textarea[placeholder*=搜索]';
const xhsSearchFieldSelector = `:is(${searchFields}):not(dialog *,[role=dialog] *,[role=menu] *,[hidden] *,[inert] *,[aria-hidden=true] *,[aria-hidden=true],[inert])`;

async function inspectPage(page, site, action) {
  if (site === 'weibo' && weiboVisitorPage(new URL(page.url())))
    return { url: page.url(), weiboVisitor: true };
  return page.evaluate(({ spec, site, action, loginSelectors, modalSelector, captchaSelector, xhsSearchFieldSelector }) => {
    const rendered = el => !!el?.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true });
    const visible = el => rendered(el) &&
      el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
    const first = (parent, selector) => Array.from(parent.querySelectorAll(selector)).find(visible);
    const clip = (value, limit) => Array.from(String(value || '').trim().slice(0, limit * 2 + 1)).slice(0, limit).join('');
    const contentArea = 'article,.AnswerItem,.Post-RichTextContainer,.Post-RichText,.note-item,.note-content,.RichText,.d_post_content,.thread-content,.post-content';
    const loginModal = Array.from(document.querySelectorAll(modalSelector)).find(el => visible(el) &&
      !el.closest(contentArea) && /登录|注册|扫码|短信验证|手机验证|邮箱验证|已发送|sign in/i.test(el.innerText) &&
      (el.matches(loginSelectors) || /^(?:请)?(?:先)?登录(?:后(?:查看|阅读|浏览|继续)|知乎|账号)?[。！!]?$/u.test(el.innerText.trim()) ||
        !!first(el,'input[type=password],input[autocomplete=one-time-code],input[type=tel],img[alt*=扫码],img[alt*=二维码]')));
    const challengeControl = first(document,captchaSelector);
    const challenge = !!challengeControl || /^(?:百度)?(?:安全验证|人机验证|访问验证|小红书安全验证)(?:$|\s|[-—_|])/u.test(document.title) ||
      /\/(?:captcha|account\/unhuman|website-login\/captcha|sorry\/index)(?:[/.]|$)/i.test(location.pathname);
    const loginPage = /^\/(?:signin|login|passport|web\/login)(?:[/.]|$)/i.test(location.pathname) ||
      site === 'weibo' && /^\/(?:newlogin|sso\/login)(?:[/.]|$)/i.test(location.pathname);
    if (challenge || loginModal || loginPage) {
      if (site === 'zhihu' && location.pathname === '/account/unhuman' && !challengeControl &&
          !first(document,'iframe[src*=captcha],.yidun_control')) {
        return { gate:loginModal ? 'login' : 'captcha', url:location.href, transition:!loginModal };
      }
      return { gate: challenge ? 'captcha' : 'login', url: location.href };
    }

    // A usable public page, a generic avatar and a saved credential are not session evidence.
    // Inspect the visible site navigation only, and return no account name, URL or image.
    const nav = 'header,nav,aside,[role=banner],[role=navigation],.AppHeader,.side-bar,.sidebar,.side-bar-component,#head,#u';
    const inNav = el => visible(el) && el.closest(nav) && !el.closest(contentArea) &&
      !el.closest('[hidden],[inert],[aria-hidden=true]');
    const personal = el => /^(我|我的主页|个人主页)$/.test((el.getAttribute('aria-label') || el.innerText || '').trim());
    let account = false;
    if (site === 'zhihu') {
      account = Array.from(document.querySelectorAll('.AppHeader-profileEntry .Avatar,.AppHeader-profile button img')).some(inNav) ||
        Array.from(document.querySelectorAll('button.AppHeader-profile,.AppHeader-profile button')).some(el => inNav(el) && personal(el));
    } else if (site === 'xiaohongshu') {
      account = Array.from(document.querySelectorAll('a[href]')).slice(0,1200).some(el => {
        if (!inNav(el) || !personal(el)) return false;
        try {
          const url = new URL(el.href,location.href);
          return url.origin === location.origin && /^\/user\/profile\/[a-f\d]{16,32}\/?$/i.test(url.pathname);
        } catch { return false; }
      });
    } else {
      account = Array.from(document.querySelectorAll('a[href],button')).slice(0,1200)
        .some(el => inNav(el) && /^(退出登录|退出账号)$/.test((el.getAttribute('aria-label') || el.innerText || '').trim()));
    }
    if (site === 'weibo' && !account) account = Array.from(document.querySelectorAll('a[href]')).some(el =>
      inNav(el) && personal(el) && /^\/u\/\d+\/?$/.test(el.pathname));
    const denialNotice = first(document,'.ErrorPage,.error-page,.access-denied');
    const denied = denialNotice && !denialNotice.closest(contentArea) &&
      /^(?:您当前请求存在异常|拒绝访问|访问受限|访问被拒)/.test(denialNotice.innerText.trim());
    if (action === 'session' || denied) return { url:location.href, account, denied:Boolean(denied) };
    if (site === 'weibo') {
      const topics = [];
      const seen = new Set();
      for (const row of document.querySelectorAll('#pl_top_realtimehot tbody tr')) {
        const link = first(row, '.td-02 a[href]');
        const title = clip(link?.innerText, 140);
        if (!title || seen.has(title) || link.href.length > 1500 || !link.href.startsWith('https://s.weibo.com/weibo?')) continue;
        seen.add(title);
        const rank = clip(first(row,'.td-01')?.innerText, 8);
        const detail = clip(first(row,'.td-02 span')?.innerText, 48);
        topics.push({ title, url:link.href, ...(rank && { rank }), ...(detail && { detail }) });
        if (topics.length === 20) break;
      }
      return { url:location.href, account, topics };
    }

    const answerPath = site === 'zhihu' && action === 'read' && /^\/question\/\d+\/answer\/(\d+)\/?$/.exec(location.pathname);
    const columnPath = site === 'zhihu' && action === 'read' && /^\/p\/(\d+)\/?$/.exec(location.pathname);
    const hupuPost = site === 'hupu' && action === 'read';
    const uiOverlay = 'dialog,[role=dialog],[role=menu],[hidden],[inert],[aria-hidden=true]';
    const columnNoise = `${uiOverlay},aside,nav,footer,.Recommendations,.Recommendation,.RelatedArticles,.Post-Recommendation,.Post-RelatedArticles`;
    const hupuNoise = `${uiOverlay},.seo-dom,.quote-thread,.discuss-card__quote,.discuss-card__quote-content,.post-reply-list-operate`;
    const hupuReplies = '.post-reply-list-content,.reply-list-wrapper,.discuss-card,.discuss-card__content';
    let root, bodyEl;
    if (answerPath) {
      const requestedPath = location.pathname.replace(/\/$/,'');
      root = Array.from(document.querySelectorAll('.AnswerItem')).find(card => {
        if (!visible(card)) return false;
        try {
          // Numeric answer IDs can exceed IEEE-754 precision. Compare their original digits.
          const data = JSON.parse(card.dataset.zop, (key, value, context) =>
            key === 'itemId' && typeof value === 'number' ? context?.source ?? (Number.isSafeInteger(value) ? String(value) : null) : value);
          if (/^\d+$/.test(data?.itemId)) return data.itemId === answerPath[1];
        } catch { /* Some cards expose only their permalink. */ }
        const permalinks = card.querySelectorAll('meta[itemprop=url][content],link[itemprop=url][href],a[itemprop=url][href],.ContentItem-time a[href],a.ContentItem-time[href]');
        return Array.from(permalinks).some(link => {
          if (link.closest('.AnswerItem') !== card || link.closest('.RichText,.RichContent-inner')) return false;
          try {
            const url = new URL(link.content || link.href, location.href);
            return url.origin === location.origin && url.pathname.replace(/\/$/,'') === requestedPath;
          } catch { return false; }
        });
      });
      if (root) {
        const ownVisible = el => el.closest('.AnswerItem') === root && visible(el);
        const content = Array.from(root.querySelectorAll('.RichContent-inner')).find(ownVisible) ||
          Array.from(root.querySelectorAll('.RichContent .RichText,:scope > .RichText')).find(ownVisible);
        const folded = Array.from(root.querySelectorAll('.RichContent.is-collapsed,.RichContent--collapsed,button,[role=button],.ContentItem-more')).some(el =>
          ownVisible(el) && (el.matches('.RichContent.is-collapsed,.RichContent--collapsed') || /^(?:展开(?:全文|全部|阅读)?|阅读全文|显示全部|登录后(?:阅读全文|查看全文|查看完整回答|继续阅读))/.test(el.innerText.trim())));
        const loginCover = Array.from(root.querySelectorAll(modalSelector)).some(el =>
          ownVisible(el) && /登录|注册|扫码|sign in/i.test(el.innerText));
        let clipped = false;
        for (let el = content; el && el !== root.parentElement; el = el.parentElement) {
          if (el.scrollHeight > el.clientHeight + 1 && /^(hidden|clip)$/.test(getComputedStyle(el).overflowY)) clipped = true;
        }
        if (!folded && !clipped && !loginCover) bodyEl = content;
      }
    } else if (columnPath) {
      // Recognize an actual column body rather than a title, navigation, or related article.
      const articleRoot = el => el.closest('.Post-Main') || el.closest('article');
      const columnId = value => {
        try {
          const url = new URL(value,location.href);
          return url.protocol === 'https:' && ['zhuanlan.zhihu.com','www.zhihu.com','zhihu.com'].includes(url.hostname)
            ? /^\/p\/(\d+)\/?$/.exec(url.pathname)?.[1] : undefined;
        } catch { return undefined; }
      };
      const canonical = columnId(document.querySelector('link[rel~="canonical"][href]')?.getAttribute('href'));
      const candidates = [];
      if (!canonical || canonical === columnPath[1]) for (const el of document.querySelectorAll('.Post-RichText,.Post-RichTextContainer')) {
        if (!visible(el) || el.closest(columnNoise) ||
            el.matches('.Post-RichTextContainer') && el.querySelector('.Post-RichText')) continue;
        const article = articleRoot(el);
        if (!article) continue;
        const ids = [article.getAttribute('data-article-id'), el.getAttribute('data-article-id')];
        const zop = article.dataset.zop;
        if (zop && zop.length <= 2000) try {
          const data = JSON.parse(zop, (key,value,context) => key === 'itemId' && typeof value === 'number'
            ? context?.source ?? (Number.isSafeInteger(value) ? String(value) : null) : value);
          ids.push(data?.itemId);
        } catch { /* Markup without a parseable ID still needs a unique article body. */ }
        const markers = ids.filter(id => typeof id === 'string' && /^\d+$/.test(id));
        if (markers.some(id => id !== columnPath[1])) continue;
        candidates.push({ body:el, article, primary:article.matches('.Post-Main'), matched:markers.length > 0 });
      }
      const matched = candidates.filter(candidate => candidate.matched);
      const primary = candidates.filter(candidate => candidate.primary);
      const scoped = matched.length ? matched : primary.length ? primary : candidates;
      if (scoped.length === 1) {
        const { body,article } = scoped[0];
        const own = el => articleRoot(el) === article && visible(el) &&
          !el.closest('[hidden],[inert],[aria-hidden=true],aside,.Recommendations,.RelatedArticles,.Post-RelatedArticles');
        const loginCover = Array.from(article.querySelectorAll(modalSelector)).some(el =>
          own(el) && /登录|注册|扫码|sign in/i.test(el.innerText));
        if (loginCover) return { gate:'login', url:location.href };
        const bodyArea = body.closest('.Post-RichTextContainer') || body;
        const collapsed = body.closest('.RichContent.is-collapsed,.RichContent--collapsed');
        const folded = collapsed && article.contains(collapsed) || Array.from(article.querySelectorAll('button,[role=button],.ContentItem-more')).some(el =>
          own(el) && (bodyArea.contains(el) || el.matches('.ContentItem-more')) &&
          /^(?:展开(?:全文|全部|阅读)?|阅读全文|显示全部|登录后(?:阅读全文|查看全文|查看完整文章|继续阅读))$/.test(el.innerText.trim()));
        let clipped = false;
        for (let el = body; el && el !== article.parentElement; el = el.parentElement) {
          if (el.scrollHeight > el.clientHeight + 1 && /^(hidden|clip)$/.test(getComputedStyle(el).overflowY)) clipped = true;
        }
        if (!folded && !clipped) { root = article; bodyEl = body; }
      }
    } else if (hupuPost) {
      // The desktop post shell and the mobile card include author metadata and actions.
      // An empty content area is not a reason to read their surrounding shell.
      const ownBody = el => rendered(el) && !el.closest(`${hupuNoise},${hupuReplies},header,nav,aside`);
      bodyEl = Array.from(document.querySelectorAll(spec.primaryBody)).find(ownBody) ||
        Array.from(document.querySelectorAll(spec.body)).find(el => ownBody(el) && el.closest(spec.root));
    } else {
      root = first(document, spec.root);
      bodyEl = first(root || document, spec.body) || first(document,spec.body) || root || first(document, 'article,main,[role=main]');
    }
    const xhsSearch = site === 'xiaohongshu' && action === 'search';
    const titleEl = xhsSearch ? null : columnPath ? root && first(root,'h1') : first(document,spec.title);
    const title = clip(titleEl?.innerText || document.title, 180);
    function shownText(el, max, excluded = uiOverlay) {
      if (!el || !visible(el) || el.closest(excluded)) return '';
      const nodes = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const words = [];
      let length = 0;
      for (let i = 0; i < 150 && nodes.nextNode() && length < max; i++) {
        const node = nodes.currentNode;
        const part = node.textContent;
        if (!part || !visible(node.parentElement) || node.parentElement.closest(excluded)) continue;
        words.push(part);
        length += part.trim().length;
      }
      return clip(words.join('').replace(/\s+/g,' '),max);
    }
    function hupuText(el, max, excluded) {
      if (!visible(el) || el.closest(excluded)) return '';
      return el.querySelector(excluded) ? shownText(el, max, excluded) : clip(el.innerText, max);
    }
    const text = hupuPost ? hupuText(bodyEl, 6001, `${hupuNoise},${hupuReplies}`)
      : columnPath && bodyEl?.querySelector(columnNoise) ? shownText(bodyEl, 6001, columnNoise)
      : bodyEl?.innerText?.trim() || '';
    const comments = [];
    if (hupuPost) {
      const replyBody = '.discuss-card__content, .post-reply-list-content .reply-list-wrapper .bbs-thread-comp.main-thread > .thread-content-detail';
      for (const el of Array.from(document.querySelectorAll(replyBody)).slice(0, 100)) {
        const comment = hupuText(el, 500, hupuNoise);
        if (comment) comments.push(comment);
        if (comments.length >= 6) break;
      }
    }
    let observation;
    if (xhsSearch) {
      const labels = (selector, max, allowSidebar = false) => {
        const values = new Set();
        for (const el of Array.from(document.querySelectorAll(selector)).slice(0,120)) {
          if (el.closest('.note-item,article') || (!allowSidebar && el.closest('aside,.side-bar,.sidebar'))) continue;
          const label = shownText(el,80);
          if (label) values.add(label);
          if (values.size >= max) break;
        }
        return [...values];
      };
      const fields = Array.from(document.querySelectorAll(xhsSearchFieldSelector)).filter(visible);
      const field = fields.find(el => el.matches(':enabled:not([readonly],[aria-disabled=true],[aria-readonly=true])')) || fields[0];
      const tabs = '[role=tab],nav [aria-current],.reds-tab-item,.channel-list .channel,.filter-tag';
      observation = {
        search_input: clip(field?.value,160),
        headings: labels('h1,h2,h3,[role=heading]',6),
        tabs: labels(tabs,12,true),
        active_tabs: labels(`:is(${tabs}):is([aria-selected=true],[aria-current=page],[aria-current=true],.active,.selected)`,6,true),
        notices: labels('[role=status],.empty-state,.empty-text,.no-result,.no-results,.loading-text',4)
      };
    }
    const links = [];
    for (const a of Array.from(document.querySelectorAll('a[href]')).slice(0, 1200)) {
      if (!visible(a)) continue;
      if (xhsSearch && (a.closest(uiOverlay) || a.closest('header,nav,footer,aside,.side-bar,.sidebar'))) continue;
      const card = a.closest('section.note-item,.note-item,.HotItem,.SearchResult-Card,.j_thread_list,.list-item');
      if (card?.querySelector('video,.play-icon,.video-icon')) continue;
      const label = xhsSearch
        ? shownText(card && first(card,'.title,.note-title'),120) || shownText(a,120) ||
          clip(a.title || first(a,'img[alt]')?.alt,120) || shownText(card,120)
        : clip(a.innerText || a.title || a.querySelector('img')?.alt || card?.innerText, 120);
      if (label) links.push({ url: a.href, title: label });
    }
    if (site === 'hupu' && action === 'feed') {
      const shown = new Set([...document.querySelectorAll('a.post[title]')].filter(visible).map(el=>el.title.trim()));
      const json = document.getElementById('__NEXT_DATA__')?.textContent;
      if (shown.size && json && json.length < 1_000_000) try {
        const rows = JSON.parse(json)?.props?.pageProps?.postList?.topicThreads;
        if (Array.isArray(rows)) for (const row of rows.slice(0,100)) {
          if (typeof row.title === 'string' && shown.has(row.title.trim()) && !row.isVideo && typeof row.url === 'string')
            links.push({url:row.url,title:clip(row.title,120)});
        }
      } catch { /* DOM links still apply if the site changes its card metadata. */ }
    }
    const images = [];
    if (action === 'read' && bodyEl) {
      const photos = answerPath || columnPath || hupuPost ? bodyEl.querySelectorAll('img') : document.querySelectorAll(spec.photos);
      for (const img of photos) {
        const lazySource = (hupuPost && img.dataset.origin) || img.dataset.original || img.dataset.actualsrc || img.dataset.src;
        if ((!visible(img) && !(hupuPost && lazySource && rendered(img))) ||
            (hupuPost && img.closest(`${hupuNoise},${hupuReplies}`)) || (columnPath && img.closest(columnNoise)) ||
            img.closest('button,aside,header,nav,[class*=captcha i],[class*=avatar i]') ||
            (answerPath ? img.closest('.AnswerItem') !== root : (!bodyEl.contains(img) && !root?.contains(img)))) continue;
        if (!(hupuPost && lazySource) && img.naturalWidth > 0 && Math.max(img.naturalWidth, img.naturalHeight) < 120) continue;
        const raw = lazySource || img.currentSrc || (hupuPost ? img.getAttribute('src') : img.src);
        if (!raw) continue;
        try { images.push({ raw: new URL(raw, location.href).href, alt: clip(img.alt,100) }); } catch {}
        if (images.length >= 8) break;
      }
      // SSR and lazy carousels can expose post images before img elements are mounted.
      // Honour only article image metadata on an already recognized post body.
      if (!answerPath && !columnPath && !hupuPost) for (const meta of document.querySelectorAll('meta[property="og:image"],meta[name="og:image"],meta[name="twitter:image"]')) {
        if (images.length >= 8) break;
        try { images.push({raw:new URL(meta.content,location.href).href,alt:''}); } catch {}
      }
      if (!answerPath && !columnPath && root && !images.length) for (const slide of root.querySelectorAll('.swiper-slide [style*="background"],.note-slider-img[style]')) {
        const match=/^url\(["']?(.+?)["']?\)$/.exec(getComputedStyle(slide).backgroundImage);
        if (match) images.push({raw:match[1],alt:''});
        if (images.length >= 8) break;
      }
    }
    return { url: location.href, account, title, text: clip(text,6000), truncated: Array.from(text.slice(0,12002)).length > 6000,
      video: answerPath || columnPath || hupuPost ? !!bodyEl?.querySelector('video,.video-player,.xgplayer') :
        !!root?.querySelector('video,.video-player,.xgplayer') || !!first(document,'#videoDetail,.note-video-player') ||
        !!document.querySelector('meta[property="og:video"][content^="http"],meta[name="og:video"][content^="http"],meta[name="og:xhs:note_type"][content="video" i]'),
      links, images, ...(hupuPost && { comments }), ...(observation && { observation }) };
  }, { spec: { root: sites[site].root, primaryBody: sites[site].primaryBody, body: sites[site].body,
    photos: sites[site].photos, title: sites[site].title },
    site, action, loginSelectors, modalSelector, captchaSelector, xhsSearchFieldSelector });
}

function collect(site, snapshot, remember) {
  const links = new Map();
  for (const item of snapshot.links) {
    const parsed = secureUrl(item.url);
    if (!isPost(site, parsed)) continue;
    const url = parsed.origin + parsed.pathname;
    if (!links.has(url)) links.set(url, { url, title: item.title });
    const signed = postUrl(site, parsed);
    if (signed !== url) remember(url, signed);
    if (links.size >= 18) break;
  }
  const images = new Map();
  for (const item of snapshot.images) {
    const parsed = secureUrl(item.raw.replace(/^http:\/\//i,'https://'));
    if (!parsed || !trustedHost(site,parsed.hostname) || /captcha|qrcode|avatar|\.svg(?:$|\?)/i.test(parsed.href)) continue;
    const url = parsed.origin + parsed.pathname;
    if (!images.has(url)) images.set(url, { ...item, raw:parsed.href, url });
  }
  return { links: [...links.values()], images: [...images.values()] };
}

module.exports = { inspectPage, collect, modalSelector, xhsSearchFieldSelector };
