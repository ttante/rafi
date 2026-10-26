#!/usr/bin/env node
/**
 * Rafi's executable. Checks the runtime before loading the CLI: under an
 * unsupported Node or a mismatched native SQLite build, importing the CLI
 * fails with an opaque SyntaxError or crashes later inside SQLite.
 */
import { runtimePreflightFailure } from "ai-foreman/runtime-preflight.js";

const failure = process.env.RAFI_SKIP_RUNTIME_PREFLIGHT === "1" ? undefined : runtimePreflightFailure();
if (failure) {
  console.error(failure);
  console.error("rafi: set RAFI_SKIP_RUNTIME_PREFLIGHT=1 to bypass this check.");
  process.exit(1);
}
const { startRafiCli } = await import("./index.js");
startRafiCli();
