// The real terminal: process stdin, stdout and stderr, title, SIGINT (or the signals asked for) and resize.
import type { Terminal } from "../types.js";

const quiet = (e: NodeJS.ErrnoException) => { if (e.code !== "EIO" && e.code !== "EPIPE") throw e; };

export function realTerminal(): Terminal {
  // A closed terminal fails reads and writes with EIO (a closed pipe: EPIPE); rafi goes on, the log has it all (C183).
  for (const s of [process.stdin, process.stdout, process.stderr]) s.on("error", quiet);
  return {
    write: (text) => { process.stdout.write(text); },
    error: (text) => { process.stderr.write(text); },
    get isTTY() { return Boolean(process.stdout.isTTY); },
    get columns() { return process.stdout.columns ?? 80; },
    get rows() { return process.stdout.rows ?? 24; },
    setTitle(title) {
      if (process.stdout.isTTY) process.stdout.write(`\u001b]0;${title}\u0007`);
    },
    onInterrupt(fn, signals = ["SIGINT"]) {
      for (const s of signals) process.on(s, fn);
      return () => { for (const s of signals) process.off(s, fn); };
    },
    onResize(fn) {
      process.stdout.on("resize", fn);
      return () => { process.stdout.off("resize", fn); };
    },
    input: process.stdin,
  };
}
