/**
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} [label]
 * @returns {Promise<T>}
 * @template T
 */
function withTimeout(promise, ms, label = '请求') {
  /** @type {ReturnType<typeof setTimeout>} */
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label}超时 (${Math.round(ms / 1000)}s)，请稍后再试`));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * @param {number} timeoutMs
 */
function createFetchController(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    controller,
    clear: () => clearTimeout(timer),
  };
}

module.exports = {
  withTimeout,
  createFetchController,
};
