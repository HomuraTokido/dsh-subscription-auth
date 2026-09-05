const MIN_INTERVAL_MS = 1e3;
const DEFAULT_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INCREMENT_MS = 5e3;
function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
async function pollDeviceFlow(options) {
  const deadline = typeof options.expiresInSeconds === "number" ? Date.now() + options.expiresInSeconds * 1e3 : Number.POSITIVE_INFINITY;
  let intervalMs = Math.max(
    MIN_INTERVAL_MS,
    Math.floor((options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) * 1e3)
  );
  let slowDowns = 0;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new Error("aborted");
    const result = await options.poll();
    if (result.status === "complete") return result.value;
    if (result.status === "failed") throw new Error(result.message);
    if (result.status === "slow_down") {
      slowDowns += 1;
      intervalMs = Math.max(MIN_INTERVAL_MS, intervalMs + SLOW_DOWN_INCREMENT_MS);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining), options.signal);
  }
  throw new Error(
    slowDowns > 0 ? "\u8BBE\u5907\u6388\u6743\u8D85\u65F6\uFF08\u591A\u6B21 slow_down\uFF0C\u53EF\u80FD\u662F\u65F6\u949F\u6F02\u79FB\uFF09" : "\u8BBE\u5907\u6388\u6743\u8D85\u65F6"
  );
}
export {
  pollDeviceFlow,
  sleep
};
