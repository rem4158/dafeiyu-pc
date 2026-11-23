const MODEL_PRESETS = Object.freeze({
  deepseek: Object.freeze({ label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash', keyUrl: 'https://platform.deepseek.com/api_keys' }),
  qwen: Object.freeze({ label: '通义千问 · 百炼（中国内地）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.8-flash', keyUrl: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key' }),
  kimi: Object.freeze({ label: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k3', keyUrl: 'https://platform.kimi.com/console/api-keys' }),
  openai: Object.freeze({ label: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-6-luna', keyUrl: 'https://platform.openai.com/api-keys' }),
});

function getPreset(id) {
  return typeof id === 'string' && Object.hasOwn(MODEL_PRESETS, id) ? MODEL_PRESETS[id] : null;
}

function presetRequestOptions(cloud) {
  const preset = getPreset(cloud?.preset);
  if (!preset || cloud.baseUrl !== preset.baseUrl || cloud.model !== preset.model) return {};
  if (cloud.preset === 'deepseek') return { thinking: { type: 'disabled' } };
  if (cloud.preset === 'qwen') return { enable_thinking: false };
  if (cloud.preset === 'kimi') return { reasoning_effort: 'low' };
  if (cloud.preset === 'openai') return { reasoning: { effort: 'none' } };
  return {};
}

module.exports = { MODEL_PRESETS, getPreset, presetRequestOptions };
