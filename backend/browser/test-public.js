// Explicit, logged-out acceptance against the four public sites. Output contains only
// result categories/counts, never post text, access tokens, login forms or credentials.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createBrowserEngine } = require('./engine');
const { sites } = require('./sites');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright-core');

async function probe(site, dir) {
  const parent = path.join(dir, site);
  fs.mkdirSync(parent);
  let observation;
  const browserType = {
    async launchPersistentContext(...args) {
      const context = await chromium.launchPersistentContext(...args);
      const blocked = new Set();
      context.on('response',r=>{
        if (r.status()>=400) try {blocked.add(new URL(r.url()).hostname+' ('+r.request().resourceType()+', HTTP '+r.status()+')');} catch {}
      });
      context.on('requestfailed',request=>{
        try { const u=new URL(request.url()); blocked.add(u.hostname+' ('+request.resourceType()+', '+request.failure()?.errorText+')'); } catch {}
      });
      const close = context.close.bind(context);
      context.close = async () => {
        try {
          const page = context.pages().at(-1);
          if (page) {
            observation = await page.evaluate(() => {
              const text=(document.querySelector('main,article,#noteContainer')?.innerText || document.body.innerText).slice(0,1200);
              const denied = text.match(/当前笔记暂时无法浏览|笔记暂时无法查看|内容已删除|笔记不存在|作者已删除|暂时无法访问|请在手机.{0,10}查看|请先登录|访问受限|访问异常/);
              const classes = [...new Set([...document.querySelectorAll('[class]')].flatMap(el=>[...el.classList])
                .filter(c=> /title|article|floor|thread|post|content|rich|detail/i.test(c)))].slice(0,55);
              return {documentTitle:document.title.slice(0,65),knownBlock:denied?.[0] || null,classes,
                root:document.querySelector('article,#noteContainer,.note-container,.post-fst-floor,.main-post,.AnswerItem')?.tagName || null,
                domImages:document.images.length, postDomImages:document.querySelectorAll('article img,#noteContainer img,.note-container img,.post-fst-floor img').length,
                imageHosts:[...new Set([...document.images].slice(0,12).map(im=>{try{return new URL(im.currentSrc || im.src).hostname;}catch{return '';}}))].slice(0,8)};
            }).catch(()=>null);
            if (observation) observation.failedHosts=[...blocked].slice(0,40);
            if (process.platform==='win32' && site==='xiaohongshu' && observation) {
              const cdp=await context.browser().newBrowserCDPSession();
              try {
                const {processInfo}=await cdp.send('SystemInfo.getProcessInfo');
                const ids=processInfo.map(p=>p.id).filter(n=>Number.isSafeInteger(n)&&n>0);
                const stats=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
                  '$p=@(Get-Process -Id '+ids.join(',')+' -ErrorAction SilentlyContinue); [PSCustomObject]@{count=$p.Count;workingSetBytes=($p|Measure-Object WorkingSet64 -Sum).Sum;privateBytes=($p|Measure-Object PrivateMemorySize64 -Sum).Sum}|ConvertTo-Json -Compress'],
                  {windowsHide:true,timeout:3000,encoding:'utf8'});
                observation.chromeSnapshot=JSON.parse(stats);
              } finally { await cdp.detach().catch(()=>{}); }
            }
          }
        } catch { /* The page can disappear while its final navigation is being inspected. */ }
        finally { await close(); }
      };
      return context;
    }
  };
  const engine = createBrowserEngine({profileDir:path.join(parent,'browser-profile'),browserType});
  const rows = [];
  async function read(args) {
    const started = Date.now();
    observation = null;
    const output = await engine.browse({site,...args},{includeImages:args.action === 'read'});
    const r = output.result;
    rows.push({ action:args.action, status:output.ok ? 'content' : output.error.code,
      ...(output.ok ? {textChars:r.text.length, postLinks:r.links.length, originalImages:output.imageInputs?.length || 0}
        : {reason:output.error.message}), observation, elapsedMs:Date.now()-started });
    return r;
  }
  try {
    const feed = await read({action:'feed'});
    const search = await read({action:'search', query:'摄影'});
    const url = feed?.links[0]?.url || search?.links[0]?.url;
    if (url) await read({action:'read',url});
  } finally { await engine.close(); }
  return {site,checks:rows};
}
async function main() {
  const temp = fs.realpathSync.native(path.join(__dirname,'..','..','temp'));
  const dir = fs.mkdtempSync(path.join(temp,'browser-public-'));
  const selected = process.argv.slice(2);
  if (selected.some(site=>!Object.hasOwn(sites,site))) throw new Error('Unknown site');
  const results = await Promise.all((selected.length ? selected : Object.keys(sites).filter(site => sites[site].search)).map(site=>probe(site,dir)));
  if (fs.realpathSync.native(dir) !== dir || path.dirname(dir) !== temp || !/^browser-public-[\w]{6}$/.test(path.basename(dir)))
    throw new Error('Unexpected temporary directory');
  fs.rmSync(dir,{recursive:true,maxRetries:10,retryDelay:150});
  console.log(JSON.stringify({node:process.version,results},null,2));
}
main().catch(error=>{ console.error(error); process.exitCode=1; });
