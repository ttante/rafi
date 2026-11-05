// Milestone: M5
// The gate's two tiers (SCN 7.10, plan 10.10): which files the fast tier runs, from the registry's milestones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRegistry } from "../checks/import-docs.mjs";
import { readDoc } from "../checks/ledger.js";
import { registry } from "../checks/registry.js";
import { loadTierInput, scenarioBlocks, selectTier } from "../harness/tiers.mjs";

const reg = [
  { id: "S-A-1", milestone: "M2", partial: [] },
  { id: "S-B-1", milestone: "M4", partial: ["M3"] },
  { id: "S-C-1", milestone: "M8", partial: ["M5"] },
  { id: "S-D-1", milestone: "M7", partial: [] },
  { id: "S-E-1", milestone: "M5", partial: [] },
];
const sc = (id: string, body = "await step(\"x\", () => {});") =>
  `scenario({ id: "${id}", run: async () => { ${body} } });\n`;
const file = (path: string, text: string) => ({ path, text });

test("a scenario block is active only when it calls step(; pending-only blocks aren't", () => {
  const text = sc("S-A-1") + sc("S-D-1", "await ctx.pending(\"y\", \"M7\");") +
    sc("S-B-1", "await ctx.step(\"z\", f);");
  assert.deepEqual(scenarioBlocks(text), [{ id: "S-A-1", active: true }, { id: "S-D-1", active: false },
    { id: "S-B-1", active: true }]);
});

test("the current milestone is the newest first-active milestone among active scenarios; a pending-only scenario " +
  "of a later milestone doesn't move it", () => {
  const out = selectTier({ registry: reg, scenarioFiles: [
    file("s/a.scenario.ts", sc("S-A-1")), file("s/c.scenario.ts", sc("S-C-1")),
    file("s/d.scenario.ts", sc("S-D-1", "await ctx.pending(\"y\", \"M7\");")),
  ], testFiles: [] });
  assert.equal(out.current, "M5");
  assert.equal(out.previous, "M4");
});

test("a file's milestone is the newest milestone of its active scenarios not after the current one; the fast tier " +
  "is the current and previous milestone's files", () => {
  const out = selectTier({ registry: reg, scenarioFiles: [
    file("s/a.scenario.ts", sc("S-A-1")), file("s/b.scenario.ts", sc("S-B-1")),
    file("s/c.scenario.ts", sc("S-C-1")), file("s/e.scenario.ts", sc("S-E-1")),
    file("s/d.scenario.ts", sc("S-D-1", "await ctx.pending(\"y\", \"M7\");")),
  ], testFiles: [
    file("t/old.test.ts", "// Milestone: M2\nimport x;\n"), file("t/new.test.ts", "// x\n// Milestone: M4\n"),
  ] });
  assert.deepEqual(Object.fromEntries(out.milestones), { "s/a.scenario.ts": "M2", "s/b.scenario.ts": "M4",
    "s/c.scenario.ts": "M5", "s/e.scenario.ts": "M5", "s/d.scenario.ts": "M7", "t/old.test.ts": "M2",
    "t/new.test.ts": "M4" });
  assert.deepEqual([...out.fast].sort(), ["s/b.scenario.ts", "s/c.scenario.ts", "s/e.scenario.ts", "t/new.test.ts"]);
  assert.deepEqual(out.problems, []);
});

test("a test file with no milestone marker, or a scenario file naming no registered scenario, is a problem", () => {
  const out = selectTier({ registry: reg, scenarioFiles: [file("s/a.scenario.ts", sc("S-A-1")),
    file("s/z.scenario.ts", "import x;\n")], testFiles: [file("t/none.test.ts", "// no marker\n")] });
  assert.deepEqual(out.problems, ["s/z.scenario.ts: names no registered scenario, so it has no milestone",
    "t/none.test.ts: no \"// Milestone: Mn\" line in its first 5 lines"]);
  assert.ok(!out.fast.has("t/none.test.ts"));
});

test("the registry carries ARCH 14's Partial lists", () => {
  const fresh = buildRegistry(readDoc("REWRITE_SCENARIOS.md"), readDoc("REWRITE_ARCHITECTURE.md"));
  const of = (id: string) => fresh.find((e: { id: string }) => e.id === id);
  assert.deepEqual(of("S-START-5")?.partial, ["M4", "M5"]);
  assert.deepEqual(of("S-CLI-19")?.partial, ["M5"]);
  assert.deepEqual(of("S-CLI-1")?.partial, []);
});

test("every file in this tree has a milestone; the fast tier holds exactly the current and previous milestone's files",
  () => {
  const out = selectTier({ registry, ...loadTierInput() });
  assert.deepEqual(out.problems, []);
  for (const [f, m] of out.milestones) {
    assert.equal(out.fast.has(f), (m === out.current || m === out.previous) && !out.crash.has(f), f);
  }
  assert.equal(out.milestones.get("packages/scenarios/scenarios/settings.scenario.ts"), "M5", "a partial's M5 steps");
  assert.equal(out.milestones.get("packages/scenarios/scenarios/crash-1-t2a.scenario.ts"), "M4");
  assert.equal(out.milestones.get("packages/scenarios/scenarios/start.scenario.ts"), "M2");
  assert.ok(out.fast.has("packages/scenarios/scenarios/batch-resume.scenario.ts"), "follows its helper import");
});

// Part 4d (plan 10.12; user approval 2026-11-04, SCN 7.10's Fast row): crash enumerations run in the full tier only.
const ENUM = "// Crash enumeration (SCN 7.7): the full tier only.\n";
const usesEnum = "import { enumerateCrashes } from \"../checks/crash.js\";\n";

test("a file marked \"// Crash enumeration\" is in the full tier but not the fast one, whatever its milestone", () => {
  const out = selectTier({ registry: reg, scenarioFiles: [
    file("s/b.scenario.ts", sc("S-B-1")), file("s/e.scenario.ts", sc("S-E-1")),
    file("s/crash-b.scenario.ts", `// S-B-1's crash shard.\n${ENUM}${usesEnum}${sc("S-B-1")}`),
    file("s/crash-e.scenario.ts", `${ENUM}${usesEnum}${sc("S-E-1")}`),
  ], testFiles: [file("t/crash.test.ts", `// Milestone: M5\n${ENUM}`), file("t/new.test.ts", "// Milestone: M5\n")] });
  assert.deepEqual(out.problems, []);
  assert.deepEqual([...out.crash].sort(), ["s/crash-b.scenario.ts", "s/crash-e.scenario.ts", "t/crash.test.ts"]);
  assert.deepEqual([...out.fast].sort(), ["s/b.scenario.ts", "s/e.scenario.ts", "t/new.test.ts"]);
  assert.deepEqual([...out.full].sort(), ["s/b.scenario.ts", "s/crash-b.scenario.ts", "s/crash-e.scenario.ts",
    "s/e.scenario.ts", "t/crash.test.ts", "t/new.test.ts"]);
  assert.equal(out.milestones.get("s/crash-e.scenario.ts"), "M5", "the marker doesn't change a file's milestone");
});

test("a file that imports the crash enumerators (enumerateCrashes, holds) without the marker is a problem", () => {
  const out = selectTier({ registry: reg, scenarioFiles: [
    file("s/x.scenario.ts", `import { holds } from "../checks/crash.js";\n${sc("S-E-1")}`),
    file("s/y.scenario.ts", `import { lever, enumerateCrashes } from "../checks/crash.js";\n${sc("S-B-1")}`),
    file("s/ok.scenario.ts", `import { workFiles } from "../checks/crash.js";\n${sc("S-E-1")}`),
  ], testFiles: [] });
  assert.deepEqual(out.problems, [
    "s/x.scenario.ts: runs a crash enumeration without a \"// Crash enumeration\" line in its first 5 lines",
    "s/y.scenario.ts: runs a crash enumeration without a \"// Crash enumeration\" line in its first 5 lines"]);
  assert.ok(out.fast.has("s/ok.scenario.ts"));
});

test("in this tree, S-CRASH-1's shards (M4's crash-1-*, M5's crash-git-*) are full-tier only", () => {
  const out = selectTier({ registry, ...loadTierInput() });
  const s = (n: string) => `packages/scenarios/scenarios/${n}.scenario.ts`;
  const shards = ["crash-1-t1t3", "crash-1-t2a", "crash-1-t2b", "crash-git-a", "crash-git-b", "crash-git-c"].map(s);
  assert.deepEqual([...out.crash].sort(), shards);
  for (const f of shards) {
    assert.ok(out.full.has(f) && !out.fast.has(f), f);
    assert.ok(out.milestones.get(f) === out.current || out.milestones.get(f) === out.previous, f);
  }
  for (const f of [s("crash-faults"), s("stop"), s("resume"), s("pause"),
    "packages/scenarios/test/crash-m5-conflict.test.ts"]) assert.ok(out.fast.has(f), `${f} stays fast`);
});
