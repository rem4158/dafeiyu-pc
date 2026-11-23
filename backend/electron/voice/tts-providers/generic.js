const { mimoPost } = require('../mimo-api');
const { loadSettings } = require('../../brain/settings');
const { getModelVoice } = require('../model-voices');
const { resolveReferenceAudio, loadReferenceAudioDataUrl } = require('../reference-audio');
const { requireTtsModelForMode } = require('../tts-models');
const { stripTextForSpeech } = require('../tts-text');

/**
 * @param {object} message
 */
function extractAudioBase64(message) {
  const audio = message?.audio;
  if (!audio) return null;
  if (typeof audio === 'string') return audio;
  if (typeof audio.data === 'string') return audio.data;
  return null;
}

/**
 * 通用 TTS：仅文本 + 静态风格，不做导演模式
 * @param {{
 *   text: string,
 *   modelId?: string,
 *   emotion?: string | null,
 *   scene?: string | null,
 * }} opts
 */
async function synthesizeGeneric(opts) {
  const clean = stripTextForSpeech(opts.text, { preserveProviderTags: false });
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

  const styleHint = voiceSettings.speakStyleHint?.trim() || profile.speakStyleHint || '';

  if (mode === 'clone') {
    if (!ref) {
      throw new Error('参考音克隆需要先在设置中选择 mp3/wav 参考音频');
    }
    messages.push({ role: 'user', content: '' });
    messages.push({ role: 'assistant', content: clean });
    audio.voice = ref;
  } else if (mode === 'preset' || mode === 'preset+rvc') {
    messages.push({ role: 'user', content: styleHint || '自然口语化中文朗读。' });
    messages.push({ role: 'assistant', content: clean });
    audio.voice = voiceSettings.presetVoice || profile.presetVoice || '冰糖';
  } else {
    const design = voiceSettings.voiceDesignPrompt?.trim() || profile.voiceDesignPrompt || '';
    const userContent = [design, styleHint].filter(Boolean).join('\n\n');
    if (!userContent) {
      throw new Error('缺少音色描述（voiceDesignPrompt）');
    }
    messages.push({ role: 'user', content: userContent });
    messages.push({ role: 'assistant', content: clean });
  }

  const data = await mimoPost('/chat/completions', { model, messages, audio },
    { timeoutMs: 45000, signal: opts.signal, settings: opts.settings });
  const audioBase64 = extractAudioBase64(data.choices?.[0]?.message);
  if (!audioBase64) {
    throw new Error('TTS 未返回音频');
  }

  return { audioBase64, format: audioFormat, provider: 'generic' };
}

module.exports = { synthesizeGeneric, extractAudioBase64 };
