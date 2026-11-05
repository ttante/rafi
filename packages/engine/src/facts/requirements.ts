// The requirements file's reading (6.3, C114–C116), moved from build/steps/common.ts (M5 C180's optional move):
// rafi's record of what it wrote, the file as it is now, and the checks rafi trusts from it.
import { createHash } from "node:crypto";
import path from "node:path";
import { setting, type BuildContext } from "../build/context.js";

export function requirementsPath(ctx: BuildContext, ticket: string): string {
  return path.join(setting<string>(ctx, "docs.root"), "requirements", `${ticket}.md`);
}

export interface Requirement {
  readonly n: number;
  readonly text: string;
  readonly check: string | null;
  /** The rendered line, as its `req_fps` digest covers it (C114). */
  readonly line: string;
}

const REQUIREMENT = /^- \*\*R(\d+)\*\* (.*)$/;

/** The rendered requirement lines, in file order (C114: each one's digest goes in `req_fps`). */
export function requirementLines(markdown: string): string[] {
  return markdown.split("\n").filter((line) => REQUIREMENT.test(line));
}

/** Reads back the requirements rafi rendered (6.3): `- **R1** text. Check: \`cmd\`, expect it to pass.` */
export function parseRequirements(markdown: string): Requirement[] {
  const out: Requirement[] = [];
  for (const line of markdown.split("\n")) {
    const m = REQUIREMENT.exec(line);
    if (!m) continue;
    const check = /Check: `([^`]+)`/.exec(m[2]!);
    out.push({ n: Number(m[1]), text: m[2]!, check: check ? check[1]! : null, line });
  }
  return out;
}

/** What rafi recorded when it wrote the file (requirements.written v 2). */
export interface Written {
  readonly path: string;
  readonly fp: string;
  readonly depth: string;
  readonly count: number;
  readonly person_only: readonly number[];
  readonly req_fps: readonly string[];
}

export interface Requirements {
  /** Rafi's own stored path (never one an agent wrote), or null when there's no requirements file. */
  readonly path: string | null;
  /** The file's text now, or null when it's missing or unreadable. */
  readonly text: string | null;
  readonly fp: string | null;
  readonly list: Requirement[];
  readonly written: Written | null;
  readonly status: "delivered" | "changed" | "missing" | "unreadable" | null;
}

export async function writtenOf(ctx: BuildContext, ticket: string): Promise<Written | null> {
  let last: Written | null = null;
  for await (const e of ctx.engine.events()) {
    if (e.ticket_id === ticket && e.type === "requirements.written") last = e.data as Written;
  }
  return last;
}

/** The requirements file as it is now, against what rafi recorded when it wrote it (NEW-REQ-5, C115). */
export async function readRequirements(ctx: BuildContext, ticket: string): Promise<Requirements> {
  const written = await writtenOf(ctx, ticket);
  const rel = (written?.path ?? requirementsPath(ctx, ticket)).split(path.sep).join("/");
  const file = path.join(ctx.project, rel);
  let text: string | null = null;
  let unreadable = false;
  if (await ctx.deps.fs.stat(file)) {
    try { text = await ctx.deps.fs.read(file); } catch { unreadable = true; }
  }
  if (text === null && !written) return { path: null, text: null, fp: null, list: [], written: null, status: null };
  const fp = text === null ? null : digest(text);
  const status = !written ? null : unreadable ? "unreadable" : text === null ? "missing"
    : fp === written.fp ? "delivered" : "changed";
  return { path: rel, text, fp: written?.fp ?? fp, list: text === null ? [] : parseRequirements(text), written,
    status };
}

export function digest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
