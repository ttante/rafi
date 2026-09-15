import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { stringify } from "yaml";
import {
  buildDiscoveryInstruction,
  buildDiscoveryRunOptions,
  buildLocalInventory,
  DISCOVERY_ENVELOPE_END,
  DISCOVERY_ENVELOPE_START,
  discoveryEnvelopePlanningSources,
  runDiscovery,
} from "../src/discovery.js";
import { buildProjectConfig, defaultAnswers } from "../src/project.js";
import type { RoleInstructionRunOptions, RoleInstructionRunResult } from "ai-foreman/agent-run.js";

const SOURCE_REQUEST_START = "RAFI_SOURCE_REQUEST_START";
const SOURCE_REQUEST_END = "RAFI_SOURCE_REQUEST_END";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "rafi-discovery-test-"));
}

function agentResult(text: string): RoleInstructionRunResult {
  return {
    turn: {
      result: { text, isError: false },
      status: { kind: "plan_complete", summary: "discovery_complete" },
    },
    runtime: "codex",
    logPath: "test.log",
    roleBundle: { system: "", skills: [], model: null, effort: null, source: "fallback" },
    skills: [],
  } as unknown as RoleInstructionRunResult;
}

function finalOutput(): string {
  return `Discovery report
${DISCOVERY_ENVELOPE_START}
{"version":1,"likely_current_state":{"state":"ready","evidence":["docs/plan.md"]},"relevant_prior_plans_docs_tickets":[{"path":"docs/plan.md","status":"current"}],"recommended_next_command":"none","handoff_brief":"Continue from here"}
${DISCOVERY_ENVELOPE_END}
STEP_STATUS: plan_complete | summary="discovery_complete"`;
}

test("discovery run options use the discovery role with read-only permissions", () => {
  const options = buildDiscoveryRunOptions({ projectDir: tempDir(), instruction: "inspect" });
  assert.equal(options.role, "discovery");
  assert.equal(options.sandboxMode, "read-only");
  assert.equal(options.persistSessionBindings, false);
  assert.deepEqual(options.permissionConfig?.allowTools, ["Read", "Glob", "Grep", "TodoWrite"]);
});

test("discovery preserves linguistic answers in the agent instruction", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "rafi-config.yaml"), stringify(buildProjectConfig(defaultAnswers())), "utf8");
  const seen: string[] = [];
  await runDiscovery({
    project: dir,
    online: ["GitHub issues labeled billing, Linear team CORE + do not use Jira"],
    background: ["We pivoted after launch, keep the migration notes intact."],
    local: ["docs/foo, docs/bar + src/payments; avoid docs/private"],
    rafiHistory: "yes - but not for the most recent updates",
    yes: true,
    loadSources: () => emptyLoadedSources(),
    registerSources: async (projectDir, registry) => ({ registry, entries: [], snapshots: [], pending: [] }),
    saveSources: () => {},
    sourceRequestFromAnswer: () => ({}),
    extractSourceRequests: () => [],
    setSourceStorage: (registry) => registry,
    runRole: async (opts: RoleInstructionRunOptions) => {
      seen.push(opts.instruction);
      return agentResult(finalOutput());
    },
  });

  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /GitHub issues labeled billing, Linear team CORE \+ do not use Jira/);
  assert.match(seen[0]!, /docs\/foo, docs\/bar \+ src\/payments; avoid docs\/private/);
});

test("discovery prompt requires latest state, latest plan, artifact freshness, and next plan", () => {
  const instruction = buildDiscoveryInstruction({
    projectDir: tempDir(),
    initialized: true,
    answers: { online: [], background: [], local: [], rafiHistory: "yes" },
    inventory: [],
    sourceRegistry: emptyLoadedSources().registry,
    lifecycle: { initialized: true },
    history: { present: [] },
    sourceAccess: "local-only",
  });

  assert.match(instruction, /latest known project state/i);
  assert.match(instruction, /most recent relevant completed, current, or abandoned plan/i);
  assert.match(instruction, /stale artifacts from current artifacts/i);
  assert.match(instruction, /Recommend the next plan or command/i);
  assert.match(instruction, /confidence and concrete gaps/i);
});

test("local inventory scans current and legacy Rafi artifact paths", () => {
  const dir = tempDir();
  mkdirSync(join(dir, ".foreman", "runs"), { recursive: true });
  mkdirSync(join(dir, ".tickets"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "project.yaml"), "appName: Legacy\n", "utf8");
  writeFileSync(join(dir, ".tickets", "config.yaml"), "queue_limit: 2\n", "utf8");
  writeFileSync(join(dir, "docs", "roadmap.md"), "# Roadmap\n", "utf8");
  writeFileSync(join(dir, "tickets.yaml"), "tickets: []\n", "utf8");

  const paths = buildLocalInventory(dir).map((entry) => entry.path);
  assert.ok(paths.includes("project.yaml"));
  assert.ok(paths.includes(".foreman/runs"));
  assert.ok(paths.includes(".tickets/config.yaml"));
  assert.ok(paths.includes("docs/roadmap.md"));
  assert.ok(paths.includes("tickets.yaml"));
});

test("uninitialized discovery does not write rafi-config.yaml or save sources", async () => {
  const dir = tempDir();
  let saved = 0;
  let registered = 0;
  await runDiscovery({
    project: dir,
    local: ["README.md"],
    yes: true,
    loadSources: () => emptyLoadedSources(),
    sourceRequestFromAnswer: () => ({}),
    extractSourceRequests: () => [],
    setSourceStorage: (registry) => registry,
    runRole: async () => agentResult(finalOutput()),
    registerSources: async (projectDir, registry) => {
      registered += 1;
      return { registry, entries: [], snapshots: [], pending: [] };
    },
    saveSources: () => { saved += 1; },
  });
  assert.equal(registered, 0);
  assert.equal(saved, 0);
  assert.equal(existsSync(join(dir, "rafi-config.yaml")), false);
});

test("discovery processes source requests and stops after three rounds", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "rafi-config.yaml"), stringify(buildProjectConfig(defaultAnswers())), "utf8");
  let runs = 0;
  let registered = 0;
  const result = await runDiscovery({
    project: dir,
    online: ["Use online sources I mention during discovery"],
    yes: true,
    loadSources: () => emptyLoadedSources(),
    saveSources: () => {},
    sourceRequestFromAnswer: () => ({}),
    extractSourceRequests: (output) => {
      const start = output.indexOf(SOURCE_REQUEST_START);
      const end = output.indexOf(SOURCE_REQUEST_END);
      if (start < 0 || end < 0) return [];
      return [JSON.parse(output.slice(start + SOURCE_REQUEST_START.length, end).trim())];
    },
    setSourceStorage: (registry) => registry,
    runRole: async () => {
      runs += 1;
      if (runs <= 4) {
        return agentResult(`Need more
${SOURCE_REQUEST_START}
{"type":"url","label":"Example ${runs}","locator":{"url":"https://example.com/${runs}"}}
${SOURCE_REQUEST_END}
STEP_STATUS: needs_input | question="more?" choices="yes|no"`);
      }
      return agentResult(finalOutput());
    },
    registerSources: async (projectDir, registry, requests) => {
      registered += 1;
      return { registry, entries: [], snapshots: requests.map((_, index) => `.rafi/source-cache/${registered}-${index}.md`), pending: [] };
    },
  });

  assert.equal(runs, 4);
  assert.equal(registered, 3);
  assert.doesNotMatch(result.output, new RegExp(SOURCE_REQUEST_START));
  assert.ok(result.envelope);
  assert.equal(result.envelope?.handoff_brief, "Discovery ended with a host-generated fallback envelope. Review the listed artifacts and source captures before making irreversible planning decisions.");
});

test("source continuation keeps original context, accumulated captures, prior output, and session ref", async () => {
  const dir = tempDir();
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "rafi-config.yaml"), stringify(buildProjectConfig(defaultAnswers())), "utf8");
  writeFileSync(join(dir, "docs", "current-plan.md"), "# Current\n", "utf8");
  const sessionRef = { version: 1, provider: "codex", role: "discovery", sessionId: "session-123", workspace: { root: dir }, generation: 0 } as never;
  const seen: RoleInstructionRunOptions[] = [];

  await runDiscovery({
    project: dir,
    online: ["Use GitHub issue 123, avoid Jira"],
    background: ["Current deploy failed after the billing plan."],
    local: ["docs/current-plan.md"],
    rafiHistory: "yes - for the last work done",
    yes: true,
    loadSources: () => emptyLoadedSources(),
    saveSources: () => {},
    sourceRequestFromAnswer: () => ({}),
    extractSourceRequests: (output) => output.includes(SOURCE_REQUEST_START)
      ? [{ type: "local", label: "Current plan", locator: { path: "docs/current-plan.md" } }]
      : [],
    setSourceStorage: (registry) => registry,
    registerSources: async (projectDir, registry, requests) => ({
      registry,
      entries: requests.map((request, index) => ({
        id: `src-${index}`,
        type: request.type,
        label: request.label,
        locator: request.locator,
        active: true,
        versions: [],
      })) as never,
      snapshots: [".rafi/source-cache/current-plan.md"],
      pending: ["needs private ticket export"],
    }),
    runRole: async (opts: RoleInstructionRunOptions) => {
      seen.push(opts);
      if (seen.length === 1) {
        return { ...agentResult(`Need plan
${SOURCE_REQUEST_START}
{"type":"local","label":"Current plan","locator":{"path":"docs/current-plan.md"}}
${SOURCE_REQUEST_END}
STEP_STATUS: needs_input | question="source?"`), sessionRef };
      }
      assert.deepEqual(opts.resumeSessionRef, sessionRef);
      return agentResult(finalOutput());
    },
  });

  assert.equal(seen.length, 2);
  const continuation = seen[1]!.instruction;
  assert.match(continuation, /Use GitHub issue 123, avoid Jira/);
  assert.match(continuation, /docs\/current-plan\.md/);
  assert.match(continuation, /Current deploy failed after the billing plan/);
  assert.match(continuation, /Lifecycle\/status summary/);
  assert.match(continuation, /Workflow\/ticket\/run history summary/);
  assert.match(continuation, /\.rafi\/source-cache\/current-plan\.md/);
  assert.match(continuation, /needs private ticket export/);
  assert.match(continuation, /Prior discovery agent output/);
  assert.match(continuation, /Need plan/);
});

test("create planning source handoff includes structured discovery envelope", () => {
  const sources = discoveryEnvelopePlanningSources({
    version: 1,
    likely_current_state: { state: "tickets populated", evidence: ["docs/ticket-progress.md"] },
    relevant_prior_plans_docs_tickets: [{ path: "docs/rafi-plan.md", status: "current" }],
    handoff_brief: "Run ticket planning next.",
  }, {
    online: ["GitHub issue 55"],
    local: ["docs/rafi-plan.md"],
    background: [],
  });

  assert.match(sources!, /GitHub issue 55/);
  assert.match(sources!, /Discovery likely_current_state/);
  assert.match(sources!, /tickets populated/);
  assert.match(sources!, /Discovery relevant_prior_plans_docs_tickets/);
  assert.match(sources!, /docs\/rafi-plan\.md/);
  assert.match(sources!, /Discovery handoff/);
  assert.match(sources!, /Run ticket planning next/);
});

test("discovery filters source requests that violate online and avoid instructions", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "rafi-config.yaml"), stringify(buildProjectConfig(defaultAnswers())), "utf8");
  const requestedTypes: string[] = [];
  let extracted = false;
  await runDiscovery({
    project: dir,
    online: ["do not use online sources and avoid Jira"],
    local: ["avoid docs/foo"],
    yes: true,
    loadSources: () => emptyLoadedSources(),
    sourceRequestFromAnswer: () => ({}),
    extractSourceRequests: () => {
      if (extracted) return [];
      extracted = true;
      return [
        { type: "url", label: "Remote", locator: { url: "https://example.com" } },
        { type: "jira", label: "Jira", locator: { site: "https://example.atlassian.net", jql: "project = ENG" } },
        { type: "local", label: "Avoided", locator: { path: "docs/foo/plan.md" } },
        { type: "local", label: "Kept", locator: { path: "docs/bar.md" } },
      ];
    },
    setSourceStorage: (registry) => registry,
    saveSources: () => {},
    registerSources: async (projectDir, registry, requests) => {
      requestedTypes.push(...requests.map((request) => `${request.type}:${request.locator?.path ?? request.label}`));
      return { registry, entries: [], snapshots: [], pending: [] };
    },
    runRole: async () => agentResult(finalOutput()),
  });

  assert.deepEqual(requestedTypes, ["local:docs/bar.md"]);
});

function emptyLoadedSources() {
  return {
    registry: { version: 1 as const, snapshot_storage: "local" as const, entries: [] },
    configured: false,
    migrated: false,
    warnings: [],
  };
}
