// Media delivery around migrated Nianan speech providers and local sticker packs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { userFilePath } = require('./electron/user-data');
const stickers = require('./stickers');
const { PRESETS, resolveOutputDraft } = require('./electron/voice/speech-output');
const MAX_BYTES = 20 * 1024 * 1024;
const DEFAULTS = {
  voice: { enabled: false, autoSpeak: true, autoSend: false, asrLanguage: 'zh', ttsMode: 'preset',
    ttsFormat: 'mp3', presetVoice: '冰糖', voiceDesignPrompt: '', speakStyleHint: '', referenceAudio: '' },
  tts: { provider: 'mimo', baseUrl: '', apiKey: '', models: { preset: '', design: '', clone: '', asr: '' } },
  asr: { baseUrl: '', apiKey: '' },
  stickers: { enabled: true, sourceRoot: stickers.DEFAULT_ROOT },
};
function mergeSettings(s = {}) {
  return { voice: { ...DEFAULTS.voice, ...s.voice }, tts: { ...DEFAULTS.tts, ...s.tts,
    models: { ...DEFAULTS.tts.models, ...s.tts?.models } }, asr: { ...DEFAULTS.asr, ...s.asr },
    stickers: { ...DEFAULTS.stickers, ...s.stickers } };
}
function validateUrl(value) {
  if (!value) return '';
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('语音地址必须使用 HTTPS 或本机 HTTP');
  return value.trim().replace(/\/+$/, '');
}
function normalizeSettings(current = {}, partial = {}, { verifiedSpeechOutput } = {}) {
  const currentMedia = mergeSettings(current), out = {};
  if (verifiedSpeechOutput) out.speechOutput = verifiedSpeechOutput;
  if (Object.hasOwn(partial, 'speechOutputEnabled')) {
    if (typeof partial.speechOutputEnabled !== 'boolean' || !current.speechOutput)
      throw new Error('请先试听并启用语音回复');
    out.speechOutput = { ...current.speechOutput, enabled: partial.speechOutputEnabled };
  }
  for (const key of Object.keys(DEFAULTS)) {
    if (partial[key] === undefined) continue;
    if (!partial[key] || typeof partial[key] !== 'object' || Array.isArray(partial[key])) throw new Error('语音或表情设置格式不正确');
    const value = { ...currentMedia[key] };
    for (const [field, item] of Object.entries(partial[key])) {
      if (!Object.hasOwn(DEFAULTS[key], field)) throw new Error('不支持的语音或表情设置');
      if (field === 'models') {
        if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(name => !Object.hasOwn(DEFAULTS.tts.models, name))) throw new Error('语音模型格式不正确');
        value.models = { ...currentMedia.tts.models };
        for (const [name, model] of Object.entries(item)) {
          if (typeof model !== 'string' || model.length > 200) throw new Error('语音模型名称过长');
          value.models[name] = model.trim();
        }
      } else if (typeof DEFAULTS[key][field] === 'boolean') {
        if (typeof item !== 'boolean') throw new Error('语音开关格式不正确'); value[field] = item;
      } else {
        if (typeof item !== 'string' || item.length > (field === 'voiceDesignPrompt' || field === 'speakStyleHint' ? 10000 : field === 'apiKey' ? 4096 : 1024)) throw new Error('语音字段格式不正确');
        if (field === 'apiKey' && item === '***') continue;
        value[field] = field === 'baseUrl' ? validateUrl(item) : item.trim();
      }
    }
    if (key === 'tts' && !['mimo', 'qwen', 'custom'].includes(value.provider)) throw new Error('不支持的语音提供商');
    if (key === 'voice' && (!['preset', 'design', 'clone'].includes(value.ttsMode) || !['mp3', 'wav'].includes(value.ttsFormat) || !['zh', 'en', 'ja', 'auto'].includes(value.asrLanguage))) throw new Error('不支持的语音模式');
    if (key === 'stickers' && value.sourceRoot && !path.isAbsolute(value.sourceRoot)) throw new Error('表情包来源应为本机绝对目录');
    out[key] = value;
  }
  return out;
}
function publicSettings(s) {
  const out = mergeSettings(s);
  for (const key of ['tts', 'asr']) out[key] = { ...out[key], apiKey: out[key].apiKey ? '***' : '' };
  return { ...out, speechPresets: PRESETS, speechOutput: s.speechOutput ? {
    ...s.speechOutput, apiKey: s.speechOutput.apiKey ? '***' : '',
  } : null };
}
function mediaError(status, code) {
  const error = new Error(code); error.status = status; error.code = code; return error;
}
function bytesFromBase64(encoded, limit = MAX_BYTES) {
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(limit / 3) * 4 + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw mediaError(400, 'invalid_audio');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > limit) throw mediaError(400, 'invalid_audio');
  return bytes;
}
function store(bytes, mime) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) throw mediaError(413, 'media_too_large');
  const id = crypto.createHash('sha256').update(mime).update(bytes).digest('hex');
  const directory = userFilePath('media'); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, id + '.bin');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file + '.tmp', bytes, { mode: 0o600 }); fs.renameSync(file + '.tmp', file);
    fs.writeFileSync(path.join(directory, id + '.json'), JSON.stringify({ mime, size: bytes.length }), { mode: 0o600 });
  }
  return { attachment_id: id, mime };
}
function attachmentFile(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw mediaError(404, 'media_not_found');
  try {
    const directory = userFilePath('media');
    const meta = JSON.parse(fs.readFileSync(path.join(directory, id + '.json'), 'utf8'));
    const file = path.join(directory, id + '.bin');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || !stat.size || stat.size > MAX_BYTES) throw new Error();
    return { file, mime: meta.mime };
  } catch { throw mediaError(404, 'media_not_found'); }
}
function attachment(id) {
  const { file, mime } = attachmentFile(id);
  try {
    return { data: fs.readFileSync(file).toString('base64'), mime };
  } catch { throw mediaError(404, 'media_not_found'); }
}
function outputEnabled(settings) {
  return settings.speechOutput ? settings.speechOutput.enabled === true : settings.voice?.enabled;
}
function speechMime(bytes) {
  if (bytes.length > 44 && bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (bytes.length > 10 && (bytes.toString('ascii', 0, 3) === 'ID3' ||
      (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) return 'audio/mpeg';
  return null;
}
async function tts(text, emotion, signal, settings = require('./electron/brain/settings').loadSettings()) {
  if (typeof text !== 'string' || !text.trim() || text.length > 10000) throw mediaError(400, 'invalid_text');
  if (!outputEnabled(settings)) throw mediaError(409, 'voice_disabled');
  try {
    require('./electron/voice/mimo-api').invalidateMimoCache();
    const data = await require('./electron/voice/tts-synth').synthesizeSpeech({ text, emotion, modelId: 'shenshen', signal, settings });
    signal?.throwIfAborted();
    const bytes = bytesFromBase64(data.audioBase64);
    const mime = settings.speechOutput ? speechMime(bytes) : data.format === 'wav' ? 'audio/wav' : 'audio/mpeg';
    if (!mime) throw mediaError(502, 'tts_failed');
    return { type: 'record', ...store(bytes, mime) };
  } catch (error) {
    signal?.throwIfAborted();
    if (error.name === 'AbortError' || error.code) throw error;
    throw mediaError(502, 'tts_failed');
  }
}
async function previewOutput(settings, input, signal) {
  let output;
  try { output = resolveOutputDraft(input, settings.speechOutput, validateUrl); }
  catch { throw mediaError(400, 'tts_preview_settings'); }
  let data;
  try {
    data = await require('./electron/voice/tts-synth').synthesizeSpeech({
      text: '你好，我是大肥鱼。今天也一起摸个鱼吧！', modelId: 'shenshen', signal,
      settings: { ...settings, speechOutput: output },
    });
  } catch (error) {
    const status = error.httpStatus;
    const code = signal.aborted ? 'tts_preview_timeout'
      : status === 401 || status === 403 ? 'tts_preview_auth'
      : status === 402 ? 'tts_preview_quota'
      : status === 429 ? 'tts_preview_rate'
      : status === 400 || status === 404 || status === 422 ? 'tts_preview_settings' : 'tts_preview_failed';
    throw mediaError(502, code);
  }
  let bytes;
  try { bytes = bytesFromBase64(data.audioBase64, 2 * 1024 * 1024); }
  catch { throw mediaError(502, 'tts_preview_audio'); }
  if (!speechMime(bytes)) throw mediaError(502, 'tts_preview_audio');
  return { output, audio: bytes.toString('base64') };
}
async function asr(body) {
  const settings = require('./electron/brain/settings').loadSettings();
  if (!settings.voice?.enabled) throw mediaError(409, 'voice_disabled');
  const mime = body.mime || 'audio/wav';
  if (!['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/webm', 'audio/ogg'].includes(mime)) throw mediaError(400, 'invalid_audio');
  const bytes = bytesFromBase64(body.audio, 8 * 1024 * 1024);
  try {
    require('./electron/voice/mimo-api').invalidateMimoCache();
    const text = await require('./electron/voice/mimo-asr').transcribeAudio({ audioDataUrl: `data:${mime};base64,${bytes.toString('base64')}`, language: settings.voice.asrLanguage });
    return { text };
  } catch { throw mediaError(502, 'asr_failed'); }
}
// A request for text or silence wins over voice, including the legacy forceVoice option.
// Match concrete delivery requests rather than mentions of ASR, audio models or acoustics.
function resolveVoiceRequest(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  const modifiers = '(?:再|一直|总是|每次|老是|经常|总|老|动不动|就|给我|给|发|发送|使用|用|听|播放|自动|直接|提供|一条|一段|任何|你的|你|个|的|了|这次|现在|[ \\t])';
  const negativePrefix = new RegExp(`(?:别|不要|不用|无需|不必|不需要|不想|不是|不)${modifiers}{0,8}$`, 'u');
  const doubleNegativePrefix = /(?:不是|并非|没有说|没说)(?:说|表示|想|完全|真的|[ \t]){0,3}$/u;
  const doubleNegativeDelivery = new RegExp(`(?:不是|并非|没有说|没说)(?:说|表示|想|完全|真的|[ \\t]){0,3}(?:不要|不用|不想|不需要|不让|不能)${modifiers}{0,8}$`, 'u');
  const voiceRefusals = new RegExp(`(?:别|不要|不用|无需|不必|不需要|不想|先不|暂时不|不发|不听|停止|关闭|关掉|取消)${modifiers}{0,8}(?:语音|声音|朗读|读出来|念出来)`, 'gu');
  for (const match of text.matchAll(voiceRefusals)) {
    if (!doubleNegativePrefix.test(text.slice(0, match.index))) return 'text';
  }
  // Also recognize the common topic-first form: “语音先别发了”.
  const reversedRefusals = /(?:语音(?:回复)?|声音|朗读)(?:先|暂时|这次|今天|现在|就|[ \t]){0,3}(?:别|不要|不用|不必|先不)(?:再|给我|给|自动|[ \t]){0,3}(?:发|发送|用|播放|听|回复|开启|读出来|念出来)/gu;
  for (const match of text.matchAll(reversedRefusals)) {
    if (!doubleNegativePrefix.test(text.slice(0, match.index))) return 'text';
  }
  const textRequests = /只(?:要|用|发)?文字|只(?:用)?打字|文字(?:回复|回答|就好|就行|即可)|(?:用|发)(?:文字|文本)(?:回复|回答|就好|就行)?|打字(?:回复|回答|就好|就行)|不方便(?:听|播放)(?:语音|声音)?/gu;
  for (const match of text.matchAll(textRequests)) {
    if (!negativePrefix.test(text.slice(0, match.index))) return 'text';
  }
  const voiceRequests = /(?:发(?:送)?|来|给我(?:发|来)?|让我听|想听|听听|听|用)(?:一条|一段|一下|条|段|个|你的|你|点|[ \t]){0,4}(?:语音|声音)(?!识别|合成|模型|设置|输入|通话|传播|API)|(?:语音|声音)(?:回复|回答)(?!功能|设置|是什么|怎么|如何)/giu;
  for (const match of text.matchAll(voiceRequests)) {
    const prefix = text.slice(0, match.index);
    if (!negativePrefix.test(prefix) && !doubleNegativeDelivery.test(prefix)) return 'voice';
  }
  return null;
}
function readableVoiceText(value, maxLength) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text || text.length > maxLength || !/[\p{L}\p{N}]/u.test(text)) return false;
  return !/`|(?:https?:\/\/|www\.)|\[[^\]]+\]\([^)]+\)|(?:^|\n)\s*(?:[-*+]\s|\d+[.)、]\s*|[一二三四五六七八九十]+[、.]|\|.*\|)/imu.test(text);
}
function voiceMessageIndex(messages, config, options) {
  if (!outputEnabled(config)) return -1;
  const request = resolveVoiceRequest(options.userText);
  if (request === 'text') return -1;
  const explicit = request === 'voice' || options.forceVoice === true;
  if (!explicit) {
    if (!config.voice.autoSpeak) return -1;
    const recent = Array.isArray(options.recentReplyTurns) ? options.recentReplyTurns.slice(0, 4) : [];
    if (recent.length < 4 || !recent.every(turn => turn?.hasVoice === false)) return -1;
  }
  const candidates = messages.map((message, index) => ({ index, text: message.text }))
    .filter(item => readableVoiceText(item.text, explicit ? 10000 : 120))
    .sort((a, b) => a.text.trim().length - b.text.trim().length || a.index - b.index);
  return candidates[0]?.index ?? -1;
}
async function enrichMessages(messages, settings, options = {}) {
  const config = { ...settings, ...mergeSettings(settings) };
  const voiceIndex = voiceMessageIndex(messages, config, options);
  const result = [];
  for (const [index, original] of messages.entries()) {
    options.signal?.throwIfAborted();
    const item = { ...original, parts: [] };
    if (item.text) item.parts.push({ type: 'plain', text: item.text });
    if (item.stickerUrl || item.sticker_url) {
      const image = stickers.resolveSticker(item.stickerUrl || item.sticker_url, config);
      if (image) item.parts.push({ type: 'image', ...store(fs.readFileSync(image.file), image.mime), filename: path.basename(image.file) });
    }
    if (index === voiceIndex) {
      try {
        const record = await tts(item.text, options.emotion, options.signal, config);
        options.signal?.throwIfAborted();
        item.parts.push({ ...record, transcript: item.text });
      } catch (error) {
        options.signal?.throwIfAborted();
        if (error.name === 'AbortError') throw error;
        item.media_error = 'tts_failed';
      }
    }
    if (item.parts.length) result.push(item);
  }
  return result;
}
async function handle({ method, path: route, body = {} }) {
  const match = route.match(/^\/media\/([a-f0-9]{64})$/);
  if (method === 'GET' && match) return { status: 200, body: attachment(match[1]) };
  if (method === 'POST' && route === '/voice/tts') return { status: 200, body: await tts(body.text, body.emotion) };
  if (method === 'POST' && route === '/voice/asr') return { status: 200, body: await asr(body) };
  if (method === 'GET' && route === '/stickers') return { status: 200, body: stickers.summary(require('./electron/brain/settings').loadSettings()) };
  if (method === 'GET' && route === '/stickers/catalog') return { status: 200, body: stickers.catalog(require('./electron/brain/settings').loadSettings()) };
  const stickerMatch = route.match(/^\/stickers\/([a-f0-9]{64})$/);
  if (method === 'GET' && stickerMatch) {
    const image = stickers.resolveSticker(stickerMatch[1], require('./electron/brain/settings').loadSettings());
    if (!image) throw mediaError(404, 'sticker_not_found');
    try {
      const bytes=fs.readFileSync(image.file);
      if (!bytes.length || bytes.length>MAX_BYTES) throw new Error();
      return {status:200,body:{data:bytes.toString('base64'),mime:image.mime}};
    } catch { throw mediaError(404,'sticker_not_found'); }
  }
  return null;
}
module.exports = { DEFAULTS, mergeSettings, normalizeSettings, publicSettings, enrichMessages, resolveVoiceRequest, handle, store, attachment, attachmentFile, tts, asr, previewOutput };
