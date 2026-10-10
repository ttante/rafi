import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GRAPH_CONFIG } from "rafi-spec";
import { adoptGraph, refreshGraph, disableGraph } from "../src/graph/maintenance.js";
import { resolveGraphPython } from "../src/graph/bridge.js";
import { graphContext, sendGraphTurn } from "../src/graph/turn.js";
import { sendPreparationGraphTurn } from "../src/graph/preparation.js";
import { sendRoleGraphTurn, type RoleBuilder } from "../src/agentRun.js";
import { withGraphDerivedAccess, type GraphDerivedAccess } from "../src/graph/derived.js";
import { withGraphSessionAccess } from "../src/graph/session.js";
import { graphExclusions } from "../src/graph/corpus.js";
import { loadGraphConfig } from "../src/graph/config.js";
import { bytesDigest, digest } from "../src/graph/util.js";
import { WorkflowDb } from "../src/workflowDb.js";
import { WorkflowReader } from "../src/workflowReader.js";
import { collectBuilderContractCoverage } from "../src/qaBuilderCoverage.js";
import type { BuilderAdapter } from "../src/adapters/types.js";

function source(root: string, label: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/main.py"), "def helper(): return 1\n");
  writeFileSync(join(root, ".gitignore"), `# ${label}\n*.scratch\n`);
  writeFileSync(join(root, "src/.gitignore"), `# nested ${label}\n*.tmp\n`);
}
function allowed(root: string, text: string): boolean {
  const reader = new WorkflowReader(root);
  try { return reader.graphEvidenceAllowed(bytesDigest(text)); } finally { reader.close(); }
}
function seedSession(root: string, adapter: BuilderAdapter): void {
  const access: GraphDerivedAccess = { policyDigest: loadGraphConfig(root).policyDigest, workspace: root,
    paths: ["src/main.py"], exclusionsDigest: digest("exclusions", graphExclusions(root, ["src/main.py"]).text), sourceVersions: {} };
  const key = digest("session-access", { provider: adapter.agent, session: adapter.sessionId() });
  const db = new WorkflowDb(root);
  try { db.registerGraphEvidence(key, [access]); db.graphStore().put("session-access", key, { grants: [access] }); }
  finally { db.close(); }
}
for (const phase of ["branch", "preparation", "final-qa"] as const) test(`${phase} graph evidence tracks durable source and project exclusions independently`, async t => {
  let python: string;
  try { python = await resolveGraphPython(); } catch { t.skip("Graphify installation unavailable"); return; }
  const root = mkdtempSync(join(tmpdir(), "graph-access-root-"));
  const branch = mkdtempSync(join(tmpdir(), "graph-access-branch-"));
  const snapshot = mkdtempSync(join(tmpdir(), "graph-access-snapshot-"));
  try {
    source(root, "project"); source(branch, "branch"); source(snapshot, "snapshot");
    adoptGraph(root, { authorization: "explicit", config: { ...structuredClone(DEFAULT_GRAPH_CONFIG), mode: "code-only", include: ["src/**"] } });
    const workspace = phase === "branch" ? branch : snapshot;
    const built = await refreshGraph(root, workspace, `refresh-${phase}`, { python });
    assert.equal(built.state, "published", built.reason);
    let calls = 0;
    const adapter = { agent: "codex", sessionId: () => phase, sendTurn: async (prompt: string) => {
      calls++; assert.match(prompt, /helper/); assert.match(prompt, /rafi_graph_evidence/);
      return { text: "provider source analysis", isError: false, numTurns: 1, costUsd: 0 };
    } } as BuilderAdapter;
    const derived = `transformed ${phase} evidence`;
    await withGraphDerivedAccess([], async () => {
      if (phase === "preparation") await sendPreparationGraphTurn(adapter, "inspect helper", {
        phase: "prepare", projectDir: root, workspace, accessWorkspace: branch, sourceRef: "snapshot",
        operationId: "prepare", workId: "work", runId: "run", remainingMs: 10000,
      });
      else await sendGraphTurn(adapter, "inspect helper", graphContext(root, workspace, phase === "branch" ? "planning" : "final-qa", "helper", phase === "branch" ? {} : { accessWorkspace: branch }));
      const db = new WorkflowDb(root);
      try { db.putEvidence("qa", derived); } finally { db.close(); }
    });
    assert.equal(calls, 1);
    assert.equal(allowed(root, derived), true);
    rmSync(snapshot, { recursive: true, force: true });
    assert.equal(allowed(root, derived), true, "snapshot disposal must not revoke durable evidence");
    writeFileSync(join(branch, "src/.gitignore"), "main.py\n");
    assert.equal(allowed(root, derived), false, "source worktree exclusions revoke evidence");
    source(branch, "branch");
    assert.equal(allowed(root, derived), true);
    writeFileSync(join(root, ".graphifyignore"), "src/main.py\n");
    assert.equal(allowed(root, derived), false, "canonical project exclusions independently revoke evidence");
    await assert.rejects(sendGraphTurn(adapter, "correction", graphContext(root, branch, "planning", "correction"), { responseOnly: true }), /revoked graph evidence/);
    assert.equal(calls, 1);
    // A fresh conversation can still do source work when optional graph input is stale.
    writeFileSync(join(branch, ".graphifyignore"), "src/main.py\n");
    const fresh = { ...adapter, sessionId: () => `${phase}-fresh`, sendTurn: async (prompt: string) => {
      assert.match(prompt, /unavailable|exclusions|freshness/);
      return { text: "source inspection", isError: false, numTurns: 1, costUsd: 0 };
    } } as BuilderAdapter;
    const result = await sendGraphTurn(fresh, "inspect helper", graphContext(root, branch, "planning", "helper"));
    assert.equal(result.text, "source inspection");
  } finally { for (const path of [root, branch, snapshot]) rmSync(path, { recursive: true, force: true }); }
});

test("retained role corrections and Builder coverage deny revoked history before provider or storage work", async () => {
  const root = mkdtempSync(join(tmpdir(), "graph-followup-"));
  try {
    source(root, "project"); adoptGraph(root, { authorization: "explicit", config: { ...structuredClone(DEFAULT_GRAPH_CONFIG), mode: "code-only" } });
    let calls = 0;
    const adapter = { agent: "codex", sessionId: () => "role", events: async function* () {}, close: async () => {}, sendTurn: async () => {
      calls++; return { text: "corrected", isError: false, numTurns: 1, costUsd: 0 };
    } } as BuilderAdapter;
    seedSession(root, adapter);
    const role = { graphRoot: root, builder: adapter } as RoleBuilder;
    await withGraphDerivedAccess([], async () => {
      await sendRoleGraphTurn(role, "correct", "planning", { responseOnly: true });
      const db = new WorkflowDb(root); try { db.putEvidence("qa", "transformed correction"); } finally { db.close(); }
    });
    assert.equal(allowed(root, "transformed correction"), true);
    disableGraph(root);
    assert.equal(allowed(root, "transformed correction"), false);
    await assert.rejects(sendRoleGraphTurn(role, "correct again", "planning", { responseOnly: true }), /revoked graph evidence/);
    await assert.rejects(collectBuilderContractCoverage(root, "run", "work", root, adapter, "op", "work", { text: "done", isError: false, numTurns: 1, costUsd: 0 }), /revoked graph evidence/);
    assert.equal(calls, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("owning session scope carries retained provenance through transformed coverage artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "graph-coverage-scope-"));
  try {
    source(root, "project"); adoptGraph(root, { authorization: "explicit", config: { ...structuredClone(DEFAULT_GRAPH_CONFIG), mode: "code-only" } });
    const adapter = { agent: "codex", sessionId: () => "coverage" } as BuilderAdapter;
    seedSession(root, adapter);
    let artifact!: string;
    await withGraphSessionAccess(root, adapter, async () => {
      const db = new WorkflowDb(root);
      try { artifact = db.qaPreparationStore().putArtifact("builder-coverage", { checks: [{ outcome: "not-run" }] }); } finally { db.close(); }
    });
    disableGraph(root);
    const db = new WorkflowDb(root);
    try { assert.throws(() => db.qaPreparationStore().artifact(artifact, "builder-coverage"), /revoked|withheld|unavailable/i); } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const provider of ["claude", "codex"] as const) test(`${provider} actual Builder coverage protects parsed claims and blocks revoked followups`, async () => {
  const { execFileSync } = await import("node:child_process");
  const { realpathSync } = await import("node:fs");
  const { candidate, assessment } = await import("./qaPreparationFixtures.js");
  const { assembleContract } = await import("../src/qaVerificationContract.js");
  const { deliverVerificationContract } = await import("../src/qaContractDelivery.js");
  const { createProviderSessionRef } = await import("../src/sessionIdentity.js");
  const { resolveQaPreparationConfig } = await import("../src/qaPreparationPolicy.js");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "graph-real-coverage-")));
  try {
    source(root, "project");
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "source"], { cwd: root });
    adoptGraph(root, { authorization: "explicit", config: { ...structuredClone(DEFAULT_GRAPH_CONFIG), mode: "code-only" } });
    const db = new WorkflowDb(root);
    try {
      db.ensureRun("run");
      db.admitWork({ runId: "run", kind: "ticket", ticketId: "T1", definition: { id: "T1" }, approvalId: "fixture", scopeRevision: "fixture", provenance: { userTurn: "Build token validation", reason: "Explicit fixture" } });
      const admission = db.assertAdmittedWork("run", "T1"), store = db.qaPreparationStore();
      store.freezePolicy("run", resolveQaPreparationConfig({ mode: "enforce" }));
      const draft = candidate(); draft.admissionDigest = admission.requirementsDigest;
      const review = assessment(draft), contract = assembleContract(draft, draft.requirements, review, "author");
      const budget = store.ensureBudget("run", "T1", admission.requirementsDigest, 2, Date.now());
      store.putArtifact("semantic-assessment", review); store.retainProgress(budget, "inventory", draft.requirements); store.publish(contract, 0, Date.now());
      let calls = 0;
      const adapter: BuilderAdapter = { agent: provider, sessionId: () => "actual-builder", sessionRef: () => createProviderSessionRef({ provider, sessionId: "actual-builder", role: "builder", stream: "builder", generation: 0, cwd: root, configRoot: root, source: "observed" }),
        contractCapabilities: () => ({ sameSessionAcceptance: true, nativeCompactionBarrier: true }), enableContractEnforcement: () => {}, contractCompactionSequence: () => 0, acceptContractDelivery: () => {}, events: async function* () {}, close: async () => {},
        sendTurn: async (instruction, policy) => {
          calls++; assert.equal(policy?.responseOnly, true);
          if (policy?.purpose === "contract-acceptance") return { text: `RAFI_QA_ACCEPTANCE_START\n${JSON.stringify({ workId: "T1", revision: 1, digest: contract.contentDigest, missingSections: [] })}\nRAFI_QA_ACCEPTANCE_END`, isError: false, numTurns: 1, costUsd: 0 };
          const binding = JSON.parse(instruction.split("Exact coverage binding: ")[1]!.split("\n")[0]!);
          return { text: `RAFI_QA_COVERAGE_START\n${JSON.stringify({ ...binding, checks: [{ checkId: "check", applicability: "applicable", predicateEvidence: [], outcome: "not-run", evidence: [] }] })}\nRAFI_QA_COVERAGE_END`, isError: false, numTurns: 1, costUsd: 0 };
        },
      };
      await deliverVerificationContract(contract, store, adapter, root, root, "Full ticket");
      seedSession(root, adapter);
      const implementation = { text: "Implementation completed", isError: false, numTurns: 1, costUsd: 0 };
      await collectBuilderContractCoverage(root, "run", "T1", root, adapter, "implementation", "work", implementation);
      const result = db.operation("builder-coverage:implementation")!.result as { coverageDigest: string };
      assert.ok(store.artifact(result.coverageDigest, "builder-coverage"));
      assert.equal(calls, 2);
      disableGraph(root);
      assert.throws(() => store.artifact(result.coverageDigest, "builder-coverage"), /revoked|withheld|unavailable/i);
      await assert.rejects(collectBuilderContractCoverage(root, "run", "T1", root, adapter, "later", "work", implementation), /revoked graph evidence/);
      assert.equal(calls, 2);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
