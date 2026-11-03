// The scenario() API of SCN 7.9. Each scenario runs as a node:test test; steps that need a later milestone
// report "not run (pending Mn)"; the after-each checks of S-CLI-2 step 4 run after every scenario.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { registry } from "../checks/registry.js";
import { fChain } from "../fixtures/f-chain.js";
import { fHuge } from "../fixtures/f-huge.js";
import { fTestsLocal } from "../fixtures/f-tests.js";
import { fOne, fOneLegacy } from "../fixtures/f-one.js";
import { copyLegacy } from "../fixtures/legacy.js";
import { git, tempRoot } from "../fixtures/common.js";
import { afterEachChecks } from "./after-each.js";
import { newComputer, rafiRunner, type Rafi, type RafiResult } from "./rafi.js";
import type { Computer } from "./deps.js";

export type Mode = "next" | "next-process";
export type FixtureName = "F-ONE" | "F-ONE-0.10" | "F-CHAIN" | "F-LEGACY" | "F-LEGACY-RUNNING" | "F-TESTS-LOCAL"
  | "F-TESTS-JEST" | "F-HUGE-NO-COMMIT" | "F-HUGE-IGNORED" | "none";

export interface ScenarioContext {
  readonly rafi: Rafi;
  readonly root: string;
  /** The fixture project (an empty folder outside any project for "none"). */
  readonly project: string;
  readonly computer: Computer;
  /** A second fixture in the same scenario; legacy fixtures are excluded from the forbidden-path check. */
  fixture(name: FixtureName): string;
  step(name: string, fn: () => Promise<void> | void): Promise<void>;
  pending(name: string, milestone: string): Promise<void>;
  /** `git status --porcelain --untracked-files=all` is empty. */
  clean(project?: string): void;
  readonly results: readonly RafiResult[];
}

export interface ScenarioDef {
  readonly id: string;
  readonly covers: readonly string[];
  readonly modes: readonly Mode[];
  readonly fixture: FixtureName;
  run(ctx: ScenarioContext): Promise<void>;
}

const LEGACY: ReadonlySet<FixtureName> = new Set(["F-LEGACY", "F-LEGACY-RUNNING", "F-ONE-0.10"]);

function build(name: FixtureName, root: string): string {
  switch (name) {
    case "F-ONE": return fOne(root);
    case "F-ONE-0.10": return fOneLegacy(root);
    case "F-CHAIN": return fChain(root);
    case "F-TESTS-LOCAL": return fTestsLocal(root);
    case "F-TESTS-JEST": return fTestsLocal(root, {}, "npx jest");
    case "F-HUGE-NO-COMMIT": return fHuge(root, "no-commit");
    case "F-HUGE-IGNORED": return fHuge(root, "ignored");
    case "F-LEGACY": return copyLegacy("F-LEGACY", root);
    case "F-LEGACY-RUNNING": return copyLegacy("F-LEGACY-RUNNING", root);
    case "none": return tempRoot("rafi-noproject-");
  }
}

function context(def: ScenarioDef, t: TestContext) {
  const root = tempRoot();
  const computer = newComputer(root);
  const projects: string[] = [];
  let extra = 0;
  const add = (name: FixtureName) => {
    const base = extra++ === 0 ? root : path.join(root, `extra-${extra}`);
    mkdirSync(base, { recursive: true });
    const dir = build(name, base);
    if (!LEGACY.has(name)) projects.push(dir);
    return dir;
  };
  const project = add(def.fixture);
  const results: RafiResult[] = [];
  const ctx: ScenarioContext = {
    rafi: rafiRunner(computer, project, results), root, project, computer, results, fixture: add,
    step: async (name, fn) => { await t.test(name, async () => { await fn(); }); },
    pending: async (name, milestone) => { await t.test(name, { skip: `not run (pending ${milestone})` }, () => {}); },
    clean: (dir = project) => assert.equal(git(dir, ["status", "--porcelain", "--untracked-files=all"]), "",
      `git status in ${dir}`),
  };
  return { ctx, projects };
}

/** S-CLI-2 step 4 for one scenario: its projects, what rafi printed, every process it started, every agent message. */
export function scenarioProblems(computer: Computer, projects: readonly string[],
  results: readonly RafiResult[]): string[] {
  return afterEachChecks({ projects, outputs: results.map((r) => r.output), transcripts: computer.sentToAgents,
    childEnvs: computer.childEnvs, canaries: computer.canaries, agentEnvs: computer.agentEnvs });
}

export function scenario(def: ScenarioDef): void {
  const entry = registry.find((r) => r.id === def.id);
  test(def.id, async (t) => {
    assert.ok(entry, `${def.id} isn't in the scenario registry`);
    assert.deepEqual([...def.covers].sort(), [...entry.covers].sort(), `${def.id}'s covers differ from SCN`);
    if (!def.modes.includes("next")) return t.skip("n/a in mode next");
    const { ctx, projects } = context(def, t);
    await def.run(ctx);
    const problems = scenarioProblems(ctx.computer, projects, ctx.results);
    assert.deepEqual(problems, [], "S-CLI-2 step 4");
  });
}
