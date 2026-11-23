const { mimoPost, resolveAsrApiCredentials } = require('./mimo-api');
const { loadSettings } = require('../brain/settings');
const { resolveAsrModel } = require('./tts-models');
const { readTextStreamLines } = require('../brain/stream-utils');

const ASR_STREAM_TIMEOUT_MS = 60000;

/**
 * @param {unknown} content
 */
function extractMessageText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

/**
 * @param {{
 *   audioDataUrl: string,
 *   language?: string,
 *   onDelta?: (delta: string, full: string) => void,
 *   settings?: import('../brain/settings').Settings,
 * }} opts
 */
async function transcribeAudioStream(opts) {
  const settings = opts.settings || loadSettings();
  const asrModel = resolveAsrModel(settings);
  if (!asrModel) {
    throw new Error('自定义语音未配置 ASR 模型，请在设置中填写或改选小米 MiMo 套件');
  }
  const lang = opts.language || settings.voice?.asrLanguage || 'zh';
  const { baseUrl, apiKey } = resolveAsrApiCredentials(settings);
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASR_STREAM_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: asrModel,
        stream: true,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'input_audio',
                input_audio: { data: opts.audioDataUrl },
              },
            ],
          },
        ],
        asr_options: { language: lang },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`MiMo ASR 流式超时 (${ASR_STREAM_TIMEOUT_MS}ms) @ ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`MiMo ASR 流式失败 (${res.status}) @ ${url}${text ? `: ${text.slice(0, 240)}` : ''}`);
  }
  if (!res.body) {
    throw new Error(`MiMo ASR 未返回流式数据（ASR → ${url}）`);
  }

  let full = '';
  await readTextStreamLines(res.body, (line) => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) return;

    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;

    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      return;
    }

    const delta = data.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      full += delta;
      opts.onDelta?.(delta, full);
    }
  });

  const text = full.trim();
  if (!text) {
    throw new Error(`语音识别未返回文本（ASR → ${url}）`);
  }
  return text;
}

/**
 * @param {{ audioDataUrl: string, language?: string }} opts
 */
async function transcribeAudio({ audioDataUrl, language, signal }) {
  const settings = loadSettings();
  const asrModel = resolveAsrModel(settings);
  if (!asrModel) {
    throw new Error('自定义语音未配置 ASR 模型，请在设置中填写或改选小米 MiMo 套件');
  }
  const lang = language || settings.voice?.asrLanguage || 'zh';
  const { baseUrl } = resolveAsrApiCredentials(settings);

  let data;
  try {
    data = await mimoPost('/chat/completions', {
      model: asrModel,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: { data: audioDataUrl },
            },
          ],
        },
      ],
      asr_options: { language: lang },
    }, { timeoutMs: 60000, kind: 'asr', signal });
  } catch (err) {
    const reason = err?.message || '语音识别失败';
    throw new Error(`${reason}（ASR → ${baseUrl}/chat/completions）`);
  }

  const text = extractMessageText(data.choices?.[0]?.message?.content);
  if (!text) {
    throw new Error(`语音识别未返回文本（ASR → ${baseUrl}/chat/completions）`);
  }
  return text;
}

module.exports = { transcribeAudio, transcribeAudioStream };
