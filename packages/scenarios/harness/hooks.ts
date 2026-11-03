// Crash and pause hooks (SCN 7.7): the boundary names of ARCH 4.6 as data, the recorder that numbers each
// occurrence, and crash.at(k) / pause.at(k).
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

export interface HookControl {
  readonly hooks: Hooks;
  /** Every boundary passed so far, numbered: "4: recorded, before progress write (T2, review, 2nd)". */
  readonly passed: string[];
  crashAt(k: number): void;
  pauseAt(k: number, onPause: (occurrence: string) => void): void;
}

const ORDINALS = ["1st", "2nd", "3rd"];
const ordinal = (n: number) => ORDINALS[n - 1] ?? `${n}th`;

export function hookControl(onCrash: (occurrence: string) => void): HookControl {
  const passed: string[] = [];
  const counts = new Map<string, number>();
  let crashIndex: number | null = null;
  let pause: { index: number; fn: (o: string) => void } | null = null;
  const record = (boundary: string) => {
    const n = (counts.get(boundary) ?? 0) + 1;
    counts.set(boundary, n);
    const occurrence = boundary.includes("(") ? boundary.replace(/\)$/, `, ${ordinal(n)})`) :
      `${boundary} (${ordinal(n)})`;
    passed.push(occurrence);
    return occurrence;
  };
  return {
    passed,
    crashAt(k) { crashIndex = k; },
    pauseAt(k, fn) { pause = { index: k, fn }; },
    hooks: {
      crash(boundary) {
        const occurrence = record(boundary);
        if (crashIndex !== null && passed.length === crashIndex) {
          onCrash(occurrence);
          throw new HarnessCrash(occurrence);
        }
      },
      pause(boundary) {
        if (pause && passed.length === pause.index) pause.fn(boundary);
      },
    },
  };
}
