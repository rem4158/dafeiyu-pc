// Adapted from Nianan settings: a single local identity, no account activation or UI dependencies.
const fs = require('node:fs');
const features = require('../../alignment-settings');
const media = require('../../media');
const { siteNames } = require('../../browser/sites');
const { MODEL_PRESETS, getPreset } = require('../../model-presets');
const { userFilePath, ensureUserDir } = require('../user-data');
const { buildPersonalityPrompt, LANGUAGE_STYLE_PROMPTS, ARCHETYPE_PROMPTS, SLIDER_TRAITS } = require('./personality');

const DEFAULTS = {
  provider: 'cloud',
  browser: { enabled: true, proactive: true, backgroundIntervalMinutes: 5, autonomousBlockedSites: [] },
  cloud: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' },
  ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'gemma4:e4b' },
  systemPrompt: '', ownerId: 'local', ownerName: '主人', characterName: '大肥鱼',
  proxy: '', personality: { dimensions: null, prompt: '' },
  memory: { enabled: true, autoExtract: false, retentionDays: 0,
    maxRecentMessages: 30, maxContextFacts: 8, maxContextEvents: 5, tokenBudget: 800 },
  awareness: { enabled: false }, proactive: { enabled: false }, hands: { enabled: false },
};
Object.assign(DEFAULTS, features.DEFAULTS, media.DEFAULTS);

const validBackgroundInterval = value => Number.isInteger(value) && value >= 1 && value <= 120;
const validBlockedSites = value => Array.isArray(value) && value.length <= Object.keys(siteNames).length &&
  value.every(site => typeof site === 'string' && Object.hasOwn(siteNames, site)) && new Set(value).size === value.length;

function normalizeDimensions(value, current = null) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('人格参数格式不正确');
  const next = { ...(current || {}) };
  const numericKeys = new Set(SLIDER_TRAITS.map(trait => trait.key));
  for (const [key, item] of Object.entries(value)) {
    if (key === 'languageStyle' || key === 'archetype') {
      if (item === '' || item === null) { delete next[key]; continue; }
      const options = key === 'languageStyle' ? LANGUAGE_STYLE_PROMPTS : ARCHETYPE_PROMPTS;
      if (typeof item !== 'string' || !Object.hasOwn(options, item)) throw new Error('不支持的人格选项');
    } else if (!numericKeys.has(key) || typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 1) {
      throw new Error('人格数值必须在 0 到 1 之间');
    }
    next[key] = item;
  }
  return next;
}

function displayName(value) {
  if (typeof value !== 'string') throw new Error('请填写有效称呼');
  const name = value.trim();
  if (!name || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('称呼须为 1 到 60 个字符，不含换行');
  return name;
}

function loadedPersonality(parsed) {
  const value = parsed.personality;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return structuredClone(DEFAULTS.personality);
  // Keep legacy custom prompt behavior until the user edits dimensions; reads never write config.
  if (value.dimensions == null) return { ...DEFAULTS.personality, ...value };
  const dimensions = normalizeDimensions(value.dimensions);
  return { ...value, dimensions, prompt: buildPersonalityPrompt(dimensions) };
}

function loadSettings() {
  let parsed = {};
  try { parsed = JSON.parse(fs.readFileSync(userFilePath('brain-settings.json'), 'utf8').replace(/^\uFEFF/, '')); }
  catch (err) { if (err.code !== 'ENOENT') throw new Error('后台设置文件无法读取，请恢复备份或检查格式'); }
  return { ...structuredClone(DEFAULTS), ...parsed,
    cloud: { ...DEFAULTS.cloud, ...parsed.cloud },
    ollama: { ...DEFAULTS.ollama, ...parsed.ollama },
    personality: loadedPersonality(parsed),
    ...features.mergeSettings(parsed),
    ...media.mergeSettings(parsed),
    browser: {
      enabled: parsed.browser?.enabled !== false,
      proactive: parsed.browser?.proactive !== false,
      backgroundIntervalMinutes: validBackgroundInterval(parsed.browser?.backgroundIntervalMinutes)
        ? parsed.browser.backgroundIntervalMinutes : DEFAULTS.browser.backgroundIntervalMinutes,
      autonomousBlockedSites: validBlockedSites(parsed.browser?.autonomousBlockedSites) ? parsed.browser.autonomousBlockedSites : [],
    },
    awareness: { enabled: false }, hands: { enabled: false },
  };
}

function validUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      !['http:', 'https:'].includes(url.protocol) ||
      (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw new Error('API 地址必须使用 HTTPS，或本机 HTTP 地址，不要包含密钥和查询参数');
  }
  return value.trim().replace(/\/+$/, '');
}

function hasCloudConnection(cloud) {
  return Boolean(cloud.preset || cloud.apiKey || cloud.baseUrl !== DEFAULTS.cloud.baseUrl || cloud.model !== DEFAULTS.cloud.model);
}

function savedCloudConnections(settings) {
  const active = settings.cloud;
  const saved = settings.cloudConnections || {};
  const connections = {};
  for (const id of [...Object.keys(MODEL_PRESETS), 'custom']) {
    if (saved[id] && typeof saved[id] === 'object') connections[id] = saved[id];
  }
  if (active.preset && getPreset(active.preset)) connections[active.preset] = active;
  else if (hasCloudConnection(active)) connections.custom = active;
  else delete connections.custom;
  return connections;
}

function publicSettings(s = loadSettings()) {
  const connections = savedCloudConnections(s);
  const maskKey = cloud => ({ ...cloud, apiKey: cloud.apiKey ? '***' : '' });
  return { provider: s.provider, cloud: maskKey(s.cloud), hasSavedCloudConnection: hasCloudConnection(s.cloud),
    cloudConnections: Object.fromEntries(Object.entries(connections).map(([id, cloud]) => [id, maskKey(cloud)])),
    modelPresets: MODEL_PRESETS,
    ollama: s.ollama, systemPrompt: s.systemPrompt, ownerName: s.ownerName,
    characterName: s.characterName, personality: s.personality, memory: s.memory, cognition: s.cognition,
    proactive: s.proactive, browser: s.browser, ...media.publicSettings(s),
    proxy: s.proxy || '' };
}

function resolveModelSettings(current, partial, { isolateCloudKey = false } = {}) {
  const next = { ...current };
  if (partial.provider !== undefined) {
    if (!['cloud', 'ollama'].includes(partial.provider)) throw new Error('不支持的模型提供方式');
    next.provider = partial.provider;
  }
  for (const field of ['cloud', 'ollama']) {
    if (!partial[field]) continue;
    if (typeof partial[field] !== 'object' || Array.isArray(partial[field])) throw new Error('模型设置格式不正确');
    const patch = partial[field];
    const preset = field === 'cloud' ? getPreset(patch.preset) : null;
    if (field === 'cloud' && patch.preset !== undefined && patch.preset !== 'custom' && !preset)
      throw new Error('不支持的模型服务商');
    let connection = { ...current[field] };
    if (field === 'cloud' && patch.preset !== undefined) {
      const connections = savedCloudConnections(current);
      const saved = connections[patch.preset];
      connection = preset ? { baseUrl: preset.baseUrl, model: preset.model, apiKey: '', ...saved, preset: patch.preset }
        : { ...DEFAULTS.cloud, ...saved };
      if (!preset) delete connection.preset;
      next.cloudConnections = connections;
    }
    if (patch.baseUrl !== undefined) {
      const baseUrl = validUrl(String(patch.baseUrl));
      if (field === 'cloud' && (isolateCloudKey || patch.preset === 'custom') && baseUrl !== connection.baseUrl &&
          (patch.apiKey === undefined || patch.apiKey === '***')) connection.apiKey = '';
      connection.baseUrl = baseUrl;
    }
    if (patch.model !== undefined) {
      const model = String(patch.model).trim();
      if (!model || model.length > 200) throw new Error('请填写有效的模型名称');
      connection.model = model;
    }
    if (preset && connection.baseUrl !== preset.baseUrl) throw new Error('预设必须使用服务商官方地址');
    if (field === 'cloud' && patch.preset === undefined && connection.preset &&
        connection.baseUrl !== getPreset(connection.preset)?.baseUrl) {
      next.cloudConnections = savedCloudConnections(current);
      delete connection.preset;
      if (patch.apiKey === undefined || patch.apiKey === '***') connection.apiKey = '';
    }
    if (field === 'cloud' && patch.apiKey !== undefined && patch.apiKey !== '***') {
      if (typeof patch.apiKey !== 'string') throw new Error('API Key 格式不正确');
      const key = patch.apiKey.trim();
      if (key.length > 4096) throw new Error('API Key 长度不正确');
      connection.apiKey = key;
    }
    next[field] = connection;
  }
  if (partial.cloud && next.cloudConnections) next.cloudConnections = savedCloudConnections(next);
  if (partial.proxy !== undefined) {
    const proxy = String(partial.proxy).trim();
    if (proxy.length > 300 || (proxy && !/^(?:https?|socks5):\/\/(?:127\.0\.0\.1|localhost):\d{1,5}$/.test(proxy))) {
      throw new Error('代理仅支持本机 HTTP 或 SOCKS5 地址');
    }
    next.proxy = proxy;
  }
  return next;
}

function saveSettings(partial, options) {
  const current = loadSettings();
  const next = resolveModelSettings(current, partial, options);
  for (const name of ['ownerName', 'characterName']) {
    if (partial[name] !== undefined) next[name] = displayName(partial[name]);
  }
  if (partial.ownerId !== undefined && partial.ownerId !== current.ownerId) throw new Error('用户身份标识不可通过称呼设置修改');
  if (partial.personality !== undefined) {
    const value = partial.personality;
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(key => key !== 'dimensions')) throw new Error('人格参数格式不正确');
    if (Object.hasOwn(value, 'dimensions')) {
      const dimensions = normalizeDimensions(value.dimensions, current.personality?.dimensions);
      next.personality = { ...current.personality, dimensions, prompt: buildPersonalityPrompt(dimensions) };
    }
  }
  if (partial.systemPrompt !== undefined) {
    if (typeof partial.systemPrompt !== 'string' || partial.systemPrompt.length > 50000) throw new Error('人格提示词过长');
    next.systemPrompt = partial.systemPrompt;
  }
  Object.assign(next, features.normalizeSettings(current, partial), media.normalizeSettings(current, partial, options));
  if (Object.hasOwn(partial, 'qq')) throw new Error('不支持的设置');
  if (partial.browser !== undefined) {
    const values = partial.browser;
    if (!values || typeof values !== 'object' || Array.isArray(values) ||
        Object.entries(values).some(([key, value]) => !Object.hasOwn(DEFAULTS.browser, key) ||
          (key === 'backgroundIntervalMinutes' ? !validBackgroundInterval(value) :
            key === 'autonomousBlockedSites' ? !validBlockedSites(value) : typeof value !== 'boolean'))) {
      throw new Error('浏览器设置无效，请检查后台间隔和自主访问黑名单');
    }
    next.browser = { ...current.browser, ...values };
  }
  ensureUserDir();
  const target = userFilePath('brain-settings.json');
  fs.writeFileSync(target + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(target + '.tmp', target);
  return publicSettings();
}
function isConfigured(s = loadSettings()) {
  return Boolean(s.provider === 'ollama' ? s.ollama?.model && s.ollama?.baseUrl
    : s.cloud?.apiKey && s.cloud?.model && s.cloud?.baseUrl);
}
module.exports = { DEFAULTS, loadSettings, saveSettings, publicSettings, isConfigured, resolveModelSettings };
