const fs = require('fs');
const path = require('path');

/** @type {Map<string, string>} */
const refDataUrlCache = new Map();

const MAX_REF_SECONDS = 12;

/**
 * @param {string} relOrAbs
 */
function toReferenceAudioAbs(relOrAbs) {
  if (!relOrAbs) return null;
  return path.isAbsolute(relOrAbs)
    ? relOrAbs
    : path.join(__dirname, '..', '..', relOrAbs.replace(/^\.\//, ''));
}

/**
 * @param {Buffer} buf
 * @param {number} maxSeconds
 */
function trimWavBuffer(buf, maxSeconds = MAX_REF_SECONDS) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return buf;

  const sampleRate = buf.readUInt32LE(24);
  const numChannels = buf.readUInt16LE(22);
  const bitsPerSample = buf.readUInt16LE(34);
  if (!sampleRate || !numChannels || bitsPerSample !== 16) return buf;

  const dataIdx = buf.indexOf('data');
  if (dataIdx < 0) return buf;
  const pcmStart = dataIdx + 8;
  const pcm = buf.slice(pcmStart);

  const bytesPerSec = sampleRate * numChannels * 2;
  const maxPcmBytes = Math.floor(maxSeconds * bytesPerSec);
  if (pcm.length <= maxPcmBytes) return buf;

  const trimmedPcm = pcm.slice(0, maxPcmBytes);
  const out = Buffer.alloc(pcmStart + trimmedPcm.length);
  buf.copy(out, 0, 0, pcmStart);
  out.writeUInt32LE(36 + trimmedPcm.length, 4);
  out.write('data', dataIdx);
  out.writeUInt32LE(trimmedPcm.length, dataIdx + 4);
  trimmedPcm.copy(out, pcmStart);
  return out;
}

/**
 * @param {string} abs
 */
function loadReferenceAudioDataUrlFromAbs(abs) {
  if (!abs || !fs.existsSync(abs)) return null;

  const stat = fs.statSync(abs);
  if (!stat.isFile()) return null;
  const cacheKey = `${abs}:${stat.mtimeMs}:${stat.size}:${MAX_REF_SECONDS}`;
  const cached = refDataUrlCache.get(cacheKey);
  if (cached) return cached;

  const ext = path.extname(abs).toLowerCase();
  if (ext !== '.mp3' && ext !== '.wav') return null;

  if (stat.size > 10 * 1024 * 1024) throw new Error('参考音频不能超过 10 MB');
  let bytes = fs.readFileSync(abs);
  if (ext === '.wav') {
    bytes = trimWavBuffer(bytes, MAX_REF_SECONDS);
  }

  const mime = ext === '.mp3' ? 'audio/mpeg' : 'audio/wav';
  const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
  refDataUrlCache.set(cacheKey, dataUrl);
  return dataUrl;
}

/**
 * @param {string} referenceAudioRel
 */
function loadReferenceAudioDataUrl(referenceAudioRel) {
  return loadReferenceAudioDataUrlFromAbs(toReferenceAudioAbs(referenceAudioRel));
}

/**
 * @param {string} modelId
 * @param {string | null | undefined} referenceAudioRel
 */
function resolveReferenceAudio(modelId, referenceAudioRel) {
  const candidates = [];
  if (referenceAudioRel) {
    candidates.push(referenceAudioRel);
    if (/\.wav$/i.test(referenceAudioRel)) {
      candidates.push(referenceAudioRel.replace(/\.wav$/i, '.mp3'));
    }
  }
  const voiceRel = `./public/models/${modelId}/voice`;
  candidates.push(
    `${voiceRel}/ref.mp3`,
    `${voiceRel}/ref.wav`,
    `${voiceRel}/reference.mp3`,
    `${voiceRel}/reference.wav`,
  );

  for (const rel of candidates) {
    const data = loadReferenceAudioDataUrl(rel);
    if (data) return data;
  }

  const voiceDir = path.join(__dirname, '..', '..', 'public', 'models', modelId, 'voice');
  if (!fs.existsSync(voiceDir)) return null;

  const names = fs
    .readdirSync(voiceDir)
    .filter((name) => /\.(wav|mp3)$/i.test(name))
    .sort();
  for (const name of names) {
    const data = loadReferenceAudioDataUrlFromAbs(path.join(voiceDir, name));
    if (data) return data;
  }

  return null;
}

/**
 * @param {string} modelId
 * @param {string | null | undefined} referenceAudioRel
 */
function hasReferenceAudio(modelId, referenceAudioRel) {
  return Boolean(resolveReferenceAudio(modelId, referenceAudioRel));
}

function clearReferenceAudioCache() {
  refDataUrlCache.clear();
}

module.exports = {
  MAX_REF_SECONDS,
  resolveReferenceAudio,
  hasReferenceAudio,
  clearReferenceAudioCache,
  loadReferenceAudioDataUrl,
};
