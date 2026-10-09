import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { WorkflowDb } from "ai-foreman/workflow-db.js";
import { buildProjectConfig, defaultAnswers } from "../src/project.js";

const driver = String.raw`
import os, pty, select, signal, sys, time, fcntl, termios, struct
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 120, 0, 0))
output = b''
sent = False
until = time.monotonic() + 20
try:
    while time.monotonic() < until:
        readable, _, _ = select.select([fd], [], [], 0.1)
        if readable:
            try: chunk = os.read(fd, 65536)
            except OSError: break
            if not chunk: break
            output += chunk
            if not sent and (b'Which interrupted build' in output or b'What should Rafi resume' in output):
                os.write(fd, b'\r')
                sent = True
        ended, status = os.waitpid(pid, os.WNOHANG)
        if ended:
            sys.stdout.buffer.write(output)
            sys.exit(os.waitstatus_to_exitcode(status))
    else:
        os.kill(pid, signal.SIGKILL)
        sys.stdout.buffer.write(output)
        raise RuntimeError('PTY selector timed out')
    _, status = os.waitpid(pid, 0)
    sys.stdout.buffer.write(output)
    sys.exit(os.waitstatus_to_exitcode(status))
finally:
    os.close(fd)
`;
for (const alias of ["resume", "build:resume"]) test(`packaged rafi ${alias} selects terminal cleanup through real TTY`, { skip: process.platform === "win32", timeout: 30000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "rafi resume tty "));
  const db = new WorkflowDb(root);
  try {
    writeFileSync(join(root, "rafi-config.yaml"), stringify(buildProjectConfig(defaultAnswers())));
    mkdirSync(join(root, ".tickets"));
    writeFileSync(join(root, ".tickets/config.yaml"), "app_name: Test\n");
    writeFileSync(join(root, ".tickets/tickets.yaml"), "tickets: []\n");
    writeFileSync(join(root, ".tickets/ticket-state.sqlite"), Buffer.from("SQLite format 3\0"));
    const owner = db.acquireBuildAdmission("terminal-pty", "worker");
    db.beginOwnedPreparationProcess(owner, undefined, true);
    db.transition(owner.runId, { status: "completed", checkpoint: "finished", state: {} });
    const raw = (db as any).db;
    const dead = { ...owner, pid: 2147483647 };
    raw.prepare("UPDATE build_admission SET record_json=?").run(JSON.stringify(dead));
    const row = raw.prepare("SELECT id,outcome_json FROM build_owned_processes").get();
    raw.prepare("UPDATE build_owned_processes SET outcome_json=? WHERE id=?").run(JSON.stringify({ ...JSON.parse(row.outcome_json), authority: dead }), row.id);
    const before = JSON.stringify(db.getRun(owner.runId));
    const result = spawnSync("python3", ["-c", driver, process.execPath, fileURLToPath(new URL("../dist/index.js", import.meta.url)), alias, root], { encoding: "utf8", timeout: 25000, env: { ...process.env, TERM: "xterm", NO_COLOR: "1" } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /readiness cleanup complete/);
    assert.deepEqual(db.readinessProcesses(), []);
    assert.equal(JSON.stringify(db.getRun(owner.runId)), before);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
