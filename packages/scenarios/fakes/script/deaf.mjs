// M4 follow-up 2: a process-mode rule with `ignoreTerm` makes the fake provider deaf to rafi's polite end from that
// turn on: it ignores SIGTERM and stdin's end, and starts a helper child in its own process group that ignores
// SIGTERM too, so only a SIGKILL of the group ends both. Each gives up after 60 s, so a failed run leaves nothing.
import { spawn } from "node:child_process";

const HELPER = "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); setTimeout(() => {}, 60000);";

export function deafness(log) {
  let deaf = false;
  return {
    get on() { return deaf; },
    start() {
      if (deaf) return;
      deaf = true;
      const helper = spawn(process.execPath, ["-e", HELPER], { stdio: "ignore" });
      setTimeout(() => process.exit(0), 60_000);
      log({ op: "deaf", pid: process.pid, helper: helper.pid });
    },
    /** True when the SIGTERM was ignored (logged with the time). */
    term() {
      if (deaf) log({ op: "sigterm-ignored", at: Date.now() });
      return deaf;
    },
  };
}
