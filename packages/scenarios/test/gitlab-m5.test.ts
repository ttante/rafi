// Milestone: M5
// GitLab through the fake `glab` (M5 plan C216; 4b's open item): the same delivery as GitHub's, as merge requests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { git } from "../fixtures/common.js";
import { gitAs, remoteOf } from "../fixtures/f-branch.js";
import { on } from "../fakes/script/behaviors.js";
import type { FakeGh } from "../fakes/gh.js";
import type { Computer } from "../harness/deps.js";
import { T1, once, setup, trailers } from "./git-race-helpers.js";

/** Not about CI: no CI point before delivery (slice 8's, C213). */
const NO_CI = { checks: { ci_tests: "none" } };

const flag = (args: readonly string[], name: string) => args[args.indexOf(name) + 1];

test("provider gitlab, completion pr: one draft MR from the ticket's branch, its description file, glab only",
  async () => {
    const { computer, rafi, exported, of } = setup({ config: NO_CI, build: { completion: "pr", provider: "gitlab" } },
      { GITLAB_TOKEN: "glpat-abcdefghij0123456789", GH_TOKEN: "ghp_notforglab0123456789abcdef" });
    const r = await rafi("start . --steps 1 --branch-per-ticket", {});
    assert.equal(r.code, 0, r.output);
    const calls = computer.gh.calls;
    assert.ok(calls.length > 0 && calls.every((c) => c.cmd === "glab"), calls.map((c) => c.cmd).join(" "));
    const create = calls.find((c) => c.args[0] === "mr" && c.args[1] === "create")!;
    assert.equal(flag(create.args, "--source-branch"), T1);
    assert.equal(flag(create.args, "--target-branch"), "main");
    assert.ok(create.args.includes("--draft") && create.args.includes("--yes"));
    const file = flag(create.args, "--description-file")!;
    assert.ok(existsSync(file) && /\.foreman\/pr-bodies\//.test(file), file);
    assert.match(readFileSync(file, "utf8"), /T1: Add the parser/);
    assert.ok(calls.findIndex((c) => c.args[1] === "list") < calls.indexOf(create), "looked up before it's made");
    assert.equal(computer.gh.prs.length, 1);
    assert.equal(computer.gh.prs[0]!.draft, true);
    const created = of(await exported(), "pr.created");
    assert.deepEqual(created.map((x) => (x.data as { url: string }).url), [computer.gh.prs[0]!.url]);
    assert.ok(calls.every((c) => c.envValues.GITLAB_TOKEN === "glpat-abcdefghij0123456789"));
  });

test("provider gitlab, auto-merge: --when-pipeline-succeeds, the wait polls glab until merged, then delivered",
  async () => {
    const units = [{ id: "U1", tickets: ["T1"], branch_mode: "per-ticket" },
      { id: "U2", tickets: ["T2"], depends_on: ["U1"], dependency_mode: "wait" }, { id: "U3", tickets: ["T3", "T4"] }];
    const build = { completion: "auto-merge", provider: "gitlab" };
    const { computer, rafi, exported, of } = setup({ config: NO_CI, units, build });
    computer.gh.mergeAfterViews = 1;
    const polls = () => computer.clock.whenTimer("poll", () => {
      polls();
      setImmediate(() => computer.clock.advance(60_000));
    });
    polls();
    const r = await rafi("start . --to-ticket T2 --branch-per-ticket", {});
    assert.equal(r.code, 0, r.output);
    const merge = computer.gh.calls.find((c) => c.args[0] === "mr" && c.args[1] === "merge")!;
    assert.ok(merge.args.includes("--when-pipeline-succeeds"), merge.args.join(" "));
    assert.ok(computer.gh.calls.some((c) => c.args[0] === "mr" && c.args[1] === "view"), "polled with glab");
    const e = await exported();
    const u1 = of(e, "unit.delivered").filter((x) => (x.data as { unit: string }).unit === "U1");
    assert.deepEqual(u1.map((x) => (x.data as { how: string }).how), ["merged"]);
    assert.ok(of(e, "pr.merged").length >= 1);
    const started = of(e, "ticket.started").find((x) => x.ticket_id === "T2")!;
    assert.ok(started.seq > u1[0]!.seq, "T2 waits for U1's merge request to merge");
  });

// GitLab's conflicting merge requests (4b-2's open item; C240 and C237 as 10b and 19b test them for gh).
const T2 = "feature/T2-add-the-printer";
const T3 = "feature/T3-add-the-store";

/** A commit on the bare remote's main (someone merged their work there). */
function remoteCommit(project: string, file: string, content: string): void {
  git(project, ["fetch", "-q", "origin"]);
  const env = { ...process.env, GIT_INDEX_FILE: path.join(path.dirname(project), "idx-them") };
  const run = (args: string[], input?: string) => execFileSync("git", ["-C", project, ...args],
    { encoding: "utf8", env, input }).trim();
  run(["read-tree", "refs/remotes/origin/main"]);
  run(["update-index", "--add", "--cacheinfo", `100644,${run(["hash-object", "-w", "--stdin"], content)},${file}`]);
  const sha = gitAs(project, ["commit-tree", run(["write-tree"]), "-p", "refs/remotes/origin/main", "-m",
    `them: ${file}`]).trim();
  git(project, ["push", "-q", "origin", `${sha}:refs/heads/main`]);
}

/** The fake provider reports an MR conflicting until its source branch (on the remote) contains main. */
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

function polls(clock: Computer["clock"]): void {
  clock.whenTimer("poll", () => {
    polls(clock);
    setImmediate(() => clock.advance(60_000));
  });
}

test("provider gitlab: an MR conflicting only in rafi's views gets main merged in, the views regenerated and " +
  "pushed; both MRs merge; no unit.failed, no question", async () => {
  const units = [{ id: "U1", tickets: ["T1", "T2"], branch_mode: "per-ticket" },
    { id: "U2", tickets: ["T3", "T4"], depends_on: ["U1"], dependency_mode: "wait" }];
  const tracker = { ".tickets/config.yaml": stringify({ app_name: "fixture", implementation_limit: 500,
    view_limit: 20000, timezone: "UTC" }) };
  const { project, computer, rafi, exported, of } = setup({ config: NO_CI, units,
    build: { completion: "auto-merge", provider: "gitlab" }, files: tracker });
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
  assert.ok(computer.gh.calls.every((c) => c.cmd === "glab"));
  const e = await exported();
  assert.equal(of(e, "unit.failed").length, 0, r.output);
  assert.equal(of(e, "question.opened").length, 0);
  const mine = computer.gh.prs.filter((p) => [T1, T2].includes(p.head));
  assert.equal(mine.length, 2, "one MR per ticket");
  assert.ok(mine.every((p) => p.state === "MERGED"), JSON.stringify(computer.gh.prs));
  git(remoteOf(project), ["merge-base", "--is-ancestor", "main", T2]);
  assert.match(git(project, ["log", "--format=%s", "-n", "1", T2]), /Merge main into/);
  assert.equal(trailers(project, T2, "T2").length, 1, "one commit for T2's work");
});

test("provider gitlab: an MR conflicting in src/ fails the unit as conflict; FIX-1 merges the remote's main into " +
  "its branch; the same MR is reused, ready, and delivered once", async () => {
  const { project, computer, rafi, exported, of } = setup({ config: NO_CI,
    units: [{ id: "U2", tickets: ["T3"] }, { id: "U1", tickets: ["T1", "T2", "T4"] }],
    build: { completion: "pr-ready", provider: "gitlab" } });
  conflictingUntilMerged(project, computer.gh);
  const onGit = once((a) => {
    if (a[0] !== "push") return false;
    remoteCommit(project, "src/T3.txt", "theirs\n");
    return true;
  });
  computer.script.rules.push(on("builder FIX-1", { steps: [{ edit: "src/T3.txt", content: "resolved\n" }],
    reply: { kind: "done", summary: "Resolved the conflict.", runs: [], block: null, question: null } }));
  const r = await rafi("start . --ticket T3 --branch-per-ticket", { onGit, tty: true, input: ["1", "1"] });
  assert.equal(r.code, 0, r.output);
  assert.ok(computer.gh.calls.every((c) => c.cmd === "glab"));
  const e = await exported();
  assert.deepEqual(of(e, "unit.failed").map((x) => (x.data as { category: string }).category), ["conflict"]);
  assert.equal(of(e, "pr.created").length, 1);
  assert.equal(computer.gh.prs.length, 1);
  assert.equal(computer.gh.prs[0]!.draft, false, "ready (pr-ready opens it ready)");
  assert.equal(of(e, "unit.delivered").length, 1);
  git(remoteOf(project), ["merge-base", "--is-ancestor", "main", T3]);
  assert.equal(git(remoteOf(project), ["show", `${T3}:src/T3.txt`]), "resolved\n");
});
