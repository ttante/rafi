import { WorkflowReader } from "../workflowReader.js";
import { assertManagerGraphRequest, parseStrictJson, type GraphReadRequestV1, type ManagerGraphRequestV3 } from "rafi-spec";
import { loadGraphConfig } from "./config.js";
import { captureGraphCorpus } from "./corpus.js";
import { acquireGraphView, graphUnavailable, readGraph, type GraphReadView } from "./read.js";
import type { GraphDerivedAccess } from "./derived.js";
import { canonical } from "./util.js";
export const MANAGER_GRAPH_GUIDANCE = `For substantial architecture/dependency questions, request graph evidence through this additional host envelope: {"kind":"manager_graph_evidence_request","version":3,"requestId":"unique-id","operations":[{"operation":"query","query":"specific source concepts"}]}. Do not mix envelopes. This shares your existing evidence lookup budget. Only the host chooses project/source scope. An optional receiptId can select previously delivered evidence belonging to the host-selected run; unavailable historical caches stay unavailable. Current-source graph evidence cannot establish a historical run's implementation or cause. Graph output never authorizes controls.`;
export function parseManagerGraphRequest(text: string): ManagerGraphRequestV3 | undefined {
  if (Buffer.byteLength(text) > 8192 || !text.trim().startsWith("{"))
    return undefined;
  let value: unknown;
  try {
    value = parseStrictJson(text);
  }
  catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || (value as {
    kind?: string;
  }).kind !== "manager_graph_evidence_request")
    return undefined;
  if ((value as {
    version?: number;
  }).version !== 3)
    throw new Error("Unsupported Manager graph protocol");
  assertManagerGraphRequest(value);
  return value;
}
export function createManagerGraphEvidence(configRoot: string, runId?: string): {
  guidance: string;
  access: () => GraphDerivedAccess[];
  execute: (request: ManagerGraphRequestV3) => Promise<string>;
} {
  const config = loadGraphConfig(configRoot);
  let deliveredAccess: GraphDerivedAccess | undefined;
  let initialized = false, view: GraphReadView | undefined;
  return {
    access: () => deliveredAccess ? [deliveredAccess] : [],
    guidance: config.enabled ? MANAGER_GRAPH_GUIDANCE : "", execute: async (request) => {
      let unavailable = graphUnavailable(config.reason, "Graph unavailable; use source/runtime evidence");
      if (config.enabled && !initialized) {
        initialized = true;
        try {
          const captured = captureGraphCorpus(configRoot, configRoot, config);
          const acquired = acquireGraphView(configRoot, configRoot, captured);
          if ("graph" in acquired)
            view = acquired;
          else
            unavailable = acquired;
        }
        catch (error) {
          unavailable = graphUnavailable("freshness-check-failed", String(error));
        }
      }
      let selected = view;
      if (request.receiptId) {
        const reader = new WorkflowReader(configRoot);
        try {
          const receipt = reader.graphRecord<{
            runId?: string;
            generationIds: string[];
          }>("receipt", request.receiptId)?.value;
          if (!runId || receipt?.runId !== runId || !receipt.generationIds.length) {
            selected = undefined;
            unavailable = graphUnavailable("invalid-scope", "Receipt is unavailable in the host-selected run");
          }
          else {
            const acquired = acquireGraphView(configRoot, configRoot, undefined, receipt.generationIds[0]);
            if ("graph" in acquired)
              selected = acquired;
            else {
              selected = undefined;
              unavailable = acquired;
            }
          }
        }
        finally {
          reader.close();
        }
      }
      const results = [];
      for (const operation of request.operations)
        results.push(selected ? await readGraph(selected, operation) : unavailable);
      const reader = new WorkflowReader(configRoot);
      let receipts: unknown[] = [];
      try {
        if (runId && request.operations.some(o => o.operation === "status"))
          receipts = reader.graphReceiptSummaries(runId);
      }
      finally {
        reader.close();
      }
      let packet = canonical({ kind: "manager_graph_evidence", version: 3, requestId: request.requestId, sourceTime: request.receiptId ? "historical receipt-bound navigation; not proof of executed work" : "current-checkout observation; not historical run evidence", results, receipts });
      if (Buffer.byteLength(packet) > 24 * 1024)
        packet = canonical({ kind: "manager_graph_evidence", version: 3, requestId: request.requestId, results: [graphUnavailable("packet-limit", "Narrow the request to one focused operation")] });
      if (selected) deliveredAccess = { policyDigest: config.policyDigest, workspace: configRoot,
        exclusionsDigest: selected.generation.files["exclusions-digest"], sourceVersions: config.config?.sourceVersions ?? {},
        paths: selected.generation.inputs.filter(i => !i.sourceId).map(i => i.path) };
      return packet;
    }
  };
}
