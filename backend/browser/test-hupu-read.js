'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createBrowserEngine } = require('./engine');

const desktop = 'https://bbs.hupu.com/100000001.html';
const mobile = 'https://m.hupu.com/bbs/100000001.html';
const commentThread = 'https://bbs.hupu.com/100000002.html';
const commentPageTwo = 'https://bbs.hupu.com/100000002-2.html';
const differentThread = 'https://bbs.hupu.com/100000003.html';
const scrollThread = 'https://m.hupu.com/bbs/100000004.html';
const original = 'https://i1.hoopchina.com.cn/post-image.png';
const thumbnail = 'https://i1.hoopchina.com.cn/post-preview.png';
const picture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAALQAAACMCAAAAADwj9wuAAAAL0lEQVR4nO3BMQEAAADCoPVPbQdvoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAzYvwAAQxQ8GUAAAAASUVORK5CYII=', 'base64');
const head = '<!doctype html><meta charset="utf-8"><title>比赛图帖</title>';
const desktopInfo = '<header class="post-content_main-post-info__qCbZu"><h1>比赛图帖</h1><span>楼主与发帖时间</span></header>';
const comment = text => '<div class="post-reply-list-content"><div class="reply-list-wrapper">' +
  '<div class="bbs-thread-comp quote-thread"><div class="thread-content-detail">引用内容</div></div>' +
  `<div class="bbs-thread-comp main-thread"><div class="thread-content-detail">${text}</div></div></div></div>`;
const bodyImage = `<span class="slate-image"><img src="${thumbnail}" data-origin="${original}" width="180" height="140" alt="赛后截图"></span>`;
const desktopPage = head + `<div class="post-content_bbs-post-content__cy7vN">${desktopInfo}` +
  '<div class="bbs-thread-comp main-thread"><div class="thread-content-detail" id="thread"></div>' +
  '<div class="seo-dom">搜索引擎摘要</div></div></div>' +
  comment('可见评论甲') + `<div hidden>${comment('隐藏评论')}</div>` +
  `<script>fetch('/api/thread/reply', {method:'POST'}).catch(() => {});` +
  `setTimeout(() => { document.querySelector('#thread').innerHTML = ${JSON.stringify(bodyImage)}; }, 180);</script>`;
const mobileInfo = '<h1 class="bbs-header-title">比赛图帖</h1><span>移动版元信息</span>';
const mobileComment = '<p class="discuss-card__content">可见评论乙</p>';

const commentText = n => '测试楼层 ' + n;
function commentPage(numbers, page, next) {
  return head + '<div class="post-content_bbs-post-content__cy7vN">' +
    '<div class="bbs-thread-comp main-thread"><div class="thread-content-detail">楼主正文</div></div></div>' +
    numbers.map(n => `<div id="reply-${n}" data-reply-id="${n}">${comment(commentText(n))}</div>`).join('') +
    `<ul class="hupu-rc-pagination"><li class="hupu-rc-pagination-item-active">${page}</li>` +
    `<li class="hupu-rc-pagination-next" aria-disabled="false"><a href="${next}">下一页</a></li></ul>`;
}
const scrollingPage = head + `<div class="hupu-bbs-post">${mobileInfo}
  <div class="bbs-content"><div class="bbs-content-font">楼主正文</div></div></div>
  <section id="comments">${mobileComment}</section><div style="height:4000px"></div>
  <script>window.addEventListener('scroll', () => {
    const added = document.createElement('p');
    added.className = 'discuss-card__content';
    added.textContent = '滚动后加载的评论';
    document.querySelector('#comments').append(added);
  }, { once: true });</script>`;

async function exerciseCommentNavigation(engine, counts) {
  const { createBrowserTurn } = require('./turn');
  const { chatWithTools } = require('../electron/brain/chat');
  const settings = { provider:'cloud', cloud:{ baseUrl:'https://fixture.invalid/v1', model:'fixture', apiKey:'fake' },
    browser:{ enabled:true } };
  const newTurn = () => createBrowserTurn({ engine, auth:{}, getSettings:() => settings,
    signal:new AbortController().signal });
  const run = (turn, name, args) => turn.executeTool({ name, arguments:args });
  const originalFetch = global.fetch;
  let visited = [], stopAfterFirst = true;
  let stoppedCursor;
  const actionNames = result => result.comment_navigation?.actions.map(option => option.action) || [];
  const call = (name, args, id) => ({ role:'assistant', content:null, tool_calls:[
    { id, type:'function', function:{ name, arguments:JSON.stringify(args) } }
  ] });
  global.fetch = async (url, init) => {
    assert.equal(String(url), 'https://fixture.invalid/v1/chat/completions');
    const request = JSON.parse(init.body);
    const results = request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
    const last = results.at(-1);
    let message;
    if (!last) message = call('browser_read_page', { url:commentThread }, 'open-thread');
    else {
      assert.equal(last.ok, true, JSON.stringify(last));
      const page = last.result;
      const navigation = page.comment_navigation;
      visited.push(page);
      if (stopAfterFirst) message = { role:'assistant', content:'先看这些。' };
      else if (actionNames(page).includes('more_visible')) {
        message = call('browser_hupu_comments', { cursor:navigation.cursor, action:'more_visible' }, 'read-more-' + results.length);
      } else if (actionNames(page).includes('next_page')) {
        message = call('browser_hupu_comments', { cursor:navigation.cursor, action:'next_page' }, 'next-page-' + results.length);
      } else message = { role:'assistant', content:'已经读到下一页的评论。' };
    }
    return new Response(JSON.stringify({ choices:[{ message, finish_reason:message.tool_calls ? 'tool_calls' : 'stop' }],
      usage:{ prompt_tokens:10, completion_tokens:2, total_tokens:12 } }), { headers:{ 'Content-Type':'application/json' } });
  };
  const conversation = turn => chatWithTools(settings, [{ role:'user', content:'看看这个帖子里的评论' }], {
    tools:turn.tools, executeTool:turn.executeTool, signal:turn.signal
  });

  try {
    const stopped = newTurn();
    try {
      assert.equal(await conversation(stopped), '先看这些。');
      assert.equal(visited.length, 1);
      assert.equal(visited[0].comments.length, 12);
      assert.ok(actionNames(visited[0]).includes('more_visible'));
      stoppedCursor = visited[0].comment_navigation.cursor;
      assert.equal(counts.pageTwo, 0, 'no pagination is done when the model stops');
    } finally { await stopped.close(); }

    const continued = newTurn();
    try {
      const old = await run(continued, 'browser_hupu_comments', { cursor:stoppedCursor, action:'more_visible' });
      assert.equal(old.error.code, 'browser_comment_cursor_invalid', 'a prior turn cannot advance comments');
      visited = [];
      stopAfterFirst = false;
      assert.equal(await conversation(continued), '已经读到下一页的评论。');
      assert.deepEqual(visited.map(page => page.comments.length), [12, 3, 7]);
      assert.deepEqual(visited.flatMap(page => page.comments), Array.from({ length:22 }, (_, i) => commentText(i+1)));
      const repeated = await run(continued, 'browser_hupu_comments', {
        cursor:visited[0].comment_navigation.cursor, action:'more_visible'
      });
      assert.equal(repeated.error.code, 'browser_comment_cursor_invalid', 'continuation cursors are single-use');
      assert.equal(counts.pageTwo, 1);
      assert.equal(counts.differentThread, 0, 'a pagination control cannot navigate to another thread');
    } finally { await continued.close(); }

    const scrolled = newTurn();
    try {
      const first = await run(scrolled, 'browser_read_page', { url:scrollThread });
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.deepEqual(first.result.comments, ['可见评论乙']);
      assert.ok(actionNames(first.result).includes('scroll'));
      const more = await run(scrolled, 'browser_hupu_comments', {
        cursor:first.result.comment_navigation.cursor, action:'scroll'
      });
      assert.equal(more.ok, true, JSON.stringify(more));
      assert.deepEqual(more.result.comments, ['滚动后加载的评论']);
    } finally { await scrolled.close(); }
  } finally { global.fetch = originalFetch; }
}

async function main() {
  const temp = fs.realpathSync.native(path.join(__dirname, '../../temp'));
  const dir = fs.mkdtempSync(path.join(temp, 'hupu-read-'));
  process.env.DAFEIYU_DATA_DIR = dir;
  let desktopLoads = 0;
  let mobileLoads = 0;
  let writeRequests = 0;
  const navigationCounts = { pageTwo:0, differentThread:0 };
  const fixtures = new Map([
    [desktop, () => { desktopLoads++; return desktopPage; }],
    [mobile, () => {
      mobileLoads++;
      return head + `<div class="hupu-bbs-post">${mobileInfo}<div class="post-content">较早的元信息副本</div><div class="bbs-content">` +
        '<div class="bbs-content-font">楼主写在正文里的复盘。</div></div></div>' + mobileComment;
    }],
    [original, { contentType:'image/png', body:picture }],
    [thumbnail, { contentType:'image/png', body:picture }],
    [commentThread, commentPage(Array.from({ length:15 }, (_, i) => i+1), 1, commentPageTwo)],
    [commentPageTwo, () => {
      navigationCounts.pageTwo++;
      return commentPage(Array.from({ length:9 }, (_, i) => i+14), 2, differentThread) +
        `<script>fetch('/api/thread/reply', {method:'POST'}).catch(() => {});</script>`;
    }],
    [differentThread, () => { navigationCounts.differentThread++; return commentPage([99], 1, commentPageTwo); }],
    [scrollThread, scrollingPage],
    ['https://bbs.hupu.com/api/thread/reply', () => { writeRequests++; return 'fixture reply'; }]
  ]);
  const engine = createBrowserEngine({ profileDir:path.join(dir, 'browser-profile'), fixtures, browserType: {
    launchPersistentContext(profile, options) {
      assert.equal(options.offline, true, 'only local fixture responses are allowed');
      assert.equal(options.headless, false, 'Hupu post reads require the headed browser');
      assert.ok(options.args.includes('--start-minimized'));
      return chromium.launchPersistentContext(profile, options);
    }
  } });
  const read = (url, options) => engine.browse({ action:'read', url }, options);

  try {
    const imagePost = await read(desktop, { includeImages:true });
    assert.equal(imagePost.ok, true, JSON.stringify(imagePost));
    assert.equal(imagePost.result.source_url, desktop);
    assert.equal(desktopLoads, 1);
    assert.equal(mobileLoads, 0, 'a supplied desktop link must stay on the desktop route');
    assert.equal(writeRequests, 0, 'the post DOM cannot initiate a write');
    assert.equal(imagePost.result.body_status, 'image_only');
    assert.equal(imagePost.result.text, '', 'title and author details are not a body');
    assert.deepEqual(imagePost.result.comments, ['可见评论甲']);
    assert.deepEqual(imagePost.result.images.map(image => image.url), [original]);
    assert.equal(imagePost.imageInputs[0].mimeType, 'image/png');
    assert.deepEqual(imagePost.imageInputs[0].data, picture);
    assert.equal(imagePost.imageInputs[0].source_url, original);

    const mobilePost = await read(mobile);
    assert.equal(mobilePost.ok, true, JSON.stringify(mobilePost));
    assert.equal(mobilePost.result.source_url, mobile);
    assert.equal(mobilePost.result.body_status, 'text');
    assert.equal(mobilePost.result.text, '楼主写在正文里的复盘。');
    assert.deepEqual(mobilePost.result.comments, ['可见评论乙']);

    const emptyPost = head + `<div class="hupu-bbs-post">${mobileInfo}<div class="bbs-content"></div></div>`;
    fixtures.set(mobile, emptyPost + mobileComment);
    const partial = await read(mobile);
    assert.equal(partial.ok, true, JSON.stringify(partial));
    assert.equal(partial.result.body_status, 'unavailable');
    assert.equal(partial.result.text, '');
    assert.deepEqual(partial.result.images, []);
    assert.deepEqual(partial.result.comments, ['可见评论乙']);

    fixtures.set(mobile, `<meta property="og:image" content="${original}">` + emptyPost);
    assert.equal((await read(mobile, { includeImages:true })).error.code, 'browser_no_content',
      'an empty body with title metadata is not a post read');

    assert.equal((await read('https://bbs.hupu.com/account')).error.code, 'browser_invalid_target');
    fixtures.set(desktop, head + '<script>history.replaceState({}, "", "/account")</script>' +
      '<div class="post-content_bbs-post-content__cy7vN">测试私密区域</div>');
    const privatePage = await read(desktop);
    assert.equal(privatePage.error.code, 'browser_navigation_blocked');
    assert.doesNotMatch(JSON.stringify(privatePage), /测试私密区域/);
    await exerciseCommentNavigation(engine, navigationCounts);
    assert.equal(writeRequests, 0, 'continuing comments cannot make a write');
    console.log('hupu-read: PASS (original image, separate comments, partial read, model-controlled pagination and scroll, same-thread and private guards)');
  } finally {
    await engine.close();
    const target = fs.realpathSync.native(dir);
    assert.equal(target, dir);
    assert.equal(path.dirname(target), temp);
    assert.match(path.basename(target), /^hupu-read-[\w]{6}$/);
    fs.rmSync(target, { recursive:true, maxRetries:8, retryDelay:120 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
