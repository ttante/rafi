// The one repair try (ARCH 5.3, NEW-MAL-2, NEW-SO-1..5): read what's readable of a broken reply, ask once for the
// same content, and accept the resend only if it keeps every recovered value. A reply with no readable JSON is a
// content error: there's nothing a resend could be compared with.
import { quoted as quote } from "../instructions/assemble.js";
import { escapeControl } from "../log/redact.js";

export type ReadResult =
  | { kind: "ok"; value: unknown }
  | { kind: "format"; error: string; atByte: number | null; recovered: unknown; cut: boolean }
  | { kind: "content"; error: string };

/** The complete top-level members of a cut-off object, closed at the last complete one. */
function recoverCut(text: string): unknown {
  let depth = 0;
  let quoted = false;
  let commas: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === "\\") i += 1;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 1) commas = [...commas, i];
  }
  for (const at of [...commas].reverse()) {
    try { return JSON.parse(`${text.slice(0, at)}}`); } catch { /* try an earlier member */ }
  }
  return undefined;
}

export function readReply(text: string, structured?: unknown): ReadResult {
  if (structured !== undefined && structured !== null) return { kind: "ok", value: structured };
  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch (error) {
    const message = String((error as Error).message);
    if (!/^\s*[[{]/.test(text)) return { kind: "content", error: "the reply has no JSON in it" };
    const where = /at position (\d+)/.exec(message);
    const plain = message.replace(/\s*(in JSON )?at position \d+.*$/s, "").replace(/\s*\(line \d+.*$/s, "");
    if (where && /after JSON/i.test(message)) {
      const at = Number(where[1]);
      try {
        return { kind: "format", error: plain, atByte: at, recovered: JSON.parse(text.slice(0, at)), cut: false };
      } catch { /* not readable up to there */ }
    }
    const recovered = recoverCut(text);
    if (recovered === undefined) return { kind: "content", error: `the reply isn't valid JSON: ${plain}` };
    return { kind: "format", error: plain || "the reply was cut off", atByte: Buffer.byteLength(text, "utf8"),
      recovered, cut: true };
  }
}

/** The parser's error can quote the reply's own text (`Unexpected token 'I', "…IGNORE PRE"…`): only as quoted data. */
export function repairMessage(error: string, atByte: number | null): string {
  const where = atByte === null ? " in it" : ` at byte ${atByte}`;
  return `Your last reply wasn't valid JSON: the parser's error is quoted below; the problem is${where}.\n` +
    `${quote(escapeControl(error))}\nSend the same reply again as valid JSON in the same format. Don't run tools, ` +
    "read files or change anything.";
}

function differs(recovered: unknown, resend: unknown, at: string): string | null {
  if (recovered && typeof recovered === "object" && !Array.isArray(recovered)) {
    if (!resend || typeof resend !== "object" || Array.isArray(resend)) return at || "the reply";
    for (const [key, value] of Object.entries(recovered)) {
      const found = differs(value, (resend as Record<string, unknown>)[key], at ? `${at}.${key}` : key);
      if (found) return found;
    }
    return null;
  }
  return JSON.stringify(recovered) === JSON.stringify(resend) ? null : at || "the reply";
}

/** Accept only a resend that keeps every recovered value; it may add only what the original lost. */
export function acceptRepair(recovered: unknown, resend: unknown): { accepted: boolean; why: string | null } {
  const path = differs(recovered, resend, "");
  return path ? { accepted: false, why: `the resend changed ${path}` } : { accepted: true, why: null };
}
