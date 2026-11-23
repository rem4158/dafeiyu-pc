// Speech/media integration with a local fake provider; never calls a paid model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
async function main() {
  const temp = path.resolve(__dirname, '../temp'); fs.mkdirSync(temp, { recursive: true });
  const dir = fs.mkdtempSync(path.join(temp, 'media-test-'));
  process.env.DAFEIYU_DATA_DIR = dir;
  const calls = [];
  const wave = Buffer.alloc(48); wave.write('RIFF'); wave.writeUInt32LE(40, 4); wave.write('WAVEfmt ', 8);
  const fake = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); calls.push(body);
    const input = body.messages?.[0]?.content;
    const data = Array.isArray(input) ? { choices: [{ message: { content: '识别到的测试内容' } }] }
      : { choices: [{ message: { audio: { data: wave.toString('base64') } } }] };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
  });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  try {
    const settings = require('./electron/brain/settings');
    const media = require('./media'); const stickers = require('./stickers');
    settings.saveSettings({ stickers: { enabled: true, sourceRoot: require('./fixtures/sticker-library').createStickerLibrary(dir) }, voice: { enabled: true, autoSpeak: true, ttsFormat: 'wav', ttsMode: 'preset' },
      tts: { provider: 'mimo', baseUrl: `http://127.0.0.1:${fake.address().port}/v1`, apiKey: 'fake-only-key' } });
    const saved = fs.readFileSync(path.join(dir, 'brain-settings.json'), 'utf8');
    const generated = await media.enrichMessages([{ text: '你好', delay: 0 }], settings.loadSettings(),
      { userText: '请用语音回复' });
    assert.equal(generated.length, 1); assert.equal(generated[0].parts.length, 2);
    assert.equal(generated[0].parts[0].text, '你好'); assert.equal(generated[0].parts[1].type, 'record');
    const id = generated[0].parts[1].attachment_id;
    assert.equal(media.attachment(id).data, wave.toString('base64'));
    const voiceRoute = await media.handle({ method: 'GET', path: '/media/' + id });
    assert.equal(voiceRoute.body.mime, 'audio/wav');
    const asr = await media.handle({ method: 'POST', path: '/voice/asr', body: { audio: wave.toString('base64'), mime: 'audio/wav' } });
    assert.equal(asr.body.text, '识别到的测试内容');
    assert.equal(calls.length, 2);
    assert.ok(calls[1].messages[0].content[0].input_audio.data.startsWith('data:audio/wav;base64,'));
    assert.equal(fs.readFileSync(path.join(dir, 'brain-settings.json'), 'utf8'), saved);
    const publicView = media.publicSettings(settings.loadSettings());
    assert.equal(publicView.tts.apiKey, '***');
    const normalized = media.normalizeSettings(settings.loadSettings(), { tts: { apiKey: '***', models: { asr: 'other-asr' } } });
    assert.equal(normalized.tts.apiKey, 'fake-only-key'); assert.equal(normalized.tts.models.asr, 'other-asr');
    assert.throws(() => media.normalizeSettings({}, { voice: { enabled: 'true' } }));
    await assert.rejects(() => media.handle({ method: 'POST', path: '/voice/asr', body: { audio: 'not-base64!', mime: 'audio/wav' } }));
    assert.throws(() => media.attachment('../brain-settings.json'));
    const library = stickers.summary(settings.loadSettings());
    assert.ok(library.packs.some(pack => pack.id === 'fixture'));
    assert.equal(library.count, 1); assert.equal(library.categories.length, 1);
    const map = stickers.getStickerMap(settings.loadSettings());
    const imageMessage = await media.enrichMessages([{ text: '', sticker: 'happy', stickerUrl: map.happy.url, delay: 0 }], settings.loadSettings());
    assert.equal(imageMessage[0].parts[0].type, 'image');
    const originalImage = stickers.resolveSticker(map.happy.url, settings.loadSettings());
    assert.equal(media.attachment(imageMessage[0].parts[0].attachment_id).data, fs.readFileSync(originalImage.file).toString('base64'));
    // GIF is delivered unchanged through the same local media store.
    const gif = Buffer.from('GIF89aFAKE'); const gifPart = media.store(gif, 'image/gif');
    assert.equal(media.attachment(gifPart.attachment_id).data, gif.toString('base64'));
    assert.equal(media.attachment(gifPart.attachment_id).mime, 'image/gif');
    settings.saveSettings({ voice: { enabled: false } });
    const textOnly = await media.enrichMessages([{ text: '只打字', delay: 0 }], settings.loadSettings());
    assert.equal(textOnly[0].parts.length, 1); assert.equal(calls.length, 2);
    console.log('media: PASS (local TTS/ASR fixture, combined text/audio, persisted image/GIF, fixture sticker pack, masked keys, validation)');
  } finally {
    fake.closeAllConnections(); await new Promise(resolve => fake.close(resolve));
    if (!dir.startsWith(temp + path.sep)) throw new Error('Unsafe temporary cleanup');
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
