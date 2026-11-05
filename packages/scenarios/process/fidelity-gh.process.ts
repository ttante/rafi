// Process set, M5 plan item 35 (slice 11; C216, C340): the fake provider's fidelity. The same F-BRANCH delivery
// (`--steps 2 --branch-per-ticket`) runs once in-process, with deps.exec routing `gh`/`glab` to the handler, and once
// through the built launcher with the executables first on PATH. Both must record the same calls (arguments, the
// working folder and the provider variables, with the project folder and run id normalized) and leave the same PR
// states. Per provider and completion: github `pr` and `pr-ready`, gitlab `pr`.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FakeGh } from "../fakes/gh.js";
import { configure, tempRoot } from "../fixtures/common.js";
import { fBranch } from "../fixtures/f-branch.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";
import { run } from "../harness/process-run.js";
import type { EventsExport } from "../checks/invariants.js";
import { deliverySetup, NO_CI, PROVIDER_VARS, type Provider } from "./delivery-helpers.js";

const TOKEN = { GH_TOKEN: "ghp_fidelity0123456789abcdefghij", GITLAB_TOKEN: "glpat-fidelity0123456789abcd" };

/** Calls and PRs with the project folder and run id replaced, so two runs of one delivery compare equal. */
function normalized(gh: FakeGh, project: string, run: string) {
  const swap = (text: string) => text.split(project).join("<project>").split(run).join("<run>");
  return {
    calls: gh.calls.map((c) => ({ cmd: c.cmd, args: c.args.map(swap), cwd: swap(c.cwd),
      vars: Object.fromEntries(Object.entries(c.envValues).filter(([k]) => PROVIDER_VARS.test(k))) })),
    prs: gh.prs.map((p) => ({ ...p, body: swap(p.body), title: swap(p.title) })),
  };
}

const runOf = (e: EventsExport) => e.events.find((x) => x.type === "build.started")!.run_id!;
const states = (e: EventsExport) => e.events.filter((x) => /^(pr|unit|git)\./.test(x.type) && x.type !== "git.intent")
  .map((x) => [x.type, x.ticket_id]);

async function inProcess(provider: Provider, args: string) {
  const root = tempRoot("rafi-gh-fid-");
  const project = fBranch(root, { config: NO_CI, build: { provider } });
  configure(project, { harness: { targets: ["codex"] } });
  const computer = newComputer(root, "a", TOKEN);
  const rafi = rafiRunner(computer, project);
  const r = await rafi(args);
  assert.equal(r.code, 0, r.output);
  const e = JSON.parse((await rafi("stats export")).out) as EventsExport;
  return { ...normalized(computer.gh, project, runOf(e)), events: states(e) };
}

async function viaExecutables(provider: Provider, args: string) {
  const s = deliverySetup(provider, { env: TOKEN });
  const r = await run(args.split(" "), s.opts);
  assert.equal(r.code, 0, r.output.slice(-2000));
  const e = await s.exported();
  return { ...normalized(s.gh(), s.project, runOf(e)), events: states(e) };
}

const CASES: [Provider, string][] = [["github", "pr"], ["github", "pr-ready"], ["gitlab", "pr"]];

for (const [provider, completion] of CASES) {
  test(`item 35 (${provider}, ${completion}): the handler and the executables record the same calls and states`,
    { skip: process.platform === "win32" ? "PATH executables need POSIX shebangs" : false, timeout: 180_000 },
    async () => {
      const args = `start . --steps 2 --branch-per-ticket --completion ${completion}`;
      const a = await inProcess(provider, args);
      const b = await viaExecutables(provider, args);
      assert.ok(a.calls.length >= 4, JSON.stringify(a.calls));
      assert.deepEqual(b.calls, a.calls, "the same calls");
      assert.deepEqual(b.prs, a.prs, "the same PR states");
      assert.deepEqual(b.events, a.events, "the same delivery records");
    });
}
