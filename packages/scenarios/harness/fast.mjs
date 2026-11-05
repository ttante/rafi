// The gate's two tiers (SCN 7.10), as jobs on RAFI_TEST_CONCURRENCY workers (default 4); `*.real.test.ts` files
// spawn real processes and belong to the process set. Modeled on ai-foreman's test-offline.mjs.
// - Fast (default): the current and previous milestone's scenario and scenarios/test files (tiers.mjs), the
//   engine and spec unit tests (the transition and log tests) and scripts/check-rules.mjs, without the crash
//   enumerations (tiers.mjs; plan 10.12); fails on any failure or over 60 s of wall time.
// - Full (`--full`): every file, including the crash enumerations; fails on any failure; its time is reported,
//   with no limit.
// Both fail when a file has no milestone (tiers.mjs). Jobs run longest first, from the last run's times (C124,
// fast-order.mjs); `--times` prints every job's time; `--list` prints the jobs.
//   node packages/scenarios/harness/fast.mjs [--full] [--list] [--times] [file filter]
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { order, pack, readTimes, writeTimes } from "./fast-order.mjs";
import { shellEnv } from "./shell-env.mjs";
import { loadTierInput, selectTier } from "./tiers.mjs";
import { registry } from "../checks/registry.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const BUDGET_MS = 60_000;
const TIMES = path.join(repo, "node_modules", ".cache", "rafi-fast", "times.json");
const workers = Math.max(1, Number(process.env.RAFI_TEST_CONCURRENCY ?? 4));
const ROOTS = [
  ["packages/engine/test", /(?<!\.real)\.test\.ts$/], ["packages/spec/test/v1", /\.test\.ts$/],
  ["packages/scenarios/test", /\.test\.ts$/], ["packages/scenarios/scenarios", /\.scenario\.ts$/],
  ["scripts", /^check-rules\.test\.mjs$/],
];

function find(dir, pattern, out) {
  let names;
  try { names = readdirSync(path.join(repo, dir)); } catch { return; }
  for (const name of names.sort()) {
    const rel = path.join(dir, name);
    if (statSync(path.join(repo, rel)).isDirectory()) find(rel, pattern, out);
    else if (pattern.test(name)) out.push(rel);
  }
}

// M4 plan section 6, lever (b): the engine's and the spec's unit tests run as one job per package, in one process
// (they're pure or use their own temp folders), so the suite doesn't pay a process start per small file.
const GROUPED = ["packages/engine/test", "packages/spec/test/v1"];

// M5 speed (plan 10.8): files whose last solo run took under SOLO_MS share a process, up to GROUP_MS a group.
const SOLO_MS = 5000;
const GROUP_MS = 8500;

function jobs(filter, times, keep) {
  const files = [];
  for (const [dir, pattern] of ROOTS) find(dir, pattern, files);
  // The engine and spec tests (GROUPED) and check-rules are in both tiers; tier files only where `keep` says.
  const tiered = (f) => f.startsWith("packages/scenarios/");
  files.splice(0, files.length, ...files.filter((f) => !tiered(f) || keep(f)));
  const test = (names) => ["--conditions=source", "--import", "tsx", "--test", "--test-reporter=tap", ...names];
  const grouped = GROUPED.map((dir) => ({ dir, files: files.filter((f) => f.startsWith(`${dir}/`)) }));
  const own = files.filter((f) => !GROUPED.some((dir) => f.startsWith(`${dir}/`)))
    .filter((f) => !filter || f.includes(filter));
  const list = pack(own, times, { solo: SOLO_MS, group: GROUP_MS }).map((g) => (g.length === 1
    ? { name: g[0], args: test(g) }
    : { name: `group: ${g.map((f) => path.basename(f)).join(", ")}`, files: g,
      args: test(["--test-isolation=none", ...g]) }));
  for (const g of grouped) {
    if (g.files.length) list.push({ name: `${g.dir} (${g.files.length} files)`,
      args: test(["--test-isolation=none", ...g.files]) });
  }
  list.push({ name: "check-rules (tree)", args: ["scripts/check-rules.mjs"], plain: true });
  return filter ? list.filter((j) => j.files || j.name.includes(filter)) : list;
}

function runJob(job) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, job.args, { cwd: repo, env: { ...shellEnv(), TZ: "UTC" },
      stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => {
      const count = (re) => Number(re.exec(output)?.[1] ?? 0);
      resolve({ ...job, code, ms: performance.now() - started, output,
        pass: job.plain ? (code === 0 ? 1 : 0) : count(/^# pass (\d+)/m),
        fail: job.plain ? (code === 0 ? 0 : 1) : count(/^# fail (\d+)/m),
        skip: count(/^# skipped (\d+)/m), todo: count(/^# todo (\d+)/m) });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const full = args.includes("--full");
  const suite = full ? "full suite" : "fast suite";
  const filter = args.find((a) => !a.startsWith("--"));
  const tier = selectTier({ registry, ...loadTierInput(repo) });
  if (tier.problems.length) {
    console.log(`${suite}: files with no milestone (tiers.mjs):\n  ${tier.problems.join("\n  ")}`);
    process.exitCode = 1;
    return;
  }
  const size = (name) => { try { return statSync(path.join(repo, name)).size; } catch { return 0; } };
  const times = readTimes(TIMES);
  const list = order(jobs(filter, times, (f) => full || tier.fast.has(f)), times, size);
  const which = full ? "every milestone" : `${tier.current} and ${tier.previous} (current ${tier.current})`;
  console.log(`${suite}: ${which}` +
    `, the engine and spec tests, check-rules` +
    (full ? "" : `; crash enumerations (${tier.crash.size} files) in the full tier`));
  if (args.includes("--list")) return void console.log(list.map((j) => j.name).join("\n"));
  const started = performance.now();
  const queue = [...list];
  const results = [];
  await Promise.all(Array.from({ length: workers }, async () => {
    while (queue.length) results.push(await runJob(queue.shift()));
  }));
  const wall = performance.now() - started;
  if (!filter) writeTimes(TIMES, results, times);
  if (args.includes("--times")) {
    for (const r of [...results].sort((a, b) => b.ms - a.ms)) console.log(`${(r.ms / 1000).toFixed(2)}s  ${r.name}`);
  }
  const failed = results.filter((r) => r.code !== 0 || r.fail > 0);
  for (const r of failed) console.log(`\n--- FAILED ${r.name} (exit ${r.code})\n${r.output.slice(-4000)}`);
  const sum = (key) => results.reduce((n, r) => n + r[key], 0);
  console.log("\nslowest:");
  for (const r of [...results].sort((a, b) => b.ms - a.ms).slice(0, 5)) {
    console.log(`  ${(r.ms / 1000).toFixed(2)}s  ${r.name}`);
  }
  console.log(`\n${suite}: ${results.length} jobs, ${sum("pass")} passed, ${sum("fail")} failed, ${sum("skip")} ` +
    `skipped (pending), ${sum("todo")} todo; ${(wall / 1000).toFixed(1)}s wall on ${workers} workers`);
  const over = !full && wall > BUDGET_MS;
  if (over) console.log(`fast suite: over the 60 s budget`);
  process.exitCode = failed.length || over ? 1 : 0;
}

await main();
