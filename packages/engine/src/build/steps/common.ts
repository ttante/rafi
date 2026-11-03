// Shared by the steps: a failed turn ends the step (ARCH 4.2 step.failed), and the requirements file's reading.
import { createHash } from "node:crypto";
import path from "node:path";
import type { TurnOutcome } from "../../turns/runner.js";
import { append, setting, type BuildContext } from "../context.js";

export async function failStep(ctx: BuildContext, ticket: string, out: Extract<TurnOutcome, { ok: false }>) {
  const reason = out.reason.split("\n")[0]!.slice(0, 300);
  await append(ctx, ticket, { type: "step.failed", data: { category: out.category, reason, circling: false } });
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
}

/** Reads back the requirements rafi rendered (6.3): `- **R1** text. Check: \`cmd\`, expect it to pass.` */
export function parseRequirements(markdown: string): Requirement[] {
  const out: Requirement[] = [];
  for (const line of markdown.split("\n")) {
    const m = /^- \*\*R(\d+)\*\* (.*)$/.exec(line);
    if (!m) continue;
    const check = /Check: `([^`]+)`/.exec(m[2]!);
    out.push({ n: Number(m[1]), text: m[2]!, check: check ? check[1]! : null });
  }
  return out;
}

export async function readRequirements(ctx: BuildContext, ticket: string) {
  const rel = requirementsPath(ctx, ticket);
  const file = path.join(ctx.project, rel);
  if (!(await ctx.deps.fs.stat(file))) return { path: null, fp: null, list: [] as Requirement[] };
  const text = await ctx.deps.fs.read(file);
  return { path: rel.split(path.sep).join("/"), fp: digest(text), list: parseRequirements(text) };
}

export function digest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
