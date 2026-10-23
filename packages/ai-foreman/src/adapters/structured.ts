import { boundedJson, structuredDigest, providerWireContract, validateStructuredCandidate, type OutputContract, type StructuredResponse } from "rafi-spec";

export function structuredReceipt(contract: OutputContract, provider: "claude" | "codex", value: unknown,
  identity: { dispatchId: string; sessionId?: string; nativeTurnId?: string; nativeItemId?: string },
  representation: "json-text" | "decoded-json", selected = providerWireContract(contract, provider)): StructuredResponse {
  if (value === undefined) return { state: "rejected", reason: "missing-result", detail: "Successful provider terminal omitted its structured result", dispatchId: identity.dispatchId };
  let observedValue: { representation: "json-text" | "decoded-json"; value: unknown; digest: string } | undefined;
  try {
    // Retain bounded invalid JSON text too, before parsing can reject it.
    if (representation === "json-text" && typeof value === "string" && Buffer.byteLength(value) <= selected.maximumResponseBytes) observedValue = { representation, value, digest: structuredDigest(value) };
    else if (representation === "decoded-json") observedValue = { representation, value: boundedJson(value, representation, selected.maximumResponseBytes), digest: structuredDigest(value) };
    if (!identity.sessionId || !identity.nativeTurnId) throw new Error("Missing native receipt identity");
    boundedJson(value, representation, selected.maximumResponseBytes);
    const candidate: StructuredResponse = { state: "candidate", protocolVersion: 1, operation: contract.operation,
      schemaVersion: contract.schemaVersion, schemaDigest: contract.schemaDigest, wireSchemaDigest: selected.wireSchemaDigest, profile: selected.profile,
      wireContractDigest: selected.descriptorDigest, wireVariant: selected.variant,
      ...identity, sessionId: identity.sessionId, nativeTurnId: identity.nativeTurnId, terminal: "completed", representation, value };
    const normalized = validateStructuredCandidate(contract, candidate, selected);
    candidate.normalization = { version: 1, rawDecodedDigest: structuredDigest(boundedJson(value, representation, selected.maximumResponseBytes)), canonicalDigest: structuredDigest(normalized) };
    return candidate;
  } catch (error) {
    return { state: "rejected", reason: "invalid-contract", detail: String(error), dispatchId: identity.dispatchId, ...(observedValue ? { observedValue } : {}) };
  }
}

/** Holds early notifications until turn/start supplies the exact turn identity. */
export class CodexTurnCollector {
  private turnId?: string;
  private early: Array<{ method: string; params: Record<string, unknown> }> = [];
  private bytes = 0;
  private finals = new Map<string, string>();
  private terminal?: Record<string, unknown>;
  private error?: Error;
  tools = false;
  private resolve!: (value: Record<string, unknown>) => void;
  private reject!: (error: Error) => void;
  readonly completion = new Promise<Record<string, unknown>>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  constructor(private readonly threadId: string, private readonly requirePhase: boolean, private readonly onProgress?: () => void, private readonly maximumResponseBytes = 2_000_000) { void this.completion.catch(() => {}); }
  bind(turnId: string): void {
    if (!turnId || this.turnId) throw new Error("Missing or duplicate native turn binding");
    this.turnId = turnId;
    this.onProgress?.();
    const early = this.early; this.early = [];
    for (const event of early) this.ingest(event.method, event.params);
    this.settle();
  }
  ingest(method: string, params: Record<string, unknown>): void {
    if (params.threadId !== this.threadId) return;
    if (!this.terminal && this.turnId && params.turnId === this.turnId && method.startsWith("item/") && method.endsWith("/delta")) this.onProgress?.();
    if (!["item/started", "item/completed", "turn/completed"].includes(method)) return;
    if (!this.turnId) {
      this.bytes += Buffer.byteLength(JSON.stringify(params));
      if (this.early.length >= 10_000 || this.bytes > this.maximumResponseBytes) return this.fail(new Error("Early Codex notification limit exceeded"));
      this.early.push({ method, params }); return;
    }
    const terminal = params.turn as Record<string, unknown> | undefined;
    if ((method === "turn/completed" ? terminal?.id : params.turnId) !== this.turnId) return;
    if (!this.terminal) this.onProgress?.();
    const item = params.item as Record<string, unknown> | undefined;
    if (item && ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "imageGeneration", "collabAgentToolCall"].includes(String(item.type))) this.tools = true;
    if (method === "item/completed" && item?.type === "agentMessage" && typeof item.text === "string" && (item.phase === "final_answer" || !this.requirePhase && item.phase === undefined)) {
      if (typeof item.id !== "string" || !item.id) return this.invalidate(new Error("Final result has no native item identity"));
      const previous = this.finals.get(item.id);
      if (previous !== undefined && previous !== item.text) return this.invalidate(new Error("Conflicting redelivery of native result item"));
      if (previous === undefined) {
        this.bytes += Buffer.byteLength(item.text);
        if (this.bytes > this.maximumResponseBytes) return this.fail(new Error("Codex result limit exceeded"));
        this.finals.set(item.id, item.text);
      }
    }
    if (method === "turn/completed") {
      if (this.terminal && JSON.stringify(this.terminal) !== JSON.stringify(terminal)) return this.invalidate(new Error("Conflicting native terminal events"));
      this.terminal = terminal;
      this.settle();
    }
  }
  fail(error: Error): void { this.error = error; this.reject(error); }
  private invalidate(error: Error): void { this.error = error; }
  private settle(): void { if (this.terminal) this.resolve(this.terminal); }
  final(): { text: string; itemId?: string } {
    if (this.error) throw this.error;
    if (this.finals.size > 1) throw new Error("Multiple distinct final result items");
    const entry = [...this.finals][0];
    return { text: entry?.[1] ?? "", itemId: entry?.[0] };
  }
}
