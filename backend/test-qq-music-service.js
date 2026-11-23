'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const temp = fs.realpathSync.native(path.join(__dirname, '../temp'));
  const dir = fs.mkdtempSync(path.join(temp, 'qq-music-service-'));
  const originalFetch = global.fetch;
  const priorData = process.env.DAFEIYU_DATA_DIR;
  process.env.DAFEIYU_DATA_DIR = dir;
  const instruction = '要不你帮我打开QQ音乐，我听一会';
  const results = [];
  const calls = [];
  let backend, fixtureError;

  global.fetch = async (url, options) => {
    try {
      assert.equal(String(url), 'https://fixture.invalid/v1/chat/completions');
      const body = JSON.parse(options.body);
      assert.ok(body.tools.some(tool => tool.function.name === 'qq_music'));
      const userIndex = body.messages.findLastIndex(message => message.role === 'user');
      const input = body.messages[userIndex].content;
      const toolResults = body.messages.slice(userIndex + 1).filter(message => message.role === 'tool');
      let message;
      if (toolResults.length || input === 'QQ 音乐是哪个公司的？') {
        const outputs = toolResults.map(item => JSON.parse(item.content));
        results.push(outputs);
        message = { role:'assistant', content:JSON.stringify([{text:outputs[0]?.result?.message || '收到', delay:0}]) };
      } else {
        const tool = (id, action, evidence) => ({ id, type:'function',
          function:{ name:'qq_music', arguments:JSON.stringify({action,evidence}) } });
        message = { role:'assistant', content:null, tool_calls:input === instruction
          ? [tool('play','play',input), tool('duplicate','open',input)] : [tool('bad-evidence','open',instruction)] };
      }
      return Response.json({choices:[{message, finish_reason:message.tool_calls ? 'tool_calls' : 'stop'}]});
    } catch (error) { fixtureError ??= error; throw error; }
  };

  try {
    require('./electron/brain/settings').saveSettings({ provider:'cloud', cloud:{ baseUrl:'https://fixture.invalid/v1',
      apiKey:'fixture', model:'fixture-qq-music' }, memory:{ enabled:false }, cognition:{ enabled:false },
    proactive:{ enabled:false }, voice:{ enabled:false }, browser:{ enabled:false } });
    backend = await require('./service').createBackend({qqMusicOptions:{ async runWorker(executable, args, options) {
      calls.push({executable,args,options});
      return {stdout:JSON.stringify({status:'playback_unconfirmed'})};
    }}});
    async function api(route, body, expected = 200) {
      const response = await originalFetch(backend.descriptor.url + route, { method:'POST',
        headers:{ Authorization:'Bearer ' + backend.descriptor.token, 'Content-Type':'application/json' },
        body:JSON.stringify(body), signal:AbortSignal.timeout(10000) });
      const result = await response.json();
      assert.equal(response.status, expected, JSON.stringify(result));
      return result;
    }
    const { session_id } = await api('/sessions', {}, 201);
    const chat = (request_id, text) => api('/chat', {session_id, request_id, text});
    await chat('music-discussion', 'QQ 音乐是哪个公司的？');
    assert.equal(calls.length, 0);
    await chat('music-stale', '你今天都做了什么？');
    assert.equal(results.at(-1)[0].error.code, 'qq_music_evidence');
    assert.equal(calls.length, 0);
    const reply = await chat('music-open', instruction);
    assert.equal(calls.length, 1);
    assert.equal(path.basename(calls[0].executable), 'python.exe');
    assert.equal(path.basename(calls[0].args[1]), 'qq_music_action.py');
    assert.equal(calls[0].args[2], path.join(dir, 'pet-appdata', 'dsh-pet-standalone', 'config.json'));
    assert.equal(calls[0].args[3], 'play');
    assert.equal(calls[0].options.shell, undefined);
    assert.equal(results.at(-1)[0].result.status, 'playback_unconfirmed');
    assert.equal(results.at(-1)[1].error.code, 'qq_music_already_attempted');
    assert.match(reply.text, /暂未确认开始播放/);
    await chat('music-open', instruction);
    assert.equal(calls.length, 1, 'replaying a completed chat must not reopen the player');
    assert.ok(!require('./chat-tools').chatTools({channel:'qq'}).some(tool => tool.function.name === 'qq_music'));
    console.log('qq-music-service: PASS (native tool, current message, one attempt, replay, isolated worker, honest receipt)');
  } catch (error) { throw fixtureError ?? error; }
  finally {
    await backend?.close();
    global.fetch = originalFetch;
    if (priorData === undefined) delete process.env.DAFEIYU_DATA_DIR;
    else process.env.DAFEIYU_DATA_DIR = priorData;
    const target = fs.realpathSync.native(dir);
    assert.equal(path.dirname(target), temp);
    assert.match(path.basename(target), /^qq-music-service-[\w]{6}$/);
    fs.rmSync(target, { recursive:true, maxRetries:4, retryDelay:100 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
