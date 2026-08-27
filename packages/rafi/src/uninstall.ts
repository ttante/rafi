import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import type { InstallManifestEntryV2, UninstallProposal } from "rafi-spec";
import { assertLifecycleForCommand } from "./lifecycle.js";
import { cleanupUninstallRecovery, INSTALL_MANIFEST, listUninstallRecoveries, preservePreimagesForLaterRestore, readInstallManifest, removeManagedBlocksTransaction, removeOwnedPathsTransaction, restoreOwnedPreimagesTransaction, restoreUninstallRecovery, validateOwnedPath } from "./ownership.js";
import { readOnlyPermissionConfig, runRoleInstruction } from "ai-foreman/agent-run.js";
import { WorkflowDb, type ProjectLease } from "ai-foreman/workflow-db.js";

export type UninstallCategory = "tickets" | "plans" | "skills" | "agents" | "rules" | "documentation-created" | "documentation-modified" | "managed-gitignore" | "config" | "runtime-state" | "generated-other" | "dependencies" | "core" | "generated-agents" | "modified-owned";
export type UninstallFileAction = "remove" | "remove-managed" | "restore" | "keep";
export interface UninstallChoice { category: UninstallCategory; remove?: boolean; action?: "remove" | "keep" | "restore"; paths?: string[]; fileActions?: Record<string, UninstallFileAction> }
export interface UninstallPlan {
  remove: Array<{ path: string; risk: "owned" | "modified-owned" | "uncertain"; kind: "file" | "directory" | "managed-block" }>;
  dependencies: string[];
  preserve: string[];
  restore: string[];
  laterRestore: string[];
  warnings: string[];
  fingerprint: string;
}

export function buildUninstallPlan(projectDir: string, choices: UninstallChoice[], proposal?: UninstallProposal): UninstallPlan {
  const root = resolve(projectDir);
  const manifest = readInstallManifest(root);
  const enabled = new Set(choices.filter((choice) => choice.remove || choice.action === "remove").map((choice) => choice.category));
  const restoreCategories = new Set(choices.filter((choice) => choice.action === "restore").map((choice) => choice.category));
  const selectedPaths = new Map(choices.filter((choice) => choice.paths).map((choice) => [choice.category, new Set(choice.paths)]));
  const remove: UninstallPlan["remove"] = [];
  const preserve: string[] = [];
  const warnings: string[] = [];
  const restore: string[] = [];
  const laterRestore: string[] = [];
  const entries = manifest?.files ?? legacyEntries(root);
  for (const entry of entries) {
    const category = categoryFor(entry.path, entry);
    const current = fileFingerprint(join(root, entry.path));
    const modified = entry.sha256 !== null && current !== null && current !== entry.sha256;
    const risk = modified ? "modified-owned" : manifest ? "owned" : "uncertain";
    const selected = !selectedPaths.has(category) || selectedPaths.get(category)!.has(entry.path);
    const fileAction = choices.find((choice) => choice.category === category)?.fileActions?.[entry.path];
    if (fileAction === "keep") {
      preserve.push(entry.path);
      if (category === "documentation-modified" && entry.backup) laterRestore.push(entry.path);
      continue;
    }
    if (fileAction === "restore") {
      if (entry.backup) restore.push(entry.path);
      else remove.push({ path: validateOwnedPath(root, entry.path), risk, kind: "file" });
      continue;
    }
    if (fileAction === "remove-managed") {
      if (entry.mode !== "managed-block" || !entry.marker) throw new Error(`managed-section removal is not available for ${entry.path}`);
      remove.push({ path: validateOwnedPath(root, entry.path), risk, kind: "managed-block" });
      continue;
    }
    if (fileAction === "remove") {
      remove.push({ path: validateOwnedPath(root, entry.path), risk, kind: entry.mode === "managed-block" ? "managed-block" : "file" });
      continue;
    }
    if (restoreCategories.has(category) && selected) { restore.push(entry.path); continue; }
    const shouldRemove = enabled.has(category) && selected && risk !== "uncertain" && !(modified && category !== "modified-owned" && category !== "documentation-modified");
    if (shouldRemove) remove.push({ path: validateOwnedPath(root, entry.path), risk, kind: entry.mode === "managed-block" ? "managed-block" : "file" });
    else {
      preserve.push(entry.path);
      if (category === "documentation-modified" && entry.backup) laterRestore.push(entry.path);
    }
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
  const fingerprint = createHash("sha256").update(JSON.stringify({
    remove: normalizedRemove,
    restore: [...restore].sort(),
    laterRestore: [...laterRestore].sort(),
    dependencies,
    current: entries.map((entry) => [entry.path, fileFingerprint(join(root, entry.path))]),
  })).digest("hex");
  return { remove: normalizedRemove, dependencies, preserve: [...new Set(preserve)].sort(), restore: [...new Set(restore)].sort(), laterRestore: [...new Set(laterRestore)].sort(), warnings, fingerprint };
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
      const { confirm, text, select, isCancel } = await import("@clack/prompts");
      const questions: Array<{ category: UninstallCategory; label: string; initial: "remove" | "keep" | "restore" }> = [
        { category: "skills", label: "Rafi-added skills", initial: "remove" },
        { category: "agents", label: "Rafi-added agents", initial: "remove" },
        { category: "rules", label: "Rafi-added rules", initial: "remove" },
        { category: "documentation-created", label: "documentation Rafi created", initial: "keep" },
        { category: "documentation-modified", label: "pre-existing documentation Rafi modified", initial: "keep" },
        { category: "tickets", label: "tickets", initial: "keep" },
        { category: "plans", label: "plans", initial: "keep" },
        { category: "managed-gitignore", label: "managed .gitignore sections", initial: "remove" },
        { category: "config", label: "configuration", initial: "remove" },
        { category: "runtime-state", label: "runtime state", initial: "remove" },
        { category: "generated-other", label: "other generated artifacts", initial: "remove" },
      ];
      const choices: UninstallChoice[] = [];
      const entriesByPath = new Map((manifest?.files ?? []).map((entry) => [entry.path, entry]));
      for (const question of questions) {
        const paths = inventory[question.category] ?? [];
        if (!paths.length) continue;
        const modifiedDocs = question.category === "documentation-modified";
        const answer = await select({ message: formatQuestion(`What should happen to ${question.label}?`, paths), initialValue: question.initial, options: [
          { value: modifiedDocs ? "restore" : "remove", label: modifiedDocs ? "Restore all pre-Rafi versions" : "Remove all" },
          { value: "keep", label: "Keep all" },
          { value: "individual", label: "Choose individually" },
        ] });
        if (isCancel(answer)) { console.log("rafi uninstall: cancelled; no transaction was created"); return; }
        const fileActions: Record<string, UninstallFileAction> = {};
        if (answer === "individual") {
          const selectedPaths: string[] = [];
          for (const path of paths) {
            const entry = entriesByPath.get(path);
            if (entry && isPostInstallModified(root, entry)) {
              const picked = await promptModifiedFileAction(root, entry, select, isCancel);
              if (!picked) { console.log("rafi uninstall: cancelled; no transaction was created"); return; }
              fileActions[path] = picked;
              selectedPaths.push(path);
            } else {
              const picked = await confirm({ message: `${modifiedDocs ? "Restore" : "Remove"} ${path}?`, initialValue: false });
              if (isCancel(picked)) { console.log("rafi uninstall: cancelled; no transaction was created"); return; }
              if (picked) selectedPaths.push(path);
            }
          }
          choices.push({ category: question.category, action: modifiedDocs ? "restore" : "remove", paths: selectedPaths, fileActions });
        } else {
          for (const path of paths) {
            const entry = entriesByPath.get(path);
            if (!entry || !isPostInstallModified(root, entry)) continue;
            console.log(`rafi uninstall: ${path} contains changes made after Rafi's last write; choose explicitly so user edits are never inferred away.`);
            const picked = await promptModifiedFileAction(root, entry, select, isCancel);
            if (!picked) { console.log("rafi uninstall: cancelled; no transaction was created"); return; }
            fileActions[path] = picked;
          }
          choices.push({ category: question.category, action: answer as "remove" | "keep" | "restore", fileActions });
        }
      }
      if ((manifest?.dependencies ?? []).length) {
        const answer = await confirm({ message: formatQuestion("Remove proven Rafi-only dependencies?", manifest!.dependencies.map((item) => `${item.manager}:${item.package}`)), initialValue: true });
        if (isCancel(answer)) return; choices.push({ category: "dependencies", remove: Boolean(answer) });
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
      const final = await confirm({ message: `Move ${plan.remove.length} path(s) into durable recovery and restore ${plan.restore.length} preimage(s) in ${root}?`, initialValue: false });
      if (isCancel(final) || !final) { console.log("rafi uninstall: cancelled; no transaction was created"); return; }
      const workflow = new WorkflowDb(root); const run = workflow.createRun({ kind: "uninstall", checkpoint: "before-recheck", originalWork: { remove: plan.remove, dependencies: plan.dependencies }, state: { fingerprint: plan.fingerprint } });
      let lease: ProjectLease | undefined;
      try {
        lease = workflow.acquireLease(run.runId);
        const rechecked = buildUninstallPlan(root, choices, proposal);
        if (rechecked.fingerprint !== plan.fingerprint) throw new Error("project changed after preview; uninstall aborted");
        if (plan.dependencies.length) throw new Error(`dependency removal requires package-manager reconciliation before file removal: ${plan.dependencies.join(", ")}`);
        workflow.transition(run.runId, { checkpoint: "before-local-transaction", event: "uninstall_intent" });
        const managedPaths = new Set(plan.remove.filter((item) => item.kind === "managed-block").map((item) => item.path));
        const managedEntries = (manifest?.files ?? []).filter((entry) => managedPaths.has(entry.path));
        const managed = managedEntries.length ? removeManagedBlocksTransaction(root, managedEntries) : undefined;
        const result = removeOwnedPathsTransaction(root, plan.remove.filter((item) => item.kind !== "managed-block").map((item) => item.path));
        const restoreEntries = (manifest?.files ?? []).filter((entry) => plan.restore.includes(entry.path));
        const restored = restoreEntries.length ? restoreOwnedPreimagesTransaction(root, restoreEntries) : undefined;
        const keptEntries = (manifest?.files ?? []).filter((entry) => plan.laterRestore.includes(entry.path));
        const later = preservePreimagesForLaterRestore(root, keptEntries);
        workflow.transition(run.runId, { status: "completed", checkpoint: "uninstall-committed", remainingWork: {}, state: { fingerprint: plan.fingerprint, transactionRunId: result.runId, removed: result.removed, managedRecoveryId: managed?.recoveryId, managedEdited: managed?.edited, restoreRunId: restored?.runId, restored: restored?.restored, laterRestoreId: later?.recoveryId, laterRestorePaths: later?.preserved } });
        console.log(`rafi uninstall: preserved ${result.removed.length} removed path(s) in recovery ${result.recoveryId}`);
        if (restored) console.log(`rafi uninstall: restored ${restored.restored.length} pre-Rafi file(s); displaced current versions are in recovery ${restored.recoveryId}`);
        if (later) for (const path of later.preserved) console.log(`rafi uninstall: kept ${path}; restore its pre-Rafi version later with \`rafi uninstall:restore ${later.recoveryId} --path ${shellQuote(path)} --yes\``);
        if (plan.preserve.length) console.log(`rafi uninstall: preserved ${plan.preserve.join(", ")}`);
        console.log("rafi uninstall: local branches, commits, stashes, remotes, and remote PR/MR state were not changed.");
      } catch (error) {
        workflow.transition(run.runId, { status: "failed", checkpoint: "uninstall-failed", state: { fingerprint: plan.fingerprint, error: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000) } });
        throw error;
      } finally { if (lease) workflow.releaseLease(lease); workflow.close(); }
    });
}

export function buildUninstallRestoreCommand(): Command {
  return new Command("uninstall:restore")
    .description("Restore files from an indefinite project-local uninstall recovery bundle.")
    .argument("<recoveryId>", "recovery bundle ID")
    .argument("[project]", "project directory", ".")
    .option("--path <paths...>", "restore only selected repository-relative paths")
    .option("--yes", "confirm restoration and collision backups")
    .action(async (recoveryId: string, project: string, opts: { path?: string[]; yes?: boolean }) => {
      const root = resolve(project); assertLifecycleForCommand(root, "uninstall-recovery");
      const preview = restoreUninstallRecovery(root, recoveryId, opts.path, false);
      console.log(`rafi uninstall:restore preview — ${recoveryId}`);
      if (preview.collisions.length) console.log(`  collisions (will be backed up): ${preview.collisions.join(", ")}`);
      if (!opts.yes) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("pass --yes outside an interactive terminal");
        const { confirm, isCancel } = await import("@clack/prompts"); const answer = await confirm({ message: "Restore these paths?", initialValue: false }); if (isCancel(answer) || !answer) return;
      }
      const result = restoreUninstallRecovery(root, recoveryId, opts.path, true);
      console.log(`rafi uninstall:restore: restored ${result.restored.join(", ") || "nothing"}${result.backupId ? `; displaced files backed up in ${result.backupId}` : ""}`);
    });
}

export function buildUninstallCleanupCommand(): Command {
  return new Command("uninstall:cleanup")
    .description("Permanently remove selected uninstall recovery bundles.")
    .argument("[recoveryId]", "one recovery ID")
    .argument("[project]", "project directory", ".")
    .option("--all", "remove every recovery bundle")
    .option("--yes", "confirm permanent removal")
    .action(async (recoveryId: string | undefined, project: string, opts: { all?: boolean; yes?: boolean }) => {
      const root = resolve(project); assertLifecycleForCommand(root, "uninstall-recovery");
      if (Boolean(recoveryId) === Boolean(opts.all)) throw new Error("provide one recoveryId or --all");
      const ids = opts.all ? listUninstallRecoveries(root) : [recoveryId!];
      console.log(`rafi uninstall:cleanup preview — permanently remove ${ids.join(", ") || "nothing"}`);
      if (!ids.length) return;
      if (!opts.yes) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("pass --yes outside an interactive terminal");
        const { confirm, isCancel } = await import("@clack/prompts"); const answer = await confirm({ message: "Permanently remove these recovery bundles?", initialValue: false }); if (isCancel(answer) || !answer) return;
      }
      console.log(`rafi uninstall:cleanup: removed ${cleanupUninstallRecovery(root, ids).join(", ")}`);
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

export function inventoryByCategory(root: string, entries: InstallManifestEntryV2[]): Record<UninstallCategory, string[]> {
  const output = Object.fromEntries(["tickets", "plans", "skills", "agents", "rules", "documentation-created", "documentation-modified", "managed-gitignore", "config", "runtime-state", "generated-other", "dependencies", "core", "generated-agents", "modified-owned"].map((key) => [key, [] as string[]])) as unknown as Record<UninstallCategory, string[]>;
  for (const entry of entries) output[categoryFor(entry.path, entry)].push(entry.path);
  for (const path of ["rafi-config.yaml", ".foreman", ".rafi/compiled", INSTALL_MANIFEST]) if (existsSync(join(root, path))) output.core.push(path);
  return output;
}

function categoryFor(_path: string, entry: InstallManifestEntryV2): UninstallCategory {
  return entry.category;
}

function legacyEntries(root: string): InstallManifestEntryV2[] {
  return ["rafi-config.yaml", "CLAUDE.md", "AGENTS.md", ".tickets/config.yaml", ".tickets/tickets.yaml"]
    .filter((path) => existsSync(join(root, path)))
    .map((path) => ({ path, sha256: null, mode: "created", origin: "legacy-detection", category: path.startsWith(".tickets") ? "tickets" : path.endsWith(".md") ? "rules" : "config" }));
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

function isPostInstallModified(root: string, entry: InstallManifestEntryV2): boolean {
  const installed = entry.installedSha256 ?? entry.sha256;
  return installed !== null && fileFingerprint(join(root, entry.path)) !== installed;
}

async function promptModifiedFileAction(
  root: string,
  entry: InstallManifestEntryV2,
  selectPrompt: typeof import("@clack/prompts").select,
  cancelCheck: typeof import("@clack/prompts").isCancel,
): Promise<UninstallFileAction | undefined> {
  while (true) {
    const hasManagedSection = entry.mode === "managed-block" && Boolean(entry.marker);
    const answer = await selectPrompt({
      message: `How should Rafi handle mixed Rafi/user edits in ${entry.path}?`,
      options: [
        ...(hasManagedSection ? [{ value: "remove-managed" as const, label: "Remove only marked Rafi-managed sections; keep all other edits (Recommended)" }] : []),
        { value: "restore" as const, label: entry.backup ? "Restore the complete pre-Rafi version (current version is backed up)" : "Restore the pre-Rafi state (the file did not exist, so remove it after backup)" },
        { value: "keep" as const, label: "Keep the current file" },
        { value: "diff" as const, label: "Show the pre-Rafi/current diff, then ask again" },
      ],
    });
    if (cancelCheck(answer)) return undefined;
    if (answer !== "diff") return answer;
    console.log(formatPreimageDiff(root, entry));
  }
}

export function formatPreimageDiff(root: string, entry: InstallManifestEntryV2): string {
  const currentPath = join(root, entry.path);
  const before = entry.backup && existsSync(join(root, entry.backup)) ? readFileSync(join(root, entry.backup), "utf8") : "";
  const after = existsSync(currentPath) ? readFileSync(currentPath, "utf8") : "";
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const lines = [`--- pre-Rafi/${entry.path}`, `+++ current/${entry.path}`];
  const count = Math.max(beforeLines.length, afterLines.length);
  let shown = 0;
  for (let index = 0; index < count && shown < 200; index++) {
    if (beforeLines[index] === afterLines[index]) continue;
    if (beforeLines[index] !== undefined) { lines.push(`-${beforeLines[index]}`); shown++; }
    if (afterLines[index] !== undefined && shown < 200) { lines.push(`+${afterLines[index]}`); shown++; }
  }
  if (shown === 200 && count > shown) lines.push("... diff truncated; inspect the file directly for the remainder ...");
  if (shown === 0) lines.push("(no textual difference)");
  return lines.join("\n");
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}

function dedupe(items: UninstallPlan["remove"]): UninstallPlan["remove"] {
  return [...new Map(items.map((item) => [item.path, item])).values()];
}
