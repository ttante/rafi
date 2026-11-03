// Standing instructions, sent once per session (ARCH 10.2, C53): the role's core (`.rafi/compiled/<role>/system.md`
// when present, else a short built-in core), the runtime contract (network, what's writable, report blocked or
// needs-input), the tools, and the reply format, described once. Untrusted text never goes here.
import path from "node:path";
import type { Fs } from "../deps/types.js";

const CORE: Readonly<Record<string, string>> = Object.freeze({
  builder: "You are the builder. Implement the ticket you're given in this repository, with tests, and nothing " +
    "outside it.",
  qa: "You are QA, an independent reviewer. You don't change code. Do not rubber-stamp work. Be skeptical: check " +
    "facts, and say \"unable to verify\" when you couldn't.",
});

const FORMAT: Readonly<Record<string, string>> = Object.freeze({
  builder: 'Reply with one JSON object: {"kind": "done" | "blocked" | "needs-input", "summary": one or two ' +
    'sentences when done (else null), "runs": rafi\'s run numbers you rely on, "block": {"type", "need", "reason"} ' +
    'or null, "question": {"text", "choices"} or null}. Cite rafi\'s run numbers; don\'t retype test output.',
  requirements: 'Reply with one JSON object: {"requirements": [{"from": the acceptance criterion\'s number, ' +
    '"text", "check": one test command or null, "expect": "passes" or null}], "in_scope": [], "out_of_scope": [], ' +
    '"risks": [], "add_tags": []}. Rafi numbers the requirements and writes the file.',
  verdict: 'Reply with one JSON object: {"results": [{"req": the requirement number, "status": "satisfied" | ' +
    '"not-satisfied" | "not-applicable" | "unable", "runs": rafi\'s run numbers, "needs": null or what you lacked, ' +
    '"note": text or null}], "summary": text}. Cite runs by their short number only.',
});

export interface Contract {
  readonly role: "builder" | "qa";
  readonly schema: "builder" | "requirements" | "verdict";
  readonly network: boolean;
  readonly writable: boolean;
  /** The JSON Schema, given in text when the model has no structured replies (C52's fallback). */
  readonly textSchema?: Record<string, unknown> | null;
}

export async function standingInstructions(fs: Fs, project: string, c: Contract): Promise<string> {
  const compiled = path.join(project, ".rafi", "compiled", c.role, "system.md");
  const core = (await fs.stat(compiled)) ? await fs.read(compiled) : CORE[c.role]!;
  const parts = [core.trim(),
    `The network is ${c.network ? "on" : "off"} for this session. ${c.writable ? "You may change files in this " +
      "worktree." : "This session is read-only."} If something you need is missing, report blocked; don't swap in a ` +
      "different stack or tool than the ticket names. If you need a decision, reply needs-input; don't ask the user.",
    "Run tests only through rafi's run_check tool (one test command); a test you run in your own shell isn't " +
      "evidence. Read a run's full output with check_output(run).",
    FORMAT[c.schema]!];
  if (c.textSchema) {
    parts.push(`Reply with only the JSON, no other text. Its JSON Schema: ${JSON.stringify(c.textSchema)}`);
  }
  return parts.join("\n\n");
}

/** Untrusted text (test output, agent text) reaches agents only as quoted data (ARCH 1.2, 10.3). */
export function quoted(text: string): string {
  // A backtick fence longer than any run of backticks inside, so nothing in the text can close it (CommonMark).
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}
