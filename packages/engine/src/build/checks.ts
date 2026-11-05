// rafi runs the checks and records them (ARCH 6.9, decision 5). One executor for builder, QA and rafi's own runs:
// the OS sandbox prefix from the grants (or none once the no-sandbox warning was accepted), the test allowlist
// (7.12: the base set, cache variables under .rafi/cache/, checks.env), the quiet and total limits on deps.clock,
// per-test results for Jest-shaped runners, the tree before and after (changed-code; QA's runs restored). The check
// step reruns only stale runs (related files).
import path from "node:path";
import type { Engine } from "../api/engine.js";
import { splitCommand } from "../agents/shellForms.js";
import type { Deps, Grants } from "../deps/types.js";
import { boundary } from "../deps/hooks.js";
import { throwIfStopped, type StopControl } from "./stop.js";
import { changedBetween, restoreTree, snapshot } from "../facts/snapshot.js";
import { quoted } from "../instructions/assemble.js";
import { escapeControl } from "../log/redact.js";
import { requirementCheckProblem, type CheckRules } from "../tools/session.js";
import { nextRun, runsOf, type RunRecord } from "../facts/runs.js";
import { testEnv } from "../agents/env.js";
import { optionalBlob } from "../log/blobs.js";
import { sandboxPrefix, type SandboxTool } from "../ask/grants.js";

export interface CheckEnv {
  readonly deps: Deps;
  readonly engine: Engine;
  readonly project: string;
  readonly run: string;
  readonly ticket: string;
  readonly grants: Grants;
  /** null: no sandbox on this machine and the warning was accepted (C60). */
  readonly sandbox: SandboxTool | null;
  readonly runner: readonly string[] | null;
  readonly quietMs: number;
  readonly limitMs: number;
  readonly outputPaths: readonly string[];
  /** `checks.env`: names passed through from the shell to every test run (ARCH 7.12, FMT-C28). */
  readonly checksEnv: readonly string[];
  /** C137: a stop now aborts the run; the step then records no outcome. */
  readonly control?: StopControl;
}

type Test = { name: string; file: string | null; outcome: string; error: string | null };
/** `after`: the worktree's tree after the run (null without a commit), the next run's `before` (slice 0, M4). */
export type Executed = { record: RunRecord & { tests: Test[] }; text: string; after: string | null };

const JEST_LIKE: ReadonlySet<string> = new Set(["jest", "fake-test"]);

/** Jest-shaped runners take `--json --outputFile` (per-test results) and `--listTests --findRelatedTests`. */
export function jestLike(argv: readonly string[]): boolean {
  return JEST_LIKE.has(argv[0] === "npx" ? argv[1] ?? "" : argv[0] ?? "");
}

async function events(engine: Engine) {
  const out: { type: string; ticket_id: string | null; data: unknown }[] = [];
  for await (const e of engine.events()) out.push(e);
  return out;
}

function cachePath(project: string): string {
  return path.join(project, ".rafi", "cache");
}

/** Every test run's environment (the test allowlist) and the declared names that aren't set. */
function environment(env: CheckEnv) {
  return testEnv(env.deps.env, { checksEnv: env.checksEnv, cache: cachePath(env.project),
    platform: env.deps.machine.platform });
}

/** Every string in a parsed report redacted: test names and file names can hold a declared value too (NEW-SEC-8). */
function redactAll(input: unknown, redact: (t: string) => string): unknown {
  if (typeof input === "string") return redact(input);
  if (Array.isArray(input)) return input.map((item) => redactAll(item, redact));
  if (input && typeof input === "object") {
    return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, redactAll(item, redact)]));
  }
  return input;
}

/**
 * Per-test results from the runner's JSON report. The report sits in the worktree, where agents can read it, and
 * holds the tests' raw failure messages, which may hold a declared secret (M2 plan 11): once read, it's rewritten
 * with every string redacted (the fix step reads it again), or removed if it can't be read.
 */
async function perTest(env: CheckEnv, file: string): Promise<Test[]> {
  const { fs } = env.deps;
  if (!(await fs.stat(file))) return [];
  try {
    const report = JSON.parse(await fs.read(file)) as { testResults?: { name: string;
      assertionResults?: { title: string; status: string; failureMessages?: string[] }[] }[] };
    const results = report.testResults ?? [];
    await fs.writeAtomic(file, JSON.stringify({ testResults: redactAll(results, (t) => env.engine.redact(t)) }));
    return results.flatMap((r) => (r.assertionResults ?? []).map((a) => ({ name: a.title,
      file: path.relative(env.project, r.name), outcome: a.status,
      error: a.failureMessages?.[0] === undefined ? null : env.engine.redact(a.failureMessages[0]) })));
  } catch {
    await fs.remove(file);
    return [];
  }
}

/** Spawns one run with the time limits: quiet for quietMs → timed-out; still going at limitMs → too-slow. */
async function spawn(env: CheckEnv, argv: string[]) {
  const { deps } = env;
  const cache = cachePath(env.project);
  await deps.fs.mkdir(path.join(cache, "tmp"));
  const controller = new AbortController();
  let reason: "quiet" | "limit" | null = null;
  const stop = (why: "quiet" | "limit") => { reason ??= why; controller.abort(); };
  let quiet = deps.clock.timer(env.quietMs, () => stop("quiet"), "timeout");
  const limit = deps.clock.timer(env.limitMs, () => stop("limit"), "timeout");
  const prefix = env.sandbox ? sandboxPrefix({ tool: env.sandbox, worktree: env.project, cache, grants: env.grants })
    : [];
  const halt = () => controller.abort();
  env.control?.now.signal.addEventListener("abort", halt, { once: true });
  try {
    const result = await deps.checks.run(argv[0]!, argv.slice(1), { cwd: env.project, grants: env.grants,
      env: environment(env).env, sandbox: prefix, signal: controller.signal,
      onOutput: () => { quiet(); if (!controller.signal.aborted) quiet = deps.clock.timer(env.quietMs,
        () => stop("quiet"), "timeout"); } });
    return { result, reason };
  } finally {
    quiet();
    limit();
    env.control?.now.signal.removeEventListener("abort", halt);
  }
}

/**
 * What run_check returns to the agent. Test names, errors and output are untrusted (ARCH 1.2, 10.3): redacted,
 * control characters escaped, and only inside one quoted block.
 */
function summary(r: RunRecord, tests: readonly Test[], output: string, redact: (t: string) => string): string {
  const lines = [`run ${r.run}: \`${redact(r.command)}\` ${r.outcome} (exit ${r.exit_code ?? "none"}) in ` +
    `${((r.duration_ms ?? 0) / 1000).toFixed(1)}s.`];
  const details = tests.filter((t) => t.outcome === "failed")
    .map((t) => `- ${t.file ?? "?"} › ${t.name}: ${(t.error ?? "").split("\n")[0]}`);
  if (details.length) details.unshift("Failing tests:");
  const excerpt = output.split("\n").filter(Boolean).slice(0, 20).join("\n");
  if (excerpt && r.outcome !== "passed") details.push("Output excerpt:", excerpt);
  if (details.length) lines.push("As the test run printed it:", untrusted(details.join("\n"), redact));
  lines.push(`Read the full output with check_output(${r.run}).`);
  return lines.join("\n");
}

/** Untrusted text for an agent: redacted, control characters escaped, quoted. */
export function untrusted(text: string, redact: (t: string) => string): string {
  return quoted(escapeControl(redact(text)));
}

/** Runs one accepted command, records `check.run` (`defer`: the caller appends it, as a CI point does once it knows
 * the fix ticket the run belongs to, M5 C271), and returns the record and the text the agent gets. */
export async function executeCheck(env: CheckEnv, argv: string[], askedBy: "builder" | "qa" | "rafi",
  known?: string, defer = false): Promise<Executed> {
  const { deps, engine } = env;
  // M4 slice 0: the check step passes the tree it just took (nothing ran since), saving one snapshot per run.
  const before = known ? { ok: true as const, tree: known } : await snapshot(deps, env.project, "before",
    { files: false });
  const tree = before.ok ? before.tree : "none";
  const run = nextRun(await events(engine), env.ticket);
  const json = path.join(cachePath(env.project), `run-${env.ticket}-${run}.json`);
  const extra = jestLike(argv) ? ["--json", `--outputFile=${json}`] : [];
  await boundary(deps.hooks, `10: before test run ${run} (${env.ticket})`);
  throwIfStopped(env.control);
  const { result, reason } = await spawn(env, [...argv, ...extra]);
  throwIfStopped(env.control);
  const after = await snapshot(deps, env.project, "after", { files: false });
  const changed = before.ok && after.ok ? (await changedBetween(deps, env.project, before.tree, after.tree))
    .filter((f) => !env.outputPaths.some((p) => f.startsWith(p))) : [];
  let outcome = reason === "quiet" ? "timed-out" : reason === "limit" ? "too-slow"
    : result.code === 0 ? "passed" : "failed";
  let restored: string[] = [];
  if (changed.length && askedBy === "qa" && before.ok) {
    await restoreTree(deps, env.project, before.tree, changed);
    const back = await snapshot(deps, env.project, "restored", { files: false });
    if (!back.ok || (await changedBetween(deps, env.project, before.tree, back.tree))
      .some((f) => !env.outputPaths.some((p) => f.startsWith(p)))) {
      throw new Error(`rafi couldn't put back the files QA's test run changed (${changed.join(", ")})`);
    }
    restored = changed;
  } else if (changed.length && outcome !== "timed-out" && outcome !== "too-slow") {
    outcome = "changed-code";
  }
  const tests = extra.length ? await perTest(env, json) : [];
  const record = { run, ticket: env.ticket, command: argv.join(" "), asked_by: askedBy, tree,
    exit_code: reason ? null : result.code, outcome, tests: tests.map(({ error: _e, ...t }) => t),
    duration_ms: result.durationMs,
    output: await optionalBlob(engine, result.output, { what: `test run ${run}'s output`,
      key: `${env.ticket}:check:run-${run}`, run: env.run, ticket: env.ticket }),
    changed_tracked: askedBy === "qa" ? [] : changed, restored, refused: null,
    sandbox: env.sandbox ? "os" as const : "none" as const, env_missing: environment(env).missing };
  const event = { type: "check.run", run_id: env.run, ticket_id: env.ticket, actor: "engine", data: record };
  if (!defer) await engine.append([event]);
  await boundary(deps.hooks, `10: after test run ${run} (${env.ticket})`);
  return { record: { ...record, tests }, text: summary(record, tests, result.output, (t) => engine.redact(t)),
    after: after.ok ? after.tree : null };
}

/** A refused run_check request, recorded (`outcome: refused`) with the reason the agent is given. */
export async function refuseCheck(env: CheckEnv, command: string, reason: string,
  askedBy: "builder" | "qa" | "rafi") {
  const run = nextRun(await events(env.engine), env.ticket);
  await env.engine.append([{ type: "check.run", run_id: env.run, ticket_id: env.ticket, actor: "engine", data: {
    run, ticket: env.ticket, command, asked_by: askedBy, tree: "none", exit_code: null, outcome: "refused", tests: [],
    duration_ms: 0, output: null, changed_tracked: [], restored: [], refused: reason,
    sandbox: env.sandbox ? "os" : "none", env_missing: environment(env).missing } }]);
  return `run ${run}: refused — ${reason}.`;
}

/**
 * The runner's related-files query (C44), as worktree-relative test files; null when there's none or it failed.
 * It runs through the same executor as a test (the runner's config can run code): the sandbox, the cache
 * variables and the quiet and total limits.
 */
/** The related-tests listing runs the test runner (so it may change files); without one, nothing runs. */
export function listsRelated(env: CheckEnv, changed: readonly string[]): boolean {
  return Boolean(env.runner && jestLike(env.runner) && changed.length);
}

export async function relatedTests(env: CheckEnv, changed: readonly string[]): Promise<string[] | null> {
  if (!listsRelated(env, changed)) return null;
  const { result, reason } = await spawn(env, [...env.runner!, "--listTests", "--findRelatedTests", ...changed]);
  if (reason || result.code !== 0) return null;
  return result.output.split("\n").map((f) => f.trim()).filter(Boolean).map((f) => path.relative(env.project, f));
}

async function related(env: CheckEnv, changed: readonly string[]): Promise<Set<string> | null> {
  const list = await relatedTests(env, changed);
  return list ? new Set(list) : null;
}

/** A passing run is fresh while nothing it depends on changed since its tree (C44's fallback: any change). */
async function fresh(env: CheckEnv, run: RunRecord, tree: string): Promise<boolean> {
  if (run.outcome !== "passed" || !run.tree || run.tree === "none") return false;
  const changed = (await changedBetween(env.deps, env.project, run.tree, tree))
    .filter((f) => !env.outputPaths.some((p) => f.startsWith(p)));
  if (!changed.length) return true;
  const split = splitCommand(run.command);
  const files = (split.ok ? split.argv.slice(env.runner?.length ?? 0) : []).filter((a) => !a.startsWith("-"));
  const rel = await related(env, changed);
  if (!rel || !files.length) return false;
  return !files.some((f) => rel.has(path.normalize(f)));
}

export interface StepResult {
  readonly outcome: "passed" | "failed" | "too-slow";
  readonly runs: number[];
  readonly reused: number[];
  readonly failing: { req: number; run: number }[];
  readonly records: RunRecord[];
}

/**
 * The check step (ARCH 4.2, 6.9): every check needs a fresh passing run; only stale ones rerun. Each command comes
 * from a repository file (the ticket's required_tests or the requirements file), so it passes run_check's rules
 * first (C43); one that doesn't is refused and recorded, and counts as failing: it never runs and never passes.
 */
export async function checkStep(env: CheckEnv, checks: readonly { req: number; command: string }[],
  rules: CheckRules, taken?: string): Promise<StepResult> {
  // M4 slice 0: the caller's tree when nothing ran since it took it.
  const now = taken ? { ok: true as const, tree: taken } : await snapshot(env.deps, env.project, "step",
    { files: false });
  const tree = now.ok ? now.tree : "none";
  let known: string | null = now.ok ? now.tree : null;
  const runs: number[] = [];
  const reused: number[] = [];
  const failing: { req: number; run: number }[] = [];
  const records: RunRecord[] = [];
  let slow = false;
  for (const check of checks) {
    const problem = requirementCheckProblem(check.command, rules);
    const split = splitCommand(check.command);
    if (problem || !split.ok) {
      await refuseCheck(env, check.command, problem ?? "it isn't one test command", "rafi");
      const refused = runsOf(await events(env.engine), env.ticket).at(-1)!;
      records.push(refused);
      failing.push({ req: check.req, run: refused.run });
      continue;
    }
    const last = runsOf(await events(env.engine), env.ticket).filter((r) => r.command === check.command).at(-1);
    if (last && (await fresh(env, last, tree))) {
      reused.push(last.run);
      records.push(last);
      continue;
    }
    const out = await executeCheck(env, split.argv, "rafi", known ?? undefined);
    known = out.after;
    runs.push(out.record.run);
    records.push(out.record);
    if (out.record.outcome === "too-slow") slow = true;
    else if (out.record.outcome !== "passed") failing.push({ req: check.req, run: out.record.run });
  }
  const outcome = failing.length ? "failed" : slow ? "too-slow" : "passed";
  return { outcome, runs, reused, failing, records };
}
