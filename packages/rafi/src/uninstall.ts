import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import type { InstallManifestEntryV1, UninstallProposal } from "rafi-spec";
import { assertLifecycleForCommand } from "./lifecycle.js";
import { INSTALL_MANIFEST, readInstallManifest, removeOwnedPathsTransaction, validateOwnedPath } from "./ownership.js";
import { readOnlyPermissionConfig, runRoleInstruction } from "ai-foreman/agent-run.js";

export type UninstallCategory = "tickets" | "plans" | "generated-agents" | "dependencies" | "modified-owned" | "core";
export interface UninstallChoice { category: UninstallCategory; remove: boolean }
export interface UninstallPlan {
  remove: Array<{ path: string; risk: "owned" | "modified-owned" | "uncertain"; kind: "file" | "directory" | "managed-block" }>;
  dependencies: string[];
  preserve: string[];
  warnings: string[];
  fingerprint: string;
}

export function buildUninstallPlan(projectDir: string, choices: UninstallChoice[], proposal?: UninstallProposal): UninstallPlan {
  const root = resolve(projectDir);
  const manifest = readInstallManifest(root);
  const enabled = new Set(choices.filter((choice) => choice.remove).map((choice) => choice.category));
  const remove: UninstallPlan["remove"] = [];
  const preserve: string[] = [];
  const warnings: string[] = [];
  const entries = manifest?.files ?? legacyEntries(root);
  for (const entry of entries) {
    const category = categoryFor(entry.path, entry);
    const current = fileFingerprint(join(root, entry.path));
    const modified = entry.sha256 !== null && current !== null && current !== entry.sha256;
    const risk = modified ? "modified-owned" : manifest ? "owned" : "uncertain";
    const shouldRemove = enabled.has(category) && risk !== "uncertain" && !(modified && category !== "modified-owned");
    if (shouldRemove) remove.push({ path: validateOwnedPath(root, entry.path), risk, kind: entry.mode === "managed-block" ? "managed-block" : "file" });
    else preserve.push(entry.path);
  }
  if (enabled.has("core")) {
    for (const path of ["rafi-config.yaml", ".tickets/config.yaml", ".foreman", ".rafi/compiled", INSTALL_MANIFEST]) {
      if (existsSync(join(root, path)) && !remove.some((item) => item.path === path)) remove.push({ path, risk: manifest ? "owned" : "uncertain", kind: path.includes(".") && !path.endsWith("compiled") && path !== ".foreman" ? "file" : "directory" });
    }
  }
  if (proposal) applyProposal(root, proposal, remove, preserve, warnings);
  const dependencies = enabled.has("dependencies") ? (manifest?.dependencies ?? []).filter((item) => item.previous === null || item.previous === undefined).map((item) => `${item.manager}:${item.package}`) : [];
  if (!manifest) warnings.push("Legacy installation: uncertain items are preserved unless explicitly and safely selected.");
  const normalizedRemove = dedupe(remove).sort((a, b) => a.path.localeCompare(b.path));
  const fingerprint = createHash("sha256").update(JSON.stringify({ remove: normalizedRemove, dependencies, config: fileFingerprint(join(root, "rafi-config.yaml")) })).digest("hex");
  return { remove: normalizedRemove, dependencies, preserve: [...new Set(preserve)].sort(), warnings, fingerprint };
}

export function buildUninstallCommand(opts: { interpret?: (projectDir: string, instruction: string) => Promise<UninstallProposal> }): Command {
  return new Command("uninstall")
    .description("Preview and safely remove selected project-local Rafi material.")
    .argument("[project]", "project directory", ".")
    .option("--dry-run", "show the final preview without writing transaction state or changing files")
    .action(async (project: string, commandOpts: { dryRun?: boolean }) => {
      const root = resolve(project);
      assertLifecycleForCommand(root, "uninstall");
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("rafi uninstall is an ordered interactive interview; use --dry-run in a TTY for a no-write preview");
      const manifest = readInstallManifest(root);
      const inventory = inventoryByCategory(root, manifest?.files ?? legacyEntries(root));
      const { confirm, text, isCancel } = await import("@clack/prompts");
      const questions: Array<{ category: UninstallCategory; message: string; initialValue: boolean }> = [
        { category: "tickets", message: formatQuestion("Remove tickets?", inventory.tickets), initialValue: false },
        { category: "plans", message: formatQuestion("Remove plans?", inventory.plans), initialValue: false },
        { category: "generated-agents", message: formatQuestion("Remove generated agents?", inventory["generated-agents"]), initialValue: true },
        { category: "dependencies", message: formatQuestion("Remove proven Rafi-only dependencies?", (manifest?.dependencies ?? []).map((item) => `${item.manager}:${item.package}`)), initialValue: true },
        { category: "modified-owned", message: formatQuestion("Remove modified Rafi-created files?", inventory["modified-owned"]), initialValue: false },
        { category: "core", message: formatQuestion("Remove core Rafi files and runtime state?", inventory.core), initialValue: true },
      ];
      const choices: UninstallChoice[] = [];
      for (const question of questions) {
        const answer = await confirm({ message: question.message, initialValue: question.initialValue });
        if (isCancel(answer)) { console.log("rafi uninstall: cancelled; no transaction was created"); return; }
        choices.push({ category: question.category, remove: Boolean(answer) });
      }
      const special = await text({ message: "Optional special instructions (blank uses only the choices above):", defaultValue: "" });
      if (isCancel(special)) { console.log("rafi uninstall: cancelled; no transaction was created"); return; }
      const instruction = String(special).trim();
      const proposal = instruction ? await requireInterpreter(opts.interpret, root, instruction) : undefined;
      const plan = buildUninstallPlan(root, choices, proposal);
      printPreview(root, plan);
      if (commandOpts.dryRun) { console.log("rafi uninstall: dry run complete; no bytes changed"); return; }
      const expected = buildUninstallPlan(root, choices, proposal).fingerprint;
      if (expected !== plan.fingerprint) throw new Error("project changed after preview; rerun uninstall");
      const final = await confirm({ message: `Permanently remove ${plan.remove.length} path(s) and ${plan.dependencies.length} dependency item(s) from ${root}?`, initialValue: false });
      if (isCancel(final) || !final) { console.log("rafi uninstall: cancelled; no transaction was created"); return; }
      const rechecked = buildUninstallPlan(root, choices, proposal);
      if (rechecked.fingerprint !== plan.fingerprint) throw new Error("project changed after preview; uninstall aborted");
      if (plan.dependencies.length) throw new Error(`dependency removal requires package-manager reconciliation before file removal: ${plan.dependencies.join(", ")}`);
      const result = removeOwnedPathsTransaction(root, plan.remove.map((item) => item.path));
      console.log(`rafi uninstall: removed ${result.removed.length} path(s); transaction journal ${join(".rafi-uninstall", result.runId, "journal.json")}`);
      if (plan.preserve.length) console.log(`rafi uninstall: preserved ${plan.preserve.join(", ")}`);
      console.log("rafi uninstall: local branches, commits, stashes, remotes, and remote PR/MR state were not changed.");
    });
}

export async function interpretUninstallInstruction(projectDir: string, instruction: string): Promise<UninstallProposal> {
  const prompt = `You are Rafi's read-only uninstaller interpreter. Inspect the project but do not mutate anything. Translate only the user's explicit instruction into JSON. Ambiguity must produce followUpQuestion instead of guessed targets.\n\nUser instruction:\n${instruction}\n\nReturn exactly one JSON object with: {"operations":[{"kind":"keep|delete|edit|remove-dependency","target":"repo-relative path or package","reason":"...","confidence":"high|medium|low"}],"followUpQuestion":"optional"}. Never target outside the repository, the repository root, remote state, or Git metadata.`;
  const run = await runRoleInstruction({
    projectDir,
    role: "uninstaller",
    instruction: prompt,
    label: "rafi uninstall special instructions",
    permissionConfig: readOnlyPermissionConfig(),
    sandboxMode: "read-only",
    logEvent: "uninstall-proposal",
  });
  if (run.turn.result.isError) throw new Error(`uninstaller agent failed: ${run.turn.result.text.slice(0, 300)}`);
  const match = run.turn.result.text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("uninstaller agent did not return a JSON proposal");
  const proposal = JSON.parse(match[0]) as UninstallProposal;
  if (!proposal || !Array.isArray(proposal.operations)) throw new Error("uninstaller agent returned an invalid proposal");
  return proposal;
}

function inventoryByCategory(root: string, entries: InstallManifestEntryV1[]): Record<UninstallCategory, string[]> {
  const output = { tickets: [], plans: [], "generated-agents": [], dependencies: [], "modified-owned": [], core: [] } as Record<UninstallCategory, string[]>;
  for (const entry of entries) output[categoryFor(entry.path, entry)].push(entry.path);
  for (const path of ["rafi-config.yaml", ".foreman", ".rafi/compiled", INSTALL_MANIFEST]) if (existsSync(join(root, path))) output.core.push(path);
  return output;
}

function categoryFor(path: string, entry: InstallManifestEntryV1): UninstallCategory {
  if (entry.mode === "modified") return "modified-owned";
  if (path.startsWith(".tickets/") && !path.endsWith("config.yaml")) return "tickets";
  if (/plans?|planning/i.test(path)) return "plans";
  if (entry.mode === "generated" || /(?:\.claude|\.codex|\.agents)\/(?:agents|skills)/.test(path)) return "generated-agents";
  return "core";
}

function legacyEntries(root: string): InstallManifestEntryV1[] {
  return ["rafi-config.yaml", "CLAUDE.md", "AGENTS.md", ".tickets/config.yaml", ".tickets/tickets.yaml"]
    .filter((path) => existsSync(join(root, path)))
    .map((path) => ({ path, sha256: null, mode: "created", origin: "legacy-detection" }));
}

function applyProposal(root: string, proposal: UninstallProposal, remove: UninstallPlan["remove"], preserve: string[], warnings: string[]): void {
  if (proposal.followUpQuestion) throw new Error(`special instructions are ambiguous: ${proposal.followUpQuestion}`);
  for (const operation of proposal.operations) {
    if (operation.kind === "remove-dependency") { warnings.push(`Agent-proposed dependency operation requires deterministic provenance: ${operation.target}`); continue; }
    const path = validateOwnedPath(root, operation.target);
    if (operation.kind === "keep") {
      for (let index = remove.length - 1; index >= 0; index--) if (remove[index]?.path === path) remove.splice(index, 1);
      preserve.push(path);
    } else if (operation.kind === "delete") {
      if (!existsSync(join(root, path))) throw new Error(`agent proposed missing target: ${path}`);
      remove.push({ path, risk: "uncertain", kind: statSync(join(root, path)).isDirectory() ? "directory" : "file" });
      warnings.push(`High-risk special-instruction target: ${path} (${operation.reason}; confidence ${operation.confidence})`);
    } else {
      throw new Error(`agent-proposed edits are not executable without a deterministic managed-block contract: ${path}`);
    }
  }
}

async function requireInterpreter(interpreter: ((projectDir: string, instruction: string) => Promise<UninstallProposal>) | undefined, root: string, instruction: string): Promise<UninstallProposal> {
  if (!interpreter) throw new Error("special instructions require the configured read-only uninstaller agent");
  return interpreter(root, instruction);
}

function printPreview(root: string, plan: UninstallPlan): void {
  console.log(`rafi uninstall preview — ${root}`);
  for (const item of plan.remove) console.log(`  D ${item.path} [${item.kind}; ${item.risk}]`);
  for (const dependency of plan.dependencies) console.log(`  - dependency ${dependency}`);
  for (const warning of plan.warnings) console.log(`  ! ${warning}`);
  if (!plan.remove.length && !plan.dependencies.length) console.log("  (nothing selected)");
}

function formatQuestion(label: string, paths: string[]): string {
  return `${label}\n${paths.length ? paths.map((path) => `  ${path}`).join("\n") : "  (none detected)"}`;
}

function fileFingerprint(path: string): string | null {
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function dedupe(items: UninstallPlan["remove"]): UninstallPlan["remove"] {
  return [...new Map(items.map((item) => [item.path, item])).values()];
}
