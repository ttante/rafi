// The check step (ARCH 4.2, 6.9): rafi runs the checks, no agent: the requirements' trusted checks (C116), then the
// ticket's required_tests and the tests related to its changed files (C117; all of it with QA off). A failure
// goes straight back to the builder (fixing·fix); a too-slow run blocks only this ticket (C59).
import { splitCommand } from "../../agents/shellForms.js";
import { snapshot } from "../../facts/snapshot.js";
import { checkStep, relatedTests, type CheckEnv } from "../checks.js";
import { checksSignature } from "../../turns/circling.js";
import {
  allEvents, append, checkEnvFor, rulesFor, setting, ticketOf, ticketRuns, type BuildContext,
} from "../context.js";
import { circlingNow, type LogEvent } from "./history.js";
import { readRequirements, trustedOf } from "./common.js";

async function relatedChecks(env: CheckEnv, files: readonly string[]): Promise<string[]> {
  return ((await relatedTests(env, files)) ?? []).map((f) => `${env.runner!.join(" ")} ${f}`);
}

const fileOf = (command: string) => { const s = splitCommand(command); return s.ok ? s.argv.at(-1) ?? "" : command; };

/** One run per test file, the first one listed kept. */
function dedupe(checks: readonly { req: number; command: string }[]): { req: number; command: string }[] {
  const seen = new Set<string>();
  return checks.filter((c) => !seen.has(fileOf(c.command)) && Boolean(seen.add(fileOf(c.command))));
}

/** The ticket's required_tests and the runner's related tests for its changed files. */
async function ownChecks(ctx: BuildContext, id: string, env: CheckEnv): Promise<string[]> {
  const snap = await snapshot(ctx.deps, ctx.project, `${id}-related`);
  return [...ticketOf(ctx, id).required_tests, ...await relatedChecks(env, snap.ok ? snap.files : [])];
}

export async function checkNode(ctx: BuildContext, id: string, attempt: number): Promise<void> {
  await append(ctx, id, { type: "step.started", data: { step: "check", attempt } });
  const env = checkEnvFor(ctx, id);
  const reqs = await readRequirements(ctx, id);
  const own = await ownChecks(ctx, id, env);
  // C116: only checks from requirement lines unchanged since rafi wrote them; with the file missing or unreadable,
  // the ticket's required_tests and related tests, as with QA off. C117: with QA on, those too, after the
  // requirements' checks, one run per test file.
  const qa = setting<boolean>(ctx, "harness.qa") && reqs.written !== null && reqs.text !== null;
  const trusted = qa ? trustedOf(reqs) : [];
  const first = trusted.length ? Math.max(...trusted.map((c) => c.req), reqs.written?.count ?? 0) : 0;
  const checks = dedupe([...trusted, ...own.map((command, i) => ({ req: first + i + 1, command }))]);
  const result = await checkStep(env, checks, rulesFor(ctx, []));
  if (result.outcome === "passed") {
    await append(ctx, id, { type: "checks.passed", data: { runs: result.runs, reused: result.reused } });
  } else if (result.outcome === "failed") {
    const runs = await ticketRuns(ctx, id);
    const signature = checksSignature(result.failing.map((f) => ({ ...f, tests: (runs.find((r) => r.run === f.run)
      ?.tests ?? []).filter((t) => t.outcome !== "passed").map((t) => t.name) })));
    const circling = circlingNow(await allEvents(ctx.engine) as LogEvent[], id, signature, attempt,
      setting<number>(ctx, "retries.circling_repeats"));
    await append(ctx, id, { type: "checks.failed", data: { failing: result.failing, signature, circling } });
  } else {
    const slow = result.records.find((r) => r.outcome === "too-slow");
    const limit = setting<number>(ctx, "timeouts.check_minutes");
    const reason = `\`${slow?.command}\` was still running at the ${limit}-minute test limit`;
    await append(ctx, id, { type: "ticket.blocked", data: { kind: "limit", reason, question: null, waits: [] } });
    ctx.ui.line(`${id} is waiting: ${reason}. The time-limit question comes in a later version; raise ` +
      "timeouts.check_minutes in rafi-config.yaml and run `rafi resume`.");
  }
}
