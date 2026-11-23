// Isolated media-policy checks with an in-memory synthesizer. No model, device or network access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const tempRoot = path.resolve(__dirname, '../temp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(tempRoot, 'voice-policy-'));
  const previousData = process.env.DAFEIYU_DATA_DIR;
  const originalFetch = globalThis.fetch;
  process.env.DAFEIYU_DATA_DIR = directory;
  globalThis.fetch = () => { throw new Error('Unexpected network request in voice-policy test'); };
  const previousModules = new Map();
  function stub(relative, exports) {
    const filename = require.resolve(relative);
    previousModules.set(filename, require.cache[filename]);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
  }
  let settingsReads = 0;
  const synthCalls = [];
  const audio = Buffer.from('isolated-fake-audio').toString('base64');
  const speech = () => ({ audioBase64: audio, format: 'mp3' });
  let synthesize = async () => speech();
  const legacyConfig = { voice: { enabled: true, autoSpeak: true } };
  stub('./electron/brain/settings', { loadSettings() { settingsReads++; return legacyConfig; } });
  stub('./electron/voice/mimo-api', { invalidateMimoCache() {} });
  stub('./electron/voice/tts-synth', { async synthesizeSpeech(options) {
    synthCalls.push(options);
    return synthesize(options);
  } });
  const media = require('./media');
  const recent = (count, hasVoice = false) => Array.from({ length: count }, () => ({ hasVoice }));
  const simple = [{ text: '今天天气很好。', delay: 0 }];
  const records = result => result.flatMap(item => item.parts.filter(part => part.type === 'record'));
  async function noSpeech(messages, config, options = {}) {
    const count = synthCalls.length;
    const reads = settingsReads;
    const result = await media.enrichMessages(messages, config, options);
    assert.equal(synthCalls.length, count, 'a text-only turn must never invoke TTS');
    assert.equal(settingsReads, reads, 'a text-only turn must not enter the synthesis path');
    assert.equal(records(result).length, 0);
    return result;
  }
  try {
    assert.equal(media.mergeSettings({ voice: { enabled: true, autoSpeak: true } }).voice.autoSpeak, true,
      'old saved configuration is still understood without a migration');
    for (let completed = 0; completed < 4; completed++) {
      const result = await noSpeech(simple, legacyConfig, { recentReplyTurns: recent(completed) });
      assert.equal(result[0].parts[0].text, simple[0].text);
    }
    await noSpeech(simple, legacyConfig, { recentReplyTurns: [{ hasVoice: true }, ...recent(3)] });
    await noSpeech(simple, legacyConfig, { recentReplyTurns: [...recent(2), { hasVoice: true }, ...recent(1)] });
    await noSpeech(simple, legacyConfig, { recentReplyTurns: [{}, ...recent(3)] });
    await noSpeech(simple, { voice: { enabled: true, autoSpeak: false } }, { recentReplyTurns: recent(4) });

    const mixed = [
      { text: '这一段稍微长一些，说明一下今天发生的事情。', delay: 0 },
      { text: '  好呀。  ', delay: 1500 },
      { text: '我会一直陪着你聊天。', delay: 1500 },
    ];
    let count = synthCalls.length;
    const result = await media.enrichMessages(mixed, legacyConfig,
      { recentReplyTurns: [...recent(4), { hasVoice: true }], emotion: '开心' });
    assert.equal(synthCalls.length, count + 1, 'a multi-segment reply produces at most one audio attachment');
    assert.equal(synthCalls.at(-1).text, mixed[1].text, 'prefer the shortest suitable segment');
    assert.equal(synthCalls.at(-1).emotion, '开心');
    assert.equal(records(result).length, 1);
    assert.equal(records(result)[0].transcript, mixed[1].text, 'transcript preserves the actual original text');
    assert.equal(result[1].parts[0].type, 'plain');
    assert.equal(result[1].parts[0].text, mixed[1].text, 'canonical plain text remains available to history and memory');
    assert.ok(!Object.hasOwn(records(result)[0], 'duration'), 'do not invent an audio duration');
    assert.equal(media.attachment(records(result)[0].attachment_id).data, audio);
    assert.deepEqual(mixed[1], { text: '  好呀。  ', delay: 1500 }, 'source messages are not mutated');

    const unreadable = [
      { text: '长'.repeat(121) },
      { text: '打开 https://example.com 看看。' },
      { text: '网页在 www.example.com' },
      { text: '代码是 `const n = 1`。' },
      { text: '```js\nconst n = 1;\n```' },
      { text: '- 第一项\n- 第二项' },
      { text: '1. 第一项\n2. 第二项' },
      { text: '一、第一项' },
      { text: '|名称|数量|\n|茶|1|' },
      { text: '[链接](https://example.com)' },
      { text: '😊' },
    ];
    await noSpeech(unreadable, legacyConfig, { recentReplyTurns: recent(4) });

    const onDemand = { voice: { enabled: true, autoSpeak: false } };
    for (const userText of ['发一条语音', '来段语音吧', '让我听听你的声音', '听一条语音',
      '用语音回复我', '语音回复我吧', '不要文字，发个语音']) {
      assert.equal(media.resolveVoiceRequest(userText), 'voice', userText);
      count = synthCalls.length;
      assert.equal(records(await media.enrichMessages(mixed, onDemand,
        { userText, recentReplyTurns: [{ hasVoice: true }] })).length, 1, userText);
      assert.equal(synthCalls.length, count + 1);
    }
    count = synthCalls.length;
    assert.equal(records(await media.enrichMessages(simple, onDemand, { forceVoice: true })).length, 1,
      'legacy callers can still explicitly request speech');
    assert.equal(synthCalls.length, count + 1);
    const longText = [{ text: '这是一段明确要求朗读的较长文字。'.repeat(12) }];
    assert.equal(records(await media.enrichMessages(longText, onDemand, { userText: '发一条语音' })).length, 1,
      'an explicit request can use a longer speakable segment when no short segment exists');

    for (const userText of ['不要发语音', '先别用语音', '不想听你声音', '别发任何语音', '不要念出来',
      '不要一直发语音', '请不要总是用语音回复', '不要动不动就发语音', '关闭语音', '停止语音',
      '先关掉语音', '取消语音', '语音先别发了', '语音回复这次不要发了',
      '用文字', '文字回复就好', '只打字', '发文本就好', '我不方便听', '来一条语音，但这次只用文字回复']) {
      assert.equal(media.resolveVoiceRequest(userText), 'text', userText);
      await noSpeech(simple, legacyConfig, { userText, forceVoice: true, recentReplyTurns: recent(4) });
    }
    for (const userText of ['语音识别是什么？', '声音传播需要介质吗？', '用语音识别可以实现什么？',
      '语音回复功能怎么配置？', '声音合成模型如何训练？', '不是不要语音', '我不是说不要语音',
      '并非不想听语音', '不是不让你发语音', '我没说不要语音']) {
      assert.equal(media.resolveVoiceRequest(userText), null, userText);
      await noSpeech(simple, onDemand, { userText, recentReplyTurns: recent(4) });
    }
    assert.equal(media.resolveVoiceRequest('不是不要语音，请发一条语音'), 'voice',
      'a separate affirmative request still works after a double-negative clarification');
    assert.equal(media.resolveVoiceRequest('不是不要语音，这次还是只用文字'), 'text');
    await noSpeech(simple, { voice: { enabled: false, autoSpeak: true } },
      { userText: '发一条语音', forceVoice: true, recentReplyTurns: recent(4) });

    synthesize = async () => { throw new Error('private fake provider failure'); };
    count = synthCalls.length;
    const failed = await media.enrichMessages(mixed, onDemand, { userText: '发一条语音' });
    assert.equal(synthCalls.length, count + 1, 'failed synthesis is not retried on another segment');
    assert.equal(records(failed).length, 0);
    assert.equal(failed[1].media_error, 'tts_failed');
    assert.equal(failed[1].parts[0].text, mixed[1].text);
    assert.ok(!JSON.stringify(failed).includes('private fake provider failure'));

    const alreadyStopped = new AbortController();
    alreadyStopped.abort();
    count = synthCalls.length;
    await assert.rejects(() => media.enrichMessages(simple, onDemand,
      { forceVoice: true, signal: alreadyStopped.signal }), error => error.name === 'AbortError');
    assert.equal(synthCalls.length, count);

    synthesize = ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
    });
    const stopped = new AbortController();
    const pending = media.enrichMessages(simple, onDemand, { forceVoice: true, signal: stopped.signal });
    stopped.abort();
    await assert.rejects(() => pending, error => error.name === 'AbortError', 'cancellation must reach service instead of committing fallback');

    const stoppedAfterSynth = new AbortController();
    const beforeFiles = fs.readdirSync(path.join(directory, 'media')).sort();
    synthesize = async () => {
      stoppedAfterSynth.abort();
      return { audioBase64: Buffer.from('must-not-be-stored-after-cancel').toString('base64'), format: 'mp3' };
    };
    await assert.rejects(() => media.enrichMessages(simple, onDemand,
      { forceVoice: true, signal: stoppedAfterSynth.signal }), error => error.name === 'AbortError');
    assert.deepEqual(fs.readdirSync(path.join(directory, 'media')).sort(), beforeFiles);

    synthesize = async () => { throw new DOMException('cancelled inside synthesizer', 'AbortError'); };
    await assert.rejects(() => media.enrichMessages(simple, onDemand, { forceVoice: true }), error => error.name === 'AbortError');
    console.log('voice-policy: PASS (text-first legacy settings, four-turn spacing, explicit intent, one voice, local transcript, failure and cancellation)');
  } finally {
    globalThis.fetch = originalFetch;
    for (const [filename, previous] of previousModules) {
      if (previous) require.cache[filename] = previous;
      else delete require.cache[filename];
    }
    if (previousData === undefined) delete process.env.DAFEIYU_DATA_DIR;
    else process.env.DAFEIYU_DATA_DIR = previousData;
    if (!directory.startsWith(tempRoot + path.sep)) throw new Error('Unsafe temporary cleanup');
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
