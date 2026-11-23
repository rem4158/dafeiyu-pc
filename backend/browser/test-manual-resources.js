// Exercise the interactive window's network policy without displaying a window or
// submitting a real verification. Inspect the public challenge components, never their contents.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createBrowserEngine } = require('./engine');
async function check(site, dir) {
  const parent=path.join(dir,site); fs.mkdirSync(parent);
  const loaded=new Set(), failed=new Set();
  let title='',frames=0,inputs=0;
  const browserType={
    async launchPersistentContext(profile,options) {
      if (options.headless) throw new Error('Expected interactive policy');
      const context=await chromium.launchPersistentContext(profile,{...options,headless:true});
      function record(set,req,state) {
        try {
          const u = new URL(req.url());
          if (!/^(?:http|https):$/.test(u.protocol)) return;
          const pathname = u.pathname.split('/').slice(1,5).map(s=>/^[a-zA-Z_-]{1,32}$/.test(s) ? s : '…').join('/');
          set.add(u.hostname + (['xhr','fetch'].includes(req.resourceType()) ? '/'+pathname : '') + ' '+req.resourceType()+' '+state);
        } catch {}
      }
      context.on('response',r=>record(r.status()<400 ? loaded : failed,r.request(),r.status()));
      context.on('requestfailed',r=>record(failed,r,r.failure()?.errorText));
      const timer=setTimeout(async()=>{
        try {
          const page=context.pages().at(-1);
          title=(await page.title()).slice(0,50); frames=page.frames().length;
          inputs=await page.locator('input:visible,button:visible').count();
        } finally {await context.close().catch(()=>{});}
      },8500);
      context.once('close',()=>clearTimeout(timer));
      return context;
    }
  };
  const engine=createBrowserEngine({profileDir:path.join(parent,'browser-profile'),browserType});
  try { const result=await engine.openLogin(site); return {site,closed:result.ok,title,frames,inputs,
    loaded:[...loaded].slice(0,70),failed:[...failed].slice(0,65)}; }
  finally {await engine.close();}
}
async function main(){
  const temp=fs.realpathSync.native(path.join(__dirname,'..','..','temp'));
  const dir=fs.mkdtempSync(path.join(temp,'browser-manual-'));
  const results=await Promise.all(['tieba','zhihu'].map(s=>check(s,dir)));
  if(fs.realpathSync.native(dir)!==dir||path.dirname(dir)!==temp||!/^browser-manual-\w{6}$/.test(path.basename(dir))) throw new Error('Unexpected profile directory');
  await fs.promises.rm(dir,{recursive:true,maxRetries:12,retryDelay:150});
  console.log(JSON.stringify(results,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
