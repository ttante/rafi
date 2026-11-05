// Shared by the steps: a failed turn ends the step (ARCH 4.2 step.failed); the requirements file's reading lives
// in facts/requirements.ts (M5 C180) and is re-exported here.
import type { TurnOutcome } from "../../turns/runner.js";
import { append, type BuildContext } from "../context.js";

import { digest, parseRequirements, type Requirements } from "../../facts/requirements.js";

export * from "../../facts/requirements.js";

export async function failStep(ctx: BuildContext, ticket: string, out: Extract<TurnOutcome, { ok: false }>) {
  const reason = out.reason.split("\n")[0]!.slice(0, 300);
  await append(ctx, ticket, { type: "step.failed", data: { category: out.category, reason,
    circling: Boolean(out.circling) } });
  ctx.ui.line(`${ticket} stopped after ${out.attempts} ${out.attempts === 1 ? "try" : "tries"}: ${reason} ` +
    `(${out.category}). Other tickets go on; run \`rafi resume\` to try ${ticket} again.`);
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
