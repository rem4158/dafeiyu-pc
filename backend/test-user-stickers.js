// User sticker -> exact local image history + text-only model semantics. Isolated providers/data.
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const http=require('node:http');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAANklEQVR4nGMM2PLsPwMNARMtDQeBUQsIgtEgIghGg4ggGA0igmA0iAiC0SAiCEaDiCCgeRABAFNfAxnx/9kmAAAAAElFTkSuQmCC','base64');
async function main(){
 const temp=path.resolve(__dirname,'../temp');fs.mkdirSync(temp,{recursive:true});
 const dir=fs.mkdtempSync(path.join(temp,'user-stickers-'));process.env.DAFEIYU_DATA_DIR=path.join(dir,'data');
 const library=path.join(dir,'memes');const pack=path.join(library,'packs','fixture');
 fs.mkdirSync(path.join(pack,'memes','happy'),{recursive:true});
 fs.writeFileSync(path.join(library,'selection_rules.json'),JSON.stringify({rules:[{scope:'default',pack_ids:['fixture']}]}));
 fs.writeFileSync(path.join(pack,'manifest.json'),JSON.stringify({name:'Test pack',categories:{happy:{description:'用于开心、鼓掌。不是用户的住址或姓名。'}}}));
 const original=path.join(pack,'memes','happy','0001_sticker_bf_001.png');
 fs.writeFileSync(original,PNG);fs.writeFileSync(path.join(pack,'memes','happy','开心鼓掌.png'),Buffer.concat([PNG,Buffer.from('other')]));
 const calls=[], extractionCalls=[];const fake=http.createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;const payload=JSON.parse(raw);
  const extraction=/你是(?:记忆|人物关系)提取助手/.test(payload.messages[0].content);
  (extraction ? extractionCalls : calls).push(payload);
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:extraction ? '[]' : '[{"text":"收到你的开心啦。","delay":0}]'}}]}));
 });
 await new Promise(r=>fake.listen(0,'127.0.0.1',r));let backend;
 try{
  const settings=require('./electron/brain/settings');settings.saveSettings({cloud:{baseUrl:`http://127.0.0.1:${fake.address().port}/v1`,apiKey:'fake',model:'fake-chat'},
   memory:{enabled:true,autoExtract:true},cognition:{enabled:false},proactive:{enabled:false},voice:{enabled:false},stickers:{enabled:true,sourceRoot:library}});
  const createBackend=require('./service').createBackend;backend=await createBackend();
  async function request(method,route,body,expected=200){const response=await fetch(backend.descriptor.url+route,{method,headers:{Authorization:'Bearer '+backend.descriptor.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));return result;}
  const sid=(await request('POST','/sessions',{},201)).session_id;
  const catalog=await request('GET','/stickers/catalog');assert.equal(catalog.stickers.length,2);assert.equal(catalog.categories[0].label,'开心');
  const sticker=catalog.stickers[0];assert.ok(sticker);assert.ok(catalog.stickers.every(s=>s.semantic_status==='unindexed'));
  assert.ok(!JSON.stringify(catalog).includes(library),'catalog does not expose local paths');
  const source=await request('GET','/stickers/'+sticker.id);assert.equal(source.mime,'image/png');assert.deepEqual(Buffer.from(source.data,'base64'),PNG);
  const bad='f'.repeat(64);
  assert.equal((await request('GET','/stickers/'+bad,undefined,404)).code,'sticker_not_found');
  assert.equal((await request('POST','/chat',{session_id:sid,request_id:'invalid',sticker_id:bad},404)).code,'sticker_not_found');
  await request('POST','/chat',{session_id:sid,request_id:'bad-text',sticker_id:sticker.id,text:12},400);
  await request('POST','/chat',{session_id:sid,request_id:'long-text',sticker_id:sticker.id,text:'字'.repeat(20001)},400);
  const payload={session_id:sid,request_id:'sticker-one',sticker_id:sticker.id};
  const answer=await request('POST','/chat',payload);assert.equal(answer.text,'收到你的开心啦。');assert.equal(calls.length,1);
  const call=calls[0];assert.ok(call.messages.every(m=>typeof m.content==='string'),'all model content is text');
  const content=call.messages.at(-1).content;assert.ok(content.includes('用户表情消息'));assert.ok(content.includes('具体文字和含义未知'));assert.ok(!content.includes('用于开心、鼓掌'));
  assert.ok(!JSON.stringify(call).includes(PNG.toString('base64')));assert.ok(!JSON.stringify(call).includes(original));
  const history=await request('GET','/sessions/'+sid);assert.equal(history.history.length,2);
  const parts=history.history[0].content.message;assert.equal(parts.length,1);assert.equal(parts[0].type,'image');
  assert.equal(parts[0].sticker_id,sticker.id);assert.equal(parts[0].name,sticker.name);assert.equal(parts[0].category,'happy');
  assert.deepEqual(Buffer.from((await request('GET','/media/'+parts[0].attachment_id)).data,'base64'),PNG);
  let db=require('./electron/brain/memory').initMemory();
  const jobsExist=db.prepare("SELECT name FROM sqlite_master WHERE name='memory_extraction_jobs'").get();
  if(jobsExist)assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_extraction_jobs').get().n,0,'sticker does not create memory extraction jobs');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM facts').get().n,0,'no metadata converted to user facts');
  assert.deepEqual(await request('POST','/chat',payload),answer);assert.equal(calls.length,1);
  const another=catalog.stickers.find(s=>s.id!==sticker.id);await request('POST','/chat',{...payload,sticker_id:another.id},409);
  await request('POST','/chat',{session_id:sid,request_id:'sticker-one',text:'别的输入'},409);
  const typed='我平时喜欢喝桂花乌龙茶。';
  const mixed={session_id:sid,request_id:'mixed-one',sticker_id:sticker.id,text:typed};
  const mixedAnswer=await request('POST','/chat',mixed);assert.equal(calls.length,2);
  const mixedInput=calls.at(-1).messages.at(-1).content;
  assert.ok(mixedInput.startsWith(typed+'\n\n【用户表情消息】'),'current model receives typed words and selected sticker semantics together');
  assert.ok(mixedInput.includes('具体文字和含义未知'));
  const mixedHistory=(await request('GET','/sessions/'+sid)).history;
  assert.equal(mixedHistory.length,4);const mixedParts=mixedHistory[2].content.message;
  assert.deepEqual(mixedParts.map(p=>p.type),['plain','image']);assert.equal(mixedParts[0].text,typed);
  assert.equal(mixedParts[1].sticker_id,sticker.id);assert.equal(mixedParts[1].semantic_text,content);
  assert.deepEqual(Buffer.from((await request('GET','/media/'+mixedParts[1].attachment_id)).data,'base64'),PNG);
  const mixedSource=db.prepare('SELECT source_message_id,user_text FROM pc_requests WHERE request_id=?').get(mixed.request_id);
  assert.equal(mixedSource.user_text,typed);assert.equal(db.prepare('SELECT content FROM messages WHERE id=?').get(mixedSource.source_message_id).content,typed);
  assert.ok(extractionCalls.length>=1);assert.ok(extractionCalls.every(call=>!JSON.stringify(call).includes('【用户表情消息】')),'extraction sees actual user text only');
  const facts=db.prepare('SELECT f.fact_value,m.content source_text FROM facts f JOIN messages m ON m.id=f.source_message_id').all();
  assert.ok(facts.some(f=>f.fact_value==='桂花乌龙茶' && f.source_text===typed),'typed preference is still extracted with its exact source');
  assert.ok(facts.every(f=>!f.fact_value.includes('用户表情消息') && f.source_text===typed),'sticker metadata creates no user facts');
  assert.deepEqual(await request('POST','/chat',mixed),mixedAnswer);assert.equal(calls.length,2);
  await request('POST','/chat',{...mixed,text:'另一句话'},409);
  await request('POST','/chat',{...mixed,sticker_id:another.id},409);
  await request('POST','/chat',{session_id:sid,request_id:mixed.request_id,text:typed},409);
  await backend.close();backend=await createBackend();db=require('./electron/brain/memory').initMemory();
  // Immutable snapshots and idempotent retries survive source removal and disabled packs.
  fs.unlinkSync(original);settings.saveSettings({stickers:{enabled:false}});
  assert.deepEqual(await request('POST','/chat',payload),answer);assert.equal(calls.length,2);
  assert.deepEqual(await request('POST','/chat',mixed),mixedAnswer);assert.equal(calls.length,2);
  assert.deepEqual(Buffer.from((await request('GET','/media/'+parts[0].attachment_id)).data,'base64'),PNG);
  assert.equal((await request('GET','/sessions/'+sid)).history.length,4);
  const disabled=await request('GET','/stickers/catalog');assert.equal(disabled.enabled,false);assert.equal(disabled.stickers.length,0);
  await request('POST','/chat',{...payload,request_id:'disabled'},409);
  // Existing text-only callers remain unchanged.
  settings.saveSettings({memory:{autoExtract:false}});
  await request('POST','/chat',{session_id:sid,request_id:'plain-one',text:'你好'});assert.equal(calls.length,3);
  const historyCall=calls.at(-1).messages;assert.ok(historyCall.some(m=>m.role==='user'&&m.content.includes('用户表情消息')),'subsequent turns recall sticker semantics as text');
  assert.ok(historyCall.some(m=>m.role==='user' && m.content===mixedInput),'mixed sticker semantics remain with the exact source turn after restart and source removal');
  assert.ok(require('./electron/brain/memory').getPromptHistory(sid,20).every(m=>!Object.hasOwn(m,'id')),'default prompt-history shape is unchanged');
  db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(Date.now()-25*60*60*1000,mixedSource.source_message_id);
  await request('POST','/chat',{session_id:sid,request_id:'plain-two',text:'继续聊'});assert.equal(calls.length,4);
  assert.ok(!calls.at(-1).messages.some(m=>m.role==='user' && m.content===mixedInput),'snapshot projection never restores a source excluded by recent-history filtering');
  console.log('user-stickers: PASS (pure/mixed text semantics, exact snapshot, grounded extraction, filtered history, replay/conflict, restart, disabled, text compatibility)');
 }finally{
  await backend?.close();fake.closeAllConnections();await new Promise(r=>fake.close(r));
  if(!path.resolve(dir).startsWith(temp+path.sep))throw new Error('Unsafe fixture cleanup');fs.rmSync(dir,{recursive:true,force:true});
 }
}
main().catch(error=>{console.error(error);process.exitCode=1});
