'use strict';
// Exercise the actual three transports and budget ledger with a stubbed fetch only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const temp = fs.realpathSync.native(path.join(__dirname, '../../temp'));
const dir = fs.mkdtempSync(path.join(temp, 'browser-vision-'));
process.env.DAFEIYU_DATA_DIR = dir;
const ledger = require('../usage-ledger');
const { enrichBrowserImages } = require('./vision');
const { chatWithTools } = require('../electron/brain/chat');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTU0AAAAASUVORK5CYII=';
const imageUrl = 'https://fixture.invalid/pixel.png';
const page = { ok: true, result: { source_url: 'https://fixture.invalid/post/1',
  text: 'fixture visible text', images: [{ url: imageUrl, alt: 'fixture alt' }] },
  imageInputs: [{ mimeType: 'image/png', data: Buffer.from(png, 'base64'), source_url: imageUrl }] };
const cloud = (baseUrl, model) => ({ provider:'cloud', cloud: {baseUrl, model, apiKey:'fake-only'} });
const official = cloud('https://api.openai.com/v1', 'gpt-6.1-terra');
const compatible = cloud('https://fixture.invalid/v1', 'fixture-vision');
const local = { provider:'ollama', ollama:{baseUrl:'http://fixture.invalid',model:'fixture-ollama-vision'} };
const message = '图中可辨文字为测试。';
const nativeUsage = { input_tokens:10, output_tokens:5, total_tokens:15 };
const json = data => new Response(JSON.stringify(data), {headers:{'Content-Type':'application/json'}});
const call = (cfg, mode, signal, input = page) => ledger.withUsageContext({purpose:'chat',requestId:'fixture-turn',
  taskId:'fixture-turn',sessionId:'main',channel:'pc'}, () => enrichBrowserImages(cfg, input, { mode, signal }));
const originalFetch = global.fetch;

async function main() {
  let bodies = [];
  const tools = [{ type:'function', function:{name:'browser_read_page',parameters:{type:'object',properties:{}}} }];
  const userMessage = { role:'user', content:'PRIVATE_SYNTHETIC_CONVERSATION' };
  function fake(url, init) {
    const body=JSON.parse(init.body);
    bodies.push({url,body});
    if (url.endsWith('/responses/input_tokens')) return Promise.resolve(json({input_tokens:10}));
    if (url.endsWith('/responses')) return Promise.resolve(json({status:'completed',usage:nativeUsage,output:[
      {type:'message',content:[{type:'output_text',text:message}]}]}));
    if (url.endsWith('/api/chat')) return Promise.resolve(json({done:true,message:{role:'assistant',content:message},
      prompt_eval_count:10,eval_count:5}));
    const first = body.messages.length === 1 && body.messages[0].content === userMessage.content;
    const answer = first ? {role:'assistant',content:null,tool_calls:[{id:'read-1',type:'function',
      function:{name:'browser_read_page',arguments:'{}'}}]} : {role:'assistant',content:message};
    return Promise.resolve(json({usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15},
      choices:[{message:answer,finish_reason:first?'tool_calls':'stop'}]}));
  }
  try {
    assert.equal(ledger.enableUsageLedger(), true);
    const sentinel = ledger.withUsageContext({requestId:'other-process'}, () =>
      ledger.beginCall(compatible,{kind:'chat_completions'}));
    const peer = require('node:child_process').spawnSync(process.execPath, ['-e', `
      const ledger=require('./usage-ledger');
      if (!ledger.enableUsageLedger({auxiliary:true})) process.exit(1);
      ledger.closeUsageLedger();`], {cwd:path.join(__dirname,'..'),encoding:'utf8',windowsHide:true});
    assert.equal(peer.status, 0, peer.stderr);
    assert.equal(ledger.getUsageSummary(compatible).today.pending_calls, 1, 'auxiliary open/close preserves another caller');
    sentinel.finish('completed');
    global.fetch=fake;
    const rawText = await call(compatible, undefined);
    assert.deepEqual(rawText, {ok:true,result:page.result});
    const absent = await call(compatible,'ocr',undefined,{...page,imageInputs:[
      {...page.imageInputs[0], source_url:'https://fixture.invalid/other'},
      {...page.imageInputs[0], data:Buffer.from('not a PNG image')} ]});
    assert.equal(absent.result.vision.status,'no_images');
    const blocked={ok:false,error:{code:'human_verification'}};
    assert.deepEqual(await call(compatible,'ocr',undefined,{...blocked,imageInputs:page.imageInputs}),blocked);
    assert.equal(bodies.length,0);

    // The original assistant receives a text tool result. The same connection sees an isolated image prompt.
    const reply=await chatWithTools(compatible,[userMessage],{
      tools, executeTool:() => call(compatible,'ocr')
    });
    assert.equal(reply,message); assert.equal(bodies.length,3);
    const [first,vision,last]=bodies.map(entry=>entry.body);
    assert.equal(first.model,vision.model); assert.equal(last.model,first.model);
    assert.ok(!JSON.stringify(vision).includes(userMessage.content),'private chat did not enter image analysis');
    const image=vision.messages[1].content[1].image_url;
    assert.deepEqual(image,{url:'data:image/png;base64,'+png,detail:'high'});
    const result=JSON.parse(last.messages.at(-1).content);
    assert.equal(result.result.vision.status,'ok');
    assert.deepEqual(result.result.vision.sources,[imageUrl]); assert.equal(result.result.vision.text,message);
    assert.ok(!JSON.stringify(last).includes(png) && !JSON.stringify(result).includes('imageInputs'));
    const summary=ledger.getUsageSummary(compatible,{taskId:'fixture-turn',requestId:'fixture-turn'});
    assert.equal(summary.today.by_purpose.browser_vision.total_tokens,15);
    assert.equal(summary.current_task.total_tokens,15); assert.equal(summary.current_request.calls,1);

    bodies=[];
    ledger.setBudget(official,{scope:'daily',tokens:20,usd:null,requestId:'fixture',originOrder:1,
      operationId:'fixture-limit',taskId:'fixture'});
    assert.equal((await call(official,'describe')).result.vision.status,'ok');
    assert.deepEqual(bodies.map(x=>new URL(x.url).pathname),['/v1/responses/input_tokens','/v1/responses']);
    assert.deepEqual(bodies[0].body.input,bodies[1].body.input);
    assert.deepEqual(bodies[1].body.input[1].content[1],
      {type:'input_image',image_url:'data:image/png;base64,'+png,detail:'auto'});
    assert.equal(bodies[1].body.max_output_tokens,10);
    await assert.rejects(call(official,'ocr'),{code:'usage_budget_exceeded'});
    assert.equal(bodies.filter(x=>x.url.endsWith('/responses')).length,1);
    bodies=[];
    await assert.rejects(chatWithTools(compatible,[userMessage],{tools,executeTool:()=>call(official,'ocr')}),
      {code:'usage_budget_exceeded'});
    assert.equal(bodies.length,2,'budget block terminates the outer loop without another model turn');
    bodies=[];
    assert.equal((await call(local,'ocr')).result.vision.status,'ok');
    assert.deepEqual(bodies[0].body.messages[1].images,[png]);
    assert.equal(bodies[0].body.model,local.ollama.model);
    global.fetch=async()=>json({choices:[{message:{role:'assistant',content:'data:image/png;base64,'+png},finish_reason:'stop'}]});
    assert.equal((await call(compatible,'ocr')).result.vision.status,'unavailable','a provider echo cannot copy original bytes into tool history');
    global.fetch=async()=>new Response('RAW_PRIVATE_PROVIDER_ERROR',{status:400});
    const unsupported=await call(compatible,'ocr');
    assert.equal(unsupported.result.vision.status,'unavailable');
    assert.equal(unsupported.result.text,page.result.text); assert.ok(!JSON.stringify(unsupported).includes('RAW_PRIVATE'));
    const stop=new AbortController();
    global.fetch=async(_url,{signal})=>new Promise((_resolve,reject)=>{
      signal.addEventListener('abort',()=>reject(new DOMException('stopped','AbortError')),{once:true});
      setImmediate(()=>stop.abort());
    });
    await assert.rejects(call(compatible,'describe',stop.signal),{name:'AbortError'});
    console.log('browser-vision: PASS (three wire formats, original-image OCR/description, same model/task/budget, challenge/invalid rejection, no binary in tool transcript, unsupported and cancelled)');
  } finally {
    global.fetch=originalFetch; ledger.closeUsageLedger();
    const target=fs.realpathSync.native(dir);
    assert.equal(path.dirname(target),temp); assert.match(path.basename(target),/^browser-vision-[a-zA-Z0-9]{6}$/);
    fs.rmSync(target,{recursive:true,maxRetries:5});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
