const { loadSettings } = require('../brain/settings');

const { getModelVoice } = require('./model-voices');

const { resolveReferenceAudio } = require('./reference-audio');

const { resolveSynthProviderId } = require('./tts-models');

const { synthesizeMimo } = require('./tts-providers/mimo');

const { synthesizeQwen } = require('./tts-providers/qwen');

const { synthesizeGeneric } = require('./tts-providers/generic');
const { synthesizeSpeechEndpoint } = require('./tts-providers/speech');
const { forSynthesis } = require('./speech-output');



/** @type {Record<string, (opts: object) => Promise<{ audioBase64: string, format: string }>>} */

const PROVIDER_IMPL = {

  mimo: synthesizeMimo,

  qwen: synthesizeQwen,

  generic: synthesizeGeneric,

};



/**

 * @param {ReturnType<typeof loadSettings>} settings

 */

function resolveActiveTtsMode(settings, modelId = 'shenshen') {

  const profile = getModelVoice(modelId);

  const voiceSettings = settings.voice || {};

  const referenceAudio = voiceSettings.referenceAudio || profile.referenceAudio;

  const ref = resolveReferenceAudio(modelId, referenceAudio);

  let mode = voiceSettings.ttsMode || profile.ttsMode || 'design';

  if (mode !== 'preset' && ref && profile.ttsMode === 'clone') {

    mode = 'clone';

  }

  return mode;

}



/**

 * @param {{

 *   text: string,

 *   modelId?: string,

 *   emotion?: string | null,

 *   scene?: string | null,

 *   openingReason?: string | null,

 *   styleHint?: string | null,

 * }} opts

 */

async function synthesizeSpeech(opts) {

  const stored = opts.settings || loadSettings();
  const output = stored.speechOutput;
  if (output) {
    const settings = forSynthesis(stored, output);
    const impl = output.protocol === 'speech' ? synthesizeSpeechEndpoint
      : PROVIDER_IMPL[output.protocol] || synthesizeGeneric;
    return impl({ ...opts, settings });
  }

  const modelId = opts.modelId || 'shenshen';

  const mode = resolveActiveTtsMode(stored, modelId);

  const providerId = resolveSynthProviderId(stored, mode);

  const impl = PROVIDER_IMPL[providerId] || synthesizeGeneric;

  return impl({ ...opts, settings: undefined });

}



module.exports = {

  synthesizeSpeech,

  resolveSynthProviderId,

  resolveActiveTtsMode,

};

