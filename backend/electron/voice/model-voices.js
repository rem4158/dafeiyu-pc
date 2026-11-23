// Local pet defaults; explicit saved voice settings always win.
const MODEL_VOICES = { shenshen: { ttsMode: 'preset', presetVoice: '冰糖',
  voiceDesignPrompt: '自然、清晰、温柔的中文声音，日常聊天语气。',
  speakStyleHint: '自然口语化，不夸张拖音。', referenceAudio: null } };
function getModelVoice(id) { return MODEL_VOICES[id] || MODEL_VOICES.shenshen; }
module.exports = { MODEL_VOICES, getModelVoice };
