// The crash boundaries of ARCH 4.6 (P34, C164): at each one the pause hook is awaited first, then the crash hook,
// with the same name, so `pause.at(k)` and `crash.at(k)` name the same point. Both are no-ops in production.
import type { Hooks } from "./types.js";

export async function boundary(hooks: Hooks, name: string): Promise<void> {
  await hooks.pause(name);
  hooks.crash(name);
}
