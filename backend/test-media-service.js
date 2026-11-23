// Actual HTTP -> chat parser -> Nianan TTS -> persisted mixed media, isolated data only.
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const http=require('node:http');
const {DatabaseSync}=require('node:sqlite');
async function main(){
 const temp=path.resolve(__dirname,'../temp');fs.mkdirSync(temp,{recursive:true});const dir=fs.mkdtempSync(path.join(temp,'media-service-'));process.env.DAFEIYU_DATA_DIR=dir;
 let calls=0,ttsCalls=0;const wav=Buffer.alloc(48);wav.write('RIFF');wav.write('WAVE',8);
 const audio = wav.toString('base64');
 const audioInputs = [];
 const observed = [];
 const networkFetch = globalThis.fetch;
 const fake=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));calls++;
  const audioInput=Array.isArray(body.messages?.[0]?.content);
  if(audioInput) audioInputs.push({ route: req.url, model: body.model, key: req.headers.authorization });
  if (req.url === '/speech/v1/audio/speech') {
    observed.push({ input: body, key: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.end(wav);
    return;
  }
  if(body.audio)ttsCalls++;
  const result=audioInput?{choices:[{message:{content:'语音输入内容'}}]}:body.audio?{choices:[{message:{audio:{data:wav.toString('base64')}}}]}:{choices:[{message:{content:'[{"text":"你好，主人。","delay":0},{"sticker":"happy","delay":0}]'}}]};
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));});
 await new Promise(r=>fake.listen(0,'127.0.0.1',r));let backend;
 try{
  const settings=require('./electron/brain/settings');settings.saveSettings({stickers:{enabled:true,sourceRoot:require('./fixtures/sticker-library').createStickerLibrary(dir)},cloud:{baseUrl:`http://127.0.0.1:${fake.address().port}/v1`,apiKey:'fake',model:'fake-model'},
   voice:{enabled:true,autoSpeak:true,ttsMode:'preset',ttsFormat:'wav'},tts:{baseUrl:`http://127.0.0.1:${fake.address().port}/v1`,apiKey:'fake'},memory:{autoExtract:false},cognition:{enabled:false},proactive:{enabled:false}});
  backend=await require('./service').createBackend();
  async function api(method,route,body,expected=200){const r=await networkFetch(backend.descriptor.url+route,{method,headers:{Authorization:'Bearer '+backend.descriptor.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await r.json();assert.equal(r.status,expected,JSON.stringify(value));return value;}
  const id=(await api('POST','/sessions',{},201)).session_id;
  const payload={session_id:id,request_id:'media-one',text:'你好，发个开心表情，再发条语音'};
  const result=await api('POST','/chat',payload);
  assert.equal(result.messages.length,2);assert.equal(result.messages[0].parts.length,2);assert.equal(result.messages[0].parts[0].type,'plain');assert.equal(result.messages[0].parts[1].type,'record');assert.equal(result.messages[1].parts[0].type,'image');
  const voiceId=result.messages[0].parts[1].attachment_id;assert.equal((await api('GET','/media/'+voiceId)).data,wav.toString('base64'));
  assert.equal(result.messages[0].parts[1].transcript,result.messages[0].text);
  const history=await api('GET','/sessions/'+id);assert.equal(history.history.length,3);assert.deepEqual(history.history[1].content.message,result.messages[0].parts);assert.deepEqual(history.history[2].content.message,result.messages[1].parts);
  const before=calls;assert.deepEqual(await api('POST','/chat',payload),result);assert.equal(calls,before);
  const source=require('./stickers').summary(settings.loadSettings());assert.equal(source.count,1);
  // A 400 KB WAV exercises the ASR route's larger body limit without external traffic.
  const input=Buffer.alloc(400000);input.write('RIFF');input.write('WAVE',8);
  const transcript=await api('POST','/voice/asr',{audio:input.toString('base64'),mime:'audio/wav'});assert.equal(transcript.text,'语音输入内容');
  assert.equal((await api('GET','/sessions/'+id)).history.length,3,'ASR never writes chat itself');
  const recordCount=reply=>reply.messages.flatMap(message=>message.parts).filter(part=>part.type==='record').length;
  const afterExplicit=ttsCalls;
  // Independent PC tool deliveries are complete requests, not extra user turns.
  // Four such text deliveries must not push the explicit voice out of the cadence window.
  const toolStore=new DatabaseSync(path.join(dir,'companion-memory.db'));
  try{
   const insertTool=toolStore.prepare(`INSERT INTO pc_requests
    (request_id,session_id,user_text,state,result_json,created_at,updated_at) VALUES (?,?,'','complete',?,?,?)`);
   for(let index=0;index<4;index++){
    const requestId='pc-tool-cadence-'+index,text='PC独立留言'+index,now=Date.now();
    const toolResult={request_id:requestId,origin_request_id:payload.request_id,source:'pc_tool',text,
     messages:[{text,delay:0,parts:[{type:'plain',text}]}]};
    insertTool.run(requestId,id,JSON.stringify(toolResult),now,now);
   }
  }finally{toolStore.close();}
  for(let turn=0;turn<4;turn++){
   if(turn===2){await backend.close();backend=await require('./service').createBackend();}
   const textReply=await api('POST','/chat',{session_id:id,request_id:'text-'+turn,text:'今天怎么样'});
   assert.equal(recordCount(textReply),0,'four user text turns must separate automatic voice replies; PC tool deliveries cannot consume the interval');
   assert.equal(ttsCalls,afterExplicit,'text-only rounds never call TTS, including across restarts');
  }
  const mixedPayload={session_id:id,request_id:'mixed-voice',text:'继续聊聊吧'};
  const mixed=await api('POST','/chat',mixedPayload);assert.equal(recordCount(mixed),1);
  assert.equal(ttsCalls,afterExplicit+1);
  assert.deepEqual(await api('POST','/chat',mixedPayload),mixed);assert.equal(ttsCalls,afterExplicit+1,'replay never re-synthesizes audio');
  assert.equal(recordCount(await api('POST','/chat',{session_id:id,request_id:'text-after-voice',text:'好的'})),0);
  const local = `http://127.0.0.1:${fake.address().port}`;
  const mimoUrl = 'https://api.xiaomimimo.com/v1/chat/completions';
  const qwenUrl = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
  const qwenAudio = 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/test.wav?Signature=synthetic';
  globalThis.fetch = async (url, opts) => {
    if (new URL(url).origin === local) return networkFetch(url, opts);
    if (url === qwenAudio) {
      assert.equal(opts.headers, undefined);
      return new Response(wav);
    }
    assert.ok([mimoUrl, qwenUrl].includes(url), 'no external network in this test');
    const key = opts.headers.Authorization;
    const input = JSON.parse(opts.body);
    observed.push({ url, input, key });
    if (key === 'Bearer rejected') return Response.json({ error: 'private upstream body' }, { status: 401 });
    if (key === 'Bearer missing-audio') return Response.json({ choices: [{ message: { audio: { data: 'bm90LWF1ZGlv' } } }] });
    if (url === mimoUrl) return Response.json({ choices: [{ message: { audio: { data: audio } } }] });
    return Response.json({ output: { audio: { url: qwenAudio.replace('https:', 'http:') } } });
  };
  const file = path.join(dir, 'brain-settings.json');
  const oldSettings = fs.readFileSync(file, 'utf8');
  const previousInput = audioInputs.at(-1);
  const readHistory = () => api('GET', '/sessions/' + id);
  const previousHistory = await readHistory();
  const previousFiles = fs.readdirSync(path.join(dir, 'media'));
  const preview = (body, status = 200) => api('POST', '/voice/tts/preview', body, status);
  const activate = (ticket, status = 200) => api('POST', '/voice/tts/activate', { ticket }, status);
  const mimo = await preview({ provider: 'mimo', apiKey: 'mimo-fake' });
  assert.equal(mimo.audio, audio);
  assert.equal(observed.at(-1).input.audio.voice, '冰糖');
  assert.equal(observed.at(-1).input.model, 'mimo-v2.5-tts');
  assert.equal(observed.at(-1).input.messages.at(-1).content, '你好，我是大肥鱼。今天也一起摸个鱼吧！');
  assert.equal(fs.readFileSync(file, 'utf8'), oldSettings);
  assert.deepEqual(await readHistory(), previousHistory);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'media')), previousFiles);
  assert.equal((await activate('wrong-ticket', 409)).code, 'tts_preview_expired');
  assert.equal((await activate(mimo.ticket)).speechOutput.apiKey, '***');
  const active = fs.readFileSync(file, 'utf8');
  assert.equal((await preview({ provider: 'mimo', apiKey: 'missing-audio' }, 502)).code, 'tts_preview_audio');
  assert.equal((await preview({ provider: 'qwen' }, 400)).code, 'tts_preview_settings');
  assert.equal((await preview({ provider: 'qwen', apiKey: 'rejected' }, 502)).code, 'tts_preview_auth');
  assert.equal(fs.readFileSync(file, 'utf8'), active);
  assert.equal((await activate(mimo.ticket, 409)).code, 'tts_preview_expired');
  const qwen = await preview({ provider: 'qwen', apiKey: 'qwen-fake' });
  assert.equal(qwen.audio, audio);
  assert.equal(observed.at(-1).input.model, 'qwen3-tts-flash');
  assert.equal(observed.at(-1).input.input.voice, 'Cherry');
  await activate(qwen.ticket);
  await api('POST', '/voice/asr', { audio, mime: 'audio/wav' });
  assert.deepEqual(audioInputs.at(-1), previousInput, 'ASR still uses the old TTS fallback, independent of the new output');
  const custom = { provider: 'custom', protocol: 'speech', baseUrl: local + '/speech/v1',
    model: 'test-speech', voice: 'custom-voice', format: 'wav', apiKey: 'custom-fake' };
  await activate((await preview(custom)).ticket);
  const output = await api('POST', '/voice/tts', { text: '确认后的语音。' });
  assert.equal(output.mime, 'audio/wav');
  assert.equal(observed.at(-1).input.input, '确认后的语音。');
  assert.equal(observed.at(-1).key, 'Bearer custom-fake');
  const { apiKey, ...withoutKey } = custom;
  await preview({ ...withoutKey, baseUrl: local + '/other/v1' }, 400);
  const chatOutput = { ...custom, protocol: 'chat', baseUrl: local + '/v1' };
  await activate((await preview(chatOutput)).ticket);
  await api('PUT', '/settings', { voice: { enabled: false } });
  const spoken = await api('POST', '/chat', { session_id: id, request_id: 'independent-tts', text: '请发一条语音。' });
  assert.equal(recordCount(spoken), 1, 'new TTS works with the existing recording switch off');
  await api('PUT', '/settings', { voice: { enabled: true }, speechOutputEnabled: false });
  assert.equal((await api('POST', '/voice/tts', { text: '这句不会合成' }, 409)).code, 'voice_disabled');
  assert.equal((await api('POST', '/voice/asr', { audio, mime: 'audio/wav' })).text, '语音输入内容');
  assert.deepEqual(audioInputs.at(-1), previousInput);
  const after = settings.loadSettings();
  const beforeTts = JSON.parse(oldSettings);
  assert.deepEqual(after.tts, beforeTts.tts);
  assert.deepEqual(after.asr, beforeTts.asr);
  console.log('media-service: PASS (voice cadence and history, MiMo/Qwen/custom preview and activation, ASR credentials and model preserved, fake upstream only)');
 }finally{globalThis.fetch=networkFetch;if(backend)await backend.close();fake.closeAllConnections();await new Promise(r=>fake.close(r));if(!dir.startsWith(temp+path.sep))throw new Error('Unsafe cleanup');fs.rmSync(dir,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1});
