import { boundedJson, structuredDigest, providerWireContract, validateStructuredCandidate, type OutputContract, type SelectedDispatchTupleV2, type StructuredResponse } from "rafi-spec";

export function structuredReceipt(contract: OutputContract, provider: "claude" | "codex", value: unknown,
  identity: { dispatchId: string; sessionId: string; nativeTurnId?: string; nativeItemId?: string },
  representation: "json-text" | "decoded-json", selected: ReturnType<typeof providerWireContract>, tuple: SelectedDispatchTupleV2): StructuredResponse {
  if (value === undefined) return { state: "rejected", reason: "missing-result", detail: "Successful provider terminal omitted its structured result", dispatchId: identity.dispatchId };
  let observedValue: { representation: "json-text" | "decoded-json"; value: unknown; digest: string } | undefined;
  try {
    // Retain bounded invalid JSON text too, before parsing can reject it.
    if (representation === "json-text" && typeof value === "string" && Buffer.byteLength(value) <= selected.maximumResponseBytes) observedValue = { representation, value, digest: structuredDigest(value) };
    else if (representation === "decoded-json") observedValue = { representation, value: boundedJson(value, representation, selected.maximumResponseBytes), digest: structuredDigest(value) };
    if (!identity.sessionId || !identity.nativeTurnId) throw new Error("Missing native receipt identity");
    boundedJson(value, representation, selected.maximumResponseBytes);
    if (tuple.provider !== provider || tuple.operation !== contract.operation || tuple.schemaDigest !== contract.schemaDigest || tuple.descriptorDigest !== selected.descriptorDigest ||
      tuple.dispatchId !== identity.dispatchId || tuple.sessionId !== identity.sessionId) throw new Error("Receipt identity does not match selected dispatch tuple v2");
    const candidate: StructuredResponse = { state: "candidate", protocolVersion: 2, operation: contract.operation,
      schemaVersion: contract.schemaVersion, schemaDigest: contract.schemaDigest, wireSchemaDigest: selected.wireSchemaDigest, profile: selected.profile,
      wireContractDigest: selected.descriptorDigest, wireVariant: selected.variant,
      selectedDispatchDigest: tuple.digest,
      ...identity, sessionId: identity.sessionId, nativeTurnId: identity.nativeTurnId, terminal: "completed", representation, value };
    const normalized = validateStructuredCandidate(contract, candidate, selected, tuple);
    candidate.normalization = { version: 1, rawDecodedDigest: structuredDigest(boundedJson(value, representation, selected.maximumResponseBytes)), canonicalDigest: structuredDigest(normalized) };
    return candidate;
  } catch (error) {
    return { state: "rejected", reason: "invalid-contract", detail: String(error), dispatchId: identity.dispatchId, ...(observedValue ? { observedValue } : {}) };
  }
}

const STREAM_HEAD_BYTES = 65_536;
const STREAM_TAIL_BYTES = 8_192;
const STREAM_TEXT_ITEMS = 8;

function headUtf8(text: string, maximum: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maximum) return text;
  let end = maximum;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString();
}
function tailUtf8(text: string, maximum: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maximum) return text;
  let start = bytes.length - maximum;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString();
}

/** Bounded, non-authoritative view of one streamed agent message. */
export interface CodexStreamItemDiagnostic {
  itemId: string; bytes: number; deltas: number; completed: boolean;
  head: string; tail: string; textRetained: boolean; startedAt: string; lastDeltaAt: string;
}
export interface CodexStreamDiagnostic { authoritative: false; streamedBytes: number; deltas: number; items: CodexStreamItemDiagnostic[] }

/** Holds early notifications until turn/start supplies the exact turn identity. */
export class CodexTurnCollector {
  private turnId?: string;
  private early: Array<{ method: string; params: Record<string, unknown> }> = [];
  private bytes = 0;
  private finals = new Map<string, string>();
  private streams = new Map<string, CodexStreamItemDiagnostic>();
  private streamedBytes = 0;
  private streamedDeltas = 0;
  private earlyDeltaBytes = 0;
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
    this.bytes = 0; // Early transport was already bounded; count result bytes once while draining.
    for (const event of early) this.ingest(event.method, event.params);
    this.settle();
  }
  ingest(method: string, params: Record<string, unknown>): void {
    if (params.threadId !== this.threadId) return;
    if (!this.terminal && this.turnId && params.turnId === this.turnId && method.startsWith("item/") && method.endsWith("/delta")) this.onProgress?.();
    if (!["item/started", "item/completed", "turn/completed", "item/agentMessage/delta"].includes(method)) return;
    if (!this.turnId) {
      // Early streamed text has its own budget so a final item is never charged twice.
      // Event count bounds overhead; content bytes bound early streamed text.
      if (method === "item/agentMessage/delta") this.earlyDeltaBytes += typeof params.delta === "string" ? Buffer.byteLength(params.delta) : 0;
      else this.bytes += Buffer.byteLength(JSON.stringify(params));
      if (this.early.length >= 10_000 || this.bytes > this.maximumResponseBytes || this.earlyDeltaBytes > this.maximumResponseBytes) return this.fail(new Error("Early Codex notification limit exceeded"));
      this.early.push({ method, params }); return;
    }
    const terminal = params.turn as Record<string, unknown> | undefined;
    if ((method === "turn/completed" ? terminal?.id : params.turnId) !== this.turnId) return;
    if (method === "item/agentMessage/delta") return this.ingestDelta(params);
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
    if (method === "item/completed" && item?.type === "agentMessage" && typeof item.id === "string") {
      const stream = this.streams.get(item.id);
      if (stream) stream.completed = true;
    }
    if (method === "turn/completed") {
      if (this.terminal && JSON.stringify(this.terminal) !== JSON.stringify(terminal)) return this.invalidate(new Error("Conflicting native terminal events"));
      this.terminal = terminal;
      this.settle();
    }
  }
  /**
   * Streamed text is bounded before completion, but never becomes a result:
   * only a completed final item is accepted and charged against the budget.
   */
  private ingestDelta(params: Record<string, unknown>): void {
    if (this.terminal || this.error) return;
    const itemId = params.itemId, delta = params.delta;
    if (typeof itemId !== "string" || !itemId || typeof delta !== "string" || this.finals.has(itemId)) return;
    const now = new Date().toISOString();
    let stream = this.streams.get(itemId);
    if (!stream) {
      stream = { itemId, bytes: 0, deltas: 0, completed: false, head: "", tail: "", textRetained: true, startedAt: now, lastDeltaAt: now };
      this.streams.set(itemId, stream);
      const retained = [...this.streams.values()].filter(item => item.textRetained);
      if (retained.length > STREAM_TEXT_ITEMS) { const oldest = retained[0]!; oldest.head = ""; oldest.tail = ""; oldest.textRetained = false; }
    }
    const bytes = Buffer.byteLength(delta);
    stream.bytes += bytes; stream.deltas += 1; stream.lastDeltaAt = now;
    this.streamedBytes += bytes; this.streamedDeltas += 1;
    const headBytes = Buffer.byteLength(stream.head);
    if (headBytes < STREAM_HEAD_BYTES) stream.head += headUtf8(delta, STREAM_HEAD_BYTES - headBytes);
    stream.tail = tailUtf8(stream.tail + delta, STREAM_TAIL_BYTES);
    if (stream.bytes > this.maximumResponseBytes) this.fail(new Error(`Codex streamed message exceeded the ${this.maximumResponseBytes}-byte result limit before completion`));
  }
  streamDiagnostic(): CodexStreamDiagnostic {
    return { authoritative: false, streamedBytes: this.streamedBytes, deltas: this.streamedDeltas, items: [...this.streams.values()].map(item => ({ ...item })) };
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
