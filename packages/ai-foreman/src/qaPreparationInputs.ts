import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ContractInputRef, RequirementRef, StructuredPlanV1 } from "rafi-spec";
import type { TicketDef } from "./tickets/ticketSchema.js";
import { loadRafiConfigObject } from "./tickets/setupConfig.js";
import { canonicalJson } from "./qaProtocolV2.js";
import { createHash } from "node:crypto";
import { contractDigest } from "./qaVerificationContract.js";

/** Resolve the admitted slice's exact approved plan revision, never a newer latest file. */
export function admittedPlanInput(projectDir: string, ticket: TicketDef): { input: ContractInputRef; plan: StructuredPlanV1; requirements: RequirementRef[] } | undefined {
  if (!ticket.plan_ref) return undefined;
  const config = loadRafiConfigObject(projectDir);
  const docsRoot = (config?.docs as { root?: string } | undefined)?.root ?? "docs";
  if (docsRoot.startsWith("/") || docsRoot.split(/[\\/]/).includes("..")) throw new Error("Unsafe approved-plan document root");
  const history = join(projectDir, docsRoot, "rafi-plans");
  const files = [join(projectDir, docsRoot, "rafi-plan.json"), ...(existsSync(history) ? readdirSync(history).filter(name => name.endsWith(".json")).sort().reverse().slice(0, 1000).map(name => join(history, name)) : [])];
  for (const path of files) {
    if (!existsSync(path)) continue;
    let plan: StructuredPlanV1; try { plan = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    if (plan.plan_id !== ticket.plan_ref.plan_id || plan.revision !== ticket.plan_ref.revision) continue;
    if (plan.content_digest !== createHash("sha256").update(canonicalJson({ ...plan, content_digest: "" })).digest("hex")) throw new Error("Corrupt admitted approved-plan revision");
    const slice = plan.slices.find(row => row.slice_ref === ticket.plan_ref!.slice_ref);
    if (!slice) throw new Error("Admitted plan slice is absent from its exact approved revision");
    const input: ContractInputRef = { id: "approved-plan", kind: "plan", reference: path, digest: plan.content_digest, authority: "approved-scope", revision: String(plan.revision), availability: "available" };
    const requirements: RequirementRef[] = [];
    for (const [field, entries, location] of [["acceptance_criteria", plan.acceptance_criteria, ""], ["test_plan", plan.test_plan, ""], ["acceptance", slice.acceptance, `slices.${slice.slice_ref}.`], ["required_tests", slice.required_tests, `slices.${slice.slice_ref}.`]] as const) {
      const occurrences = new Map<string, number>();
      entries.forEach((statement, index) => {
        const fingerprint = contractDigest("plan-requirement", { field, statement }), occurrence = occurrences.get(fingerprint) ?? 0;
        occurrences.set(fingerprint, occurrence + 1);
        requirements.push({ id: `req-plan-${fingerprint.slice(0, 24)}-${occurrence}`, inputRef: input.id, locator: `${location}${field}[${index}]`, statement, digest: contractDigest("statement", statement), obligation: "mandatory", origin: "explicit", authority: "approved" });
      });
    }
    return { input, plan, requirements };
  }
  throw new Error("Exact admitted approved-plan revision unavailable; restore its immutable artifact before preparation");
}
