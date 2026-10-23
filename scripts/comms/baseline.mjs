import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const tests = [
  "packages/spec/test/providerContracts.test.ts", "packages/spec/test/qaFailureReport.test.ts",
  ...["qaPreparationRecovery", "unifiedContinuity", "buildStallRepairs", "qaContractDelivery",
    "handoffProtocol", "qaHandbackSafety", "ticketPopulation", "buildAssignment", "hostQaComparison"]
    .map(name => `packages/ai-foreman/test/${name}.test.ts`),
  "packages/rafi/test/plan.test.ts",
];
export function pnpmCommand(args, env = process.env, platform = process.platform) {
  const entry = env.npm_execpath;
  if (entry && /^pnpm\.(?:c?js|mjs)$/.test(basename(entry))) return [process.execPath, [entry, ...args]];
  if (platform === "win32") throw new Error("Run this baseline through pnpm baseline:comms on Windows");
  return ["pnpm", args];
}

export async function runCommands(commands, { root, evidence, report, save }) {
  for (const [name, executable, args] of commands) {
    const before = performance.now();
    const output = openSync(join(evidence, `${name}.log`), "w");
    const result = await new Promise(resolve => {
      const child = spawn(executable, args, { cwd: root, stdio: ["ignore", output, output], timeout: 600_000 });
      let error;
      child.on("error", value => { error = value; });
      child.on("close", (status, signal) => resolve({ status, signal, error }));
    });
    closeSync(output);
    const row = { name, executable, args, exitCode: result.status, signal: result.signal,
      error: result.error?.message, seconds: (performance.now() - before) / 1000 };
    report.results.push(row); save(); console.log(JSON.stringify(row));
    // Later tests can consume stale dist artifacts if build/typecheck failed.
    if (result.status !== 0) return false;
  }
  return true;
}

async function main() {
  const evidence = process.argv[2] ?? mkdtempSync(join(tmpdir(), "rafi-comms-baseline-"));
  mkdirSync(evidence, { recursive: true });
  const files = [...new Set(execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0"))]
    .filter(p => p && !p.startsWith(".pnpm-store/") && existsSync(join(root, p))).sort();
  const digests = Object.fromEntries(files.map(p => [p, createHash("sha256").update(readFileSync(join(root, p))).digest("hex")]));
  const report = { startedAt: new Date().toISOString(), node: process.version,
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    sourceDigest: createHash("sha256").update(JSON.stringify(digests)).digest("hex"),
    files: digests, results: [] };
  const save = () => writeFileSync(join(evidence, "baseline.json"), JSON.stringify(report, null, 2) + "\n");
  const commands = [
    ["native", process.execPath, ["scripts/check-native-runtime.mjs"]],
    ["build", ...pnpmCommand(["-r", "build"])],
    ["typecheck", ...pnpmCommand(["-r", "typecheck"])],
    ["journeys", process.execPath, ["--import", "tsx", "--test", "--test-reporter=tap", "--test-concurrency=2", ...tests]],
  ];
  console.log(`Baseline evidence: ${evidence}`); save();
  if (!await runCommands(commands, { root, evidence, report, save })) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
