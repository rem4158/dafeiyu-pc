const { stripTextForSpeech } = require('../tts-text');

async function synthesizeSpeechEndpoint({ text, settings, signal }) {
  const input = stripTextForSpeech(text, { preserveProviderTags: false });
  if (!input) throw new Error('没有可朗读的文本');
  const { apiKey, baseUrl, models } = settings.tts;
  const { presetVoice, ttsFormat, speakStyleHint } = settings.voice;
  const body = { model: models.preset, input, voice: presetVoice, response_format: ttsFormat };
  if (speakStyleHint) body.instructions = speakStyleHint;
  const timeout = AbortSignal.timeout(45000);
  const response = await fetch(baseUrl.replace(/\/audio\/speech$/i, '') + '/audio/speech', {
    method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error('语音服务请求失败'), { httpStatus: response.status });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 20 * 1024 * 1024) throw new Error('语音附件过大');
    chunks.push(chunk);
  }
  return { audioBase64: Buffer.concat(chunks).toString('base64'), format: ttsFormat, provider: 'speech' };
}

module.exports = { synthesizeSpeechEndpoint };
