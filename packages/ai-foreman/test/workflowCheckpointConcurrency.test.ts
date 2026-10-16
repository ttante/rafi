import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { WorkflowDb } from "../src/workflowDb.js";
import { baselineContinuityDelta } from "../src/continuity.js";

test("continuity checkpoint serializes a concurrent heartbeat before reading its snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-checkpoint-concurrency-"));
  const db = new WorkflowDb(root);
  db.ensureRun("run");
  const init = new Database(db.path);
  init.exec("CREATE TABLE heartbeat_probe(value INTEGER); INSERT INTO heartbeat_probe VALUES(0)"); init.close();
  const signal = join(root, "read-started"), finished = join(root, "peer-finished"), attempted = join(root, "peer-attempted");
  const peer = spawn(process.execPath, ["--input-type=module", "-e", `
    import Database from 'better-sqlite3'; import {existsSync,writeFileSync} from 'node:fs';
    const [path,signal,finished,attempted]=process.argv.slice(1); const db=new Database(path,{timeout:2000});
    process.stdout.write('ready\\n');
    const poll=setInterval(()=>{if(!existsSync(signal))return; clearInterval(poll);
      writeFileSync(attempted,'attempting heartbeat');
      db.prepare('UPDATE heartbeat_probe SET value=value+1').run(); db.close(); writeFileSync(finished,'committed');
    },5);
  `, db.path, signal, finished, attempted], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; peer.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve, reject) => { peer.once("error", reject); peer.once("close", resolve); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Peer failed to initialize: ${stderr}`)), 5000);
      peer.stdout.once("data", () => { clearTimeout(timer); resolve(); });
    });
    const read = db.continuityHead.bind(db); let observed = false;
    db.continuityHead = (...args) => {
      const head = read(...args);
      if (!observed && args[1] === "qa") {
        observed = true; writeFileSync(signal, "start peer writer");
        // The second process runs while this synchronous transaction is open.
        const wait = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + 2000;
        while (!existsSync(attempted) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 10);
        assert.equal(existsSync(attempted), true, "The concurrent writer must actually attempt its heartbeat");
        Atomics.wait(wait, 0, 0, 100);
        assert.equal(existsSync(finished), false, "A competing write must wait until the checkpoint transaction commits");
      }
      return head;
    };
    const checkpoint = db.publishContinuityCheckpoint({ runId: "run", role: "qa", delta: baselineContinuityDelta(), authoritativeStateRevision: 1 });
    assert.equal(checkpoint.state, "current"); assert.equal(observed, true);
    assert.equal(await exited, 0, stderr); assert.equal(existsSync(finished), true);
    assert.equal(db.continuityHead("run", "qa")?.digest, checkpoint.digest);
  } finally { peer.kill("SIGKILL"); await exited.catch(() => {}); db.close(); rmSync(root, { recursive: true, force: true }); }
});
