// M2 plan 1.2 and 1.3: the probe table on the real deps.checks.run under the real OS sandbox (C40, C41).
// Process set only (it spawns real processes and opens sockets); skipped, with the reason, where no sandbox exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { sandboxInfo, sandboxPrefix } from "../../src/build/sandbox.js";
import { testEnv } from "../../src/build/env.js";
import { realChecks } from "../../src/deps/real/checks.js";
import type { CheckResult, Need } from "../../src/deps/types.js";

const checks = realChecks();
const info = sandboxInfo(await checks.sandbox());
const skip = info.available ? false : `no sandbox on this machine: ${info.missing}`;
if (skip) console.log(`# sandbox probes skipped: ${skip}`);

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "rafi-sbx-")));
const project = path.join(root, "project");
const outside = path.join(root, "outside");
const cache = path.join(project, ".rafi", "cache");
mkdirSync(project, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "p", private: true,
  scripts: { test: "node -e \"require('fs').writeFileSync('ran.txt','ok')\"" } }));

async function run(js: string, needs: Need[] = [], cmd = process.execPath, args = ["-e", js]): Promise<CheckResult> {
  assert.ok(info.available);
  const sandbox = sandboxPrefix({ tool: info.tool, worktree: project, cache, grants: { needs } });
  mkdirSync(path.join(cache, "tmp"), { recursive: true });
  const env = testEnv({ PATH: process.env.PATH, HOME: homedir() }, { checksEnv: [], cache,
    platform: process.platform }).env;
  return checks.run(cmd, args, { cwd: project, env, grants: { needs }, sandbox, onOutput: () => undefined,
    signal: new AbortController().signal });
}

const write = (file: string) => `require('fs').writeFileSync(${JSON.stringify(file)}, 'x'); console.log('wrote')`;
const connect = (host: string, port: number) => `const s = require('net').connect(${port}, ${JSON.stringify(host)});
  const t = setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 5000);
  s.on('connect', () => { console.log('CONNECTED'); process.exit(0); });
  s.on('error', (e) => { clearTimeout(t); console.log('ERR ' + e.code); process.exit(2); });`;
const loopback = `const net = require('net'); const srv = net.createServer((c) => c.end('hi'));
  srv.on('error', (e) => { console.log('LISTEN ' + e.code); process.exit(2); });
  srv.listen(0, '127.0.0.1', () => { const c = net.connect(srv.address().port, '127.0.0.1');
    c.on('data', () => { console.log('LOOPBACK OK'); process.exit(0); });
    c.on('error', (e) => { console.log('CONNECT ' + e.code); process.exit(2); }); });`;

test("writes in the worktree, coverage/ and .rafi/cache/ are allowed", { skip }, async () => {
  mkdirSync(path.join(project, "coverage"), { recursive: true });
  for (const file of [path.join(project, "a.txt"), path.join(project, "coverage", "c.json"),
    path.join(cache, "c.txt")]) {
    const r = await run(write(file));
    assert.equal(r.code, 0, `${file}: ${r.output}`);
    assert.ok(existsSync(file));
  }
});

test("npm test passes with npm_config_cache and TMPDIR under .rafi/cache/, no EPERM", { skip }, async () => {
  const r = await run("", [], "npm", ["test"]);
  assert.equal(r.code, 0, r.output);
  assert.doesNotMatch(r.output, /EPERM/);
  assert.ok(existsSync(path.join(project, "ran.txt")));
});

test("writes to $HOME and outside the project are denied", { skip }, async () => {
  const home = path.join(homedir(), ".rafi-sandbox-probe");
  rmSync(home, { force: true });
  for (const file of [home, path.join(outside, "x.txt")]) {
    const r = await run(write(file));
    assert.notEqual(r.code, 0, `${file} was writable: ${r.output}`);
    assert.ok(!existsSync(file), `${file} exists`);
  }
});

test("threat 9: a test can't write .git/ (core.fsmonitor runs at rafi's next git add), .rafi/ or .tickets/",
  { skip }, async () => {
    for (const dir of [".git", ".rafi", ".tickets"]) mkdirSync(path.join(project, dir), { recursive: true });
    for (const file of [path.join(project, ".git", "config"), path.join(project, ".rafi", "state.sqlite3"),
      path.join(project, ".tickets", "tickets.yaml")]) {
      rmSync(file, { force: true });
      const r = await run(write(file));
      assert.notEqual(r.code, 0, `${file} was writable: ${r.output}`);
      assert.ok(!existsSync(file), `${file} exists`);
    }
    const kept = path.join(cache, "still-writable.txt");
    assert.equal((await run(write(kept))).code, 0, "the cache under .rafi/ is still writable");
  });

test("threat 11: a run that prints more than 4 MB keeps only about the first 4 MB", async () => {
  const r = await checks.run(process.execPath, ["-e", "const s = 'x'.repeat(65536); " +
    "for (let i = 0; i < 160; i += 1) process.stdout.write(s);"], { cwd: root, env: { PATH: process.env.PATH },
  grants: { needs: [] }, sandbox: [], onOutput: () => undefined, signal: new AbortController().signal });
  assert.equal(r.code, 0);
  assert.ok(r.output.length >= 4 * 1024 * 1024 && r.output.length < 4 * 1024 * 1024 + 2 * 65536, `${r.output.length}`);
});

test("a child process, a worker thread and reading files anywhere are allowed", { skip }, async () => {
  const js = `const { execFileSync } = require('child_process'); const { Worker } = require('worker_threads');
    execFileSync(process.execPath, ['-e', '0']); require('fs').readFileSync('/etc/hosts');
    new Worker('require("worker_threads").parentPort.postMessage(1)', { eval: true })
      .on('message', () => { console.log('ok'); process.exit(0); });`;
  const r = await run(js);
  assert.equal(r.code, 0, r.output);
});

test("a TCP connect to a public address is denied with an error, not a timeout", { skip }, async () => {
  const r = await run(connect("1.1.1.1", 443));
  assert.match(r.output, /ERR E[A-Z]+/, r.output);
  assert.doesNotMatch(r.output, /CONNECTED|TIMEOUT/);
});

test("1.3: with local-servers, loopback listen and connect works and a public connect is still denied",
  { skip }, async () => {
    const r = await run(loopback, ["local-servers"]);
    assert.match(r.output, /LOOPBACK OK/, r.output);
    const pub = await run(connect("1.1.1.1", 443), ["local-servers"]);
    assert.match(pub.output, /ERR E[A-Z]+/, pub.output);
  });

test("1.3 record: loopback with no grants", { skip }, async () => {
  const r = await run(loopback);
  console.log(`# loopback with no grants on ${info.available ? info.tool : "-"}: ${r.output.trim()}`);
  assert.ok(r.code !== null);
});

test("an aborted run is ended and reported as aborted", { skip }, async () => {
  assert.ok(info.available);
  const controller = new AbortController();
  const sandbox = sandboxPrefix({ tool: info.tool, worktree: project, cache, grants: { needs: [] } });
  const pending = checks.run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: project,
    env: testEnv({ PATH: process.env.PATH }, { checksEnv: [], cache, platform: process.platform }).env,
    grants: { needs: [] }, sandbox,
    onOutput: () => undefined, signal: controller.signal });
  setTimeout(() => controller.abort(), 200);
  const r = await pending;
  assert.equal(r.aborted, true);
});
