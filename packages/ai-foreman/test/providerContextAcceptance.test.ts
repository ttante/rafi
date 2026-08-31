import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderSessionRefV1, ResolvedAgentSettings, SessionAvailabilityV1 } from "rafi-spec";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import type {
  BuilderAdapter,
  BuilderEvent,
  CompactResult,
  ContextManagementPolicy,
  ContextUsage,
  InterruptResult,
  ManagedTurnDispatcher,
  PreparedContextManagement,
  TurnResult,
} from "../src/adapters/types.js";
import { HandoffService } from "../src/handoffs.js";
import { ThresholdCompactionController } from "../src/sessionLifecycle.js";
import { WorkflowDb } from "../src/workflowDb.js";

const live = process.env.RAFI_LIVE_PROVIDER_SESSIONS === "1";
const configuredThreshold = live
  ? Number.parseInt(process.env.RAFI_LIVE_CONTEXT_THRESHOLD_PERCENT ?? "10", 10)
  : 10;
if (live && (!Number.isInteger(configuredThreshold) || configuredThreshold < 1 || configuredThreshold > 10)) {
  throw new Error("RAFI_LIVE_CONTEXT_THRESHOLD_PERCENT must be an integer from 1 through 10");
}

class TracingAdapter implements BuilderAdapter {
  readonly timeline: BuilderEvent[] = [];

  constructor(readonly inner: BuilderAdapter) {}

  get agent(): "claude" | "codex" { return this.inner.agent; }
  sendTurn(text: string): Promise<TurnResult> { return this.inner.sendTurn(text); }
  sessionId(): string | undefined { return this.inner.sessionId(); }
  sessionRef(): ProviderSessionRefV1 | undefined { return this.inner.sessionRef?.(); }
  adoptSessionRef(ref: ProviderSessionRefV1): void { this.inner.adoptSessionRef?.(ref); }
  validateSession(): Promise<SessionAvailabilityV1> {
    return this.inner.validateSession?.() ?? Promise.resolve({
      version: 1, status: "unknown", checkedAt: new Date().toISOString(), reason: "probe-failed",
    });
  }
  compact(): Promise<CompactResult> {
    const compact = this.inner.compact;
    return compact ? compact.call(this.inner) : Promise.resolve({ ok: false, error: "native compact unavailable" });
  }
  prepareContextManagement(policy: ContextManagementPolicy): Promise<PreparedContextManagement> {
    const prepare = this.inner.prepareContextManagement;
    if (!prepare) return Promise.reject(new Error("native context preparation unavailable"));
    return prepare.call(this.inner, policy);
  }
  updateContextManagement(policy: ContextManagementPolicy): Promise<PreparedContextManagement> {
    const update = this.inner.updateContextManagement;
    if (!update) return Promise.reject(new Error("native context update unavailable"));
    return update.call(this.inner, policy);
  }
  interruptTurnAtCompactionBoundary(providerEventId?: string): Promise<InterruptResult> {
    const interrupt = this.inner.interruptTurnAtCompactionBoundary;
    return interrupt
      ? interrupt.call(this.inner, providerEventId)
      : Promise.resolve({ ok: false, error: "compaction-boundary interrupt unavailable", providerEventId });
  }
  contextUsage(): Promise<ContextUsage | undefined> { return this.inner.contextUsage?.() ?? Promise.resolve(undefined); }
  installManagedTurnDispatcher(dispatcher: ManagedTurnDispatcher): void { this.inner.installManagedTurnDispatcher?.(dispatcher); }
  async *events(): AsyncIterable<BuilderEvent> {
    for await (const event of this.inner.events()) {
      this.timeline.push(event);
      yield event;
    }
  }
  close(): Promise<void> { return this.inner.close(); }
}

interface NativeTurnEvidence {
  start: number;
  success: number;
  complete: number;
  providerEventId: string;
}

function nativeTurnEvidence(events: BuilderEvent[], offset: number): NativeTurnEvidence | undefined {
  for (let success = offset; success < events.length; success += 1) {
    const event = events[success];
    if (event?.kind !== "context-compaction" || event.phase !== "succeeded" || event.origin !== "provider-auto") continue;
    const start = events.findIndex((candidate, index) => index >= offset && index < success
      && candidate.kind === "context-compaction"
      && candidate.phase === "started"
      && candidate.providerEventId === event.providerEventId);
    const complete = events.findIndex((candidate, index) => index > success && candidate.kind === "turn-complete");
    if (start >= offset && complete > success) return { start, success, complete, providerEventId: event.providerEventId };
  }
  return undefined;
}

function seedContinuity(projectDir: string, runId: string, role: "builder" | "qa", nonce: string): void {
  const db = new WorkflowDb(projectDir);
  try {
    db.ensureRun(runId);
    db.appendContinuityEvent({
      runId, role: "host", kind: "live_context_acceptance_seed", payload: { nonce }, authoritativeStateRevision: 1,
    });
    db.publishContinuityCheckpoint({
      runId, role, authoritativeStateRevision: 1,
      delta: {
        version: 1,
        decisions: [],
        constraints: ["Do not modify the credentialed acceptance fixture."],
        discoveries: [`The early continuity nonce is ${nonce}.`],
        completedActions: ["Initialized the native context-management acceptance run."],
        evidence: [], failures: [], blockers: [],
        openWork: ["Complete the current read-only inspection turn."],
        nextAction: "Continue the frozen read-only inspection action and report the early nonce.",
      },
    });
  } finally { db.close(); }
}

function fixture(projectDir: string): void {
  const lines = Array.from({ length: 240 }, (_, index) => [
    `fixture-line-${String(index).padStart(3, "0")}`,
    `stable-${(index * 7919).toString(36)}`,
    "Rafi native context acceptance data remains read-only and intentionally verbose.",
  ].join(" | "));
  writeFileSync(join(projectDir, "context-acceptance-fixture.txt"), `${lines.join("\n")}\n`);
  execFileSync("git", ["add", "context-acceptance-fixture.txt"], { cwd: projectDir });
  execFileSync("git", [
    "-c", "user.name=Rafi Acceptance", "-c", "user.email=acceptance@invalid.local",
    "commit", "-q", "-m", "Add context acceptance fixture",
  ], { cwd: projectDir });
}

function toolHeavyPrompt(round: number): string {
  return [
    `This is read-only context acceptance round ${round}.`,
    "Use three distinct tool calls, with exactly one command in each tool call:",
    "1. git status --short",
    "2. wc -l context-acceptance-fixture.txt",
    "3. sed -n '1,240p' context-acceptance-fixture.txt",
    "Do not combine the commands and do not modify anything.",
    "After all three calls, finish with the exact early nonce from the earlier turn. The nonce is deliberately not repeated here.",
  ].join("\n");
}

for (const provider of ["claude", "codex"] as const) {
  for (const role of ["builder", "qa"] as const) {
    test(`authenticated ${provider} enforces native context ceiling and maximum for ${role}`, {
      skip: !live,
      timeout: 20 * 60_000,
    }, async () => {
      const projectDir = mkdtempSync(join(tmpdir(), `rafi-${provider}-${role}-context-live-`));
      execFileSync("git", ["init", "-q"], { cwd: projectDir });
      fixture(projectDir);
      const runId = `live-${provider}-${role}-${Date.now()}`;
      const nonce = `rafi-context-${provider}-${role}`;
      seedContinuity(projectDir, runId, role, nonce);

      const policy: ContextManagementPolicy = {
        role,
        configuredThresholdPercent: configuredThreshold,
        compactMaximum: 1,
        settingsRevision: 1,
        model: "default",
        nativeCompactionEnabled: true,
      };
      const settings: ResolvedAgentSettings = {
        role, source: "project", make: provider, model: "default", reasoning: "high", fast: false,
        session_strategy: "compact", settings_revision: 1, display_session_cost: false,
        auto_compact_threshold_percent: configuredThreshold, compact_maximum: 1,
      };
      const traces: TracingAdapter[] = [];
      const make = async (generation: number): Promise<TracingAdapter> => {
        const options = {
          cwd: projectDir,
          configRoot: projectDir,
          permission: async () => ({ behavior: "allow" as const }),
          sandboxMode: "read-only" as const,
          sessionRole: role,
          sessionStream: `${role}-live-context`,
          sessionGeneration: generation,
          workspaceIdentity: `live-context-${provider}-${role}`,
          contextManagementPolicy: policy,
          systemPromptAppend: "This is a read-only native context acceptance run. Obey distinct tool-call and exact-output instructions.",
        };
        const raw: BuilderAdapter = provider === "claude"
          ? await ClaudeAdapter.create(options)
          : new CodexAdapter(options);
        const traced = new TracingAdapter(raw);
        traces.push(traced);
        return traced;
      };

      let handoffCount = 0;
      const controller = new ThresholdCompactionController({
        projectDir, runId, role, initialSettings: settings,
        requireNativeContextManagement: true,
        settingsPollMs: 60_000,
        handoff: async ({ reason, adapter, sample, settings: activeSettings, compactionCount, frozenAction }) => {
          handoffCount += 1;
          assert.equal(handoffCount, 1, "a fresh successor must not enter a handoff loop");
          const transferred = await new HandoffService(projectDir).transfer({
            runId, role, reason,
            predecessorSessionId: adapter.sessionId(),
            predecessorSessionRef: adapter.sessionRef?.(),
            roleState: {
              contextSample: sample,
              frozenActionDigest: createHash("sha256").update(frozenAction).digest("hex"),
            },
            compactionCount,
            compactMaximum: activeSettings.compact_maximum ?? 1,
          }, async (staged) => make(staged.manifest.generation));
          await adapter.close();
          return transferred.successor;
        },
      });
      const predecessor = await make(0);
      const managed = controller.manage(predecessor);

      try {
        await controller.atSafeBoundary(managed, "initialize credentialed context acceptance");
        const predecessorRef = managed.sessionRef();
        const predecessorId = managed.sessionId();
        assert.ok(predecessorRef && predecessorId, "native preparation must establish a scoped provider session");
        const initializedOffset = predecessor.timeline.length;

        const seed = await managed.sendTurn(`Remember the early nonce ${nonce}. Return only SEED_READY.`);
        assert.equal(seed.isError, false, seed.text);

        let evidence: NativeTurnEvidence | undefined;
        let sameSessionResult: TurnResult | undefined;
        for (let round = 1; round <= 12 && !evidence; round += 1) {
          sameSessionResult = await managed.sendTurn(toolHeavyPrompt(round));
          assert.equal(sameSessionResult.isError, false, sameSessionResult.text);
          evidence = nativeTurnEvidence(predecessor.timeline, initializedOffset);
        }
        assert.ok(evidence, "a real provider-native compaction must start and succeed before its work turn completes");
        assert.match(sameSessionResult?.text ?? "", new RegExp(nonce));
        assert.equal(managed.sessionId(), predecessorId, "the first verified native compaction must continue the same scoped session");
        const toolsBeforeCompact = predecessor.timeline.slice(
          predecessor.timeline.map((event) => event.kind).lastIndexOf("turn-complete", evidence.start - 1) + 1,
          evidence.start,
        ).filter((event) => event.kind === "tool").length;
        assert.ok(toolsBeforeCompact >= 2, "the threshold must be crossed during a controlled multi-tool provider turn");
        assert.ok(evidence.start < evidence.success && evidence.success < evidence.complete);
        const afterFirst = controller.snapshot();
        assert.equal(afterFirst?.compactionCount, 1);
        assert.ok((afterFirst?.contextSample.percentage ?? 100) < configuredThreshold, "verified usage must fall below the configured ceiling");

        let successorResult: TurnResult | undefined;
        for (let round = 13; round <= 28 && managed.sessionId() === predecessorId; round += 1) {
          successorResult = await managed.sendTurn(toolHeavyPrompt(round));
          assert.equal(successorResult.isError, false, successorResult.text);
        }
        assert.notEqual(managed.sessionId(), predecessorId, "the next native boundary at maximum one must adopt a fresh session");
        assert.equal(handoffCount, 1);
        assert.match(successorResult?.text ?? "", new RegExp(nonce), "the replayed frozen action must preserve the early fact");
        const secondStart = predecessor.timeline.findIndex((event, index) => index > evidence.success
          && event.kind === "context-compaction" && event.phase === "started" && event.providerEventId !== evidence.providerEventId);
        assert.ok(secondStart > evidence.success, "the provider must expose the over-maximum native compaction boundary");
        assert.equal(predecessor.timeline.some((event, index) => index > secondStart
          && event.kind === "context-compaction" && event.phase === "succeeded"
          && event.providerEventId === (predecessor.timeline[secondStart] as Extract<BuilderEvent, { kind: "context-compaction" }>).providerEventId), false,
        "the vetoed over-maximum compaction must not be accepted as another success");
        assert.ok(predecessor.timeline.some((event, index) => index > secondStart
          && event.kind === "turn-complete" && event.result.interrupted?.reason === "compaction-boundary"));

        const verificationDb = new WorkflowDb(projectDir);
        try {
          assert.equal(verificationDb.successfulCompactionCount(runId, role, predecessorRef), 1);
          assert.equal(verificationDb.handoffs(runId).at(-1)?.state, "accepted");
        } finally { verificationDb.close(); }
        assert.equal(controller.snapshot()?.role, role);
      } finally {
        await managed.close();
        for (const trace of traces) await trace.close().catch(() => {});
      }
    });
  }
}
