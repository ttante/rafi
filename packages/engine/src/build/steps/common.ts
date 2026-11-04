// Shared by the steps: a failed turn ends the step (ARCH 4.2 step.failed), and the requirements file's reading.
import { createHash } from "node:crypto";
import path from "node:path";
import type { TurnOutcome } from "../../turns/runner.js";
import { append, setting, type BuildContext } from "../context.js";

export async function failStep(ctx: BuildContext, ticket: string, out: Extract<TurnOutcome, { ok: false }>) {
  const reason = out.reason.split("\n")[0]!.slice(0, 300);
  await append(ctx, ticket, { type: "step.failed", data: { category: out.category, reason,
    circling: Boolean(out.circling) } });
  ctx.ui.line(`${ticket} stopped after ${out.attempts} ${out.attempts === 1 ? "try" : "tries"}: ${reason} ` +
    `(${out.category}). Other tickets go on; run \`rafi resume\` to try ${ticket} again.`);
}

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

/** C116: the requirement checks whose rendered line is byte for byte the one rafi wrote (its `req_fps` digest). */
export function trustedChecks(markdown: string | null, reqFps: readonly string[]): { req: number; command: string }[] {
  if (markdown === null) return [];
  const list = parseRequirements(markdown);
  return list.filter((r) => r.check && list.filter((x) => x.n === r.n).length === 1 &&
    reqFps[r.n - 1] === digest(r.line)).map((r) => ({ req: r.n, command: r.check! }));
}

/** C115: the requirements a changed or missing file affects: any whose line isn't exactly once as rafi wrote it. */
export function affectedRequirements(markdown: string | null, reqFps: readonly string[]): number[] {
  const list = markdown === null ? [] : parseRequirements(markdown);
  return reqFps.map((fp, i) => i + 1).filter((n) => {
    const lines = list.filter((r) => r.n === n);
    return lines.length !== 1 || digest(lines[0]!.line) !== reqFps[n - 1];
  });
}

/** The checks rafi trusts for a ticket now (C116): none without rafi's record or the file. */
export function trustedOf(reqs: Requirements): { req: number; command: string }[] {
  return reqs.written ? trustedChecks(reqs.text, reqs.written.req_fps) : [];
}

export function digest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
