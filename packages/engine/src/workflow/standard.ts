// The built-in workflow, `standard` (ARCH 4.2, 4.8): prepare → build → check → review → deliver,
// with fix looping back through check and review. The only place the step list is written down.
import type { Workflow } from "./types.js";

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

const FIX_LIMIT = { setting: "retries.fixes", exhausted: "blocked" } as const;

export const standard: Workflow = deepFreeze({
  id: "standard",
  version: 1,
  start: "prepare",
  nodes: [
    { id: "prepare", step: "prepare", state: "building", type: "checker", role: "qa", onPass: "build",
      onFail: "blocked", skipWhenQaOff: true },
    { id: "build", step: "build", state: "building", type: "maker", role: "builder", onPass: "build-check",
      onFail: "blocked" },
    { id: "build-check", step: "check", state: "building", type: "rafi", role: null, onPass: "review",
      onFail: "fix", limit: FIX_LIMIT },
    { id: "review", step: "review", state: "reviewing", type: "checker", role: "qa", onPass: "deliver",
      onFail: "fix", limit: FIX_LIMIT, skipWhenQaOff: true },
    { id: "fix", step: "fix", state: "fixing", type: "maker", role: "builder", onPass: "fix-check",
      onFail: "blocked" },
    { id: "fix-check", step: "check", state: "fixing", type: "rafi", role: null, onPass: "review",
      onFail: "fix", limit: FIX_LIMIT },
    { id: "deliver", step: "deliver", state: "building", type: "rafi", role: null, onPass: "done",
      onFail: "blocked" },
  ],
});
