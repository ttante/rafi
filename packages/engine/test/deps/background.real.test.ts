// The real deps.spawnBackground (ARCH 8.7, D5; process set, M4 item 27): one ordinary child with exactly the given
// arguments, in a new session (its own process group, so it outlives its parent's group), stdin closed, stdout and
// stderr appended to the log file, the parent's environment with nothing added (no ENV-5 hand-off variable).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tempDir } from "../helpers.js";

const real = pathToFileURL(fileURLToPath(new URL("../../src/deps/real/background.ts", import.meta.url))).href;
// The parent runs from the engine package, so `--import tsx` resolves; the child's folder is the temp dir.
const engineDir = fileURLToPath(new URL("../..", import.meta.url));
const ENV5 = ["RAFI_BUILD_WORKER_RUN", "RAFI_BUILD_WORKER_GENERATION", "RAFI_DETACHED_SUPERVISOR_RUN",
  "RAFI_BUILD_LAUNCH_TOKEN", "RAFI_PROBE_ENV"];

const waitFor = async (what: string, check: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

test("spawnBackground: argv as given, new session, stdin closed, output in the log, outlives its parent's group",
  { skip: process.platform === "win32" ? "process groups and ps need POSIX (Windows: CI)" : false, timeout: 30_000 },
  async () => {
    const dir = tempDir("rafi-bg-");
    const entry = path.join(dir, "entry.mjs");
    const report = path.join(dir, "report.json");
    // The background child: records what it got, prints, then outlives the parent's group by a second.
    writeFileSync(entry, `import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
let stdin = "";
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  writeFileSync(${JSON.stringify(report)}.replace(".json", ".stdin"), "ended:" + stdin.length);
});
console.log("hello from the background");
console.error("and its stderr");
setTimeout(() => writeFileSync(${JSON.stringify(report)}, JSON.stringify({ argv: process.argv.slice(2),
  pid: process.pid, ppid: process.ppid, cwd: process.cwd(),
  pgid: execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim(),
  env: Object.keys(process.env).filter((k) => k.startsWith("RAFI_")) })), 1500);
`);
    const parentScript = path.join(dir, "parent.mjs");
    writeFileSync(parentScript, `const { backgroundSpawner } = await import(${JSON.stringify(real)});
const spawned = backgroundSpawner(${JSON.stringify(entry)})(["resume", "--run", "r7"],
  { cwd: ${JSON.stringify(dir)}, log: ".rafi/background.log" });
console.log(JSON.stringify(spawned));
setInterval(() => {}, 1000);
`);
    // The parent leads its own group; killing that whole group must leave the background child running.
    const parent = spawn(process.execPath, ["--conditions=source", "--import", "tsx", parentScript],
      { cwd: engineDir, detached: true, stdio: ["ignore", "pipe", "inherit"],
        env: { ...process.env, RAFI_ENGINE: "next" } });
    let out = "";
    parent.stdout.on("data", (c: Buffer) => { out += c; });
    await waitFor("the child's pid", () => /"pid":\d+/.test(out));
    const pid = Number(/"pid":(\d+)/.exec(out)![1]);
    process.kill(-parent.pid!, "SIGKILL");
    // Written 1.5 s after the parent's whole group was killed: only a child in its own session gets there.
    await waitFor("the child's report", () => existsSync(report));
    const got = JSON.parse(readFileSync(report, "utf8")) as { argv: string[]; pid: number; cwd: string; env: string[];
      pgid: string };
    assert.equal(got.pid, pid);
    assert.deepEqual(got.argv, ["resume", "--run", "r7"], "exactly the ordinary arguments");
    assert.equal(got.cwd, realpathSync(dir));
    assert.deepEqual(got.env.filter((k) => ENV5.includes(k) || k.startsWith("RAFI_REHEARSAL_")), []);
    assert.ok(got.env.includes("RAFI_ENGINE"), "the parent's own environment passes through unchanged");
    assert.equal(readFileSync(report.replace(".json", ".stdin"), "utf8"), "ended:0", "stdin is closed");
    const log = readFileSync(path.join(dir, ".rafi", "background.log"), "utf8");
    assert.match(log, /hello from the background/);
    assert.match(log, /and its stderr/);
    assert.equal(got.pgid, String(pid), "a new session: the child leads its own process group");
  });
