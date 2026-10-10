import { createHash, randomUUID } from "node:crypto";
import type { ManagerEvidencePageV2 } from "rafi-spec";

export const evidenceDigest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
export interface ManagerEvidenceArtifact {
  handle: string;
  identity: { runId: string; workId: string; attemptId: string; occurrenceId: string };
  rawDigest: string;
  renderedDigest: string;
  rawBytes: number;
  totalBytes: number;
  redactions: ManagerEvidencePageV2["redactions"];
}

/** Host-owned copies pin bytes through concurrent retention; handles are never paths. */
export class ManagerEvidenceArtifacts {
  constructor(private readonly permitted:(digest:string)=>boolean=()=>true) {}
  private readonly artifacts = new Map<string, { metadata: ManagerEvidenceArtifact; raw: Buffer; rendered: Buffer }>();
  create(identity: ManagerEvidenceArtifact["identity"], bytes: Buffer): ManagerEvidenceArtifact {
    const raw = Buffer.from(bytes);
    const display = renderEvidenceText(raw.toString("utf8"));
    const rendered = Buffer.from(display.text);
    const metadata: ManagerEvidenceArtifact = { handle: randomUUID(), identity: { ...identity }, rawDigest: evidenceDigest(raw), renderedDigest: evidenceDigest(rendered), rawBytes: raw.length, totalBytes: rendered.length, redactions: display.redactions };
    this.artifacts.set(metadata.handle, { metadata, raw, rendered });
    return metadata;
  }
  metadata(handle: string): ManagerEvidenceArtifact | undefined { return this.artifacts.get(handle)?.metadata; }
  /** Called only by host commands; protected raw content is never a model packet. */
  bytes(handle: string, raw = false): Buffer {
    const artifact = this.artifacts.get(handle);
    if (!artifact) throw new Error("Evidence artifact expired; retrieve the report again");
    if(!this.permitted(artifact.metadata.rawDigest))throw new Error("Evidence artifact access revoked; retained bytes withheld");
    return Buffer.from(raw ? artifact.raw : artifact.rendered);
  }
  chunks(handle: string, maximumBytes = 8192): Array<ManagerEvidenceArtifact & { offset: number; returnedBytes: number; body: string; redactionSpanCount: number }> {
    if (!Number.isInteger(maximumBytes) || maximumBytes < 4 || maximumBytes > 8192) throw new Error("Invalid evidence chunk size");
    const artifact = this.artifacts.get(handle);
    if (!artifact) throw new Error("Evidence artifact expired; retrieve the report again");
    if(!this.permitted(artifact.metadata.rawDigest))throw new Error("Evidence artifact access revoked; retained bytes withheld");
    const chunks = [];
    let offset = 0;
    do {
      let end = Math.min(offset + maximumBytes, artifact.rendered.length);
      while (end < artifact.rendered.length && (artifact.rendered[end]! & 0xc0) === 0x80) end--;
      chunks.push({ ...artifact.metadata, redactions: artifact.metadata.redactions.slice(0, 16), redactionSpanCount: artifact.metadata.redactions.length, offset, returnedBytes: end - offset, body: artifact.rendered.subarray(offset, end).toString("utf8") });
      offset = end;
    } while (offset < artifact.rendered.length);
    return chunks;
  }
  clear(): void { this.artifacts.clear(); }
}

/** Same secret categories as diagnostic reads, with full text and disclosed spans. */
export function renderEvidenceText(value: string): { text: string; redactions: ManagerEvidencePageV2["redactions"] } {
  const redactions: ManagerEvidencePageV2["redactions"] = [];
  const urlCredentials = /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi;
  // URL passwords can contain '='. Mask their known boundaries while finding
  // scalar assignments, keeping UTF-16 positions and the public host/path.
  const assignmentInput = value.replace(urlCredentials, match => " ".repeat(match.length));
  // Match original text, then merge overlaps. A token inside a quoted assignment
  // must never shorten the enclosing redaction or shift the disclosed offsets.
  const assignments: Array<{ category: string; start: number; end: number }> = [];
  const keys = /\b(?:api[_-]?key|token|password|secret|authorization)(?:\\*["'])?\s*[:=]\s*/gi;
  for (let match; (match = keys.exec(assignmentInput));) {
    const start = match.index;
    let end = start + match[0].length;
    let quoted = end;
    while (assignmentInput[quoted] === "\\") quoted++;
    const quote = assignmentInput[quoted];
    if (quote === '"' || quote === "'") {
      const escaping = quoted - end;
      end = quoted + 1;
      let slashes = 0;
      while (end < assignmentInput.length) {
        const char = assignmentInput[end++]!;
        // JSON-encoded quotes have 1, 3, 7, ... preceding slashes. The
        // delimiter and an escaped quote inside the value remain distinct,
        // including when the credential ends in a literal backslash.
        if (char === quote && slashes >= escaping && (slashes - escaping) % (2 * (escaping + 1)) === 0) break;
        slashes = char === "\\" ? slashes + 1 : 0;
      }
    } else {
      while (end < assignmentInput.length && !/[\s,;"'}]/.test(assignmentInput[end]!)) end++;
    }
    assignments.push({ category: "secret_assignment", start, end });
    keys.lastIndex = end;
  }
  const patterns = [
    // HTTP headers such as Digest can contain spaces, quotes and commas. Keep
    // the whole header value out of display rather than treating it as a scalar.
    { category: "secret_assignment", pattern: /^[\t ]*authorization[\t ]*:[^\r\n]*/gmi },
    { category: "secret_assignment", pattern: /\bauthorization["']?\s*[:=]\s*[^\s"'\r\n,;}][^"'\r\n,;}]*/gi },
    { category: "credential", pattern: /\b(?:sk|ghp|glpat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi },
    { category: "url_credentials", pattern: urlCredentials },
    { category: "terminal_control", pattern: /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g },
  ];
  const matches = [...assignments, ...patterns.flatMap(({ category, pattern }) => [...(category === "secret_assignment" ? assignmentInput : value).matchAll(pattern)].map(match => ({ category, start: match.index!, end: match.index! + match[0].length })))];
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const spans: typeof matches = [];
  for (const match of matches) {
    const prior = spans.at(-1);
    if (prior && match.start < prior.end) prior.end = Math.max(prior.end, match.end);
    else spans.push({ ...match });
  }
  let text = "", offset = 0;
  for (const span of spans) {
    const match = value.slice(span.start, span.end);
    redactions.push({ ...span, field: "body (original UTF-16 character offsets)" });
    text += value.slice(offset, span.start);
    text += span.category === "terminal_control" ? `\\u${match.charCodeAt(0).toString(16).padStart(4, "0")}`
      : span.category === "url_credentials" ? `${match.split("://")[0]}://[REDACTED]@` : "[REDACTED]";
    offset = span.end;
  }
  text += value.slice(offset);
  return { text, redactions };
}
