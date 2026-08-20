#!/usr/bin/env node
/** Run every authenticated live interview acceptance journey. */
import { resolve } from "node:path";
import {
  LIVE_SKIP_BUILD_ENV,
  buildWorkspace,
  livePreflightFailures,
  requireLiveAcknowledgement,
  run,
} from "./live-interview-harness.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);

try {
  requireLiveAcknowledgement("Claude and Codex");
  const preflight = livePreflightFailures(["claude", "codex"]);
  if (preflight.failures.length) throw new Error(`preflight failed:\n${preflight.failures.map((failure) => `- ${failure}`).join("\n")}`);
  buildWorkspace(root);
  const childEnv = { [LIVE_SKIP_BUILD_ENV]: "1" };
  run(process.execPath, [resolve(root, "scripts", "live-create.mjs")], { cwd: root, env: childEnv });
  run(process.execPath, [resolve(root, "scripts", "live-ticket-plan.mjs")], { cwd: root, env: childEnv });
} catch (error) {
  console.error(`live interview: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
