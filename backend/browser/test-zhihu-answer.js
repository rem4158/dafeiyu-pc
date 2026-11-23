'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createBrowserEngine } = require('./engine');

async function main() {
  const temp = fs.realpathSync.native(path.join(__dirname,'..','..','temp'));
  const dir = fs.mkdtempSync(path.join(temp,'zhihu-answer-'));
  const question = 'https://www.zhihu.com/question/1234';
  const target = '1234567890123456789';
  const other = '1234567890123456788'; // Both round to the same IEEE-754 value.
  const answer = question + '/answer/' + target;
  const column = 'https://zhuanlan.zhihu.com/p/4321';
  const otherColumn = 'https://zhuanlan.zhihu.com/p/4322';
  const asset = 'https://pic1.zhimg.com/';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAKAAAAB4CAAAAABQyaazAAAAKUlEQVR4nO3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAAAAAAPwbS3gAAUa1eoQAAAAASUVORK5CYII=','base64');
  const fixtures = new Map(['question','other','requested'].map(name => [asset + name + '.png',{ contentType:'image/png', body:png }]));
  const engine = createBrowserEngine({ profileDir:path.join(dir,'browser-profile'), fixtures });
  const checks = [];
  const img = name => '<img width="160" height="120" src="'+asset+name+'.png">';
  const questionHeader = '<section class="QuestionHeader"><h1>问题标题</h1><div class="QuestionRichText">问题描述'+img('question')+'</div></section>';
  const page = body => '<!doctype html><meta charset="utf-8"><meta property="og:image" content="'+asset+'question.png">'+questionHeader+body;
  const zop = id => 'data-zop=\'{"itemId":'+id+'}\'';
  const card = (attributes, content, footer='') => '<article class="AnswerItem" '+attributes+'><div class="RichContent"><div class="RichContent-inner"><span class="RichText">'+content+'</span></div></div>'+footer+'</article>';
  const columnBody = text => `<article class="Post-Main"><header><h1>专栏标题</h1><span>作者和发布时间</span></header>
    <div class="Post-RichTextContainer"><div class="RichText ztext Post-RichText">${text}</div></div></article>`;
  const read = (url=answer) => engine.browse({action:'read',url},{includeImages:true});
  async function rejectBody(markup, expected='browser_no_content') {
    fixtures.set(answer,page(markup));
    const output = await read();
    assert.equal(output.error?.code,expected,JSON.stringify(output.result));
    assert.equal(output.imageInputs,undefined);
  }
  try {
    const ref = '<div class="ContentItem-time"><a href="'+answer+'">发布时间</a></div>';
    const unrelated = card(zop(other),'别人的回答'+img('other')+'<video></video>',ref);
    fixtures.set(answer,page(unrelated+card(zop(target),'指定回答'+img('requested'))+'<meta property="og:video" content="https://www.zhihu.com/fixture">'));
    const hit = await read();
    assert.equal(hit.result?.text,'指定回答');
    assert.equal(hit.result.source_url,answer);
    assert.deepEqual(hit.result.images.map(item=>item.url),[asset+'requested.png']);
    assert.deepEqual(hit.imageInputs.map(item=>item.source_url),[asset+'requested.png']);
    assert.deepEqual(hit.imageInputs[0].data,png);
    checks.push('question and another answer before target, precise large numeric ID, target-only text, photos and media classification');

    fixtures.set(answer,page(card('style="display:none" '+zop(target),'隐藏回答') +
      card('', '正文中引用<a itemprop="url" href="'+answer+'">别人的链接</a>') +
      card('', '通过永久链接确认',ref)));
    const permalink = await read();
    assert.equal(permalink.result?.text,'通过永久链接确认');
    assert.deepEqual(permalink.result.images,[]);
    checks.push('visible card permalink only, narrative links and page OG images excluded');

    await rejectBody(unrelated+card('','不属于这一条','<meta itemprop="url" content="https://www.zhihu.com/question/999/answer/'+target+'">')+
      card('','其他站的引用','<meta itemprop="url" content="https://example.com/question/1234/answer/'+target+'">'));
    checks.push('missing target, conflicting ID, wrong question and foreign permalink rejected');
    await rejectBody(card(zop(target),'被隐藏的长回答'+img('requested'),'<button class="ContentItem-more">阅读全文</button>')+unrelated);
    await rejectBody(card(zop(target),'折叠内容'+img('requested')).replace('class="RichContent"','class="RichContent is-collapsed"'));
    await rejectBody(card(zop(target),'首行<br>后续隐藏'+img('requested')).replace('class="RichContent-inner"','class="RichContent-inner" style="height:8px;overflow:hidden"'));
    checks.push('read-more, collapsed class and CSS clipping reject hidden answer and its images');
    await rejectBody(card(zop(target),'墙后的回答')+'<div role="dialog">请登录后查看</div>','browser_login_required');
    await rejectBody(card(zop(target),'墙后'.repeat(300)+img('requested'),'<div role="dialog">登录知乎</div>'));
    checks.push('page login wall and answer-local login cover block answer');

    fixtures.set(question,page(unrelated));
    assert.equal((await read(question)).result?.text,'问题描述');
    fixtures.set(column,'<article><h1>专栏标题</h1><div class="Post-RichText">专栏正文</div></article>');
    assert.equal((await read(column)).result?.text,'专栏正文');
    checks.push('question description and column reads preserved');

    const recommended = `<aside><article><div class="Post-RichText">推荐内容${img('other')}</div></article></aside>`;
    fixtures.set(column,page(recommended + columnBody('专栏正文'+img('requested'))+recommended));
    const article = await read(column);
    assert.equal(article.result?.text,'专栏正文',JSON.stringify(article.error));
    assert.equal(article.result.source_url,column);
    assert.deepEqual(article.result.images.map(item=>item.url),[asset+'requested.png']);
    assert.deepEqual(article.imageInputs.map(item=>item.source_url),[asset+'requested.png']);
    assert.deepEqual(article.imageInputs[0].data,png);
    checks.push('main column body and its original image, excluding title, author, recommendations and OG image');

    fixtures.set(column,page(`<article class="Post-Main"><header><h1>专栏标题</h1>
      <span>作者和发布时间</span></header><div class="Post-RichTextContainer"></div></article>${recommended}`));
    const metadataOnly = await read(column);
    assert.equal(metadataOnly.error?.code,'browser_no_content',JSON.stringify(metadataOnly.result));
    assert.equal(metadataOnly.imageInputs,undefined);

    fixtures.set(column,page(`<link rel="canonical" href="${otherColumn}">${columnBody('别篇正文'+img('other'))}`));
    const wrongCanonical = await read(column);
    assert.equal(wrongCanonical.ok,false,JSON.stringify(wrongCanonical.result));
    assert.equal(wrongCanonical.imageInputs,undefined);
    checks.push('column shell and recommendation text rejected, conflicting canonical not read');

    fixtures.set(column,'<script>location.replace("/p/4322")</script>');
    fixtures.set(otherColumn,page(columnBody('别篇正文'+img('other'))));
    const wrongArticle = await read(column);
    assert.equal(wrongArticle.error?.code,'browser_navigation_blocked',JSON.stringify(wrongArticle.result));
    assert.equal(wrongArticle.imageInputs,undefined);
    checks.push('same-host column redirect to a different article rejected');

    let deniedLoads = 0, authCalls = 0;
    const auth = async () => { authCalls++; };
    const tryReading = () => engine.browse({action:'read',url:column},
      {includeImages:true,onManualChallenge:auth,getCredentials:auth,requestCode:auth});
    fixtures.set(column, () => {
      deniedLoads++;
      return {status:403,contentType:'application/json',body:JSON.stringify({error:{code:40362,message:'fixture ref'}})};
    });
    const rejected = await tryReading();
    assert.equal(rejected.error?.code,'browser_access_denied');
    assert.equal(rejected.error.site_code,40362);
    assert.equal(rejected.error.session_status,'unknown');
    assert.equal(rejected.error.http_status,403);
    assert.doesNotMatch(JSON.stringify(rejected),/fixture ref/);
    assert.equal(authCalls,0);
    assert.equal(deniedLoads,1);

    fixtures.set(column, () => {
      deniedLoads++;
      return {status:403,contentType:'text/html; charset=utf-8',body:page(columnBody('40362 fixture ref'+img('other')))};
    });
    const genericDenial = await tryReading();
    assert.equal(genericDenial.error?.code,'browser_access_denied');
    assert.equal(genericDenial.error.site_code,undefined);
    assert.equal(genericDenial.error.session_status,'unknown');
    assert.doesNotMatch(JSON.stringify(genericDenial),/fixture ref/);
    assert.equal(authCalls,0);
    assert.equal(deniedLoads,2);
    checks.push('40362 and generic 403 classified without exposing raw response, opening auth, or retrying');

    let gateLoads = 0;
    let signedIn = false;
    fixtures.set(column, () => {
      gateLoads++;
      return signedIn ? page(columnBody('验证后同一篇文章')) : page('<div role="dialog">请登录后查看</div>');
    });
    const resumed = await engine.browse({action:'read',url:column},{onManualChallenge:async challenge => {
      assert.equal(challenge.site,'zhihu');
      assert.equal(challenge.kind,'login');
      authCalls++;
      signedIn = true;
    }});
    assert.equal(resumed.result?.text,'验证后同一篇文章',JSON.stringify(resumed.error));
    assert.equal(resumed.result.source_url,column);
    assert.equal(authCalls,1);
    assert.equal(gateLoads,2);
    checks.push('explicit login wall permits a manual challenge and one re-read of the same column');

    await rejectBody('<script>location.replace("/question/1234")</script>','browser_navigation_blocked');
    checks.push('requested answer redirected to question rejected');
  } finally {
    await engine.close();
    assert.equal(fs.realpathSync.native(dir),dir);
    assert.equal(path.dirname(dir),temp);
    assert.match(path.basename(dir),/^zhihu-answer-[\w]{6}$/);
    fs.rmSync(dir,{recursive:true,maxRetries:10,retryDelay:120});
  }
  console.log(JSON.stringify({runtime:process.version,offline:true,checks},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
