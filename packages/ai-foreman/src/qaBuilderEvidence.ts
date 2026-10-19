import type { BuilderAdapter, BuilderEvent } from "./adapters/types.js";
import { captureBuildSource } from "./buildAssignment.js";

export interface HostBuilderToolObservation {
  kind: "node-test" | "npm-test";
  startedAt: string;
  completedAt: string;
  outcome: string;
  exitCode?: number;
  outputDigest?: string;
  sourceDigest: string;
  testPath?: string;
}

type OpenTool = { kind: HostBuilderToolObservation["kind"]; startedAt: string; testPath?: string };

function commandDetails(input: unknown): { kind: HostBuilderToolObservation["kind"]; testPath?: string } | undefined {
  const command = typeof (input as { command?: unknown } | undefined)?.command === "string"
    ? (input as { command: string }).command
    : undefined;
  if (!command) return undefined;
  const nodeTest = /\bnode\s+--test(?:\s+([^\s;&|>]+))?/.exec(command);
  if (nodeTest) return { kind: "node-test", ...(nodeTest[1] ? { testPath: nodeTest[1] } : {}) };
  if (/\bnpm\s+test\b/.test(command)) return { kind: "npm-test" };
  return undefined;
}

/**
 * Observe only bounded test-command metadata while the provider is working.
 * The provider remains subject to its normal shell policy; this is a host-side
 * observation of what actually completed, not an execution or permission grant.
 */
export function observeHostBuilderTests(adapter: BuilderAdapter, workspace: string, observations: HostBuilderToolObservation[]): () => void {
  const open = new Map<string, OpenTool>();
  const stop = adapter.observeEvents?.((event: BuilderEvent) => {
    if (event.kind !== "tool") return;
    const details = commandDetails(event.input);
    if (event.lifecycle === "started" && details && event.callId) {
      open.set(event.callId, { ...details, startedAt: event.observedAt ?? new Date().toISOString() });
      return;
    }
    if (event.lifecycle !== "completed" || !event.callId || !event.completionKnown) return;
    const prior = open.get(event.callId);
    if (!prior) return;
    open.delete(event.callId);
    if (observations.length >= 40) return;
    observations.push({
      kind: prior.kind,
      startedAt: prior.startedAt,
      completedAt: event.observedAt ?? new Date().toISOString(),
      // Some adapters label every finished tool call "completed" even when
      // the process exited non-zero. Exit status is the host-owned authority
      // for the red/green distinction whenever it is available.
      outcome: event.exitCode !== undefined ? event.exitCode === 0 ? "completed" : "failed" : event.status ?? "completed",
      ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
      ...(event.outputDigest && /^[a-f0-9]{64}$/.test(event.outputDigest) ? { outputDigest: event.outputDigest } : {}),
      sourceDigest: captureBuildSource(workspace).digest,
      ...(prior.testPath ? { testPath: prior.testPath } : {}),
    });
  }) ?? (() => {});
  return () => { stop(); open.clear(); };
}

export function hostTestSequenceEvidence(observations: HostBuilderToolObservation[], finalSourceDigest: string, testPath?: string): HostBuilderToolObservation[] | undefined {
  const relevant = observations.filter(observation => (observation.kind === "node-test" || observation.kind === "npm-test") && (!testPath || observation.testPath === testPath));
  const red = relevant.find(observation => observation.outcome !== "completed" && observation.outcome !== "denied");
  const redIndex = red ? relevant.indexOf(red) : -1;
  const green = red ? relevant.slice(redIndex + 1).find(observation => observation.sourceDigest === finalSourceDigest && observation.outcome === "completed" && observation.sourceDigest !== red.sourceDigest) : undefined;
  return red && green ? [red, green] : undefined;
}
