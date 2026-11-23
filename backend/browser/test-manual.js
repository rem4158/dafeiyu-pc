'use strict';
// Windows + installed Chrome. The fixture never leaves the in-memory route handler.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {setTimeout: delay} = require('node:timers/promises');
const {chromium} = require('playwright-core');
const {createBrowserEngine} = require('./engine');

const root = fs.realpathSync.native(path.join(__dirname,'..','..'));
const temp = fs.realpathSync.native(path.join(root,'temp'));
const post = 'https://tieba.baidu.com/p/45678', feed = 'https://tieba.baidu.com/';
const challenge = `<!doctype html><meta charset="utf-8"><title>安全验证</title>
  <div id="captcha_container"><button onclick="document.cookie='manual=ok; Path=/; Max-Age=600; SameSite=Lax; Secure'">完成模拟验证</button></div>`;
const article = '<!doctype html><meta charset="utf-8"><title>观察记录</title><article>人工验证后的湖边记录</article>';
const closeOwnedWindow = `
import ctypes as c, ctypes.wintypes as w, sys
user = c.WinDLL("user32", use_last_error=True)
enumproc = c.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
user.EnumWindows.argtypes = [enumproc,w.LPARAM]
user.GetWindowThreadProcessId.argtypes = [w.HWND,c.POINTER(w.DWORD)]
user.GetClassNameW.argtypes = [w.HWND,w.LPWSTR,c.c_int]
user.IsWindowVisible.argtypes = [w.HWND]
user.PostMessageW.argtypes = [w.HWND,w.UINT,w.WPARAM,w.LPARAM]
pid = int(sys.argv[1]); owned = []
@enumproc
def visit(hwnd, _):
    found = w.DWORD()
    user.GetWindowThreadProcessId(hwnd,c.byref(found))
    if found.value == pid and user.IsWindowVisible(hwnd):
        name = c.create_unicode_buffer(128)
        user.GetClassNameW(hwnd,name,len(name))
        if name.value == "Chrome_WidgetWin_1": owned.append(hwnd)
    return True
if not user.EnumWindows(visit,0) or len(owned) != 1:
    raise SystemExit("Expected exactly one native window owned by the sampled browser")
if not user.PostMessageW(owned[0],0x0010,0,0): raise SystemExit("Window close failed")
`;
function deferred() { let resolve; const promise=new Promise(done=>{resolve=done;}); return {resolve,promise}; }
async function within(promise, label, ms=10000) {
  let timer;
  try {return await Promise.race([promise,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error(label+' did not finish within '+ms+'ms')),ms);
  })]);} finally {clearTimeout(timer);}
}
function live(pid) {
  try {process.kill(pid,0); return true;} catch(error){if (error.code==='ESRCH') return false; throw error;}
}
async function exited(pids) {
  const deadline=Date.now()+5000;
  while(pids.some(live) && Date.now()<deadline) await delay(50);
  assert.deepEqual(pids.filter(live),[],'sampled Chrome processes are still running');
}
async function manualWindow(context,url) {
  let page;
  const deadline=Date.now()+8500;
  while(!(page=context.pages().find(p=>p.url()===url)) && Date.now()<deadline) await delay(20);
  assert.ok(page,'manual Chrome must open the original target');
  await page.getByRole('button',{name:'完成模拟验证'}).waitFor({timeout:3000});
  const cdp=await context.browser().newBrowserCDPSession();
  try {
    const {arguments:args}=await cdp.send('Browser.getBrowserCommandLine');
    assert.ok(!args.some(arg=>/^--headless(?:=|$)/.test(arg)), 'manual browser must be headed');
    const {processInfo}=await cdp.send('SystemInfo.getProcessInfo');
    const pids=processInfo.map(info=>info.id);
    assert.ok(pids.every(pid=>Number.isSafeInteger(pid)&&pid>0));
    return {page,pids,browserPid:processInfo.find(info=>info.type==='browser').id};
  } finally {await cdp.detach();}
}

async function main() {
  assert.equal(process.platform,'win32');
  const dir=fs.mkdtempSync(path.join(temp,'browser-manual-'));
  const profileDir=path.join(dir,'browser-profile'), loads=[], samples=[];
  const fixtures = new Map([[post,async req=>{
    const passed=/(?:^|; )manual=ok(?:;|$)/.test((await req.allHeaders()).cookie || '');
    loads.push(passed); return passed ? article : challenge;
  }],[feed,challenge]]);
  let opened;
  const browserType={async launchPersistentContext(location,options) {
    assert.equal(location,profileDir); assert.equal(options.offline,true);
    const args=[...options.args,'--enable-automation'];
    if (!options.headless) args.push('--window-position=-12000,-12000','--window-size=640,480','--start-minimized');
    const context=await chromium.launchPersistentContext(location,{...options,args});
    if (!options.headless) opened.resolve(context);
    return context;
  }};
  const make=()=>createBrowserEngine({profileDir,fixtures,browserType});
  const engine=make();
  const ready=deferred(), resume=deferred(), reading=new AbortController();
  const headless=engine.browse({action:'read',url:post},{signal:reading.signal,onManualChallenge:async task=>{
    assert.equal(task.kind,'captcha'); assert.equal(task.site,'tieba');
    ready.resolve(); await resume.promise;
  }}).then(value=>({value}),error=>({error}));
  async function open(signal) {
    opened=deferred();
    const work=engine.openLogin('tieba',{signal}).then(value=>({value}),error=>({error}));
    const context=await within(Promise.race([opened.promise,work.then(()=>{throw new Error('manual launch failed');})]),'headed launch',22000);
    return {context,work};
  }
  try {
    await within(Promise.race([ready.promise,headless.then(()=>{throw new Error('expected a challenge');})]),'headless challenge',25000);
    const first=await open();
    const owned=await manualWindow(first.context,post); samples.push(owned.pids.length);
    assert.deepEqual(loads,[false,false]);
    await owned.page.getByRole('button',{name:'完成模拟验证'}).click({timeout:3500});
    assert.equal(await owned.page.evaluate(()=>document.cookie),'manual=ok');
    assert.equal((await engine.browse({action:'read',url:post})).error.code,'browser_profile_busy');
    execFileSync(require('../pc-python').pcPython(root),['-B','-c',closeOwnedWindow,String(owned.browserPid)],
      {windowsHide:true,timeout:4000});
    const closed=await within(first.work,'closing the final native window');
    assert.equal(closed.value?.result?.window_closed,true,JSON.stringify(closed));
    await exited(owned.pids);
    resume.resolve();
    const resumed=await within(headless,'resumed headless navigation');
    assert.deepEqual(loads,[false,false,true],'resumed headless request must carry the manual cookie');
    assert.equal(resumed.value?.result?.text,'人工验证后的湖边记录');

    const stop=new AbortController(), cancel=await open(stop.signal);
    const cancelledWindow=await manualWindow(cancel.context,feed); samples.push(cancelledWindow.pids.length);
    stop.abort();
    assert.equal((await within(cancel.work,'cancel manual login')).error?.name,'AbortError');
    await exited(cancelledWindow.pids);
    assert.equal((await engine.browse({action:'read',url:post})).ok,true,'release profile after cancel');
    const shutdown=await open(), shutdownWindow=await manualWindow(shutdown.context,feed);
    samples.push(shutdownWindow.pids.length);
    await within(engine.close(),'shutdown manual login');
    assert.equal((await shutdown.work).error?.name,'AbortError'); await exited(shutdownWindow.pids);
    const reopened=make();
    try { assert.equal((await reopened.browse({action:'read',url:post})).ok,true,'release profile after shutdown'); }
    finally { await reopened.close(); }
  } finally {
    reading.abort(); resume.resolve();
    await engine.close(); await headless;
    const target=fs.realpathSync.native(dir);
    assert.equal(target,dir); assert.equal(path.dirname(target),temp); assert.match(path.basename(target),/^browser-manual-[\w]{6}$/);
    fs.rmSync(target,{recursive:true,maxRetries:6,retryDelay:150});
  }
  console.log(JSON.stringify({node:process.version,check:'headed Chrome manual challenge',nativeClose:'WM_CLOSE',
    preManualAuthenticated:false,resumedWithCookie:true,cancelReleased:true,shutdownReleased:true,sampledProcesses:samples}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
