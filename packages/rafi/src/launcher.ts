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

// The engine switch (ARCH 9.1): RAFI_ENGINE is read once. `next` runs the 1.0 layer in this process;
// anything else runs today's 0.10.x layer, after D6's refusal of a 1.0 project (ARCH 9.2).
const engine = process.env.RAFI_ENGINE;
const argv = process.argv.slice(2);
if (engine === "next") {
  const [{ runCli }, { realDeps }] = await Promise.all([import("./next/cli.js"), import("./next/deps.js")]);
  process.exitCode = await runCli(argv, realDeps());
} else {
  const format = await import("./next/format.js");
  const { promises: fsp } = await import("node:fs");
  const fs = {
    readText: (file: string) => fsp.readFile(file, "utf8").catch(() => null),
    isDir: (dir: string) => fsp.stat(dir).then((s) => s.isDirectory(), () => false),
  };
  let refused = false;
  if (!format.isVersionOrHelp(argv)) {
    const projectArg = await format.guessProjectArg(argv, process.cwd(), fs);
    const project = await format.findProject(argv, process.cwd(), fs, projectArg);
    if (project && (await format.readFormat(project, fs)).format === "1.0") {
      console.error(format.OLD_ENGINE_REFUSAL);
      process.exitCode = 1;
      refused = true;
    }
  }
  if (!refused) {
    const { startRafiCli } = await import("./index.js");
    startRafiCli();
  }
}
