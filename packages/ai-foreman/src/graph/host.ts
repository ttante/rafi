import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BuilderAdapter, BuilderAdapterOptions, TurnResult } from "../adapters/types.js";
import { ClaudeAdapter } from "../adapters/claude.js";
import { CodexAdapter } from "../adapters/codex.js";
import { WorkflowDb } from "../workflowDb.js";
import type { GraphSemanticHost, SemanticExtraction } from "./maintenance.js";
import { parseSemanticResult, semanticExchange, SEMANTIC_INSTRUCTIONS } from "./semantic.js";
import { canonical, confined, digest, bytesDigest } from "./util.js";
/** Fresh packet-only worker, using the selected host's exact runtime settings. */
export function graphSemanticHost(root: string, host: BuilderAdapter, createWorker: (options: BuilderAdapterOptions) => Promise<BuilderAdapter> = async options => host.agent === "codex" ? new CodexAdapter(options) : ClaudeAdapter.create(options)): GraphSemanticHost | undefined {
  const settings = host.graphRuntimeSettings?.();
  if (!settings)
    return undefined;
  return async (chunks, operationId, budget) => {
    const result: SemanticExtraction = { nodes: [], edges: [], origin: { provider: host.agent, model: settings.model, operationId } };
    const deadline = budget?.deadline ?? Date.now() + 300000;
    const check = (): void => {
      if (budget?.signal?.aborted) throw new Error("Semantic extraction cancelled");
      if (Date.now() >= deadline) throw new Error("Semantic extraction deadline exceeded");
    };
    let outputBytes = 0;
    const accountOutput = (text: string): void => {
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > 120000) throw new Error("Semantic output budget exceeded");
      if (Buffer.byteLength(text) > 16000) throw new Error("Semantic chunk output budget exceeded");
    };
    if (chunks.reduce((n, c) => n + Buffer.byteLength(c.text), 0) > 1000000)
      throw new Error("Semantic input budget exceeds 250k conservatively estimated tokens");
    const groups: Array<typeof chunks> = [];
    for (const chunk of chunks) {
      const size = Buffer.byteLength(chunk.text);
      if (size > 64000)
        throw new Error("scope-decision-required: semantic file exceeds chunk budget");
      const last = groups.at(-1);
      if (last && last.reduce((n, c) => n + Buffer.byteLength(c.text), 0) + size <= 64000)
        last.push(chunk);
      else
        groups.push([chunk]);
    }
    for (let index = 0; index < groups.length; index++) {
      check();
      // Whole input files remain attributable; oversize files require explicit
      // narrower adoption instead of silently truncating their semantic input.
      const request = semanticExchange(groups[index], `${operationId}:chunk:${index}`);
      const id = digest("semantic-dispatch", request);
      const db = new WorkflowDb(root);
      try {
        const store = db.graphStore(), prior = store.get<{
          state: string;
          result?: SemanticExtraction;
          outputBytes?: number;
        }>("job", id)?.value;
        if (prior) {
          if (prior.state !== "completed" || !prior.result)
            throw new Error("Uncertain semantic dispatch requires explicit reconciliation; refusing replay");
          outputBytes += prior.outputBytes ?? Buffer.byteLength(canonical(prior.result));
          if (outputBytes > 120000) throw new Error("Semantic output budget exceeded");
          result.nodes.push(...prior.result.nodes);
          result.edges.push(...prior.result.edges);
          continue;
        }
        const scratchRoot = join(root, "graphify-out", "rafi", "semantic-sessions");
        mkdirSync(scratchRoot, { recursive: true });
        confined(root, "graphify-out/rafi/semantic-sessions");
        const scratch = mkdtempSync(join(scratchRoot, "worker-"));
        let worker: BuilderAdapter | undefined;
        let closing: Promise<void> | undefined;
        const close = (): Promise<void> => {
          // Do not memoize an empty close while asynchronous creation is pending.
          // A worker arriving after the deadline still needs its own teardown.
          if (!worker) return Promise.resolve();
          const target = worker;
          return closing ??= Promise.resolve().then(() => target.close()).then(() => undefined).catch(() => undefined);
        };
        let stop!: (error: Error) => void;
        const stopped = new Promise<never>((_, reject) => { stop = reject; });
        // The provider may fail to settle its turn even after close. The host's
        // absolute deadline independently bounds the awaited dispatch.
        const cancel = (): void => {
          stop(new Error(budget?.signal?.aborted ? "Semantic extraction cancelled" : "Semantic extraction deadline exceeded"));
          if (worker) void close();
        };
        const timer = setTimeout(cancel, Math.max(1, deadline - Date.now()));
        budget?.signal?.addEventListener("abort", cancel, { once: true });
        try {
          const opts: BuilderAdapterOptions = { ...settings, cwd: scratch, configRoot: root, sessionRole: "planner", sessionStream: "graph-semantic", sandboxMode: "read-only", approvalPolicy: "never", networkAccess: false, systemPromptAppend: SEMANTIC_INSTRUCTIONS, permission: async () => ({ behavior: "deny", message: "Graph semantic extraction accepts only the captured packet; all tools denied" }), turnDeadlineMs: Math.max(1, deadline - Date.now()) };
          worker = await Promise.race([createWorker(opts).then(created => {
            worker = created;
            if (budget?.signal?.aborted || Date.now() >= deadline) void close();
            return created;
          }), stopped]);
          check();
          store.put("job", id, { version: 1, state: "dispatch-intended", operationId, requestId: request.operationId, inputDigest: request.inputDigest, provider: host.agent, model: settings.model });
          const chunkOutputStart = outputBytes;
          const observations: TurnResult[] = [];
          const recordObservation = (turn: TurnResult): void => {
            observations.push(turn);
            store.put("job", id, { version: 1, state: "returned-unvalidated", operationId, requestId: request.operationId,
              inputDigest: request.inputDigest, sessionId: worker?.sessionId(),
              observations: observations.map(t => ({ turnId: t.turnId, usage: t.usage, costUsd: t.costAuthoritative ? t.costUsd : undefined,
                responseDigest: bytesDigest(t.rawResponse ?? t.text), failed: Boolean(t.isError || t.failure) })) });
          };
          const turn = await Promise.race([worker.sendTurn(canonical(request), { responseOnly: true, handback: true, logicalActionId: request.operationId }), stopped]);
          recordObservation(turn);
          check();
          accountOutput(turn.cleanedResponse ?? turn.text);
          if (turn.isError || turn.failure)
            throw new Error(`Semantic provider failed: ${turn.text.slice(0, 500)}`);
          let parsed: SemanticExtraction;
          try {
            parsed = parseSemanticResult(turn.cleanedResponse ?? turn.text, request);
          }
          catch (error) {
            check();
            store.put("job", id, { version: 1, state: "repair-intended", operationId, requestId: request.operationId, inputDigest: request.inputDigest, initialResponseDigest: bytesDigest(turn.rawResponse ?? turn.text), observations: observations.map(t => ({ turnId: t.turnId, usage: t.usage, costUsd: t.costAuthoritative ? t.costUsd : undefined })) });
            const repaired = await Promise.race([worker.sendTurn(`Format correction only. Preserve your source observations; no tools or new extraction. Return strict JSON matching ${canonical({ operationId: request.operationId, inputDigest: request.inputDigest })}. Validation: ${String(error)}`, { responseOnly: true, handback: true, logicalActionId: request.operationId }), stopped]);
            recordObservation(repaired);
            check();
            accountOutput(repaired.cleanedResponse ?? repaired.text);
            if (repaired.isError || repaired.failure)
              throw new Error("Semantic format correction failed; reconciliation required");
            parsed = parseSemanticResult(repaired.cleanedResponse ?? repaired.text, request);
          }
          const known = observations.every(t => t.usage?.scope === "turn-delta" && t.usage.inputTokens !== undefined && t.usage.outputTokens !== undefined);
          const authoritative = observations.every(t => t.costAuthoritative === true);
          store.put("job", id, { version: 1, state: "completed", operationId, sessionId: worker.sessionId(),
            turnIds: observations.map(t => t.turnId), result: parsed, outputBytes: outputBytes - chunkOutputStart,
            usage: { inputTokens: known ? observations.reduce((n, t) => n + t.usage!.inputTokens!, 0) : undefined,
              outputTokens: known ? observations.reduce((n, t) => n + t.usage!.outputTokens!, 0) : undefined,
              costUsd: authoritative ? observations.reduce((n, t) => n + t.costUsd, 0) : undefined,
              observations: observations.map(t => ({ turnId: t.turnId, usage: t.usage, costUsd: t.costAuthoritative ? t.costUsd : undefined })) } });
          result.nodes.push(...parsed.nodes);
          result.edges.push(...parsed.edges);
        }
        finally {
          clearTimeout(timer);
          budget?.signal?.removeEventListener("abort", cancel);
          let closeTimer: ReturnType<typeof setTimeout> | undefined;
          try { await Promise.race([close(), new Promise<void>(resolve => { closeTimer = setTimeout(resolve, 1000); })]); }
          finally { if (closeTimer) clearTimeout(closeTimer); }
          rmSync(scratch, { recursive: true, force: true });
        }
      }
      finally {
        db.close();
      }
      if (Date.now() > deadline)
        throw new Error("Semantic extraction deadline exceeded");
    }
    return result;
  };
}
