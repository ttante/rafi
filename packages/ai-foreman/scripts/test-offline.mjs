import { spawn } from "node:child_process";
import { createWriteStream, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const files = readdirSync(join(root, "test")).filter(file => /\.test\.(ts|mjs)$/.test(file)).sort();
const jobs = files.flatMap(file => file === "qaGuidanceDelivery.test.ts" ? ["claude", "codex"].map(provider => ({ file, provider })) : [{ file, provider: undefined }]);
// Measured process/QA matrices start first so one long file cannot dominate the tail.
const expensive = ["qaGuidanceDelivery.test.ts", "qaRecovery.test.ts", "qaPrebuildCallers.test.ts", "branch.test.ts", "foreman.test.ts", "buildAdmission.test.ts", "buildOwnershipReconciliation.test.ts", "qaHandbackInvestigation.test.ts"];
jobs.sort((a, b) => (expensive.indexOf(a.file) < 0 ? 100 : expensive.indexOf(a.file)) - (expensive.indexOf(b.file) < 0 ? 100 : expensive.indexOf(b.file)));
const concurrency = Number(process.env.RAFI_TEST_CONCURRENCY ?? 4);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("RAFI_TEST_CONCURRENCY must be 1–16");
const logs = mkdtempSync(join(tmpdir(), "rafi-offline-tests-"));
const started = performance.now();
const timings = [];
let cursor = 0;
let failed = 0;
let tests = 0, passed = 0, skipped = 0;
console.log(`Offline gate: ${files.length} files, ${jobs.length} isolated jobs, concurrency ${concurrency}; logs ${logs}`);
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (cursor < jobs.length) {
    const { file, provider } = jobs[cursor++];
    const label = provider ? `${file}:${provider}` : file;
    const path = join(logs, `${label}.tap`);
    const output = createWriteStream(path);
    const before = performance.now();
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--test", "--test-reporter=tap", join(root, "test", file)], { cwd: root, env: { ...process.env, RAFI_TEST_PROVIDER_SHARD: provider }, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
      child.once("error", reject);
      child.once("close", code => output.end(() => resolve(code)));
    });
    const seconds = (performance.now() - before) / 1000;
    timings.push({ file: label, seconds, code });
    const log = readFileSync(path, "utf8");
    tests += Number(/^# tests (\d+)$/m.exec(log)?.[1] ?? 0);
    passed += Number(/^# pass (\d+)$/m.exec(log)?.[1] ?? 0);
    skipped += Number(/^# skipped (\d+)$/m.exec(log)?.[1] ?? 0);
    console.log(`${code === 0 ? "PASS" : "FAIL"} ${label} ${seconds.toFixed(1)}s`);
    if (code !== 0) { failed++; console.error(log); }
  }
}));
console.log(`Gate: ${tests} tests, ${passed} passed, ${skipped} skipped; ${failed} failed files; wall ${((performance.now() - started) / 1000).toFixed(2)}s`);
console.log("Slowest files:", timings.sort((a, b) => b.seconds - a.seconds).slice(0, 10));
process.exitCode = failed ? 1 : 0;
