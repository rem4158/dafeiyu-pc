// Curated image coverage + real HTTP text-only semantics. No real models or user DB.
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const http=require('node:http');
async function main(){
 const tempRoot=path.resolve(__dirname,'../temp');fs.mkdirSync(tempRoot,{recursive:true});const dir=fs.mkdtempSync(path.join(tempRoot,'sticker-semantics-'));process.env.DAFEIYU_DATA_DIR=path.join(dir,'data');
 const stickers=require('./stickers');const semantics=require('./sticker-semantics');const entries=semantics.readIndex();
 const installed=stickers.inventory();
 if (!installed.packs.some(pack => pack.id === 'deepseek-fanart-meme-pack')) {
  try {
   const sourceRoot = require('./fixtures/sticker-library').createStickerLibrary(dir);
   const [image] = stickers.inventory({stickers:{enabled:true,sourceRoot}}).images;
   const key = image.pack_id + '/' + image.relative_path;
   const index = { [key]: { sha256:image.content_sha256, name:'测试图', text:'你好',
    meaning:'打招呼', confidence:'high' } };
   const reviewed = semantics.annotate(image,index);
   assert.equal(reviewed.semantic.text,'你好');
   assert.ok(semantics.semanticText(reviewed).includes('打招呼'));
   fs.appendFileSync(image.file,'changed');
   const changed = semantics.annotate(image,index);
   assert.equal(changed.semantic,null);
   assert.ok(semantics.semanticText(changed).includes('具体文字和含义未知'));
   assert.equal(Object.keys(entries).length,174);
   console.log('sticker-semantics: PASS (fixture image, exact hash, change invalidation and optional pack index)');
  } finally {
   assert.equal(path.dirname(fs.realpathSync(dir)),fs.realpathSync(tempRoot));
   fs.rmSync(dir,{recursive:true,force:true});
  }
  return;
 }
 assert.equal(installed.images.length,174);
 assert.equal(Object.keys(entries).length,174,'every installed image is reviewed once');
 for(const image of installed.images){
  assert.ok(image.semantic, image.relative_path+' lacks matching review');
  assert.ok(['high','medium','low'].includes(image.semantic.confidence));
  assert.equal(entries[image.pack_id+'/'+image.relative_path].sha256,image.content_sha256);
 }
 const fish=installed.images.find(i=>i.file.endsWith('0003_sticker_bf_004.webp'));
 const work=installed.images.find(i=>i.file.endsWith('0053_sticker_bf_078.png'));
 assert.equal(fish.category,'affection');assert.ok(fish.semantic.text.includes('杂鱼'));
 assert.equal(work.category,'angry');assert.ok(work.semantic.text.includes('下班'));
 const library=path.join(dir,'library');fs.mkdirSync(library,{recursive:true});
 fs.writeFileSync(path.join(library,'selection_rules.json'),JSON.stringify({rules:[{scope:'default',pack_ids:[fish.pack_id]}]}));
 const pack=path.join(library,'packs',fish.pack_id);fs.mkdirSync(pack,{recursive:true});
 fs.writeFileSync(path.join(pack,'manifest.json'),JSON.stringify({name:'Isolated semantic review',categories:{affection:{description:'旧分类亲近贴贴'},angry:{description:'旧分类生气责备'}}}));
 for(const image of [fish,work]){const dest=path.join(pack,image.relative_path);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(image.file,dest);}
 const calls=[];const fake=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;calls.push(JSON.parse(raw));res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'[{"text":"收到这张表情。","delay":0}]'}}]}));});
 await new Promise(r=>fake.listen(0,'127.0.0.1',r));let backend;
 try{
  require('./electron/brain/settings').saveSettings({cloud:{baseUrl:`http://127.0.0.1:${fake.address().port}/v1`,apiKey:'fake',model:'fake'},memory:{autoExtract:true},voice:{enabled:false},cognition:{enabled:false},proactive:{enabled:false},stickers:{enabled:true,sourceRoot:library}});
  backend=await require('./service').createBackend();
  async function api(method,route,body){const response=await fetch(backend.descriptor.url+route,{method,headers:{Authorization:'Bearer '+backend.descriptor.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;}
  const sid=(await api('POST','/sessions',{})).session_id;
  const catalog=await api('GET','/stickers/catalog');assert.equal(catalog.stickers.length,2);
  for(const [index,word] of ['杂鱼','下班'].entries()){
   const selected=catalog.stickers.find(i=>i.semantic.text.includes(word));assert.ok(selected);
   await api('POST','/chat',{session_id:sid,request_id:'review-'+index,sticker_id:selected.id});
   const call=calls.at(-1);assert.ok(call.messages.every(m=>typeof m.content==='string'));
   const text=call.messages.at(-1).content;assert.ok(text.includes(word));assert.ok(text.includes(selected.semantic.meaning));
   assert.ok(!text.includes('旧分类'));assert.ok(!text.includes('分类用途：'));
   assert.ok(!JSON.stringify(call).includes('data:image'));assert.ok(!JSON.stringify(call).includes(pack));
  }
  const history=await api('GET','/sessions/'+sid);const user=history.history.filter(m=>m.content.type==='user');assert.equal(user.length,2);
  assert.ok(user[0].content.message[0].semantic.text.includes('杂鱼'));assert.ok(user[1].content.message[0].semantic.text.includes('下班'));
  const snapshot=await api('GET','/media/'+user[1].content.message[0].attachment_id);
  const original=path.join(pack,work.relative_path);fs.appendFileSync(original,Buffer.from('changed'));
  const stale=stickers.resolveSticker(user[1].content.message[0].sticker_id,{stickers:{enabled:true,sourceRoot:library}});
  assert.equal(stale.semantic_status,'stale');assert.equal(stale.semantic,null);
  const fallback=stickers.semanticText(stale);assert.ok(fallback.includes('具体文字和含义未知'));assert.ok(!fallback.includes('下班'));
  await api('POST','/chat',{session_id:sid,request_id:'changed',sticker_id:stale.id});
  assert.ok(calls.at(-1).messages.at(-1).content.includes('具体文字和含义未知'));
  assert.deepEqual(await api('GET','/media/'+user[1].content.message[0].attachment_id),snapshot,'past image snapshot remains unchanged');
  const memory=require('./electron/brain/memory').initMemory();assert.equal(memory.prepare('SELECT COUNT(*) n FROM facts').get().n,0);
  console.log('sticker-semantics: PASS (174 content-matched reviews, exact text/meaning for both reported cases, text-only HTTP, immutable semantic/image history, changed-image neutral fallback)');
 }finally{await backend?.close();fake.closeAllConnections();await new Promise(r=>fake.close(r));assert.ok(dir.startsWith(tempRoot+path.sep));fs.rmSync(dir,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1});
