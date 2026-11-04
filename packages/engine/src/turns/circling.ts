// Going in circles (ARCH 5.5, NEW-ENG-5; C111, C112): failure signatures, "no progress" and circling, for the
// attempts of a ticket's fix loop and for the retries of one turn. Pure; the steps feed it from the event log.

/** One failed attempt of a ticket: its signature, the builder's tree before it, and the files that turn read. */
export interface AttemptRecord {
  readonly signature: string;
  readonly tree: string | null;
  readonly read: readonly string[];
}

/** QA: the sorted not-satisfied requirement numbers with the outcome of the runs each cited (never run numbers). */
export function verdictSignature(results: readonly { req: number; status: string; runs: readonly number[] }[],
  runs: readonly { run: number; outcome: string }[]): string {
  return results.filter((r) => r.status === "not-satisfied").sort((a, b) => a.req - b.req)
    .map((r) => `R${r.req}[${r.runs.map((n) => runs.find((x) => x.run === n)?.outcome ?? "unknown").join(",")}]`)
    .join(" ");
}

/** Checks: the failing requirement numbers and test names. */
export function checksSignature(failing: readonly { req: number; run: number; tests: readonly string[] }[]): string {
  return [...failing].sort((a, b) => a.req - b.req)
    .map((f) => `R${f.req}${f.tests.length ? `[${[...f.tests].sort().join("|")}]` : ""}`).join(" ");
}

export function blockSignature(kind: string, reason: string): string {
  return `${kind}: ${reason}`;
}

/** A format or content failure: its class and the field; a rejected repair names the field the resend changed. */
export function replySignature(category: string, errors: readonly string[]): string | null {
  if (category !== "format" && category !== "content") return null;
  const first = errors[0] ?? "";
  const repair = /the repair was rejected: the resend changed (\S+)/.exec(first);
  if (repair) return `repair rejected: ${repair[1]}`;
  const field = /^([A-Za-z_][\w.[\]]*): /.exec(first);
  return `${category}: ${field ? field[1] : first.slice(0, 120)}`;
}

/** Attempt `i` made no progress: the same failure as before, a tree already seen, and no file read for the first
 * time. */
export function noProgress(history: readonly AttemptRecord[], i: number): boolean {
  const cur = history[i];
  const prev = history[i - 1];
  if (!cur || !prev || cur.tree === null || cur.signature !== prev.signature) return false;
  const earlier = history.slice(0, i);
  if (!earlier.some((a) => a.tree === cur.tree)) return false;
  const read = new Set(earlier.flatMap((a) => a.read));
  return cur.read.every((f) => read.has(f));
}

/** `repeats` no-progress attempts in a row, ending with the latest. */
export function isCircling(history: readonly AttemptRecord[], repeats: number): boolean {
  let run = 0;
  for (let i = history.length - 1; i > 0 && noProgress(history, i); i -= 1) run += 1;
  return run >= repeats;
}

/** C112: within one turn, a failed try whose signature equals the previous one's and that touched nothing new. */
export function turnCircling(tries: readonly { signature: string | null; touched: readonly string[] }[],
  repeats: number): boolean {
  let run = 0;
  for (let i = tries.length - 1; i > 0; i -= 1) {
    const cur = tries[i]!;
    if (cur.signature === null || cur.signature !== tries[i - 1]!.signature) break;
    const seen = new Set(tries.slice(0, i).flatMap((t) => t.touched));
    if (!cur.touched.every((t) => seen.has(t))) break;
    run += 1;
  }
  return run >= repeats;
}
