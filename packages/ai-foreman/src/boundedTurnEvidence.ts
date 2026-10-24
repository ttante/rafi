import { createHash } from "node:crypto";
import { canonicalJson } from "rafi-spec";
import type { BuilderEvent, TurnResult } from "./adapters/types.js";

export function boundedUtf8(text: string, maximum: number): Buffer {
  const bytes = Buffer.from(text);
  if (bytes.length <= maximum) return bytes;
  let end = maximum;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}
const fingerprints = new WeakMap<TurnResult, { receipt: string; raw: string }>();
export function receiptFingerprint(turn: TurnResult): string { return fingerprints.get(turn)?.receipt ?? digest(canonicalJson(JSON.parse(JSON.stringify(turn.structured ?? null)))); }
export function rawFingerprint(turn: TurnResult): string { return fingerprints.get(turn)?.raw ?? digest(turn.rawResponse ?? turn.text); }
function digest(text: string): string { return createHash("sha256").update(text).digest("hex"); }

/** Retains at most one descriptor budget; omitted events cannot establish acceptance. */
export class BoundedTurnEvents extends Array<BuilderEvent> {
  static get [Symbol.species](): ArrayConstructor { return Array; }
  retainedBytes = 2;
  totalCount = 0;
  toolCount = 0;
  terminalCount = 0;
  omittedCount = 0;
  terminalOverflow = false;
  constructor(readonly maximumBytes: number) { super(); }
  override push(...events: BuilderEvent[]): number {
    for (const event of events) {
      this.totalCount++;
      if (event.kind === "tool" || event.kind === "provider-item" && !["text", "agentMessage", "reasoning", "userMessage", "contextCompaction", "structuredOutput"].includes(event.itemType)) this.toolCount++;
      let projected: BuilderEvent;
      if (event.kind === "turn-complete") {
        this.terminalCount++;
        const turn = event.result;
        const result: TurnResult = { text: "", isError: turn.isError, costUsd: 0, numTurns: turn.numTurns, turnId: turn.turnId,
          providerMetadata: turn.providerMetadata && JSON.parse(JSON.stringify(turn.providerMetadata)), failure: turn.failure && { ...turn.failure, diagnostics: "omitted" } };
        fingerprints.set(result, { receipt: receiptFingerprint(turn), raw: rawFingerprint(turn) });
        projected = { kind: "turn-complete", turnId: event.turnId, result };
      } else if (event.kind === "tool") projected = { ...event, input: Buffer.byteLength(JSON.stringify(event.input) ?? "") <= 1024 ? JSON.parse(JSON.stringify(event.input ?? null)) : {}, outputSummary: undefined, inputCompleteness: Buffer.byteLength(JSON.stringify(event.input) ?? "") <= 1024 ? event.inputCompleteness : "truncated" };
      else if (event.kind === "provider-item") projected = { ...event, payload: {}, payloadCompleteness: "truncated" };
      else if (event.kind === "text") projected = { kind: "text", text: boundedUtf8(event.text, 512).toString(), byteCount: Buffer.byteLength(event.text), digest: digest(event.text) };
      else if (event.kind === "error") projected = { kind: "error", message: boundedUtf8(event.message, 512).toString() };
      else projected = event;
      if (projected.kind !== "turn-complete") projected = JSON.parse(JSON.stringify(projected));
      const size = Buffer.byteLength(JSON.stringify(projected)) + 1;
      const limit = event.kind === "turn-complete" ? this.maximumBytes - 2048 : Math.floor(this.maximumBytes / 2);
      if (this.retainedBytes + size > limit) { this.omittedCount++; if (event.kind === "turn-complete") this.terminalOverflow = true; continue; }
      this.retainedBytes += size;
      super.push(projected);
    }
    return this.length;
  }
  metadata(): unknown {
    return JSON.parse(JSON.stringify({ totalCount: this.totalCount, toolCount: this.toolCount, terminalCount: this.terminalCount, omittedCount: this.omittedCount,
      terminalOverflow: this.terminalOverflow, events: this.map(event => event.kind === "turn-complete"
        ? { kind: event.kind, turnId: event.turnId, receiptDigest: receiptFingerprint(event.result), rawDigest: rawFingerprint(event.result), isError: event.result.isError, provider: event.result.providerMetadata }
        : event) }));
  }
}
