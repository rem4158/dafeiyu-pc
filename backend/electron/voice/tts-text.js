/** MiMo 风格前缀：(开心) （委屈）等 */
const MIMO_STYLE_PREFIX_RE = /^[\s]*[（(]([^）)\]]+)[）)]/;

/**
 * 朗读前清洗：保留 MiMo 风格/音频标签，去掉我们自己的 [表情] 等
 * @param {string} text
 * @param {{ preserveProviderTags?: boolean }} [opts]
 */
function stripTextForSpeech(text, opts = {}) {
  const preserveProviderTags = opts.preserveProviderTags !== false;
  let raw = String(text || '').trim();
  if (/^\[表情包:[^\]]+\]$/.test(raw)) return '';

  raw = raw
    .replace(/\s*\[表情[:：]\s*[^\]\s]+\s*\]/g, '')
    .replace(/\[表情包:[^\]]+\]/g, ' ')
    .replace(/[*_~`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  let stylePrefix = '';
  if (preserveProviderTags) {
    const match = raw.match(MIMO_STYLE_PREFIX_RE);
    if (match) {
      stylePrefix = match[0];
      raw = raw.slice(match[0].length).trim();
    }
    // 去掉舞台说明式括号，保留 [音频标签]
    raw = raw.replace(/[（(][^）)]*[）)]/g, ' ').replace(/\s+/g, ' ').trim();
  } else {
    raw = raw.replace(/[（(][^）)]*[）)]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const combined = `${stylePrefix}${raw}`.trim();
  if (!combined || !/[\p{L}\p{N}]/u.test(combined)) return '';
  return combined;
}

module.exports = { stripTextForSpeech, MIMO_STYLE_PREFIX_RE };
