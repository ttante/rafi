// The interviews' half of `rafi resume`'s picker (C142, C150): unfinished saved interviews as candidates, each
// labelled with its title escaped and redacted; a record that can't be read safely is named in one line (threat
// review 1). Picking one hands it to its own command, none of which is built in M4.
import type { Engine } from "../api/engine.js";
import { escapeControl } from "../log/redact.js";
import { INTERVIEW_COMMANDS, readInterviews, unfinishedInterviews, type Interview } from "./interviews.js";

export type Candidate = { at: string; label: string; run?: string; interview?: Interview };

/** C150: an interview goes to its own command; none of them is built yet in M4. */
export function interviewResult(engine: Engine, line: (text: string) => void, r: Interview): { code: number } {
  const owner = INTERVIEW_COMMANDS[r.workflow]!;
  const title = clean(engine.redact(r.title));
  line(`Saved interview ${r.id} ("${title}") continues in \`${owner.command}\`, which isn't ` +
    `in the new engine yet (milestone ${owner.milestone}).`);
  return { code: 1 };
}

export const clean = (text: string) => escapeControl(text).replace(/\s+/g, " ").slice(0, 120);

/** Unfinished interviews, labelled; skipped records are named through `line`. */
export async function interviewCandidates(engine: Engine, line: (text: string) => void): Promise<Candidate[]> {
  const saved = await readInterviews(engine.deps.fs, engine.projectDir);
  // Threat review 1 (10.4): a record that can't be read safely is named in one line, never silently dropped.
  for (const s of saved.skipped) line(`Skipped saved interview ${clean(s.file)}: ${clean(engine.redact(s.why))}.`);
  return unfinishedInterviews(saved.records).map((r) => ({ at: r.updated_at, interview: r,
    label: `${clean(engine.redact(r.title))} (${r.workflow} interview, ${r.status.replace("_", " ")}, saved ` +
      `${r.updated_at.slice(0, 16).replace("T", " ")})` }));
}
