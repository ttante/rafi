import type { BranchPlanNode } from "../branch/types.js";
import { branchNodeFooter } from "../branch/presentation.js";
import { loadTicketSetupConfigWithDefaults, type TicketBuildSetupConfig } from "./setupConfig.js";
import type { TicketDef } from "./ticketSchema.js";

export function configuredReviewTitle(projectDir: string, ticket: TicketDef): string {
  const build = loadTicketSetupConfigWithDefaults(projectDir).build;
  return renderReviewTitle(build, ticket);
}

export function renderReviewTitle(build: TicketBuildSetupConfig, ticket: TicketDef): string {
  const standard = build.review;
  if (standard.title_style === "ticket-title") return `${ticket.id}: ${ticket.title}`;
  if (standard.title_style === "conventional") return `feat(${ticket.area.toLowerCase().replace(/[^a-z0-9]+/g, "-")}): ${ticket.title}`;
  if (standard.title_style === "custom" && standard.title_template) return interpolate(standard.title_template, ticket);
  return ticket.title;
}

export function configuredReviewBody(projectDir: string, node: BranchPlanNode, qaEvidence?: string, commit?: string): string {
  const build = loadTicketSetupConfigWithDefaults(projectDir).build;
  return renderReviewBody(build, node, qaEvidence, commit);
}

export function renderReviewBody(build: TicketBuildSetupConfig, node: BranchPlanNode, qaEvidence?: string, commit?: string): string {
  const ticket = node.ticket;
  const sections = build.review.description_sections.flatMap((section) => {
    const key = section.toLowerCase();
    let body: string[];
    if (key === "summary") body = [ticket.summary];
    else if (key === "linked ticket") body = [`${ticket.id}: ${ticket.title}`];
    else if (key === "changes made") body = ticket.likely_files.length ? ticket.likely_files.map((path) => `- ${path}`) : ["- See branch diff."];
    else if (key === "tests and validation performed") body = [...ticket.required_tests.map((test) => `- ${test}`), `- Evidence: ${qaEvidence ?? "Foreman QA emitted qa_pass."}`];
    else if (key === "risks or rollback notes") body = [`- Risk: ${ticket.risk}`, `- Rollback: ${ticket.rollback ?? "Revert the review commit."}`];
    else if (key === "checklist") body = build.validation_checklist.map((item) => `- [ ] ${item}`);
    else body = ["_Complete before review._"];
    return [`## ${section}`, "", ...body, ""];
  });
  return [
    ...sections,
    "## Branch Metadata", "",
    `- Base: ${node.baseBranch}`, `- Head: ${node.branch}`,
    `- Dependencies: ${node.dependencies.length ? node.dependencies.join(", ") : "None"}`,
    `- Commit: ${commit ?? "N/A"}`, "",
    branchNodeFooter(node), "",
  ].join("\n");
}

function interpolate(template: string, ticket: TicketDef): string {
  return template.replaceAll("{id}", ticket.id).replaceAll("{title}", ticket.title).replaceAll("{area}", ticket.area);
}
