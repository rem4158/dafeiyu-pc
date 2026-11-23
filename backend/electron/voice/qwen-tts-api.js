const { loadSettings } = require('../brain/settings');
const { resolveTtsApiCredentials, normalizeVoiceBaseUrl } = require('./mimo-api');

const DEFAULT_QWEN_TTS_BASE = 'https://dashscope.aliyuncs.com/api/v1';
const QWEN_TTS_PATH = '/services/aigc/multimodal-generation/generation';

/**
 * @param {ReturnType<typeof loadSettings>} [settings]
 */
function resolveQwenTtsUrl(settings = loadSettings()) {
  const { baseUrl } = resolveTtsApiCredentials(settings);
  const root = normalizeVoiceBaseUrl(baseUrl) || DEFAULT_QWEN_TTS_BASE;
  if (/\/services\/aigc\//i.test(root)) {
    return root.replace(/\/+$/, '');
  }
  return `${root.replace(/\/+$/, '')}${QWEN_TTS_PATH}`;
}

/**
 * @param {object} body
 * @param {{ timeoutMs?: number, settings?: ReturnType<typeof loadSettings> }} [opts]
 */
async function qwenTtsPost(body, opts = {}) {
  const settings = opts.settings || loadSettings();
  const { apiKey } = resolveTtsApiCredentials(settings);
  if (!apiKey?.trim()) {
    throw new Error('请先在设置里填写 TTS API Key');
  }

  const url = resolveQwenTtsUrl(settings);
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 45000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify(body),
      ...(opts.officialPreset ? { redirect: 'error' } : {}),
      signal: opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal,
    });

    const data = await res.json().catch(() => ({}));
    if (opts.officialPreset && (!res.ok || data?.code)) {
      const httpStatus = data?.code === 'Arrearage' ? 402 : res.status;
      throw Object.assign(new Error('语音服务请求失败'), { httpStatus });
    }
    if (!res.ok) {
      const msg = data?.message || data?.code || '';
      throw new Error(`Qwen TTS 失败 (${res.status}) @ ${url}${msg ? `: ${String(msg).slice(0, 240)}` : ''}`);
    }
    if (data?.code) {
      throw new Error(`Qwen TTS 失败: ${data.message || data.code}`);
    }
    return data;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`Qwen TTS 超时 (${timeoutMs}ms) @ ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} responseData
 * @param {{ timeoutMs?: number }} [opts]
 */
async function extractQwenAudio(responseData, opts = {}) {
  const audio = responseData?.output?.audio;
  if (!audio) return null;

  if (typeof audio.data === 'string' && audio.data.length > 0) {
    return { audioBase64: audio.data, format: 'wav' };
  }

  if (typeof audio.url === 'string' && audio.url.length > 0) {
    const url = new URL(audio.url);
    if (opts.officialPreset) {
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
          !/^dashscope-result[a-z\d-]*\.oss(?:-[a-z\d-]+)?\.aliyuncs\.com$/i.test(url.hostname))
        throw new Error('语音下载地址无效');
      url.protocol = 'https:';
    }
    const timeoutMs = opts.timeoutMs || 30000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        ...(opts.officialPreset ? { redirect: 'error' } : {}),
        signal: opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal,
      });
      if (!res.ok) {
        throw new Error(`下载 Qwen 音频失败 (${res.status})`);
      }
      if (Number(res.headers.get('content-length')) > 20 * 1024 * 1024) throw new Error('语音附件过大');
      const chunks = []; let size = 0;
      for await (const chunk of res.body) { size += chunk.length; if (size > 20 * 1024 * 1024) throw new Error('语音附件过大'); chunks.push(chunk); }
      const buf = Buffer.concat(chunks);
      const format = audio.url.includes('.mp3') ? 'mp3' : 'wav';
      return { audioBase64: buf.toString('base64'), format };
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}

module.exports = {
  DEFAULT_QWEN_TTS_BASE,
  QWEN_TTS_PATH,
  resolveQwenTtsUrl,
  qwenTtsPost,
  extractQwenAudio,
};
