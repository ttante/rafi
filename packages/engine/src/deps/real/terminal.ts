// The real terminal: process stdin, stdout and stderr, title, SIGINT and resize.
import type { Terminal } from "../types.js";

export function realTerminal(): Terminal {
  return {
    write: (text) => { process.stdout.write(text); },
    error: (text) => { process.stderr.write(text); },
    get isTTY() { return Boolean(process.stdout.isTTY); },
    get columns() { return process.stdout.columns ?? 80; },
    get rows() { return process.stdout.rows ?? 24; },
    setTitle(title) {
      if (process.stdout.isTTY) process.stdout.write(`\u001b]0;${title}\u0007`);
    },
    onInterrupt(fn) {
      process.on("SIGINT", fn);
      return () => { process.off("SIGINT", fn); };
    },
    onResize(fn) {
      process.stdout.on("resize", fn);
      return () => { process.stdout.off("resize", fn); };
    },
    input: process.stdin,
  };
}
