// The fast suite (SCN 7.10): every active scenario, the transition and log tests, the engine and harness tests,
// and scripts/check-rules.mjs, as isolated jobs on RAFI_TEST_CONCURRENCY workers (default 4); `*.real.test.ts`
// files spawn real processes and belong to the process set. Prints totals and the slowest files; fails on any
// failure or over 60 s of wall time. Modeled on ai-foreman's test-offline.mjs.
//   node packages/scenarios/harness/fast.mjs [--list] [file filter]
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const BUDGET_MS = 60_000;
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

function jobs(filter) {
  const files = [];
  for (const [dir, pattern] of ROOTS) find(dir, pattern, files);
  const list = files.map((file) => ({ name: file, args: ["--conditions=source", "--import", "tsx", "--test",
    "--test-reporter=tap", file] }));
  list.push({ name: "check-rules (tree)", args: ["scripts/check-rules.mjs"], plain: true });
  return filter ? list.filter((j) => j.name.includes(filter)) : list;
}

function runJob(job) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, job.args, { cwd: repo, env: { ...process.env, TZ: "UTC" },
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
  const list = jobs(args.find((a) => !a.startsWith("--")));
  if (args.includes("--list")) return void console.log(list.map((j) => j.name).join("\n"));
  const started = performance.now();
  const queue = [...list];
  const results = [];
  await Promise.all(Array.from({ length: workers }, async () => {
    while (queue.length) results.push(await runJob(queue.shift()));
  }));
  const wall = performance.now() - started;
  const failed = results.filter((r) => r.code !== 0 || r.fail > 0);
  for (const r of failed) console.log(`\n--- FAILED ${r.name} (exit ${r.code})\n${r.output.slice(-4000)}`);
  const sum = (key) => results.reduce((n, r) => n + r[key], 0);
  console.log("\nslowest:");
  for (const r of [...results].sort((a, b) => b.ms - a.ms).slice(0, 5)) {
    console.log(`  ${(r.ms / 1000).toFixed(2)}s  ${r.name}`);
  }
  console.log(`\nfast suite: ${results.length} jobs, ${sum("pass")} passed, ${sum("fail")} failed, ${sum("skip")} ` +
    `skipped (pending), ${sum("todo")} todo; ${(wall / 1000).toFixed(1)}s wall on ${workers} workers`);
  if (wall > BUDGET_MS) console.log(`fast suite: over the 60 s budget`);
  process.exitCode = failed.length || wall > BUDGET_MS ? 1 : 0;
}

await main();
