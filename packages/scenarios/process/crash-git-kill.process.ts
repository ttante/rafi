// Process set, M5 plan item 21 (slice 11; C201, C235): a SIGKILL during git delivery. A slow `pre-receive` hook on
// the bare remote holds rafi's first `git push` (the remote's own hook: rafi's hooks-off, C197, covers only the
// repositories rafi runs git in, so this one runs, and its marker proves it). The harness then kills rafi and every
// process under it (the push, the remote's receive-pack, the hook), as a crashed computer would. Between the kill and
// the resume no file of yours changes; `rafi resume` (until finished, at most 3) delivers each ticket once: one
// commit with its trailer, one PR, its branch on the remote; and no `index.lock` is left behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git } from "../fixtures/common.js";
import { remoteOf } from "../fixtures/f-branch.js";
import { hashes, launch, processes, run, waitFor } from "../harness/process-run.js";
import { deliverySetup } from "./delivery-helpers.js";

const ARGS = ["start", ".", "--steps", "2", "--branch-per-ticket", "--completion", "pr"];
const HEADS = ["feature/T1-add-the-parser", "feature/T2-add-the-printer"];

/** The remote's pre-receive hook: the first push writes `held` and waits for `release` (at most 60 s). */
function holdFirstPush(remote: string, dir: string): { held: string; release: string } {
  const held = path.join(dir, "held");
  const release = path.join(dir, "release");
  const hook = path.join(remote, "hooks", "pre-receive");
  writeFileSync(hook, `#!/bin/sh\ncat >/dev/null\nif [ ! -e '${held}' ]; then\n  : > '${held}'\n` +
    `  i=0\n  while [ ! -e '${release}' ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done\nfi\nexit 0\n`);
  chmodSync(hook, 0o755);
  return { held, release };
}

/** rafi and everything it started, by parent pid: a crash takes them all. */
function killTree(root: number): number[] {
  const all = processes();
  const tree = [root];
  for (let i = 0; i < tree.length; i += 1) tree.push(...all.filter((p) => p.ppid === tree[i]).map((p) => p.pid));
  for (const pid of tree.reverse()) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  return tree;
}

/** Every index.lock in the repository and its worktrees' git directories. */
function locks(project: string): string[] {
  const gitDir = path.join(project, ".git");
  const dirs = [gitDir, ...(existsSync(path.join(gitDir, "worktrees"))
    ? readdirSync(path.join(gitDir, "worktrees")).map((w) => path.join(gitDir, "worktrees", w)) : [])];
  return dirs.map((d) => path.join(d, "index.lock")).filter((f) => existsSync(f));
}

const finished = (types: string[]) => types.includes("build.finished");

test("item 21: SIGKILL while the remote's pre-receive hook holds rafi's push; resume delivers each ticket once",
  { skip: process.platform === "win32" ? "SIGKILL and shell hooks need POSIX" : false, timeout: 300_000 },
  async () => {
    const s = deliverySetup("github");
    const remote = remoteOf(s.project);
    const hook = holdFirstPush(remote, s.root);
    const live = launch(ARGS, s.opts);
    await waitFor("the remote's pre-receive hook to hold rafi's push", () => existsSync(hook.held), 120_000);
    const killed = killTree(live.pid);
    const r = await live.done;
    assert.equal(r.signal, "SIGKILL", `rafi wasn't killed: exit ${r.code}\n${r.output.slice(-1500)}`);
    assert.ok(killed.length > 1, "the push was running under rafi");
    const atKill = hashes(s.project, { withRafi: false });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(hashes(s.project, { withRafi: false }), atKill, "no file of yours changed after the kill");
    assert.equal(git(remote, ["branch", "--list", HEADS[0]!]), "", "the held push never reached the remote");
    // The kill landed between the push's intent and its result (C235): the redo has to look before it pushes.
    const atCrash = (await s.exported()).events;
    const intents = atCrash.filter((x) => x.type === "git.intent").map((x) => x.data as { op: string; ref: string });
    assert.equal(intents.at(-1)?.op, "push", JSON.stringify(intents));
    assert.ok(!atCrash.some((x) => x.type === "git.pushed"), "no push recorded before the kill");
    assert.ok(atCrash.some((x) => x.type === "git.committed" && x.ticket_id === "T1"), "T1 committed before its push");
    writeFileSync(hook.release, "");
    const outputs: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const resumed = await run(["resume"], s.opts);
      outputs.push(resumed.output);
      if (/index\.lock/.test(resumed.output)) {
        // C201's storage stop: one line naming the lock, nothing else; then it's removed and the build resumed.
        assert.equal(resumed.output.split("\n").filter((l) => /index\.lock/.test(l)).length, 1, resumed.output);
      } else {
        assert.equal(resumed.code, 0, `resume ${i + 1} exited ${resumed.code}: ${resumed.output.slice(-1500)}`);
      }
      if (finished((await s.exported()).events.map((e) => e.type))) break;
    }
    const e = await s.exported();
    assert.ok(finished(e.events.map((x) => x.type)), `finished within 3 resumes:\n${outputs.join("\n---\n")}`);
    assert.deepEqual(locks(s.project), [], "no index.lock left");
    const gh = s.gh();
    assert.deepEqual(gh.prs.map((p) => p.head).sort(), HEADS, "one PR per ticket");
    assert.equal(gh.calls.filter((c) => c.args[1] === "create").length, 2, "each PR created once");
    for (const [i, head] of HEADS.entries()) {
      const id = `T${i + 1}`;
      const commits = git(s.project, ["log", "--all", "--format=%H", `--grep=^Rafi-Ticket: ${id}$`]).split("\n")
        .filter(Boolean);
      assert.equal(new Set(commits).size, 1, `one commit for ${id}: ${commits.join(" ")}`);
      assert.equal(git(remote, ["rev-parse", head]).trim(), commits[0], `${head} on the remote is ${id}'s commit`);
    }
    assert.equal(e.events.filter((x) => x.type === "git.committed").length, 2, "one git.committed per ticket");
    assert.equal(e.events.filter((x) => x.type === "pr.created").length, 2);
  });
