const SEARCH_SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });
const SEARCH_STOP_WORDS = new Set([
  '我', '你', '他', '她', '它', '我们', '你们', '他们', '的', '了', '吗', '呢', '呀', '啊', '吧',
  '是', '在', '和', '也', '都', '就', '有', '这', '那', '这个', '那个', '一个', '一下',
  '什么', '怎么', '如何', '为什么', '还', '记得', '记忆', '知道', '说', '说过', '能', '可以',
  'i', 'you', 'the', 'a', 'an', 'is', 'are', 'was', 'to', 'of', 'and', 'do', 'does', 'my',
]);
function normalizeSearchText(text) {
  return String(text || '').normalize('NFKC').toLowerCase();
}
function tokenizeForFactSearch(text) {
  // Word boundaries cover the full sentence, including Chinese subjects at its end.
  // This is lexical retrieval, not a substitute for a semantic embedding model.
  const tokens = [];
  for (const part of SEARCH_SEGMENTER.segment(normalizeSearchText(text))) {
    if (!part.isWordLike || SEARCH_STOP_WORDS.has(part.segment)) continue;
    if (part.segment.length >= 2 || /[\u4e00-\u9fff]/.test(part.segment)) tokens.push(part.segment);
  }
  return [...new Set(tokens)].slice(0, 256);
}

module.exports = { normalizeSearchText, tokenizeForFactSearch };
