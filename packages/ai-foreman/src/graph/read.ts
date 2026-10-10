import { ownedGraphPython } from "./install.js";
import { existsSync } from "node:fs";
import { loadSourceRegistry } from "../sources/sourceRegistry.js";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { GraphGenerationV1, GraphInputV1, GraphReadOperationV1, GraphReadResultV1, GraphSourceLocationV1 } from "rafi-spec";
import { WorkflowReader } from "../workflowReader.js";
import { loadGraphConfig, type EffectiveGraphConfig } from "./config.js";
import { graphExclusions, graphPathAllowed, type CapturedGraphCorpus } from "./corpus.js";
import { resolveGraphPython, runBridge } from "./bridge.js";
import { bytesDigest, confined, digest, readBounded } from "./util.js";
export function graphScope(workspace: string): string { return digest("scope", realpathSync(workspace)); }
export function graphUnavailable(reason: string, detail: string): GraphReadResultV1 {
  return sealResult({ version: 1, status: "unavailable", freshness: "unknown", nodes: [], edges: [], limitations: [{ reason, detail, nextAction: "Inspect authorized source directly; graph evidence does not waive required checks." }], truncated: false });
}
export function sealResult(result: Omit<GraphReadResultV1, "digest">): GraphReadResultV1 { return { ...result, digest: digest("result", result) }; }
export function graphStatus(configRoot: string, workspace = configRoot): {
  enabled: boolean;
  reason: string;
  policyDigest: string;
  generation?: GraphGenerationV1;
  capability?: unknown;
  jobs?: ReturnType<WorkflowReader["graphRecentJobs"]>;
} {
  const config = loadGraphConfig(configRoot);
  if (!config.enabled)
    return { enabled: false, reason: config.reason, policyDigest: config.policyDigest };
  const reader = new WorkflowReader(configRoot);
  try {
    const head = reader.graphRecord<{
      generationId: string;
    }>("head", graphScope(workspace))?.value;
    const generation = head ? reader.graphRecord<GraphGenerationV1>("generation", head.generationId)?.value : undefined;
    return { enabled: true, reason: generation ? "freshness-not-checked" : "missing-graph", policyDigest: config.policyDigest, generation, capability: reader.graphRecord("capability", "machine")?.value, jobs: reader.graphRecentJobs() };
  }
  finally {
    reader.close();
  }
}
export interface GraphReadView {
  configRoot: string;
  workspace: string;
  config: EffectiveGraphConfig;
  generation: GraphGenerationV1;
  graph: Record<string, unknown>;
  corpus?: CapturedGraphCorpus;
  python?: string;
  historical?: boolean;
}
export function acquireGraphView(configRoot: string, workspace: string, corpus?: CapturedGraphCorpus, historicalGenerationId?: string): GraphReadView | GraphReadResultV1 {
  const config = loadGraphConfig(configRoot);
  if (!config.enabled)
    return graphUnavailable(config.reason, `Graph integration is ${config.reason}`);
  const status = graphStatus(configRoot, workspace);
  let generation = status.generation;
  if (historicalGenerationId) {
    const reader = new WorkflowReader(configRoot);
    try {
      generation = reader.graphRecord<GraphGenerationV1>("generation", historicalGenerationId)?.value;
    }
    finally {
      reader.close();
    }
  }
  if (!historicalGenerationId && corpus && generation?.corpusDigest !== corpus.corpusDigest) {
    const reader = new WorkflowReader(configRoot);
    try {
      generation = reader.graphGenerationForCorpus<GraphGenerationV1>(corpus.corpusDigest, config.policyDigest) ?? generation;
    }
    finally {
      reader.close();
    }
  }
  if (!generation)
    return graphUnavailable("missing-graph", "No published generation for this workspace");
  if (generation.version !== 1 || !/^[a-f0-9]{64}$/.test(generation.id) || !Array.isArray(generation.inputs) || !generation.files || !Array.isArray(generation.limitations))
    return graphUnavailable("corrupt-graph", "Invalid generation metadata");
  const { id, ...metadata } = generation;
  if (digest("generation", metadata) !== id)
    return graphUnavailable("corrupt-graph", "Generation metadata digest mismatch");
  if (generation.policyDigest !== config.policyDigest)
    return graphUnavailable("revoked-policy", "Published generation has a different access/extraction policy");
  const exclusionInput = generation.files["exclusions-digest"];
  if (exclusionInput !== digest("exclusions", graphExclusions(workspace, generation.inputs.filter(i => !i.sourceId).map(i => i.path)).text))
    return graphUnavailable("exclusions-changed", "Current exclusions differ; historical evidence is withheld pending authorized maintenance");
  try {
    const graphPath = confined(configRoot, `graphify-out/rafi/generations/${generation.id}/graph.json`);
    const bytes = readBounded(graphPath, config.limits.maxGraphBytes);
    if (bytesDigest(bytes) !== generation.graphDigest)
      throw new Error("Generation graph digest mismatch");
    const graph = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    return { configRoot, workspace, config, generation, graph, corpus, historical: Boolean(historicalGenerationId) };
  }
  catch (error) {
    return graphUnavailable("corrupt-or-missing-generation", String(error));
  }
}
function locations(raw: Record<string, unknown>, allowed: Map<string, GraphInputV1>): GraphSourceLocationV1[] {
  const source = typeof raw.source_file === "string" ? raw.source_file : undefined;
  if (!source)
    return [];
  const input = allowed.get(source);
  if (!input)
    return [];
  const match = typeof raw.source_location === "string" ? /^L?(\d+)(?:[-:]L?(\d+))?$/.exec(raw.source_location) : undefined;
  const line = typeof raw.line_start === "number" && raw.line_start > 0 ? raw.line_start : match ? Number(match[1]) : undefined;
  return [{ path: source, digest: input.digest, ...(input.sourceId ? { sourceId: input.sourceId, version: input.sourceVersion, provenance: input.provenance } : {}), ...(line ? { line } : {}) }];
}
export async function readGraph(view: GraphReadView, operation: GraphReadOperationV1): Promise<GraphReadResultV1> {
  const { generation, config } = view;
  const accessAllowed = (): boolean => {
    const current = loadGraphConfig(view.configRoot);
    const registry = loadSourceRegistry(view.configRoot).registry;
    if (generation.inputs.some(i => i.sourceId && !registry.entries.some(e => e.id === i.sourceId && e.active && e.versions.some(v => v.fingerprint === i.sourceVersion))))
      return false;
    return current.enabled && current.policyDigest === config.policyDigest && digest("exclusions", graphExclusions(view.workspace, generation.inputs.filter(i => !i.sourceId).map(i => i.path)).text) === generation.files["exclusions-digest"];
  };
  if (!accessAllowed())
    return graphUnavailable("access-revoked", "Graph access policy changed; retained evidence withheld");
  const base = {
    version: 1 as const, generationId: generation.id, corpusDigest: generation.corpusDigest, sourceBinding: view.corpus?.binding ?? generation.binding,
    freshness: view.historical ? "historical" as const : view.corpus ? view.corpus.corpusDigest === generation.corpusDigest ? "matching" as const : "stale" as const : "unknown" as const,
    limitations: [...generation.limitations], truncated: false
  };
  if (operation.operation === "status")
    return sealResult({ ...base, status: "ok", nodes: [], edges: [] });
  try {
    view.python ??= existsSync(ownedGraphPython(view.configRoot)) ? ownedGraphPython(view.configRoot) : await resolveGraphPython();
    const raw = await runBridge<{
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
      ambiguous: boolean;
      truncated: boolean;
      nodeCount: number;
      resourceControls?: { addressSpaceBytes?: number | null; memoryEnforcement?: string };
    }>(view.python, { action: "read", graph: view.graph, operation }, { timeoutMs: config.limits.queryMs });
    if (!accessAllowed())
      return graphUnavailable("access-revoked", "Graph access changed during the query; result withheld");
    if (!raw.resourceControls?.addressSpaceBytes)
      base.limitations.push({ reason: "memory-limit-unavailable", detail: "This platform uses conservative byte/node admission; an OS address-space limit was not established" });
    const allowed = new Map(generation.inputs.map(i => [i.path, i]));
    let withheld = false;
    const nodes: GraphReadResultV1["nodes"] = raw.nodes.flatMap(n => {
      const sources = locations(n, allowed);
      if (!sources.length) {
        withheld = true;
        return [];
      }
      return [{ id: String(n.id).slice(0, 2048), label: String(n.label ?? n.id).slice(0, 2048), kind: typeof n.type === "string" ? n.type.slice(0, 128) : undefined, sources, origin: allowed.get(sources[0]!.path)?.kind === "code" ? "structural" as const : "semantic" as const }];
    });
    const ids = new Set(nodes.map(n => n.id));
    const edges: GraphReadResultV1["edges"] = raw.edges.flatMap(e => {
      const source = String(e._src ?? e.source), target = String(e._tgt ?? e.target);
      if (!ids.has(source) || !ids.has(target))
        return [];
      const sources = locations(e, allowed);
      const evidence = ["EXTRACTED", "INFERRED", "AMBIGUOUS"].includes(String(e.confidence)) ? e.confidence as "EXTRACTED" | "INFERRED" | "AMBIGUOUS" : "UNKNOWN";
      return [{ source, target, relation: String(e.relation ?? "unknown").slice(0, 256), evidence, ...(typeof e.confidence_score === "number" && Number.isFinite(e.confidence_score) ? { confidence: e.confidence_score } : {}), sources }];
    });
    const result = { ...base, status: raw.ambiguous ? "ambiguous" as const : raw.truncated || withheld || base.limitations.length ? "partial" as const : nodes.length ? "ok" as const : raw.nodeCount ? "no-match" as const : "empty-corpus" as const, nodes, edges, truncated: raw.truncated };
    if (withheld)
      result.limitations.push({ reason: "missing-provenance", detail: "Nodes without authorized input provenance were withheld" });
    while (Buffer.byteLength(JSON.stringify(result)) > config.limits.packetBytes - 128 && (result.nodes.length || result.edges.length)) {
      result.truncated = true;
      result.status = "partial";
      if (result.edges.length)
        result.edges.pop();
      else
        result.nodes.pop();
    }
    if (result.truncated)
      result.limitations.push({ reason: "truncated", detail: "Narrow the query or request a specific returned node to continue" });
    if (Buffer.byteLength(JSON.stringify(result)) > config.limits.packetBytes - 128)
      return graphUnavailable("packet-limit", "Graph metadata alone exceeds the packet budget");
    return sealResult(result);
  }
  catch (error) {
    return graphUnavailable("query-failed", String(error));
  }
}
