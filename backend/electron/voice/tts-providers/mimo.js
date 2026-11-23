const { mimoPost } = require('../mimo-api');
const { loadSettings } = require('../../brain/settings');
const { getModelVoice } = require('../model-voices');
const { resolveReferenceAudio, loadReferenceAudioDataUrl } = require('../reference-audio');
const { requireTtsModelForMode } = require('../tts-models');
const { stripTextForSpeech } = require('../tts-text');
const { buildDynamicDirectorBlock } = require('../tts-style');
const { extractAudioBase64 } = require('./generic');

/**
 * MiMo TTS：导演模式 user 指令 + assistant 台词（含可选风格前缀）
 * @param {{
 *   text: string,
 *   modelId?: string,
 *   emotion?: string | null,
 *   scene?: string | null,
 *   openingReason?: string | null,
 *   styleHint?: string | null,
 * }} opts
 */
async function synthesizeMimo(opts) {
  const clean = stripTextForSpeech(opts.text, { preserveProviderTags: true });
  if (!clean) {
    throw new Error('没有可朗读的文本');
  }

  const modelId = opts.modelId || 'shenshen';
  const settings = opts.settings || loadSettings();
  const profile = getModelVoice(modelId);
  const voiceSettings = settings.voice || {};
  const referenceAudio = voiceSettings.referenceAudio || profile.referenceAudio;
  let mode = settings.voice?.ttsMode || profile.ttsMode || 'design';
  const ref = opts.settings ? (mode === 'clone' ? loadReferenceAudioDataUrl(referenceAudio) : null)
    : resolveReferenceAudio(modelId, referenceAudio);
  if (mode !== 'preset' && ref && profile.ttsMode === 'clone') {
    mode = 'clone';
  }

  const model = requireTtsModelForMode(settings, mode);
  /** @type {object[]} */
  const messages = [];
  const audioFormat =
    mode === 'clone' ? 'mp3' : mode === 'preset+rvc' ? 'wav' : settings.voice?.ttsFormat || 'mp3';
  /** @type {Record<string, unknown>} */
  const audio = { format: audioFormat };

  const staticStyleHint = voiceSettings.speakStyleHint?.trim() || profile.speakStyleHint || '';
  const directorBlock = buildDynamicDirectorBlock({
    emotion: opts.emotion,
    scene: opts.scene,
    openingReason: opts.openingReason,
    styleHint: opts.styleHint,
  });

  if (mode === 'clone') {
    if (!ref) {
      throw new Error('参考音克隆需要先在设置中选择 mp3/wav 参考音频');
    }
    const cloneHint = directorBlock || staticStyleHint;
    messages.push({ role: 'user', content: cloneHint });
    messages.push({ role: 'assistant', content: clean });
    audio.voice = ref;
  } else if (mode === 'preset' || mode === 'preset+rvc') {
    const userParts = [staticStyleHint, directorBlock].filter(Boolean);
    messages.push({
      role: 'user',
      content: userParts.join('\n\n') || '自然口语化中文朗读。',
    });
    messages.push({ role: 'assistant', content: clean });
    audio.voice = voiceSettings.presetVoice || profile.presetVoice || '冰糖';
  } else {
    const design = voiceSettings.voiceDesignPrompt?.trim() || profile.voiceDesignPrompt || '';
    const userParts = [design, staticStyleHint, directorBlock].filter(Boolean);
    if (!userParts.length) {
      throw new Error('缺少音色描述（voiceDesignPrompt）');
    }
    messages.push({ role: 'user', content: userParts.join('\n\n') });
    messages.push({ role: 'assistant', content: clean });
  }

  const data = await mimoPost('/chat/completions', { model, messages, audio },
    { timeoutMs: 45000, signal: opts.signal, settings: opts.settings });
  const audioBase64 = extractAudioBase64(data.choices?.[0]?.message);
  if (!audioBase64) {
    throw new Error('MiMo TTS 未返回音频');
  }

  return { audioBase64, format: audioFormat, provider: 'mimo' };
}

module.exports = { synthesizeMimo };
