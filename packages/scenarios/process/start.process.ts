// The process set's M2 rows (M2 plan 3.2): S-START-1 on the built launcher with the fake `codex` and the fake
// `claude` first on PATH, real deps (the OS sandbox runs `npm test`, the Codex fake reaches rafi's real HTTP
// endpoint); and S-ENG-5 step 3, one rafi process plus provider and check processes during a build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { writeShims } from "../fakes/shims.js";
import type { Behavior } from "../fakes/script/engine.js";
import { git, tempRoot } from "../fixtures/common.js";
import { fOne } from "../fixtures/f-one.js";
import { launcher } from "../harness/process.js";

const REQUIREMENTS: Behavior = { reply: { requirements: [{ from: 1, text: "The empty-state message shows.",
  check: "npm test", expect: "passes" }], in_scope: ["T1"], out_of_scope: [], risks: [], add_tags: [] } };
const BUILD: Behavior = { steps: [{ edit: "src/T1.txt", content: "T1 done\n" }, { runCheck: "npm test" }],
  reply: { kind: "done", summary: "Built T1.", runs: "$runs", block: null, question: null } };
const REVIEW: Behavior = { reply: { results: [{ req: 1, status: "satisfied", runs: [], needs: null, note: null }],
  summary: "R1 is satisfied." } };
const SCRIPT = [REQUIREMENTS, BUILD, REVIEW];

function build(runtime: "codex" | "claude") {
  const root = tempRoot("rafi-proc-");
  const project = fOne(root);
  if (runtime === "codex") {
    const file = path.join(project, "rafi-config.yaml");
    writeFileSync(file, stringify({ ...parse(readFileSync(file, "utf8")), harness: { targets: ["codex"] } }));
    git(project, ["commit", "-qam", "codex only"]);
  }
  const shims = writeShims(root, { codex: SCRIPT, claude: SCRIPT }, { ps: runtime === "codex" });
  const r = launcher(["start", ".", "--steps", "1"], { cwd: project, engine: "next", pathFirst: shims.bin });
  return { project, shims, r };
}

for (const runtime of ["codex", "claude"] as const) {
  test(`S-START-1 (process, ${runtime}): the built launcher finishes T1 on the fake ${runtime} executable`,
    { skip: process.platform === "win32" ? "PATH shims need a shell on Windows" : false, timeout: 240_000 },
    () => {
      const { project, shims, r } = build(runtime);
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`.slice(-3000));
      const show = launcher(["tickets", "show", "--all", "--json"], { cwd: project, engine: "next" });
      const t1 = JSON.parse(show.stdout).tickets.find((t: { id: string }) => t.id === "T1");
      assert.equal(t1.status, "done");
      assert.ok(t1.validation.runs.some((x: { command: string; outcome: string }) => x.command === "npm test" &&
        x.outcome === "passed"));
      const status = git(project, ["status", "--porcelain", "--untracked-files=all"]).trim().split("\n").sort();
      assert.deepEqual(status, ["?? .rafi/progress.yaml", "?? docs/requirements/T1.md", "?? src/T1.txt"]);
      assert.match(r.stdout, /^\d\d:\d\d:\d\d +builder +T1 /m);
      if (runtime === "codex") {
        const log = readFileSync(shims.logs.codex, "utf8");
        assert.match(log, /"op":"mcp","tool":"run_check","status":200/, "the fake reached rafi's real endpoint");
      }
    });
}

test("S-ENG-5 step 3 (process): one rafi process plus provider and check processes; no child rafi or ai-foreman",
  { skip: process.platform === "win32" ? "no ps on Windows (as D5)" : false, timeout: 240_000 }, () => {
    const { r, shims } = build("codex");
    assert.equal(r.code, 0, r.stderr.slice(-2000));
    const snapshots = readFileSync(shims.logs.codex, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((e) => e.op === "ps");
    assert.ok(snapshots.length > 0, "the fake recorded its ancestry");
    for (const s of snapshots as { ancestry: string[] }[]) {
      // The fake's chain up to the built launcher: provider ← rafi. Above it is the test runner, not rafi's.
      const top = s.ancestry.findIndex((c) => /dist\/launcher\.js/.test(c));
      assert.ok(top > 0, s.ancestry.join("\n"));
      const ours = s.ancestry.slice(0, top + 1);
      assert.equal(ours.filter((c) => /dist\/launcher\.js|\bbin\/rafi\b/.test(c)).length, 1, ours.join("\n"));
      assert.equal(s.ancestry.filter((c) => /dist\/launcher\.js/.test(c)).length, 1, "no child rafi");
      assert.ok(!ours.some((c) => /ai-foreman/.test(c)), "no ai-foreman process");
    }
  });
