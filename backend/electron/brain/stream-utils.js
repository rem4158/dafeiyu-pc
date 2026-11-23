/**
 * 流式响应过程中隐藏未写完的 [表情:…] 尾巴，避免闪一下标签
 * @param {string} raw
 */
function stripPartialEmotionTag(raw) {
  return raw.replace(/\n?\[表情[:：][^\]\n]*$/, '');
}

/**
 * @param {ReadableStream<Uint8Array>} body
 * @param {(line: string) => void} onLine
 */
async function readTextStreamLines(body, onLine) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      onLine(line);
    }
  }

  if (buffer.trim()) onLine(buffer);
}

module.exports = { stripPartialEmotionTag, readTextStreamLines };
