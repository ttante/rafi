// The prepare step (ARCH 6.3, 4.2): QA writes the requirements' content; rafi checks each `check` (C43, P15),
// numbers them, renders the Markdown and records `requirements.written`.
import path from "node:path";
import type { RequirementsReply, TicketV1 } from "rafi-spec/v1";
import { prepareMessage } from "../../instructions/messages.js";
import { requirementCheckProblem } from "../../tools/session.js";
import { agentTurn, append, rulesFor, ticketOf, type BuildContext } from "../context.js";
import { digest, failStep, requirementsPath } from "./common.js";

function render(ticket: TicketV1, reply: RequirementsReply): string {
  const lines = [`<!-- rafi requirements v1 ticket=${ticket.id} depth=standard -->`, `# ${ticket.id}: ${ticket.title}`,
    "", "## Requirements"];
  reply.requirements.forEach((r, i) => {
    const check = r.check ? ` Check: \`${r.check}\`, expect it to pass.` : "";
    const marks = [`acceptance ${r.from}`, ...(ticket.person_only.includes(r.from) ? ["person-only"] : []),
      ...(ticket.locked.includes(r.from) ? ["locked"] : [])];
    lines.push(`- **R${i + 1}** ${r.text}${check} *(${marks.join("; ")})*`);
  });
  for (const [title, list] of [["In scope", reply.in_scope], ["Out of scope", reply.out_of_scope],
    ["Risks", reply.risks]] as const) {
    if (list.length) lines.push("", `## ${title}`, ...list.map((item) => `- ${item}`));
  }
  return `${lines.join("\n")}\n`;
}

export async function prepareStep(ctx: BuildContext, id: string, attempt: number, redo: boolean): Promise<void> {
  const ticket = ticketOf(ctx, id);
  await append(ctx, id, { type: "step.started", data: { step: "prepare", attempt } });
  const rules = rulesFor(ctx, []);
  const out = await agentTurn(ctx, { ticket: id, step: "prepare", role: "qa", reply: "requirements", attempt, redo,
    message: prepareMessage(ticket), validate: (value) => {
      const reply = value as RequirementsReply;
      const errors = reply.requirements.filter((r) => r.from > ticket.acceptance.length)
        .map((r) => `requirement "${r.text}" cites acceptance criterion ${r.from}, which doesn't exist`);
      for (const r of reply.requirements) {
        const problem = r.check ? requirementCheckProblem(r.check, rules) : null;
        if (problem) errors.push(problem);
      }
      return errors;
    } });
  if (!out.ok) return failStep(ctx, id, out);
  const reply = out.value as RequirementsReply;
  const markdown = render(ticket, reply);
  const rel = requirementsPath(ctx, id);
  ctx.deps.hooks.crash(`7: writing the requirements file (${id})`);
  await ctx.deps.fs.writeAtomic(path.join(ctx.project, rel), markdown);
  const personOnly = reply.requirements.flatMap((r, i) => (ticket.person_only.includes(r.from) ? [i + 1] : []));
  await append(ctx, id, { type: "requirements.written", data: { path: rel.split(path.sep).join("/"),
    fp: digest(markdown), depth: "standard", depth_raised_from: null, count: reply.requirements.length,
    person_only: personOnly } });
}
