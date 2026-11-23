const { loadSettings } = require('../brain/settings');

const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1';

/** @type {Record<'tts' | 'asr', { baseUrl: string, apiKey: string } | null>} */
const cachedCredentials = { tts: null, asr: null };

function invalidateMimoCache() {
  cachedCredentials.tts = null;
  cachedCredentials.asr = null;
}

/** 去掉用户误填的 /chat/completions 等路径，只保留 API 根地址 */
function normalizeVoiceBaseUrl(url) {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '');
}

/**
 * 朗读（TTS）API 凭证：tts.* → cloud.*
 * @param {ReturnType<typeof loadSettings>} [settings]
 */
function resolveTtsApiCredentials(settings = loadSettings()) {
  const tts = settings.tts || {};
  const raw = tts.baseUrl?.trim() || settings.cloud?.baseUrl || DEFAULT_BASE_URL;
  const baseUrl = normalizeVoiceBaseUrl(raw) || DEFAULT_BASE_URL;
  const apiKey = (tts.apiKey?.trim() || settings.cloud?.apiKey?.trim() || '');
  return { baseUrl, apiKey };
}

/**
 * 识别（ASR）API 凭证：asr.* → tts.* → cloud.*
 * @param {ReturnType<typeof loadSettings>} [settings]
 */
function resolveAsrApiCredentials(settings = loadSettings()) {
  const asr = settings.asr || {};
  const ttsCreds = resolveTtsApiCredentials(settings);
  const raw = asr.baseUrl?.trim() || ttsCreds.baseUrl;
  const baseUrl = normalizeVoiceBaseUrl(raw) || ttsCreds.baseUrl;
  const apiKey = (asr.apiKey?.trim() || ttsCreds.apiKey);
  return { baseUrl, apiKey };
}

/** @deprecated 兼容旧名，等同 resolveTtsApiCredentials */
function resolveVoiceApiCredentials(settings = loadSettings()) {
  return resolveTtsApiCredentials(settings);
}

/**
 * @param {'tts' | 'asr'} [kind]
 * @param {ReturnType<typeof loadSettings>} [settings]
 */
function getMimoCredentials(kind = 'tts', settings) {
  const key = kind === 'asr' ? 'asr' : 'tts';
  if (cachedCredentials[key]) return cachedCredentials[key];

  const resolver = key === 'asr' ? resolveAsrApiCredentials : resolveTtsApiCredentials;
  const { baseUrl, apiKey } = resolver(settings || loadSettings());
  if (!apiKey) {
    const label = key === 'asr' ? '识别（ASR）' : '朗读（TTS）';
    throw new Error(`请先在设置里填写${label} API Key（可单独配置，或与大脑共用）`);
  }
  cachedCredentials[key] = { baseUrl, apiKey };
  return cachedCredentials[key];
}

/**
 * @param {string} path
 * @param {object} body
 * @param {{ timeoutMs?: number, kind?: 'tts' | 'asr' }} [opts]
 */
async function mimoPost(path, body, opts = {}) {
  const kind = opts.kind === 'asr' ? 'asr' : 'tts';
  const { baseUrl, apiKey } = opts.settings
    ? resolveTtsApiCredentials(opts.settings) : getMimoCredentials(kind);
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 45000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      ...(opts.settings ? { redirect: 'error' } : {}),
      signal: opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal,
    });

    if (!res.ok) {
      if (opts.settings) {
        await res.body?.cancel().catch(() => {});
        throw Object.assign(new Error('语音服务请求失败'), { httpStatus: res.status });
      }
      const text = await res.text().catch(() => '');
      throw new Error(`MiMo API 失败 (${res.status}) @ ${url}${text ? `: ${text.slice(0, 240)}` : ''}`);
    }

    return await res.json();
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`MiMo API 超时 (${timeoutMs}ms) @ ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  getMimoCredentials,
  resolveTtsApiCredentials,
  resolveAsrApiCredentials,
  resolveVoiceApiCredentials,
  mimoPost,
  DEFAULT_BASE_URL,
  invalidateMimoCache,
  normalizeVoiceBaseUrl,
};
