// One-time generator for F-LEGACY and F-LEGACY-RUNNING (SCN 2.1, plan choice C19): runs 0.10.2 itself
// (packages/rafi/src/index.ts under tsx) against today's Codex fake, the flow of rafi/test/e2eWorkflow.test.ts,
// then freezes the project with a manifest of the paths git tracks. F-LEGACY-RUNNING's build is killed by the
// fake's one-shot `hang` fault on the builder's first turn, then SIGKILLed, so its 0.10.x run stays unfinished.
// Run once: node packages/scenarios/fixtures/legacy/generate.mjs
// The blocked ticket and saved answer S-MIG-1 needs are left for M9 (C19).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../..");
const rafiPkg = path.join(repo, "packages", "rafi");
const cli = path.join(rafiPkg, "src", "index.ts");
const codexFake = path.join(rafiPkg, "test", "fixtures", "e2e-codex-faults.cjs");
const env = { GIT_AUTHOR_NAME: "Rafi Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", TZ: "UTC",
  GIT_COMMITTER_NAME: "Rafi Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" };

function run(root, args, extra = {}, accept = [0]) {
  const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: rafiPkg, encoding: "utf8", timeout: 180_000,
    env: { ...process.env, ...env, ...extra, PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}` },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (!accept.includes(result.status)) {
    throw new Error(`rafi ${args.join(" ")} exited ${result.status} (${result.signal ?? ""}):\n${output.slice(-3000)}`);
  }
  return output;
}

function gitIn(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

export function project(state, oplog) {
  const root = mkdtempSync(path.join(tmpdir(), "rafi-legacy-gen-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "legacy-fixture", private: true }, null, 2));
  writeFileSync(path.join(root, "README.md"), "# Legacy fixture\n");
  writeFileSync(path.join(root, ".gitignore"), "bin/\n");
  mkdirSync(path.join(root, "bin"));
  copyFileSync(codexFake, path.join(root, "bin", "codex"));
  chmodSync(path.join(root, "bin", "codex"), 0o755);
  gitIn(root, ["add", "-A"]);
  gitIn(root, ["commit", "-qm", "fixture baseline"]);
  const extra = { RAFI_E2E_FAULT_STATE: state, RAFI_E2E_OPLOG: oplog };
  run(root, ["create", root, "--defaults", "--no-graph", "--runtime", "codex"], extra);
  const configPath = path.join(root, "rafi-config.yaml");
  const config = parse(readFileSync(configPath, "utf8"));
  config.qa_preparation = false;
  writeFileSync(configPath, stringify(config));
  run(root, ["plan", root, "--brief", "Add a small safe feature", "--agent", "codex", "--yes", "--no-grill-me"], extra);
  run(root, ["tickets", "setup:init", "--project", root, "--defaults", "--population-mode", "approved_plan"], extra);
  run(root, ["tickets", "populate", "--project", root, "--agent", "codex", "--yes"], extra);
  gitIn(root, ["add", "-A"]);
  gitIn(root, ["commit", "-qm", "rafi setup, plan and tickets"]);
  return { root, extra };
}

export function start(root, extra, fault) {
  const args = ["start", root, "--steps", "1", "--no-qa", "--yes", "--agent", "codex", "--dirty-work", "include"];
  return run(root, args, fault ? { ...extra, RAFI_E2E_FAULT: fault } : extra, fault ? [null, 0, 1, 2, 137] : [0]);
}

/** Starts a build whose first `op` turn hangs, then SIGKILLs the whole process tree, like a power cut. */
async function startAndKill(root, extra, op) {
  const args = ["--import", "tsx", cli, "start", root, "--steps", "1", "--no-qa", "--yes", "--agent", "codex",
    "--dirty-work", "include"];
  const child = spawn(process.execPath, args, { cwd: rafiPkg, detached: true, stdio: "ignore",
    env: { ...process.env, ...env, ...extra, RAFI_E2E_FAULT: `${op}:hang`,
      PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}` } });
  const marker = path.join(extra.RAFI_E2E_FAULT_STATE, `${op}.hang.fired`);
  const deadline = Date.now() + 120_000;
  while (!existsSync(marker)) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`the ${op} turn never started`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  process.kill(-child.pid, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 500));
}

function unfinishedRun(root) {
  const require = createRequire(path.join(repo, "packages", "ai-foreman", "package.json"));
  const Database = require("better-sqlite3");
  const db = new Database(path.join(root, ".rafi", "recovery.sqlite3"), { readonly: true });
  try {
    const row = db.prepare(`SELECT run_id, status FROM workflow_runs WHERE kind = 'build'
      AND status NOT IN ('completed', 'cancelled', 'superseded') ORDER BY updated_at DESC LIMIT 1`).get();
    return row ? row.run_id : null;
  } finally {
    db.close();
  }
}

function freeze(root, name, extraManifest) {
  const dest = path.join(here, name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const tracked = gitIn(root, ["ls-files"]).trim().split("\n").filter(Boolean);
  cpSync(root, path.join(dest, "project"), { recursive: true,
    filter: (src) => !/^(\.git|bin)([/\\]|$)/.test(path.relative(root, src)) });
  const manifest = { generatedWith: "@rafi-ai/cli 0.10.2 + ai-foreman 2.0.2, e2e-codex-faults.cjs", tracked,
    ...extraManifest };
  writeFileSync(path.join(dest, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const scratch = mkdtempSync(path.join(tmpdir(), "rafi-legacy-state-"));
  const finished = project(path.join(scratch, "a"), path.join(scratch, "a.oplog"));
  start(finished.root, finished.extra);
  const ops = readFileSync(path.join(scratch, "a.oplog"), "utf8").trim().split("\n");
  console.log(`F-LEGACY operations: ${[...new Set(ops)].join(", ")}`);
  const legacy = freeze(finished.root, "F-LEGACY", { unfinishedRun: unfinishedRun(finished.root) });
  console.log(`F-LEGACY: ${legacy.tracked.length} tracked files, unfinished run ${legacy.unfinishedRun}`);

  const builderOp = process.argv[2] ?? ops.find((op) => /builder|work|implement/i.test(op)) ?? ops.at(-1);
  const running = project(path.join(scratch, "b"), path.join(scratch, "b.oplog"));
  await startAndKill(running.root, running.extra, builderOp);
  const runId = unfinishedRun(running.root);
  if (!runId) throw new Error(`a hang and SIGKILL at ${builderOp} left no unfinished build`);
  const runningManifest = freeze(running.root, "F-LEGACY-RUNNING", { unfinishedRun: runId, killedAt: builderOp });
  console.log(`F-LEGACY-RUNNING: unfinished run ${runningManifest.unfinishedRun} (killed at ${builderOp})`);
}
