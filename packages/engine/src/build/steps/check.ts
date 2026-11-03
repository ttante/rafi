// The check step (ARCH 4.2, 6.9): rafi runs the checks, no agent. With QA on, the requirements' checks; with QA
// off (no requirements file), the ticket's required_tests plus the tests related to its changed files. A failure
// goes straight back to the builder (fixing·fix); a too-slow run blocks only this ticket (C59).
import { splitCommand } from "../../agents/shellForms.js";
import { snapshot } from "../../facts/snapshot.js";
import { checkStep, relatedTests, type CheckEnv } from "../checks.js";
import { append, checkEnvFor, rulesFor, setting, ticketOf, type BuildContext } from "../context.js";
import { readRequirements } from "./common.js";

async function relatedChecks(env: CheckEnv, files: readonly string[]): Promise<string[]> {
  return ((await relatedTests(env, files)) ?? []).map((f) => `${env.runner!.join(" ")} ${f}`);
}

export async function checkNode(ctx: BuildContext, id: string, attempt: number): Promise<void> {
  const ticket = ticketOf(ctx, id);
  await append(ctx, id, { type: "step.started", data: { step: "check", attempt } });
  const env = checkEnvFor(ctx, id);
  const reqs = await readRequirements(ctx, id);
  let checks: { req: number; command: string }[];
  if (setting<boolean>(ctx, "harness.qa") && reqs.path) {
    checks = reqs.list.flatMap((r) => (r.check ? [{ req: r.n, command: r.check }] : []));
  } else {
    const snap = await snapshot(ctx.deps, ctx.project, `${id}-related`);
    const related = await relatedChecks(env, snap.ok ? snap.files : []);
    const own = ticket.required_tests;
    const files = new Set(own.flatMap((c) => { const s = splitCommand(c); return s.ok ? s.argv.slice(-1) : []; }));
    checks = [...own, ...related.filter((c) => !files.has(c.split(" ").at(-1)!))]
      .map((command, i) => ({ req: i + 1, command }));
  }
  const result = await checkStep(env, checks, rulesFor(ctx, []));
  if (result.outcome === "passed") {
    await append(ctx, id, { type: "checks.passed", data: { runs: result.runs, reused: result.reused } });
  } else if (result.outcome === "failed") {
    const signature = result.failing.map((f) => `R${f.req}`).join(",");
    await append(ctx, id, { type: "checks.failed", data: { failing: result.failing, signature, circling: false } });
  } else {
    const slow = result.records.find((r) => r.outcome === "too-slow");
    const limit = setting<number>(ctx, "timeouts.check_minutes");
    const reason = `\`${slow?.command}\` was still running at the ${limit}-minute test limit`;
    await append(ctx, id, { type: "ticket.blocked", data: { kind: "limit", reason, question: null, waits: [] } });
    ctx.ui.line(`${id} is waiting: ${reason}. The time-limit question comes in a later version; raise ` +
      "timeouts.check_minutes in rafi-config.yaml and run `rafi resume`.");
  }
}
