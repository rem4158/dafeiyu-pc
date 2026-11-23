const path = require('node:path');

const PRESETS = Object.freeze({
  mimo: Object.freeze({
    label: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', voice: '冰糖',
    keyUrl: 'https://platform.xiaomimimo.com/',
    models: Object.freeze({ preset: 'mimo-v2.5-tts', design: 'mimo-v2.5-tts-voicedesign', clone: 'mimo-v2.5-tts-voiceclone' }),
  }),
  qwen: Object.freeze({
    label: '通义千问 · 百炼（北京）', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', voice: 'Cherry',
    keyUrl: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key',
    models: Object.freeze({ preset: 'qwen3-tts-flash' }),
  }),
});

function field(input, name, limit, fallback = '') {
  const value = input[name] ?? fallback;
  if (typeof value !== 'string' || value.length > limit) throw new Error('语音合成设置无效');
  return value.trim();
}

function resolveOutputDraft(input, saved, validateUrl) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('语音合成设置无效');
  const provider = input.provider;
  if (typeof provider !== 'string' || (provider !== 'custom' && !Object.hasOwn(PRESETS, provider)))
    throw new Error('未知语音服务商');
  const preset = PRESETS[provider];
  const protocol = preset ? provider : field(input, 'protocol', 12);
  if (!preset && !['chat', 'speech'].includes(protocol)) throw new Error('未知语音接口格式');
  const baseUrl = preset?.baseUrl || validateUrl(field(input, 'baseUrl', 1024));
  const mode = field(input, 'mode', 12, 'preset');
  if (!['preset', 'design', 'clone'].includes(mode) || (preset && !preset.models[mode]) ||
      (protocol === 'speech' && mode !== 'preset')) throw new Error('此服务不支持所选音色模式');
  const model = field(input, 'model', 200) || preset?.models[mode];
  const voice = field(input, 'voice', 200) || preset?.voice || '';
  const format = provider === 'qwen' ? 'wav' : mode === 'clone' ? 'mp3' : field(input, 'format', 12, 'mp3');
  const detail = field(input, 'detail', mode === 'clone' ? 1024 : 10000);
  const style = field(input, 'style', 10000);
  const enteredKey = field(input, 'apiKey', 4096);
  const savedKey = saved?.provider === provider && saved?.baseUrl === baseUrl ? saved.apiKey : '';
  const apiKey = enteredKey && enteredKey !== '***' ? enteredKey : savedKey;
  if (!baseUrl || !apiKey || !model || (mode === 'preset' && !voice) || (mode !== 'preset' && !detail) ||
      (mode === 'clone' && (!path.isAbsolute(detail) || !/\.(mp3|wav)$/i.test(detail))) ||
      !['mp3', 'wav'].includes(format) || /[\u0000-\u001f\u007f]/.test(apiKey)) throw new Error('语音合成设置不完整');
  return { provider, protocol, baseUrl, apiKey, mode, model, voice, format, detail, style, enabled: true };
}

function forSynthesis(settings, output) {
  return { ...settings,
    tts: { provider: output.provider, baseUrl: output.baseUrl,
      apiKey: output.apiKey, models: { [output.mode]: output.model } },
    voice: { ...settings.voice, ttsMode: output.mode, presetVoice: output.voice, ttsFormat: output.format,
      voiceDesignPrompt: output.mode === 'design' ? output.detail : '', speakStyleHint: output.style,
      referenceAudio: output.mode === 'clone' ? output.detail : '' },
  };
}

module.exports = { PRESETS, resolveOutputDraft, forSynthesis };

