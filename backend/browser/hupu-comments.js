'use strict';

const { createHash } = require('node:crypto');
const { isPost, secureUrl } = require('./sites');

const rows = '.discuss-card__content, .post-reply-list-content .reply-list-wrapper .bbs-thread-comp.main-thread > .thread-content-detail';
const noise = 'dialog,[role=dialog],[role=menu],[hidden],[inert],[aria-hidden=true],.seo-dom,.quote-thread,.discuss-card__quote,.discuss-card__quote-content,.post-reply-list-operate';
const pager = '.hupu-rc-pagination';
const pagerNoise = `${noise},.post-reply-list,.post-reply-list-content,.post-card,.thread-content-detail`;

function threadAt(value) {
  const url = secureUrl(value);
  if (!isPost('hupu', url)) return null;
  const [, prefix, id, part = '1'] = /^(\/(?:bbs\/)?)(\d+)(?:-(\d+))?\.html\/?$/.exec(url.pathname);
  const page = Number(part);
  return Number.isSafeInteger(page) && page >= 1 ? { url, prefix, id, page } : null;
}

function sameThread(left, right) {
  return Boolean(left && right && left.url.origin === right.url.origin && left.prefix === right.prefix && left.id === right.id);
}

function sameHupuThread(first, second) {
  return sameThread(threadAt(first), threadAt(second));
}

function nextLink(hrefs, thread, current) {
  for (const { href, label } of hrefs) {
    const next = threadAt(href);
    if (sameThread(thread, next) && !next.url.search && next.page === current.page + 1) {
      return { href: next.url.origin + next.url.pathname, label };
    }
  }
  return null;
}

function readDom(page, expectedUrl, { scroll = false, controlsOnly = false } = {}) {
  return page.evaluate(({ expectedUrl, rows, noise, pager, pagerNoise, scroll, controlsOnly }) => {
    if (location.href !== expectedUrl) return null;
    const visible = el => Boolean(el?.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) &&
      el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
    const clip = (value, max) => Array.from((value || '').trim()).slice(0, max).join('');
    const comments = Array.from(document.querySelectorAll(rows)).slice(0, 100)
      .filter(el => visible(el) && !el.closest(noise));
    const commentArea = comments.at(-1) || Array.from(document.querySelectorAll('.discuss-section,.post-reply-list-wrapper'))
      .find(el => visible(el) && !el.closest(noise));
    const pagers = Array.from(document.querySelectorAll(pager)).filter(el => visible(el) && !el.closest(pagerNoise));
    const next = [];
    for (const list of pagers) {
      const anchor = list.querySelector('.hupu-rc-pagination-next:not(.hupu-rc-pagination-disabled):not([aria-disabled=true]) > a[href]');
      if (visible(anchor) && !anchor.closest(`${pagerNoise},[aria-disabled=true]`))
        next.push({ href: anchor.href, label: clip(anchor.innerText, 30) || '下一页' });
    }

    const room = el => el.scrollHeight - el.clientHeight - el.scrollTop > 2;
    let scrollTarget = null;
    if (commentArea && !pagers.length) {
      for (let el = commentArea.parentElement; el && el !== document.body; el = el.parentElement) {
        if (/^(auto|scroll|overlay)$/.test(getComputedStyle(el).overflowY) && room(el)) {
          scrollTarget = el;
          break;
        }
      }
      const documentTarget = document.scrollingElement;
      if (!scrollTarget && documentTarget && room(documentTarget)) scrollTarget = documentTarget;
    }
    let scrolled = false;
    if (scroll && scrollTarget) {
      const before = scrollTarget.scrollTop;
      const lastRow = comments.at(-1);
      const viewBottom = scrollTarget === document.scrollingElement ? window.innerHeight : scrollTarget.getBoundingClientRect().bottom;
      const toLastRow = lastRow ? lastRow.getBoundingClientRect().bottom - viewBottom + 48 : 0;
      const height = scrollTarget.clientHeight;
      const distance = Math.min(height * 2, Math.max(height, toLastRow));
      scrollTarget.scrollBy({ top: distance, behavior: 'instant' });
      scrolled = scrollTarget.scrollTop > before;
    }

    function commentText(el) {
      if (!el.querySelector(noise)) return clip(el.innerText, 500);
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const parts = [];
      let length = 0;
      for (let index = 0; index < 150 && length < 500 && walker.nextNode(); index++) {
        const node = walker.currentNode;
        if (!visible(node.parentElement) || node.parentElement.closest(noise)) continue;
        parts.push(node.textContent);
        length += node.textContent.length;
      }
      return clip(parts.join('').replace(/\s+/g, ' '), 500);
    }
    const entries = [];
    if (!controlsOnly) for (const row of comments) {
      const value = commentText(row);
      if (!value) continue;
      const card = row.closest('.post-reply-list,.hp-m-discuss-card,.discuss-card,.post-card');
      const author = card?.querySelector('.post-reply-list-user-info-top-name,.discuss-card__username');
      const time = card?.querySelector('.post-reply-list-user-info-top-time,.discuss-card__time');
      entries.push({ text: value, identity: [clip(author?.getAttribute('href') || author?.innerText, 180), clip(time?.innerText, 60), value] });
    }
    return { entries, next, canScroll: Boolean(scrollTarget), scrolled };
  }, { expectedUrl, rows, noise, pager, pagerNoise, scroll, controlsOnly });
}

async function observeHupuComments(page, threadUrl) {
  const thread = threadAt(threadUrl);
  const current = threadAt(page.url());
  if (!sameThread(thread, current)) return null;
  const dom = await readDom(page, current.url.href);
  const after = threadAt(page.url());
  if (!dom || !sameThread(thread, after) || after.page !== current.page) return null;
  const repeats = new Map();
  const comments = dom.entries.map(({ text, identity }) => {
    const key = JSON.stringify(identity);
    const duplicate = repeats.get(key) || 0;
    repeats.set(key, duplicate + 1);
    const id = createHash('sha256').update(key).update(`:${duplicate}`).digest('hex');
    return { id, text };
  });
  const next = nextLink(dom.next, thread, current);
  const actions = [];
  if (next) actions.push({ action: 'next_page', label: next.label });
  if (dom.canScroll) actions.push({ action: 'scroll', label: '向下滚动评论区' });
  return { comments, actions, position: { page: current.page, atEnd: actions.length === 0 } };
}

async function advanceHupuComments(page, threadUrl, action, { signal } = {}) {
  signal?.throwIfAborted();
  const thread = threadAt(threadUrl);
  const current = threadAt(page.url());
  if (!sameThread(thread, current)) return { performed: false, status: 'thread_changed' };
  if (action === 'scroll') {
    const dom = await readDom(page, current.url.href, { scroll: true, controlsOnly: true });
    signal?.throwIfAborted();
    if (!dom) return { performed: false, status: 'thread_changed' };
    return { performed: dom.scrolled, status: dom.scrolled ? 'advanced' : 'unavailable' };
  }
  if (action !== 'next_page') return { performed: false, status: 'unavailable' };
  const dom = await readDom(page, current.url.href, { controlsOnly: true });
  signal?.throwIfAborted();
  const before = threadAt(page.url());
  if (!dom || !sameThread(thread, before) || before.page !== current.page) return { performed: false, status: 'thread_changed' };
  const next = nextLink(dom.next, thread, current);
  if (!next) return { performed: false, status: 'unavailable' };
  const response = await page.goto(next.href, { waitUntil: 'domcontentloaded', timeout: 12000 });
  signal?.throwIfAborted();
  const after = threadAt(page.url());
  return { performed: true, status: sameThread(thread, after) ? 'advanced' : 'thread_changed', response };
}

module.exports = { advanceHupuComments, observeHupuComments, sameHupuThread };
