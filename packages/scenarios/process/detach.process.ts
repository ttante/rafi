// Process set, M4 item 13: S-START-5 step 4 (D5, ARCH 8.7), on both fake executables. `rafi start . --steps 1
// --detach` with a slow first builder turn returns 0 right after launch with 8.7's line, leaving one ordinary rafi
// process running `rafi resume --run <id>`: its own session, stdin closed, output in `.rafi/background.log` (ignored
// by git), none of ENV-5's hand-off variables. `rafi status` shows its progress and `rafi resume` attaches; neither
// starts a second build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { EventsExport } from "../checks/invariants.js";
import { pOn, writeShims } from "../fakes/shims.js";
import { configure, git, tempRoot } from "../fixtures/common.js";
import { fChain3 } from "../fixtures/f-chain3.js";
import { LAUNCHER } from "../harness/process.js";
import { alive, processes, run, waitFor } from "../harness/process-run.js";

const ENV5 = new RegExp(`\\b(${["RAFI_BUILD_WORKER_RUN", "RAFI_BUILD_WORKER_GENERATION", "RAFI_DETACHED_SUPERVISOR_RUN",
  "RAFI_BUILD_LAUNCH_TOKEN", "RAFI_PROBE_ENV", "RAFI_REHEARSAL_\\w+"].join("|")})=`);

for (const runtime of ["codex", "claude"] as const) {
  test(`S-START-5 step 4 (process, ${runtime}): --detach leaves one ordinary rafi; status and resume follow it`,
    { skip: process.platform === "win32" ? "detach on Windows: CI" : false, timeout: 180_000 }, async () => {
      const root = tempRoot("rafi-detach-");
      const project = fChain3(root);
      configure(project, { harness: { targets: [runtime] }, checks: { env: ["API_SECRET"] } });
      // Threat 3: a declared secret the agent prints in its activity is redacted in the background log too.
      const secret = `canary-${runtime}-5f1d2c9a7b`;
      const shims = writeShims(root, { rules: [pOn("builder T1#1 @build", { kind: "slow", ms: 6_000, every: 250,
        say: `the key is ${secret}` })] });
      const o = { cwd: project, pathFirst: shims.bin, env: { API_SECRET: secret } };
      const started = Date.now();
      const r = await run(["start", ".", "--steps", "1", "--detach"], o);
      assert.equal(r.code, 0, r.output.slice(-1500));
      const id = /build (\S+) started in the background\. Follow it with `rafi status` or `rafi resume`\./
        .exec(r.output)?.[1];
      assert.ok(id, r.output);
      assert.ok(Date.now() - started < 15_000, "it returned right after launch");
      // The process set runs files side by side, so other tests' rafi processes are in `ps` too: this build's is the
      // one running its run id (and the export below shows it's the only build).
      const child = processes().filter((p) => p.command.includes(LAUNCHER) && p.command.includes(id));
      assert.equal(child.length, 1, child.map((c) => c.command).join("\n"));
      assert.equal(child[0]!.command, `${process.execPath} ${LAUNCHER} resume --run ${id}`, "the ordinary command");
      assert.equal(child[0]!.pgid, child[0]!.pid, "its own session and process group");
      if (process.platform === "darwin") {
        const env = spawnSync("ps", ["-E", "-o", "command=", "-p", String(child[0]!.pid)], { encoding: "utf8" }).stdout;
        assert.doesNotMatch(env, ENV5, "no ENV-5 hand-off variable");
      }
      const lsof = spawnSync("lsof", ["-a", "-p", String(child[0]!.pid), "-d", "0", "-Fn"], { encoding: "utf8" });
      if (lsof.status === 0) assert.match(lsof.stdout, /n\/dev\/null/, "stdin closed");
      const log = path.join(project, ".rafi", "background.log");
      assert.ok(existsSync(log));
      assert.equal(spawnSync("git", ["-C", project, "check-ignore", "-q", ".rafi/background.log"]).status, 0);
      const status = await run(["status"], o);
      assert.equal(status.code, 0, status.output);
      assert.match(status.output, new RegExp(`${id}[\\s\\S]*T1`), status.output);
      const follow = await run(["resume"], o);
      assert.equal(follow.code, 0, follow.output.slice(-1500));
      assert.match(follow.output, /Following build/);
      await waitFor("the background build to exit", () => !alive(child[0]!.pid), 60_000);
      const e = JSON.parse((await run(["stats", "export"], o)).output) as EventsExport;
      assert.equal(e.events.filter((x) => x.type === "build.started").length, 1, "no second build");
      assert.equal(e.events.filter((x) => x.type === "build.owner_acquired").length, 1);
      assert.ok(e.events.some((x) => x.type === "build.finished"));
      const text = readFileSync(log, "utf8");
      assert.match(text, /T1/, "the background build's output is in its log");
      assert.match(text, /the key is \[REDACTED/, "the activity line is there, redacted");
      assert.ok(!text.includes(secret), "no secret in .rafi/background.log");
      assert.deepEqual(git(project, ["status", "--porcelain", "--untracked-files=all", "--", ".rafi"]).trim()
        .split("\n"), ["?? .rafi/progress.yaml"], "only the progress file shows; the background log is ignored");
    });
}
