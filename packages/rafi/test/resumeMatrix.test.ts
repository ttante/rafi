// Resume must work wherever a build stops. Each case runs the real CLI against a
// scripted Codex provider (fixtures/e2e-codex-faults.cjs) that misbehaves once at
// one operation, then resumes with `rafi resume --yes` and requires the build to
// finish without any interactive or guided step.
//
// Fault modes: invalid (a required field is missing), crash (the provider exits
// mid-turn), hang (the provider never answers), killhost (the provider kills the
// Rafi process, like a machine restart), and fail (QA reports a real failure, used
// to reach the Builder handoff path).
//
// The default run covers a quick subset. RAFI_RESUME_MATRIX=full runs every case
// (`pnpm test:resume-matrix`); any other value is a ";"-separated case list.
// RAFI_RESUME_MATRIX_LOGS keeps each case's transcript; RAFI_RESUME_MATRIX_KEEP
// keeps the projects.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify } from "yaml";
import { readBuildRuns } from "ai-foreman/build-runs.js";
import { WorkflowDb } from "ai-foreman/workflow-db.js";

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const fixture = fileURLToPath(new URL("fixtures/e2e-codex-faults.cjs", import.meta.url));
const MODES = ["invalid", "crash", "hang", "killhost"] as const;

/** A case is "<faults>" or "prep/<faults>" (QA preparation enabled). */
function fullMatrix(): string[] {
  const cases = ["baseline", "prep/baseline"];
  for (const operation of ["session-initialization", "build-preflight", "work-report", "qa-verdict"]) for (const mode of MODES) cases.push(`${operation}:${mode}`);
  for (const mode of MODES) cases.push(`qa-verdict:fail,handoff-acceptance:${mode}`);
  for (const mode of MODES) cases.push(`qa-verdict:crash,qa-recovery-acceptance:${mode}`);
  for (const operation of ["qa-preparation-draft", "qa-preparation-assessment", "builder-coverage"]) for (const mode of MODES) cases.push(`prep/${operation}:${mode}`);
  return cases;
}

const requested = process.env.RAFI_RESUME_MATRIX;
const cases = requested === "full" ? fullMatrix()
  : (requested ?? "baseline;build-preflight:crash;qa-verdict:invalid").split(";").map(item => item.trim()).filter(Boolean);

function run(root: string, args: string[], env: Record<string, string> = {}): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, ...env, PATH: `${join(root, "bin")}${delimiter}${process.env.PATH ?? ""}` },
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(result.error, undefined, String(result.error));
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function ok(root: string, args: string[]): string {
  const result = run(root, args);
  assert.equal(result.status, 0, result.output);
  return result.output;
}

// Rafi binds local state to the project path, so every case builds its own project.
function project(parent: string, preparation: boolean): string {
  const root = join(parent, `case-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(root);
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Rafi E2E"]);
  execFileSync("git", ["-C", root, "config", "user.email", "e2e@example.test"]);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "rafi-resume-matrix", private: true }));
  writeFileSync(join(root, "README.md"), "# Resume matrix fixture\n");
  mkdirSync(join(root, "bin"));
  copyFileSync(fixture, join(root, "bin", "codex"));
  chmodSync(join(root, "bin", "codex"), 0o755);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture baseline"]);
  ok(root, ["create", root, "--defaults", "--no-graph", "--runtime", "codex"]);
  const configPath = join(root, "rafi-config.yaml");
  const config = parseYaml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.qa_preparation = preparation;
  writeFileSync(configPath, stringify(config), "utf8");
  ok(root, ["plan", root, "--brief", "Add a small safe feature", "--agent", "codex", "--yes", "--no-grill-me"]);
  ok(root, ["tickets", "setup:init", "--project", root, "--defaults", "--population-mode", "approved_plan", "--branch-strategy", "current", "--completion", "none"]);
  ok(root, ["tickets", "populate", "--project", root, "--agent", "codex", "--yes"]);
  return root;
}

function runStatus(root: string): { runId: string; status: string | undefined } {
  const record = readBuildRuns(root)[0];
  assert.ok(record, "start must create a durable build run");
  const db = new WorkflowDb(root);
  try { return { runId: record.runId, status: db.getRun(record.runId)?.status }; } finally { db.close(); }
}

const START = ["--steps", "1", "--yes", "--agent", "codex", "--dirty-work", "include"];

let parent: string;
test.before(() => { parent = mkdtempSync(join(tmpdir(), "rafi-resume-matrix-")); });
test.after(() => { if (!process.env.RAFI_RESUME_MATRIX_KEEP) rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

for (const spec of cases) {
  test(`resume finishes the build after ${spec}`, { timeout: 300_000 }, () => {
    const preparation = spec.startsWith("prep/");
    const faults = preparation ? spec.slice("prep/".length) : spec;
    const name = spec.replace(/[^a-z0-9-]/gi, "_");
    const logs = process.env.RAFI_RESUME_MATRIX_LOGS ?? parent;
    const root = project(parent, preparation);
    // A short idle deadline lets a hung provider fail in seconds instead of 30 minutes.
    const common = { RAFI_PROVIDER_IDLE_TIMEOUT_MS: "8000", RAFI_E2E_OPLOG: join(logs, `${name}.ops`) };
    // Fault markers live outside the project so they never change its source.
    const faultEnv = faults === "baseline" ? common : { ...common, RAFI_E2E_FAULT: faults, RAFI_E2E_FAULT_STATE: `${root}.fault-state` };
    const started = run(root, ["start", root, ...START], faultEnv);
    const transcript = [`$ start (${spec}) -> ${started.status}\n${started.output}`];
    let state = runStatus(root);
    for (let attempt = 1; state.status !== "completed" && attempt <= 3; attempt++) {
      const resumed = run(root, ["resume", root, "--run", state.runId, "--yes"], common);
      transcript.push(`$ resume #${attempt} -> ${resumed.status}\n${resumed.output}`);
      state = runStatus(root);
    }
    const log = transcript.join("\n\n");
    const ops = (() => { try { return readFileSync(common.RAFI_E2E_OPLOG, "utf8").split("\n").filter(Boolean); } catch { return []; } })();
    writeFileSync(join(logs, `${name}.log`), `project: ${root}\n${log}`);
    if (preparation) {
      // The scripted QA cannot produce host-observed contract evidence, so a
      // preparation-mode build stops at final QA by design. Resume must still
      // get past the faulted step and reach implementation and final QA.
      const faulted = faults.split(",").at(-1)!.split(":")[0]!;
      assert.ok(faults === "baseline" || ops.lastIndexOf(faulted) > ops.indexOf(faulted), `${faulted} never ran again after its fault\n${log.slice(-4000)}`);
      assert.ok(ops.includes("work-report") && ops.includes("qa-verdict"), `resume never reached implementation and final QA\n${log.slice(-4000)}`);
      return;
    }
    assert.equal(state.status, "completed", log.slice(-6000));
    assert.match(readFileSync(join(root, "implemented.txt"), "utf8"), /scripted implementation/);
  });
}
