import { createHash } from "node:crypto";

/** Optional history is advisory. Mandatory current requirements/findings stay exact. */
export function boundedQaHistory(history: readonly unknown[]): Array<Record<string, unknown>> {
  return history.slice(-4).map(value => {
    const entry = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const output: Record<string, unknown> = {};
    for (const key of ["attemptId", "reportOccurrenceId", "operationId", "cycle", "outcome", "reportDigest", "remediationDigest", "fixSummaryDigest", "remediationRequestDigest"]) {
      if (typeof entry[key] === "string" || typeof entry[key] === "number") output[key] = entry[key];
    }
    // Never recursively embed the previous request, report, or handoff.
    for (const key of ["detail", "fixSummary"]) if (typeof entry[key] === "string") output[key] = utf8Prefix(entry[key], 1024);
    output.advisoryOnly = true;
    return output;
  });
}

export function utf8Prefix(text: string, bytes: number): string {
  let used = 0, result = "";
  for (const point of text) { const size = Buffer.byteLength(point); if (used + size > bytes) break; result += point; used += size; }
  return result;
}

export function evidenceDigest(text: string): string { return createHash("sha256").update(text).digest("hex"); }
