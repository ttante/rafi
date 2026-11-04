// answerEffects, the "What next?" rows (ARCH 4.2, 5.6, 7.7; REQ PRM-81, PRM-82; C103): what an answer appends,
// besides question.answered. Pure; the engine appends them with the answer in one transaction (C101).

export interface WhatNextAnswer {
  readonly ticket: string;
  readonly choice: string;
  /** "I verified it myself" requires one; it's stored as typed (redacted on write). */
  readonly note: string | null;
  /** PRM-82's "Waive and continue". */
  readonly confirmed?: boolean;
  /** The last verdict's not-satisfied requirements, or the failing checks' requirements. */
  readonly findings: readonly string[];
  /** The waiver key's digest of the files the findings cover (C106). */
  readonly fp: string;
}

export type Effects = { ok: true; events: { type: string; data: unknown }[] } | { ok: false; reason: string };

// M4 (C149): "Pause at this checkpoint" is built; it writes a pause request, not an answer (ask/blocked.ts).
export const WHAT_NEXT_LATER: Readonly<Record<string, string>> = Object.freeze({ planner: "M8" });

export function whatNextEffects(a: WhatNextAnswer): Effects {
  const unblock = (resume: string) => ({ type: "ticket.unblocked", data: { resume_step: resume, by: "user" } });
  const waiver = (kind: string, note: string) => ({ type: "waiver.recorded", data: { kind, note,
    findings: [...a.findings], fp: a.fp } });
  switch (a.choice) {
    case "retry":
      return { ok: true, events: [{ type: "fix.granted", data: { by: "user", reason: "Retry another Builder fix" } },
        unblock("fix")] };
    case "verified": {
      const note = a.note?.trim() ?? "";
      if (!note) return { ok: false, reason: "\"I verified it myself\" needs a note saying what you checked." };
      return { ok: true, events: [waiver("verified-myself", a.note!), unblock("deliver")] };
    }
    case "waive":
      if (!a.confirmed) return { ok: false, reason: "Waiving QA needs your confirmation." };
      return { ok: true, events: [waiver("waive-qa", ""), unblock("deliver")] };
    default: {
      const later = WHAT_NEXT_LATER[a.choice];
      return { ok: false, reason: later ? `that option isn't in the new engine yet (milestone ${later})`
        : `there's no option ${a.choice}` };
    }
  }
}
