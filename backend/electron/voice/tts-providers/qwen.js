const { loadSettings } = require('../../brain/settings');
const { getModelVoice } = require('../model-voices');
const { requireTtsModelForMode, isQwenInstructModel } = require('../tts-models');
const { stripTextForSpeech } = require('../tts-text');
const { buildQwenInstructions } = require('../tts-style');
const { qwenTtsPost, extractQwenAudio } = require('../qwen-tts-api');

/**
 * 通义千问 TTS：input.text + input.voice + 可选 input.instructions
 * @param {{
 *   text: string,
 *   modelId?: string,
 *   emotion?: string | null,
 *   scene?: string | null,
 *   openingReason?: string | null,
 *   styleHint?: string | null,
 * }} opts
 */
async function synthesizeQwen(opts) {
  const clean = stripTextForSpeech(opts.text, { preserveProviderTags: false });
  if (!clean) {
    throw new Error('没有可朗读的文本');
  }

  const modelId = opts.modelId || 'shenshen';
  const settings = opts.settings || loadSettings();
  const profile = getModelVoice(modelId);
  const voiceSettings = settings.voice || {};
  let mode = settings.voice?.ttsMode || profile.ttsMode || 'design';
  if (mode === 'clone') {
    throw new Error('Qwen TTS 暂不支持参考音克隆，请改用音色设计或预设音色');
  }

  const model = requireTtsModelForMode(settings, mode);
  const voice = (voiceSettings.presetVoice || profile.presetVoice || 'Cherry').trim() || 'Cherry';

  /** @type {Record<string, unknown>} */
  const input = {
    text: clean,
    voice,
    language_type: 'Chinese',
  };

  if (isQwenInstructModel(model)) {
    const instructions = buildQwenInstructions({
      voiceDesignPrompt: voiceSettings.voiceDesignPrompt || profile.voiceDesignPrompt,
      speakStyleHint: voiceSettings.speakStyleHint || profile.speakStyleHint,
      emotion: opts.emotion,
      scene: opts.scene,
      openingReason: opts.openingReason,
      styleHint: opts.styleHint,
    });
    if (instructions) {
      input.instructions = instructions;
      input.optimize_instructions = true;
    }
  }

  const officialPreset = Boolean(opts.settings);
  const data = await qwenTtsPost({ model, input }, { timeoutMs: 45000, settings, signal: opts.signal, officialPreset });
  const audio = await extractQwenAudio(data, { timeoutMs: 30000, signal: opts.signal, officialPreset });
  if (!audio?.audioBase64) {
    throw new Error('Qwen TTS 未返回音频');
  }

  return { audioBase64: audio.audioBase64, format: audio.format || 'wav', provider: 'qwen' };
}

module.exports = { synthesizeQwen };
