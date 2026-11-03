// Real time and timers. The only engine file allowed to touch them (ARCH 2.4).
import type { Clock } from "../types.js";

export function realClock(): Clock {
  return {
    now: () => new Date(),
    timer(ms, fn) {
      const handle = setTimeout(fn, ms);
      return () => clearTimeout(handle);
    },
    sleep(ms, _kind, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const handle = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
        const onAbort = () => {
          clearTimeout(handle);
          reject(signal?.reason);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}
