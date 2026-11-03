// C89 (SCN 5.7): canary values a scenario puts in the shell environment, and the forms the harness greps for. The
// forms are computed here, independently of the engine's redactor, so a redaction bug can't hide itself.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** `canary-<24 hex>`, fixed by the seed (the scenario's root and the variable's name). */
export function canary(seed: string): string {
  return `canary-${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
}

/** A value raw, as base64 (padded or not), base64url, hex (either case) and URL-encoded. */
export function canaryForms(value: string): Record<string, string> {
  const bytes = Buffer.from(value, "utf8");
  return { raw: value, base64: bytes.toString("base64"), unpadded: bytes.toString("base64").replace(/=+$/, ""),
    base64url: bytes.toString("base64url"), hex: bytes.toString("hex"), HEX: bytes.toString("hex").toUpperCase(),
    url: encodeURIComponent(value) };
}

/** Every file under `dir` except git's objects and dependencies, as bytes (the event log and blobs included). */
function* files(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else yield full;
  }
}

export interface CanaryInput {
  readonly canaries: Readonly<Record<string, string>>;
  readonly projects: readonly string[];
  readonly texts: readonly { where: string; text: string }[];
  readonly agentEnvs: readonly { kind: string; env: Readonly<Record<string, string | undefined>> }[];
}

/** Where a canary, raw or encoded, turned up: a project file, a text (terminal, transcript) or an agent's env. */
export function canaryProblems(input: CanaryInput): string[] {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(input.canaries)) {
    const forms = Object.entries(canaryForms(value));
    const found = (haystack: string) => forms.filter(([, f]) => haystack.includes(f)).map(([form]) => form);
    for (const { where, text } of input.texts) {
      for (const form of found(text)) problems.push(`canary ${name} (${form}) in ${where}`);
    }
    for (const project of input.projects) {
      for (const file of files(project)) {
        const bytes = readFileSync(file).toString("latin1");
        for (const form of found(bytes)) problems.push(`canary ${name} (${form}) in ${path.relative(project, file)}`);
      }
    }
    for (const { kind, env } of input.agentEnvs) {
      for (const [key, v] of Object.entries(env)) {
        if (v && found(v).length) problems.push(`canary ${name} in ${kind}'s environment as ${key}`);
      }
    }
  }
  return problems;
}
