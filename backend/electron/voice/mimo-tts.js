const { synthesizeSpeech } = require('./tts-synth');
const { stripTextForSpeech } = require('./tts-text');

module.exports = { synthesizeSpeech, stripTextForSpeech };
