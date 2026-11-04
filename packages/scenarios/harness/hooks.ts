// Crash and pause hooks (SCN 7.7): the boundary names of ARCH 4.6 as data, the recorder that numbers each
// occurrence, and crash.at(k) / pause.at(k). P34 (C164): the engine awaits `pause` and then calls `crash` with the
// same name at every site, so the occurrence is numbered once, in `pause`, and `crash` reuses it.
import type { Hooks } from "@rafi-ai/engine";

export const BOUNDARIES: readonly string[] = Object.freeze([
  "1: after turn.intent, before sending",
  "2: after sending, before any reply",
  "3: after the reply arrives, before it's recorded",
  "4: recorded, before progress write",
  "5: during the progress-file write",
  "6: around a git operation",
  "7: during another write",
  "8: inside migrate or populate, between files",
  "9: after a question is recorded, before it's shown",
  "10: around a test run or CI point",
]);

export class HarnessCrash extends Error {
  constructor(readonly occurrence: string) {
    super(`harness crash at ${occurrence}`);
  }
}

/** What runs at a pause point: the occurrence's name and every occurrence passed so far. Awaited (P34). */
export type PauseFn = (occurrence: string, passed: readonly string[]) => unknown;

export interface HookControl {
  readonly hooks: Hooks;
  /** Every boundary passed so far, numbered: "4: recorded, before progress write (T2, review, 2nd)". */
  readonly passed: string[];
  /** The occurrence this instance crashed at, or null. */
  readonly crashed: string | null;
  /** Crash at the k-th occurrence (1-based), or the first whose name starts with the given text. */
  crashAt(at: number | string): void;
  /** At the k-th occurrence, or at every occurrence the predicate picks. */
  pauseAt(k: number | ((occurrence: string, index: number) => boolean), onPause: PauseFn): void;
  /** Called at every occurrence (record mode, P33: the crash enumeration takes its snapshots here). */
  onEach(fn: (occurrence: string, index: number) => void): void;
  /** A crash right here, outside the named boundaries (a torn write, C157). */
  crashNow(occurrence: string): never;
}

const ORDINALS = ["1st", "2nd", "3rd"];
const ordinal = (n: number) => ORDINALS[n - 1] ?? `${n}th`;

export function hookControl(onCrash: (occurrence: string) => void): HookControl {
  const passed: string[] = [];
  const counts = new Map<string, number>();
  let crashAt: number | string | null = null;
  let crashed: string | null = null;
  let pause: { at: number | ((o: string, i: number) => boolean); fn: PauseFn } | null = null;
  let each: ((occurrence: string, index: number) => void) | null = null;
  let numbered: { boundary: string; occurrence: string } | null = null;
  const record = (boundary: string) => {
    const n = (counts.get(boundary) ?? 0) + 1;
    counts.set(boundary, n);
    const occurrence = boundary.includes("(") ? boundary.replace(/\)$/, `, ${ordinal(n)})`) :
      `${boundary} (${ordinal(n)})`;
    passed.push(occurrence);
    each?.(occurrence, passed.length);
    return occurrence;
  };
  return {
    passed,
    get crashed() { return crashed; },
    crashAt(at) { crashAt = at; },
    pauseAt(k, fn) { pause = { at: k, fn }; },
    onEach(fn) { each = fn; },
    crashNow(occurrence) {
      crashed = occurrence;
      passed.push(occurrence);
      onCrash(occurrence);
      throw new HarnessCrash(occurrence);
    },
    hooks: {
      pause(boundary) {
        const occurrence = record(boundary);
        numbered = { boundary, occurrence };
        const at = pause?.at;
        if (pause && (typeof at === "number" ? passed.length === at : at!(occurrence, passed.length))) {
          const fn = pause.fn;
          return Promise.resolve(fn(occurrence, passed)).then(() => undefined);
        }
        return undefined;
      },
      crash(boundary) {
        const reuse = numbered?.boundary === boundary ? numbered.occurrence : null;
        numbered = null;
        const occurrence = reuse ?? record(boundary);
        const index = passed.indexOf(occurrence) + 1;
        const hit = typeof crashAt === "number" ? index === crashAt
          : typeof crashAt === "string" && crashed === null && occurrence.startsWith(crashAt);
        if (hit) {
          crashed = occurrence;
          onCrash(occurrence);
          throw new HarnessCrash(occurrence);
        }
      },
    },
  };
}
