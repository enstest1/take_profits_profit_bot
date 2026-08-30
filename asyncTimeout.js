/**
 * Promise.race timeout. Does not cancel the underlying work — caller must
 * treat a timeout as fatal (exit/restart) if the raced promise may stay hung.
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 * @template T
 */
export function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
