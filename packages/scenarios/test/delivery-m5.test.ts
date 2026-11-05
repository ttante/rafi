// Milestone: M5
// M5 slice 6, part 2: the delivery question (C203), the conflict fix ticket (C237, item 19b), rafi's views on PR
// branches (C240, item 10b), the merge-wait timeout question (4.3.2) and transient retries (5.1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { git } from "../fixtures/common.js";
import { gitAs, remoteOf } from "../fixtures/f-branch.js";
import { on } from "../fakes/script/behaviors.js";
import type { FakeGh } from "../fakes/gh.js";
import type { Computer } from "../harness/deps.js";
import { once, setup, trailers } from "./git-race-helpers.js";

const T3 = "feature/T3-add-the-store";
const T1 = "feature/T1-add-the-parser";
const T2 = "feature/T2-add-the-printer";
const U2 = [{ id: "U2", tickets: ["T3"] }, { id: "U1", tickets: ["T1", "T2", "T4"] }];
// CI points (slice 8) aren't what these tests are about.
const NO_CI = { checks: { ci_tests: "none" } };
type Ev = { type: string; ticket_id: string | null; data: Record<string, unknown> };

const resolve = (file: string) => on("builder FIX-1", { steps: [{ edit: file, content: "resolved\n" }],
  reply: { kind: "done", summary: "Resolved the conflict.", runs: [], block: null, question: null } });
const leaveMarkers = on("builder FIX-1#1", { steps: [{ edit: "NOTES.md", content: "looked\n" }],
  reply: { kind: "done", summary: "Looked at it.", runs: [], block: null, question: null } });

/** A commit on the bare remote's main (someone merged their work there). */
function remoteCommit(project: string, file: string, content: string, parent = "refs/remotes/origin/main"): void {
  git(project, ["fetch", "-q", "origin"]);
  const env = { ...process.env, GIT_INDEX_FILE: path.join(path.dirname(project), `idx-${file.replace(/\W/g, "")}`) };
  const run = (args: string[], input?: string) => execFileSync("git", ["-C", project, ...args],
    { encoding: "utf8", env, input }).trim();
  run(["read-tree", parent]);
  run(["update-index", "--add", "--cacheinfo", `100644,${run(["hash-object", "-w", "--stdin"], content)},${file}`]);
  const sha = gitAs(project, ["commit-tree", run(["write-tree"]), "-p", parent, "-m", `them: ${file}`]).trim();
  git(project, ["push", "-q", "origin", `${sha}:refs/heads/main`]);
}

/** Every merge-wait poll moves the clock to it (polls never fire on their own, SCN 7.4). */
function polls(clock: Computer["clock"]): void {
  clock.whenTimer("poll", () => {
    polls(clock);
    setImmediate(() => clock.advance(60_000));
  });
}

/** The fake provider reports a PR conflicting until its head (on the remote) contains the remote's main. */
function conflictingUntilMerged(project: string, gh: FakeGh): void {
  const remote = remoteOf(project);
  const before = gh.onCall;
  gh.onCall = async (args, g) => {
    await before?.(args, g);
    for (const pr of g.prs) {
      const has = (() => { try { git(remote, ["merge-base", "--is-ancestor", "main", pr.head]); return true; }
      catch { return false; } })();
      pr.mergeable = has ? "MERGEABLE" : "CONFLICTING";
    }
  };
}

test("19b (direct-merge): a conflict opens the delivery question; without a terminal it stays open; " +
  "\"Builder resolves the conflict\" adds FIX-1, which merges in U2's worktree; one branch, one delivery", async () => {
  const { project, computer, rafi, exported, of } = setup({ config: NO_CI, units: U2,
    build: { completion: "direct-merge" } });
  const onGit = once((a) => {
    if (a[0] !== "merge-tree") return false;
    writeFileSync(path.join(project, "src", "T3.txt"), "yours\n");
    git(project, ["add", "--", "src/T3.txt"]);
    gitAs(project, ["commit", "-qm", "you: src/T3.txt"]);
    return true;
  });
  const first = await rafi("start . --ticket T3 --branch-per-ticket", { onGit });
  assert.equal(first.code, 1, first.output);
  assert.match(first.output, /U2 failed \(conflict\)/);
  let e = await exported();
  const q = of(e, "question.opened").map((x) => x.data as { kind: string; tickets: string[]; options: { label:
    string }[] });
  assert.deepEqual(q.map((x) => [x.kind, x.tickets]), [["delivery", ["T3"]]]);
  assert.deepEqual(q[0]!.options.map((o) => o.label), ["Builder resolves the conflict",
    "Skip this merge (the branch stays pushed)", "Stop the build"]);
  assert.match(first.output, /waiting on question 1 \(delivery\)/);
  computer.script.rules.push(leaveMarkers, resolve("src/T3.txt"));
  const r = await rafi("resume", { tty: true, input: ["1"] });
  assert.equal(r.code, 0, r.output);
  e = await exported();
  const added = of(e, "ticket.added").map((x) => x.data);
  assert.deepEqual(added, [{ ticket: "FIX-1", source: "conflict", unit: "U2", hint: null,
    requirements: ["src/T3.txt has no conflict markers, keeping both sides' intent"] }]);
  assert.equal(of(e, "git.branch_created").length, 1, "no branch for FIX-1");
  assert.equal(of(e, "unit.delivered").length, 1);
  const all = e.events as unknown as Ev[];
  const t3 = all.filter((x) => x.ticket_id === "T3" && ["ticket.reopened", "ticket.status_set"]
    .includes(x.type));
  assert.deepEqual(t3, [], "T3 stays done");
  assert.equal(of(e, "checks.failed").filter((x) => x.ticket_id === "FIX-1").length, 1, "markers loop as a fix");
  const [fix] = trailers(project, T3, "FIX-1");
  assert.ok(fix);
  assert.equal(git(project, ["rev-list", "--parents", "-n", "1", fix!]).trim().split(" ").length, 3, "two parents");
  assert.equal(git(project, ["show", `${fix}:src/T3.txt`]), "resolved\n");
  assert.equal(git(project, ["show", "main:src/T3.txt"]), "resolved\n");
  assert.throws(() => git(project, ["grep", "-q", "-e", "<<<<<<<", "main", "--"]), "no markers on main");
});

test("10b (b) and 19b (pr-ready): a PR conflicting in src/ fails the unit as conflict; FIX-1 merges the remote's " +
  "base into the branch; the same PR is reused", async () => {
  const { project, computer, rafi, exported, of } = setup({ config: NO_CI, units: U2,
    build: { completion: "pr-ready" } });
  conflictingUntilMerged(project, computer.gh);
  const onGit = once((a) => {
    if (a[0] !== "push") return false;
    remoteCommit(project, "src/T3.txt", "theirs\n");
    return true;
  });
  computer.script.rules.push(resolve("src/T3.txt"));
  const r = await rafi("start . --ticket T3 --branch-per-ticket", { onGit, tty: true, input: ["1", "1"] });
  assert.equal(r.code, 0, r.output);
  const e = await exported();
  assert.deepEqual(of(e, "unit.failed").map((x) => (x.data as { category: string }).category), ["conflict"]);
  assert.equal(of(e, "pr.created").length, 1);
  assert.equal(computer.gh.prs.length, 1);
  assert.equal(computer.gh.prs[0]!.draft, false);
  assert.equal(of(e, "unit.delivered").length, 1);
  git(remoteOf(project), ["merge-base", "--is-ancestor", "main", T3]);
  const pushes = computer.gh.calls.length;
  assert.ok(pushes > 0);
});

test("10b (a): rafi's views ride on each ticket's commit; a PR conflicting only in them is updated from the base, " +
  "regenerated and pushed; one PR per ticket, no unit.failed, no question", async () => {
  // T3 waits for U1's merge, so the build polls U1's PRs (C204).
  const units = [{ id: "U1", tickets: ["T1", "T2"], branch_mode: "per-ticket" },
    { id: "U2", tickets: ["T3", "T4"], depends_on: ["U1"], dependency_mode: "wait" }];
  const tracker = { ".tickets/config.yaml": stringify({ app_name: "fixture", implementation_limit: 500,
    view_limit: 20000, timezone: "UTC" }) };
  const { project, computer, rafi, exported, of } = setup({ config: NO_CI, units, build: { completion: "auto-merge" },
    files: tracker });
  computer.gh.mergeAfterViews = 1;
  polls(computer.clock);
  conflictingUntilMerged(project, computer.gh);
  const inner = computer.gh.onCall;
  let merged = false;
  computer.gh.onCall = async (args, g) => {
    const t1 = g.prs.find((p) => p.head === T1);
    if (!merged && t1?.state === "MERGED") { merged = true; git(project, ["push", "-q", "origin", `${T1}:main`]); }
    await inner?.(args, g);
  };
  const r = await rafi("start . --steps 3 --branch-per-ticket");
  assert.equal(r.code, 0, r.output);
  for (const b of [T1, T2]) {
    const files = git(project, ["show", "--name-only", "--format=", trailers(project, b, b.slice(8, 10))[0]!]);
    assert.match(files, /\.rafi\/progress\.yaml/);
    assert.match(files, /docs\/ticket-progress\.md/);
  }
  const e = await exported();
  assert.equal(of(e, "unit.failed").length, 0, r.output);
  assert.equal(of(e, "question.opened").length, 0);
  const mine = computer.gh.prs.filter((p) => [T1, T2].includes(p.head));
  assert.equal(mine.length, 2, "one PR per ticket");
  assert.ok(mine.every((p) => p.state === "MERGED"), `${r.output}\n${JSON.stringify(computer.gh.prs)}\n${
    computer.gh.calls.map((c) => c.args.slice(0, 3).join(" ")).join("\n")}`);
  git(remoteOf(project), ["merge-base", "--is-ancestor", "main", T2]);
  assert.match(git(project, ["log", "--format=%s", "-n", "1", T2]), /Merge main into/);
});

test("the merge-wait timeout asks Keep waiting / Merge it myself, then continue / Skip the units that wait on it",
  async () => {
  // F-BRANCH's U3 (T4) stacks on U2 (T3), so the build waits for U2's PR.
  const { computer, rafi, exported, of } = setup({ config: NO_CI, units: [{ id: "U1", tickets: ["T1", "T2"] },
    { id: "U2", tickets: ["T3"] }, { id: "U3", tickets: ["T4"], depends_on: ["U2"], dependency_mode: "stack" }],
  build: { completion: "auto-merge", auto_merge_timeout_minutes: 2 } });
  polls(computer.clock);
  const r = await rafi("start . --steps 2 --skip U1 --branch-per-ticket", { tty: true, input: ["1", "2"] });
  assert.equal(r.code, 0, r.output);
  const e = await exported();
  const q = of(e, "question.opened").map((x) => x.data as { kind: string; options: { label: string }[] });
  const types = (e.events as unknown as Ev[]).map((x) => x.type);
  assert.equal(q.length, 2, `asked again after waiting again\n${r.output}\n${types
    .join(" ")}`);
  assert.deepEqual(q[0]!.options.map((o) => o.label), ["Keep waiting", "Merge it myself, then continue",
    "Skip the units that wait on it"]);
  const u2 = (type: string) => of(e, type).filter((x) => (x.data as { unit: string }).unit === "U2").length;
  assert.equal(u2("unit.merge_waiting"), 2);
  assert.equal(u2("unit.delivered"), 1);
  assert.ok(of(e, "delivery.done").some((x) => x.ticket_id === "T4"), "T4 built after U2 counted merged");
  assert.equal(of(e, "unit.failed").length, 0);
});

test("a transient provider failure is retried with backoff on the clock, not asked", async () => {
  const { computer, rafi, exported, of } = setup({ config: NO_CI, build: { completion: "pr" } });
  let failures = 1;
  computer.gh.fail = (args) => (args[1] === "create" && failures-- > 0
    ? { code: 1, stderr: "HTTP 502: Bad Gateway (try again)" } : null);
  const r = await rafi("start . --steps 1 --branch-per-ticket");
  assert.equal(r.code, 0, r.output);
  const e = await exported();
  assert.equal(of(e, "unit.failed").length, 0);
  assert.equal(of(e, "question.opened").length, 0);
  assert.equal(of(e, "unit.delivered").length, 1);
  assert.equal(computer.gh.prs.length, 1);
});
