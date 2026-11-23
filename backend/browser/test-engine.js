'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { sites,targetFor,secureUrl } = require('./sites');
const { createBrowserEngine } = require('./engine');

const posts = {
  xiaohongshu:'https://www.xiaohongshu.com/explore/650abcde1234567890abcdef',
  tieba:'https://tieba.baidu.com/p/123456',
  hupu:'https://m.hupu.com/bbs/12345678.html',
  zhihu:'https://zhuanlan.zhihu.com/p/123456789'
};
const html = '<!doctype html><html lang="zh"><meta charset="utf-8"><title>湿地笔记</title>';
function png() {
  function chunk(kind,data) {
    const key = Buffer.from(kind);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([key,data])));
    return Buffer.concat([length,key,data,crc]);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(180); ihdr.writeUInt32BE(140,4); ihdr[8]=8; ihdr[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),
    chunk('IDAT',zlib.deflateSync(Buffer.alloc((180*3+1)*140,0))),chunk('IEND',Buffer.alloc(0))]);
}
const picture = png();
const text = '周末在湿地看见了一只白鹭。';
function detail(imageUrl) {
  return html + '<article><h1>湿地笔记</h1><p>'+text+'</p><img alt="白鹭" width="180" height="140" src="'+imageUrl+'"></article>';
}
function addProfile(dir, name) {
  const parent = path.join(dir,name); fs.mkdirSync(parent);
  return path.join(parent,'browser-profile');
}
async function siteCases(site, dir) {
  const post = posts[site];
  const image = new URL('/post-image.png',post).href;
  const search = { action:'search',site,query:'湿地' };
  const signed = site === 'xiaohongshu' ? post + '?xsec_token=fixture' : post;
  const card = '<a href="'+signed+'">湿地笔记</a>';
  const listing = html+'<main>'+(site === 'xiaohongshu' ? '<section class="note-item">'+card+'</section>' : card)+'</main>';
  const fixtures = new Map([[sites[site].feed,listing],[targetFor(search).url,listing],
    [signed,detail(image)],[image,{contentType:'image/png',body:picture}]]);
  if (site === 'xiaohongshu') {
    fixtures.set(sites[site].feed,listing+'<input placeholder="搜索笔记" onkeydown="if(event.key===\'Enter\')location.href=\'/search_result?keyword=\'+encodeURIComponent(this.value)">');
  }
  if (site === 'hupu') {
    fixtures.set(signed,detail(image).replace('<article><h1>湿地笔记</h1>',
      '<article class="hupu-bbs-post"><h1>湿地笔记</h1><div class="bbs-content">').replace('</article>','</div></article>'));
    fixtures.set(targetFor(search).url,html+'<input placeholder="搜我想看" onkeydown="if(event.key===\'Enter\')fetch(\'/api/v2/search2?keyword=\'+encodeURIComponent(this.value)).then(()=>document.body.insertAdjacentHTML(\'beforeend\',\'<section class=search-result__fixture>湿地笔记</section>\'))">');
    fixtures.set('https://m.hupu.com/api/v2/search2?keyword='+encodeURIComponent('湿地'),
      {contentType:'application/json',body:JSON.stringify({data:{result:{data:[{id:12345678,title:'湿地笔记'}]}}})});
  }
  if (site === 'zhihu') {
    fixtures.set(signed,detail(image).replace('<p>','<div class="Post-RichText"><p>').replace('</article>','</div></article>'));
  }
  const engine = createBrowserEngine({profileDir:addProfile(dir,site),fixtures});
  try {
    for (const args of [{ action:'feed',site },search]) {
      const output = await engine.browse(args);
      assert.equal(output.ok,true,JSON.stringify(output));
      assert.deepEqual(output.result.links,[{url:post,title:'湿地笔记'}]);
    }
    const output = await engine.browse({action:'read',url:post},{includeImages:true});
    assert.equal(output.ok,true,JSON.stringify(output));
    assert.ok(output.result.text.includes(text));
    assert.equal(output.result.source_url,post);
    assert.equal(output.imageInputs[0].mimeType,'image/png');
    assert.deepEqual(output.imageInputs[0].data,picture);
    if (site === 'zhihu') {
      const bridge = 'https://www.zhihu.com/account/unhuman';
      fixtures.set(targetFor(search).url,'<script>location.replace("/account/unhuman")</script>');
      fixtures.set(bridge,'<title>安全验证 - 知乎</title><script>setTimeout(()=>location.replace("/signin"),650)</script>');
      fixtures.set('https://www.zhihu.com/signin','<title>知乎</title><form class="SignFlow">登录知乎<input></form>');
      assert.equal((await engine.browse(search)).error.code,'browser_login_required');
      fixtures.set(bridge,'<title>安全验证 - 知乎</title><main class="yidun_panel">请完成验证</main>');
      assert.equal((await engine.browse(search)).error.code,'browser_verification_required');
    }
    if (site === 'tieba') {
      const image2 = image+'-two', image3=image+'-three';
      fixtures.set(signed,detail(image).replace('</article>','<img src="'+image2+'" width=180 height=140><img src="'+image3+'" width=180 height=140></article>'));
      fixtures.set(image2,fixtures.get(image)); fixtures.set(image3,fixtures.get(image));
      const next=await engine.browse({action:'read',url:post},{includeImages:true,imageStart:2});
      assert.deepEqual(next.imageInputs.map(i=>i.source_url),[image2,image3]);
    }
    assert.ok(!JSON.stringify(output.result).includes('xsec_token'));
    const video = '<video></video>视频内容';
    fixtures.set(signed,html+(site === 'hupu'
      ? '<article class="hupu-bbs-post"><div class="bbs-content">'+video+'</div></article>'
      : site === 'zhihu' ? '<article><div class="Post-RichText">'+video+'</div></article>'
      : '<article>'+video+'</article>'));
    assert.equal((await engine.browse({action:'read',url:post})).error.code,'browser_video_unsupported');
  } finally { await engine.close(); }
}

async function xiaohongshuSearchObservations(dir) {
  const site = 'xiaohongshu';
  const query = 'BLG 战胜 DK';
  const search = { action:'search', site, query };
  const feed = sites[site].feed;
  const searchUrl = targetFor(search).url;
  const resultPage = 'https://www.xiaohongshu.com/search_result_ai?keyword=BLG%20DK&source=web_explore_feed';
  const selected = posts.xiaohongshu;
  const signed = selected+'?xsec_token=fixture';
  const next = 'https://www.xiaohongshu.com/explore/65abcdef1234567890abcdef';
  const homePost = 'https://www.xiaohongshu.com/explore/66abcdef1234567890abcdef';
  const card = (url,title) => '<section class="note-item"><a href="'+url+'">'+title+'</a></section>';
  const homepage = html+'<h1>发现推荐</h1>'+card(homePost,'湿地摄影');
  const cards = html+'<aside><a href="'+homePost+'">侧栏旧推荐</a></aside>' +
    '<main><h1>笔记搜索</h1><button role="tab" aria-selected="true">综合</button><button role="tab">最新</button>'+
    '<div hidden>'+card(homePost,'隐藏的旧结果')+'</div>'+
    card(signed,'今晚晋级四强！')+card(next,'赛后采访')+'</main>';
  const input = '<input id="search-input" placeholder="搜索笔记">';
  const readOnlyInput = '<input readonly placeholder="搜索笔记" value="旧搜索词">';
  const signedInInput = '<input id="search-input" hidden>'+readOnlyInput+
    '<div class="search-input"><textarea placeholder="搜索笔记"></textarea></div>';
  const engineFixtures = new Map();
  const engine = createBrowserEngine({ profileDir:addProfile(dir,'signed-in-search'), fixtures:engineFixtures });
  try {
    let postVisits = 0, directVisits = 0;
    engineFixtures.set(signed,()=>{postVisits++; return html+'<article>已选择笔记正文</article>';});
    engineFixtures.set(searchUrl,()=>{directVisits++; return cards;});
    engineFixtures.set(resultPage,cards);
    engineFixtures.set(feed,homepage+signedInInput+'<script>document.querySelector("textarea").onkeydown=e=>{'+
      'if(e.key==="Enter" && e.target.value==='+JSON.stringify(query)+'){e.preventDefault();'+
      'setTimeout(()=>location.assign('+JSON.stringify(resultPage)+'),250);}}</script>');
    const moved = await engine.browse(search);
    assert.equal(moved.ok,true,JSON.stringify(moved));
    const source = new URL(moved.result.source_url);
    assert.equal(source.pathname,'/search_result_ai');
    assert.equal(source.searchParams.get('keyword'),'BLG DK','observe the actual URL after a site rewrites the query');
    assert.ok(!source.searchParams.has('source'));
    assert.equal(moved.result.observation.action,'pressed_enter');
    assert.ok(moved.result.observation.headings.includes('笔记搜索'));
    assert.ok(moved.result.observation.tabs.includes('最新'));
    assert.deepEqual(moved.result.observation.active_tabs,['综合']);
    assert.deepEqual(moved.result.links,[{url:selected,title:'今晚晋级四强！'},{url:next,title:'赛后采访'}]);
    assert.ok(!JSON.stringify(moved.result).includes('xsec_token'));

    // A submitted search may replace the visible cards without recording a navigation.
    const updated = '<h1>赛事搜索</h1><button role="tab">最新</button>'+card(signed,'晋级赛图集');
    engineFixtures.set(feed,html+input+'<main><h1>发现推荐</h1>'+card(homePost,'湿地摄影')+'</main>'+
      '<script>document.querySelector("input").onkeydown=e=>{if(e.key==="Enter")setTimeout(()=>{'+
      'document.querySelector("main").innerHTML='+JSON.stringify(updated)+';},250);};</script>');
    const inPlace = await engine.browse(search);
    assert.equal(inPlace.ok,true,JSON.stringify(inPlace));
    assert.equal(inPlace.result.source_url,feed);
    assert.equal(inPlace.result.observation.same_visible_links,false);
    assert.ok(inPlace.result.observation.headings.includes('赛事搜索'));
    assert.deepEqual(inPlace.result.links,[{url:selected,title:'晋级赛图集'}]);

    // If the UI misses the first Enter, surface what a person would still see.
    // Submitting again would navigate, making an unintended second attempt observable.
    engineFixtures.set(feed,homepage+input+'<script>let presses=0;document.querySelector("input").onkeydown=e=>{'+
      'if(e.key==="Enter" && ++presses===2)location.assign('+JSON.stringify(resultPage)+');};</script>');
    const stayed = await engine.browse(search);
    assert.equal(stayed.ok,true,JSON.stringify(stayed));
    assert.equal(stayed.result.source_url,feed);
    assert.equal(stayed.result.observation.action,'pressed_enter');
    assert.equal(stayed.result.observation.search_input,query);
    assert.equal(stayed.result.observation.same_visible_links,true);
    assert.ok(stayed.result.observation.headings.includes('发现推荐'));
    assert.deepEqual(stayed.result.links,[{url:homePost,title:'湿地摄影'}]);

    engineFixtures.set(feed,homepage+readOnlyInput);
    const readOnly = await engine.browse(search);
    assert.equal(readOnly.ok,true,JSON.stringify(readOnly));
    assert.equal(readOnly.result.observation.action,'search_box_unavailable');
    assert.ok(readOnly.result.observation.headings.includes('发现推荐'));
    assert.deepEqual(readOnly.result.links,[{url:homePost,title:'湿地摄影'}]);

    engineFixtures.set(feed,html+'<main><h1>正在加载推荐</h1><p role="status">请稍候</p>'+
      '<div hidden><h2>不可见标题</h2><p role="status">隐藏状态</p></div></main>');
    const missing = await engine.browse(search);
    assert.equal(missing.ok,true,JSON.stringify(missing));
    assert.equal(missing.result.observation.action,'search_box_unavailable');
    assert.ok(missing.result.observation.headings.includes('正在加载推荐'));
    assert.deepEqual(missing.result.observation.notices,['请稍候']);
    assert.ok(!JSON.stringify(missing.result).includes('不可见标题'));
    assert.deepEqual(missing.result.links,[]);
    assert.equal(directVisits,0,'the home search must not silently switch to another entry point');

    const direct = await engine.browse({...search,entry:'search_url'});
    assert.equal(direct.ok,true,JSON.stringify(direct));
    assert.equal(direct.result.observation.action,'opened_search_url');
    assert.equal(directVisits,1);
    assert.ok(direct.result.links.some(link=>link.url===selected));
    assert.equal(postVisits,0,'search must not open even the first visible note');
    const chosen = await engine.browse({action:'read',url:selected});
    assert.equal(chosen.ok,true,JSON.stringify(chosen));
    assert.equal(postVisits,1,'only an explicit read opens the note with its signed URL');

    engineFixtures.set(feed,html+input+'<main></main><script>document.querySelector("input").onkeydown=e=>{'+
      'if(e.key!=="Enter")return;history.pushState({},"","/notification");'+
      'document.querySelector("main").innerHTML='+JSON.stringify('<h1>测试私密通知</h1>'+card(selected,'测试私密消息'))+';};</script>');
    const privatePage = await engine.browse(search);
    assert.equal(privatePage.error.code,'browser_navigation_blocked');
    assert.ok(!JSON.stringify(privatePage).includes('测试私密'),'a same-site SPA cannot expose a private view');

    const opensSearchTab = html+input+'<script>document.querySelector("input").onkeydown=e=>{'+
      'if(e.key==="Enter")window.open('+JSON.stringify(resultPage)+',"_blank");};</script>';
    engineFixtures.set(feed,opensSearchTab);
    engineFixtures.set(resultPage,html+'<script>location.replace("/login")</script>');
    engineFixtures.set('https://www.xiaohongshu.com/login',html+'<div class="login-modal">请登录账号</div>');
    assert.equal((await engine.browse(search)).error.code,'browser_login_required');

    engineFixtures.set(feed,html+'<div class="login-modal">请登录账号</div>'+card(homePost,'登录墙后的卡片'));
    assert.equal((await engine.browse(search)).error.code,'browser_login_required');

    engineFixtures.set(feed,opensSearchTab);
    engineFixtures.set(resultPage,{status:429,contentType:'text/html; charset=utf-8',body:cards});
    const limited = await engine.browse(search);
    assert.equal(limited.error.code,'browser_rate_limited',
      'an actual access restriction takes precedence over visible cards in a new search tab');
    assert.equal(limited.error.http_status,429);
  } finally { await engine.close(); }
}

async function loginAndLifecycle(dir) {
  const post = posts.tieba;
  const valid = html+'<article><h1>湿地笔记</h1>'+text+'</article>';
  const gate = html + '<div class="login-modal"><h2>账号登录</h2><input name="username"><input type="password">'+
    '<button id="next">登录</button></div><script>next.onclick=()=>{if(document.querySelector("input[type=password]").value!=="stand-in-pass")return;'+
    'const form=document.querySelector(".login-modal");form.innerHTML=\'<h2>手机验证</h2><p>短信已发送至 138****1234，58秒后重新发送</p><input autocomplete="one-time-code" placeholder="短信验证码"><button>确认</button>\';'+
    'form.querySelector("button").onclick=()=>{if(form.querySelector("input").value==="804213"){document.cookie="done=1; Path=/; Max-Age=3600";form.remove()}};};</script>';
  const fixtures = new Map([[post,async req=> (await req.allHeaders()).cookie?.includes('done=1') ? valid : gate]]);
  const engine = createBrowserEngine({profileDir:addProfile(dir,'lifecycle'),fixtures});
  const args = {action:'read',url:post};
  try {
    let codeRequests = 0;
    const output = await engine.browse(args,{
      getCredentials:async () => ({username:'fixture-owner',password:'stand-in-pass'}),
      requestCode:async ({site,method}) => { assert.equal(site,'tieba');assert.equal(method,'sms'); codeRequests++;return '804213'; }
    });
    assert.equal(output.ok,true,JSON.stringify(output));
    assert.equal(codeRequests,1);
    assert.equal((await engine.browse(args)).ok,true,'dedicated profile reuses sign-in cookie');

    fixtures.set(post,html+'<div id="captcha_container" style="height:50px">完成滑块验证</div>');
    let manual = 0;
    const resumed = await engine.browse(args,{onManualChallenge:async ({kind})=>{
      assert.equal(kind,'captcha'); manual++;
      fixtures.set(post,valid);
      assert.equal((await engine.browse(args)).ok,true,'manual handoff releases the locked profile');
    }});
    assert.equal(resumed.ok,true);assert.equal(manual,1);

    const controller = new AbortController();
    let entered, release;
    const ready = new Promise(resolve=>{ entered=resolve; });
    fixtures.set(post,()=>new Promise(resolve=>{release=()=>resolve(valid); entered();}));
    const inFlight= engine.browse(args,{signal:controller.signal});
    const readyTimer = AbortSignal.timeout(12000);
    await Promise.race([ready,new Promise((_,reject)=>readyTimer.addEventListener('abort',()=>reject(new Error('navigation never reached fixture')),{once:true}))]);
    assert.equal((await engine.browse(args)).error.code,'browser_profile_busy');
    controller.abort();
    try { await assert.rejects(inFlight,{name:'AbortError'}); } finally {release();}
    fixtures.set(post,valid); assert.equal((await engine.browse(args)).ok,true);
    for (const url of ['file:///c:/private','http://127.0.0.1/',post+'/../../logout','https://tieba.baidu.com@private.test/p/123']) {
      assert.equal((await engine.browse({action:'read',url})).error.code,'browser_invalid_target');
    }
  } finally { await engine.close(); }
}

async function main() {
  const temp=fs.realpathSync.native(path.join(__dirname,'..','..','temp'));
  const dir=fs.mkdtempSync(path.join(temp,'browser-engine-'));
  try {
    assert.equal(secureUrl('https://bad.test:9000/'),null);
    const checks=await Promise.allSettled(Object.keys(posts).map(site=>siteCases(site,dir)));
    for (const outcome of checks) if (outcome.status === 'rejected') throw outcome.reason;
    await xiaohongshuSearchObservations(dir);
    await loginAndLifecycle(dir);
  } finally {
    assert.equal(fs.realpathSync.native(dir),dir);assert.equal(path.dirname(dir),temp);
    assert.match(path.basename(dir),/^browser-engine-[\w]{6}$/);
    fs.rmSync(dir,{recursive:true,maxRetries:10,retryDelay:120});
  }
  console.log(JSON.stringify({node:process.version,sites:Object.keys(posts),checks:['four feeds/searches/posts, source and signed-link privacy',
    'Xiaohongshu search: observed rewritten keyword, delayed navigation, actual homepage, missing input, explicit retry and read',
    'Zhihu transient security page settles to sign-in or shows a real challenge',
    'actual image buffers','video rejection','password then already-dispatched SMS code','persistent login','manual challenge handoff and resume',
    'busy/stop/reuse','rejected private or unrelated targets','temporary profiles released']},null,2));
}
main().catch(error=>{ console.error(error);process.exitCode=1; });
