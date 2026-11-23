/**
 * VITS TTS 文本预处理过滤器
 * 处理模型无法正确发音的字符和模式
 */

const LAUGH_REPLACEMENT = '嘿嘿嘿';

const LATIN_TOKEN_REPLACEMENTS = [
  [/\bVITS\b/gi, '维茨'],
  [/\bRVC\b/gi, '阿尔维西'],
  [/\bTTS\b/gi, '文字转语音'],
  [/\bASR\b/gi, '语音识别'],
  [/\bAI\b/gi, '人工智能'],
  [/\bONNX\b/gi, '模型'],
  [/\bLive2D\b/gi, '立绘'],
];

function normalizePunctuation(text) {
  return text
    .replace(/[!！]{2,}/g, '！')
    .replace(/[?？]{2,}/g, '？')
    .replace(/[.。]{3,}/g, '……')
    .replace(/[,，]{3,}/g, '，')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLatinTokens(text) {
  let out = text;
  for (const [pattern, replacement] of LATIN_TOKEN_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/[A-Za-z][A-Za-z0-9+#._-]*/g, '');
}

/**
 * 对文本进行 VITS 模型友好的预处理
 * @param {string} text 原始文本
 * @returns {string} 过滤后的文本
 */
function filterForVits(text) {
  if (!text) return '';

  let out = normalizeLatinTokens(normalizePunctuation(text));

  // 1. 开头的单个"嘿" → "喂"
  out = out.replace(/^嘿(?=[,.!?、\s])/g, '喂');
  // 也处理开头紧跟标点的情况：嘿，→ 喂，
  out = out.replace(/^嘿(?=[^嘿])/g, '喂');

  // 2. "嘿嘿"（双字，不在开头）→ "嘿嘿嘿"
  //    但如果开头已经是"嘿嘿嘿"则不动
  out = out.replace(/嘿嘿(?!嘿)/g, LAUGH_REPLACEMENT);

  // 3. 其他笑声标识 → "嘿嘿嘿"
  out = out.replace(/嘻嘻+/g, LAUGH_REPLACEMENT);
  out = out.replace(/呵呵+/g, LAUGH_REPLACEMENT);
  out = out.replace(/哈哈+/g, LAUGH_REPLACEMENT);

  out = out.replace(/([,.!?;:])\1+/g, '$1');
  out = out.replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, '$1$2');
  out = out.replace(/\s+/g, ' ').trim();

  return out;
}

module.exports = { filterForVits };
