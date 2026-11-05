// The prepare step (ARCH 6.3, 4.2): QA writes the requirements' content; rafi checks each `check` (C43, P15),
// numbers them, renders the Markdown and records `requirements.written`.
import path from "node:path";
import type { RequirementsReply, TicketV1 } from "rafi-spec/v1";
import { boundary } from "../../deps/hooks.js";
import { prepareMessage } from "../../instructions/messages.js";
import { fixedTags } from "../../instructions/packs.js";
import { addQaTags, tagPatterns } from "../../instructions/tags.js";
import { requirementCheckProblem } from "../../tools/session.js";
import { append, rulesFor, ticketOf, type BuildContext } from "../context.js";
import { agentTurn } from "../../turns/agent.js";
import { depthFor } from "../depth.js";
import { digest, failStep, requirementLines, requirementsPath } from "./common.js";

/** ARCH 6.3's rendering; every section is always there, "- None listed." when empty (C126). */
function render(ticket: TicketV1, reply: RequirementsReply, depth: string): string {
  const lines = [`<!-- rafi requirements v1 ticket=${ticket.id} depth=${depth} -->`, `# ${ticket.id}: ${ticket.title}`,
    "", "## Requirements"];
  reply.requirements.forEach((r, i) => {
    const check = r.check ? ` Check: \`${r.check}\`, expect it to pass.` : "";
    const marks = [`acceptance ${r.from}`, ...(ticket.person_only.includes(r.from) ? ["person-only"] : []),
      ...(ticket.locked.includes(r.from) ? ["locked"] : [])];
    lines.push(`- **R${i + 1}** ${r.text}${check} *(${marks.join("; ")})*`);
  });
  const acceptance = ticket.acceptance.map((a, i) => `Acceptance ${i + 1}: ${a}`);
  for (const [title, list] of [["Acceptance criteria", acceptance], ["In scope", reply.in_scope],
    ["Out of scope", reply.out_of_scope], ["Risks", reply.risks]] as const) {
    lines.push("", `## ${title}`, ...(list.length ? list.map((item) => `- ${item}`) : ["- None listed."]));
  }
  return `${lines.join("\n")}\n`;
}

export async function prepareStep(ctx: BuildContext, id: string, attempt: number, redo: boolean): Promise<void> {
  const ticket = ticketOf(ctx, id);
  await append(ctx, id, { type: "step.started", data: { step: "prepare", attempt } });
  const rules = rulesFor(ctx, []);
  const depth = depthFor(ticket);
  const rel = requirementsPath(ctx, id).split(path.sep).join("/");
  const out = await agentTurn(ctx, { ticket: id, step: "prepare", role: "qa", reply: "requirements", attempt, redo,
    message: prepareMessage(ticket, { ...depth, path: rel }), validate: (value) => {
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
  await addQaTags(ctx.engine, ctx.run, ticket, reply.add_tags, tagPatterns(ctx.settings, await fixedTags(ctx.deps.fs)),
    (text) => ctx.ui.line(text));
  const markdown = render(ticket, reply, depth.depth);
  await boundary(ctx.deps.hooks, `7: writing the requirements file (${id})`);
  await ctx.deps.fs.writeAtomic(path.join(ctx.project, rel), markdown);
  const personOnly = reply.requirements.flatMap((r, i) => (ticket.person_only.includes(r.from) ? [i + 1] : []));
  await append(ctx, id, { type: "requirements.written", data: { path: rel,
    fp: digest(markdown), depth: depth.depth, depth_raised_from: depth.raisedFrom, count: reply.requirements.length,
    person_only: personOnly, req_fps: requirementLines(markdown).map(digest) } });
}
