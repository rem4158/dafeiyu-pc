/**
 * 本地文本相似度（无外部 embedding API）
 * 供记忆检索、画像 revision 检查等复用
 */

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * @param {string} text
 * @returns {number[]}
 */
function simpleEmbedding(text) {
  const input = String(text || '');
  /** @type {number[]} */
  const features = [];

  features.push(input.length / 1000);

  const emotionWords = {
    joy: ['开心', '高兴', '快乐', '幸福', '棒', '喜欢', '爱'],
    sadness: ['难过', '伤心', '哭', '委屈', '心疼'],
    anger: ['生气', '讨厌', '烦', '气死', '愤怒'],
    curiosity: ['什么', '为什么', '怎么', '如何', '吗'],
    empathy: ['理解', '辛苦', '心疼', '抱抱', '陪你'],
    contentment: ['满足', '舒服', '惬意', '安心'],
    excitement: ['太棒了', '耶', '兴奋', '激动'],
    surprise: ['诶', '咦', '哇', '真的吗'],
    trust: ['相信', '信任', '当然', '一定'],
    warmth: ['温暖', '温柔', '贴心', '暖心'],
  };

  for (const words of Object.values(emotionWords)) {
    let count = 0;
    for (const word of words) {
      if (input.includes(word)) count++;
    }
    features.push(count / words.length);
  }

  features.push((input.match(/[！!？?。.]/g) || []).length / 100);
  features.push((input.match(/我|你|他|她|它/g) || []).length / 100);

  return features;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function textSimilarity(a, b) {
  const left = String(a || '').trim();
  const right = String(b || '').trim();
  if (!left || !right) return left === right ? 1 : 0;
  return cosineSimilarity(simpleEmbedding(left), simpleEmbedding(right));
}

module.exports = {
  cosineSimilarity,
  simpleEmbedding,
  textSimilarity,
};
