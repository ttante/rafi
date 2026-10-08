import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { lookup } from "node:dns/promises";
import { qaDigest } from "./qaProtocolV2.js";
import { resolveExecutablePath } from "./runtimeReadiness.js";
import type { TicketDef } from "./tickets/ticketSchema.js";

export interface QaPrerequisiteEvidence {
  version: 3;
  scopeDigest: string;
  snapshotPath: string;
  checkedAt: string;
  /** Host absence is actionable; host availability never proves provider access. */
  authority: "host-preflight";
  checks: Array<{ requirement: string; capability: string; outcome: "available" | "not_run"; evidence: string }>;
  sourceDefects: string[];
}

export async function checkQaPrerequisites(input: {
  snapshotPath: string; sourceDigest: string; ticket: TicketDef; runtimeContext?: unknown;
  env?: NodeJS.ProcessEnv; timeoutMs?: number;
  probe?: (executable: string, args: string[]) => Promise<boolean>;
  connectivity?: (host: string) => Promise<boolean>;
}): Promise<QaPrerequisiteEvidence> {
  const env = input.env ?? process.env, timeoutMs = input.timeoutMs ?? 1500;
  const manifests = ["package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "pyproject.toml", "requirements.txt", "Cargo.lock", "go.sum"]
    .map(path => ({ path, content: existsSync(join(input.snapshotPath, path)) ? readFileSync(join(input.snapshotPath, path), "utf8") : null }));
  let pkg: { dependencies?: object; devDependencies?: object } | undefined;
  try { const raw = manifests.find(f => f.path === "package.json")?.content; if (raw) pkg = JSON.parse(raw); } catch { /* malformed manifests remain source findings */ }
  const evidence: QaPrerequisiteEvidence = {
    version: 3, snapshotPath: realpathSync(input.snapshotPath), checkedAt: new Date().toISOString(), authority: "host-preflight",
    scopeDigest: qaDigest("qa-prerequisites-v3", { sourceDigest: input.sourceDigest, snapshotPath: realpathSync(input.snapshotPath), manifests, node: process.version, path: env.PATH ?? "", runtimeContext: input.runtimeContext ?? null, requirements: input.ticket.required_tests }),
    checks: [], sourceDefects: [],
  };
  const probe = input.probe ?? ((executable, args) => new Promise<boolean>(resolve => {
    execFile(executable, args, { cwd: input.snapshotPath, env, timeout: timeoutMs, maxBuffer: 4096, windowsHide: true }, error => resolve(!error));
  }));
  for (const requirement of input.ticket.required_tests) {
    const command = /^\s*`?(pnpm|npm|yarn|bun|node|docker|python3|pytest|cargo|go)\b/.exec(requirement)?.[1];
    if (command) {
      const executable = resolveExecutablePath(command, env);
      evidence.checks.push({ requirement, capability: `executable:${command}`, outcome: executable ? "available" : "not_run", evidence: executable ? `Host executable available: ${executable}; provider confinement must still permit execution` : `Required executable ${command} unavailable; provisioning requires existing workflow authority` });
      if (/^(pnpm|npm|yarn|bun)$/.test(command) && pkg) {
        if (Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length > 0) {
          const installed = existsSync(join(input.snapshotPath, "node_modules"));
          evidence.checks.push({ requirement, capability: "project-dependencies", outcome: installed ? "available" : "not_run", evidence: installed ? "Existing dependency tree projected into snapshot; verification still required" : "Dependencies unavailable in QA snapshot; no installation attempted" });
        }
        const lock = command === "pnpm" ? "pnpm-lock.yaml" : command === "npm" ? "package-lock.json" : command === "yarn" ? "yarn.lock" : "bun.lock";
        if (/frozen-lockfile|\bci\b|\baudit\b/.test(requirement) && !existsSync(join(input.snapshotPath, lock))) evidence.sourceDefects.push(`Required ${lock} is absent; retain as a source finding`);
      }
      if (command === "docker" && executable) {
        const ready = await bounded(() => probe(executable, ["info", "--format", "{{.ServerVersion}}"]), timeoutMs);
        evidence.checks.push({ requirement, capability: "docker-service", outcome: ready ? "available" : "not_run", evidence: ready ? "Docker service responded to a read-only probe" : "Required Docker service is unavailable or probe timed out" });
      }
    }
    const host = /^requires connectivity https?:\/\/([^/\s]+)/i.exec(requirement)?.[1];
    if (host) {
      const reachable = await bounded(() => input.connectivity ? input.connectivity(host) : lookup(host).then(() => true, () => false), timeoutMs);
      evidence.checks.push({ requirement, capability: `dns:${host}`, outcome: reachable ? "available" : "not_run", evidence: reachable ? "Host DNS resolved; provider network/service access still requires verification" : "Required hostname cannot be resolved or probe timed out" });
    }
  }
  return evidence;
}

async function bounded(work: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work().catch(() => false), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
