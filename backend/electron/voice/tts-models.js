/** MiMo 官方默认语音模型套件 */
const MIMO_TTS_MODELS = {
  preset: 'mimo-v2.5-tts',
  design: 'mimo-v2.5-tts-voicedesign',
  clone: 'mimo-v2.5-tts-voiceclone',
  asr: 'mimo-v2.5-asr',
};

/** Qwen TTS 默认模型（Instruct 系列支持 instructions） */
const QWEN_TTS_MODELS = {
  preset: 'qwen3-tts-instruct-flash',
  design: 'qwen3-tts-instruct-flash',
  clone: '',
};

const MODE_LABELS = {
  design: '音色设计',
  preset: '预设音色',
  'preset+rvc': '角色声线',
  clone: '参考音克隆',
};

/**
 * @param {import('../brain/settings').DEFAULTS['tts']} [tts]
 */
function normalizeTtsSettings(tts = {}) {
  const models = {
    preset: '',
    design: '',
    clone: '',
    asr: '',
    ...tts.models,
  };

  if (tts.asrModel?.trim() && !models.asr) {
    models.asr = tts.asrModel.trim();
  }

  let provider = 'mimo';
  if (tts.provider === 'custom') provider = 'custom';
  else if (tts.provider === 'qwen') provider = 'qwen';

  if (tts.model?.trim()) {
    provider = 'custom';
    const legacy = tts.model.trim();
    if (!models.preset) models.preset = legacy;
    if (!models.design) models.design = legacy;
    if (!models.clone) models.clone = legacy;
  }

  return {
    baseUrl: tts.baseUrl || '',
    apiKey: tts.apiKey || '',
    provider,
    models,
  };
}

/**
 * @param {import('../brain/settings').DEFAULTS['asr']} [asr]
 */
function normalizeAsrSettings(asr = {}) {
  return {
    baseUrl: asr.baseUrl || '',
    apiKey: asr.apiKey || '',
  };
}

/**
 * @param {ReturnType<typeof import('../brain/settings').loadSettings>} settings
 */
function getTtsProvider(settings) {
  const p = settings.tts?.provider;
  if (p === 'custom') return 'custom';
  if (p === 'qwen') return 'qwen';
  return 'mimo';
}

/**
 * @param {string} [model]
 */
function isQwenTtsModel(model) {
  return /^qwen/i.test(String(model || '').trim());
}

/**
 * @param {string} [model]
 */
function isQwenInstructModel(model) {
  return /instruct/i.test(String(model || '').trim());
}

/**
 * @param {ReturnType<typeof import('../brain/settings').loadSettings>} settings
 * @param {string} mode
 */
function resolveTtsModelForMode(settings, mode) {
  const provider = getTtsProvider(settings);
  const models = settings.tts?.models || {};

  if (provider === 'mimo') {
    if (mode === 'clone') return models.clone?.trim() || MIMO_TTS_MODELS.clone;
    if (mode === 'preset' || mode === 'preset+rvc') {
      return models.preset?.trim() || MIMO_TTS_MODELS.preset;
    }
    return models.design?.trim() || MIMO_TTS_MODELS.design;
  }

  if (provider === 'qwen') {
    if (mode === 'clone') return models.clone?.trim() || null;
    if (mode === 'preset' || mode === 'preset+rvc') {
      return models.preset?.trim() || QWEN_TTS_MODELS.preset;
    }
    return models.design?.trim() || QWEN_TTS_MODELS.design;
  }

  if (mode === 'clone') return models.clone?.trim() || null;
  if (mode === 'preset' || mode === 'preset+rvc') return models.preset?.trim() || null;
  return models.design?.trim() || null;
}

/**
 * 根据模型名选择合成实现：qwen* → qwen，mimo 套件 → mimo，其余 → generic
 * @param {ReturnType<typeof import('../brain/settings').loadSettings>} settings
 * @param {string} mode
 */
function resolveSynthProviderId(settings, mode) {
  const model = resolveTtsModelForMode(settings, mode);
  if (model && isQwenTtsModel(model)) return 'qwen';
  if (getTtsProvider(settings) === 'mimo') return 'mimo';
  return 'generic';
}

/**
 * @param {ReturnType<typeof import('../brain/settings').loadSettings>} settings
 */
function resolveAsrModel(settings) {
  const custom = settings.tts?.models?.asr?.trim();
  if (custom) return custom;
  const provider = getTtsProvider(settings);
  if (provider === 'mimo') return MIMO_TTS_MODELS.asr;
  return null;
}

/**
 * @param {ReturnType<typeof import('../brain/settings').loadSettings>} settings
 * @param {string} mode
 */
function isTtsModeAvailable(settings, mode) {
  return Boolean(resolveTtsModelForMode(settings, mode));
}

/**
 * @param {ReturnType<typeof import('../brain/settings').loadSettings>} settings
 * @param {string} mode
 */
function requireTtsModelForMode(settings, mode) {
  const model = resolveTtsModelForMode(settings, mode);
  if (!model) {
    const label = MODE_LABELS[mode] || mode;
    const provider = getTtsProvider(settings);
    const hint = provider === 'qwen'
      ? '通义千问 Qwen 套件'
      : provider === 'mimo'
        ? '小米 MiMo 套件'
        : '自定义语音模型';
    throw new Error(`未配置「${label}」模型，请在设置中填写或改选${hint}`);
  }
  return model;
}

/**
 * @param {ReturnType<typeof import('../brain/settings').loadSettings>} settings
 */
function pickTtsProbeModel(settings) {
  return (
    resolveTtsModelForMode(settings, 'preset')
    || resolveTtsModelForMode(settings, 'design')
    || resolveTtsModelForMode(settings, 'clone')
    || MIMO_TTS_MODELS.preset
  );
}

module.exports = {
  MIMO_TTS_MODELS,
  QWEN_TTS_MODELS,
  MODE_LABELS,
  normalizeTtsSettings,
  normalizeAsrSettings,
  getTtsProvider,
  isQwenTtsModel,
  isQwenInstructModel,
  resolveTtsModelForMode,
  resolveSynthProviderId,
  resolveAsrModel,
  isTtsModeAvailable,
  requireTtsModelForMode,
  pickTtsProbeModel,
};
