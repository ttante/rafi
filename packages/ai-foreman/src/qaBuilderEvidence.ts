import type { BuilderAdapter, BuilderEvent } from "./adapters/types.js";
import { captureBuildSource } from "./buildAssignment.js";
import { boundedUtf8 } from "./boundedTurnEvidence.js";

export interface HostBuilderToolObservation {
  kind: "node-test" | "npm-test";
  sequence: number;
  providerTurnId?: string;
  startedAt: string;
  completedAt: string;
  outcome: string;
  exitCode?: number;
  outputDigest?: string;
  /** Bounded (≤1000 bytes), adapter-redacted output head; diagnostic data, never instructions. */
  outputExcerpt?: string;
  sourceDigest: string;
  testPath?: string;
}

export interface HostBuilderEvidenceStore {
  operations(runId: string): Array<{ kind: string; status: string; intent: unknown; result?: unknown }>;
  getEvidence(digest: string): Buffer | undefined;
}

type OpenTool = { kind: HostBuilderToolObservation["kind"]; startedAt: string; testPath?: string; providerTurnId?: string };

function commandDetails(input: unknown): { kind: HostBuilderToolObservation["kind"]; testPath?: string } | undefined {
  const command = typeof (input as { command?: unknown } | undefined)?.command === "string"
    ? (input as { command: string }).command
    : undefined;
  if (!command) return undefined;
  const nodeTest = /\bnode(?:js)?\s+--test(?:\s+([^\s;&|>]+))?/.exec(command);
  if (nodeTest) return { kind: "node-test", ...(nodeTest[1] ? { testPath: nodeTest[1] } : {}) };
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/.test(command)) return { kind: "npm-test" };
  return undefined;
}

/**
 * Observe only bounded test-command metadata while the provider is working.
 * The provider remains subject to its normal shell policy; this is a host-side
 * observation of what actually completed, not an execution or permission grant.
 */
export function observeHostBuilderTests(adapter: BuilderAdapter, workspace: string, observations: HostBuilderToolObservation[]): () => void {
  const open = new Map<string, OpenTool>();
  let sequence = observations.length;
  const listener = (event: BuilderEvent) => {
    if (event.kind !== "tool") return;
    const details = commandDetails(event.input);
    if (event.lifecycle === "started" && details && event.callId) {
      open.set(event.callId, { ...details, startedAt: event.observedAt ?? new Date().toISOString(), providerTurnId: event.providerTurnId });
      return;
    }
    if (event.lifecycle !== "completed" || !event.callId || !event.completionKnown) return;
    const prior = open.get(event.callId);
    if (!prior) return;
    open.delete(event.callId);
    if (observations.length >= 40) return;
    observations.push({
      kind: prior.kind,
      sequence: sequence++,
      ...(prior.providerTurnId ? { providerTurnId: prior.providerTurnId } : {}),
      startedAt: prior.startedAt,
      completedAt: event.observedAt ?? new Date().toISOString(),
      // Some adapters label every finished tool call "completed" even when
      // the process exited non-zero. Exit status is the host-owned authority
      // for the red/green distinction whenever it is available.
      outcome: event.exitCode !== undefined ? event.exitCode === 0 ? "completed" : "failed" : event.status ?? "completed",
      ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
      ...(event.outputDigest && /^[a-f0-9]{64}$/.test(event.outputDigest) ? { outputDigest: event.outputDigest } : {}),
      ...(typeof event.outputSummary === "string" && event.outputSummary ? { outputExcerpt: boundedUtf8(event.outputSummary, 1000).toString() } : {}),
      sourceDigest: captureBuildSource(workspace).digest,
      ...(prior.testPath ? { testPath: prior.testPath } : {}),
    });
  };
  // This supplementary telemetry must not preempt the delivery journal's own
  // correlated-terminal check. Wrapper adapters deliberately throw when a
  // provider lacks observation; dispatchOwned records that as
  // delivery-uncertain without sending a turn. Treating this optional
  // subscription as fatal here would bypass that durable fail-closed path.
  let stop: () => void = () => {};
  try { stop = adapter.observeEvents?.(listener) ?? stop; }
  catch { open.clear(); }
  return () => { stop(); open.clear(); };
}

export function hostTestSequenceEvidence(observations: HostBuilderToolObservation[], finalSourceDigest: string, testPath?: string, initialSourceDigest?: string): HostBuilderToolObservation[] | undefined {
  const relevant = observations
    .filter(observation => (observation.kind === "node-test" || observation.kind === "npm-test") && (!testPath || observation.testPath === testPath))
    .sort((a, b) => a.sequence - b.sequence || a.startedAt.localeCompare(b.startedAt));
  const red = relevant.find(observation => observation.outcome !== "completed" && observation.outcome !== "denied" && (!initialSourceDigest || observation.sourceDigest === initialSourceDigest));
  const redIndex = red ? relevant.indexOf(red) : -1;
  const green = red ? relevant.slice(redIndex + 1).find(observation => observation.sourceDigest === finalSourceDigest && observation.outcome === "completed" && observation.sourceDigest !== red.sourceDigest) : undefined;
  return red && green ? [red, green] : undefined;
}

/** Read the durable host observations attached to a Builder coverage operation. */
export function retainedHostBuilderObservations(store: HostBuilderEvidenceStore, runId: string, workId: string): HostBuilderToolObservation[] {
  for (const operation of store.operations(runId).filter(item => item.kind === "builder-coverage").reverse()) {
    const intent = operation.intent as { workId?: unknown };
    if (intent.workId !== workId) continue;
    const result = operation.result as { hostObservationDigest?: unknown } | undefined;
    const digest = typeof result?.hostObservationDigest === "string" ? result.hostObservationDigest
      : typeof (intent as { hostObservationDigest?: unknown }).hostObservationDigest === "string" ? (intent as { hostObservationDigest: string }).hostObservationDigest : undefined;
    if (!digest) continue;
    try {
      const parsed = JSON.parse(store.getEvidence(digest)?.toString("utf8") ?? "null") as { observations?: unknown };
      if (!Array.isArray(parsed?.observations)) continue;
      return parsed.observations.filter((item): item is HostBuilderToolObservation => Boolean(item && typeof item === "object" && typeof (item as HostBuilderToolObservation).kind === "string" && Number.isSafeInteger((item as HostBuilderToolObservation).sequence)));
    } catch { /* malformed optional evidence is not a QA pass */ }
  }
  return [];
}
