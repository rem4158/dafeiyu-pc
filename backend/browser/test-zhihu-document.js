'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createBrowserEngine } = require('./engine');

const base = 'https://zhuanlan.zhihu.com/p/';
const recovers = base + '96234521';
const denied = base + '96234522';
const iframeOnly = base + '96234523';
const permanent = base + '96234524';
const transientScript = 'https://static.zhihu.com/zse-ck/v4/' + 'a'.repeat(64) + '.js';
const stationaryScript = 'https://static.zhihu.com/zse-ck/v4/' + 'b'.repeat(64) + '.js';
const body = '<!doctype html><meta charset="utf-8"><title>公开正文</title>' +
  '<article class="Post-RichTextContainer"><div class="Post-RichText">正文由后到的主文档提供。</div></article>';
const interstitial = script => `<!doctype html><title></title><script src="${script}"></script>`;
const jsonDenied = { status:403,contentType:'application/json; charset=utf-8',
  body:JSON.stringify({error:{code:40362,message:'fixture private challenge ID must stay outside the tool result'}}) };
const htmlDenied = { status:403,contentType:'text/html; charset=utf-8',body:interstitial(transientScript) };

async function main() {
  const temp = fs.realpathSync.native(path.join(__dirname,'../../temp'));
  const directory = fs.mkdtempSync(path.join(temp,'zhihu-document-test-'));
  const counts = new Map();
  const served = (url, first, later) => () => {
    const count = (counts.get(url) || 0) + 1;
    counts.set(url,count);
    return count === 1 ? first : later;
  };
  const fixtures = new Map([
    [recovers,served(recovers,htmlDenied,body)],
    [denied,served(denied,htmlDenied,jsonDenied)],
    [iframeOnly,served(iframeOnly,{...htmlDenied,
      body:interstitial(stationaryScript) + `<iframe src="${iframeOnly}"></iframe>`},body)],
    [permanent,served(permanent,jsonDenied,jsonDenied)],
    [transientScript,{ contentType:'application/javascript',body:'setTimeout(() => location.reload(), 180)' }],
    [stationaryScript,{ contentType:'application/javascript',body:'void 0' }],
  ]);
  const engine = createBrowserEngine({ profileDir:path.join(directory,'browser-profile'),fixtures });
  const read = url => engine.browse({action:'read',url});
  try {
    const success = await read(recovers);
    assert.equal(success.ok,true,JSON.stringify(success));
    assert.equal(success.result.http_status,200);
    assert.equal(success.result.source_url,recovers);
    assert.equal(success.result.text,'正文由后到的主文档提供。');
    assert.equal(counts.get(recovers),2,'the site alone reloaded the first HTML response');

    const terminal = await read(denied);
    assert.equal(terminal.error?.code,'browser_access_denied',JSON.stringify(terminal));
    assert.equal(terminal.error.http_status,403);
    assert.equal(terminal.error.site_code,40362);
    assert.equal(terminal.error.session_status,'unknown');
    assert.equal(counts.get(denied),2,'a terminal 40362 must not be retried');
    assert.doesNotMatch(JSON.stringify(terminal),/private challenge ID/);

    const nested = await read(iframeOnly);
    assert.equal(nested.error?.code,'browser_access_denied',JSON.stringify(nested));
    assert.equal(nested.error.http_status,403);
    assert.doesNotMatch(JSON.stringify(nested),/正文由后到的主文档提供/);
    assert.equal(counts.get(iframeOnly),2,'main and nested same-URL documents were both observed');

    const immediate = await read(permanent);
    assert.equal(immediate.error?.code,'browser_access_denied');
    assert.equal(immediate.error.site_code,40362);
    assert.equal(counts.get(permanent),1,'direct terminal denial must not be retried');
    console.log('zhihu-document: PASS (site-driven same-URL recovery, final JSON denial, iframe isolation, no terminal retry)');
  } finally {
    await engine.close();
    const target = fs.realpathSync.native(directory);
    assert.equal(target,directory);
    assert.equal(path.dirname(target),temp);
    assert.match(path.basename(target),/^zhihu-document-test-[\w]{6}$/);
    fs.rmSync(target,{recursive:true,maxRetries:8,retryDelay:120});
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
