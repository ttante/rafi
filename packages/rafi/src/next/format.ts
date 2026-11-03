// Finds the project from argv and reads its format marker (ARCH 9.2, plan choices C13, C14).
// Shared by the launcher (node:fs) and runCli (deps.fs); imports only yaml and node:path.
import path from "node:path";
import { parse } from "yaml";

export const CONFIG_FILE = "rafi-config.yaml";
export const OLD_ENGINE_REFUSAL = "This project uses 1.0 formats; set RAFI_ENGINE=next.";
export const NEW_ENGINE_REFUSAL = "This project uses 0.10.x formats. Run `rafi migrate` first.";

/** What the format check needs from a file system. */
export interface FormatFs {
  readText(file: string): Promise<string | null>;
  isDir(dir: string): Promise<boolean>;
}

export type Format = "1.0" | "0.10.x" | "invalid";

const VERSION_FLAGS: ReadonlySet<string> = new Set(["--version", "-V"]);
const HELP_FLAGS: ReadonlySet<string> = new Set(["--help", "-h"]);

/** Version and every help form: answered without a project under both engines. */
export function isVersionOrHelp(argv: readonly string[]): boolean {
  const before = argv.includes("--") ? argv.slice(0, argv.indexOf("--")) : argv;
  if (before.length === 0) return true;
  if (before.some((arg) => VERSION_FLAGS.has(arg) || HELP_FLAGS.has(arg))) return true;
  const positional = before.filter((arg) => !arg.startsWith("-"));
  return positional[0] === "help" || positional[1] === "help";
}

function optionValue(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") return undefined;
    if (arg === "-p" || arg === "--project") return argv[i + 1];
    if (arg.startsWith("--project=")) return arg.slice("--project=".length);
  }
  return undefined;
}

/** The project folder: `-p`/`--project`, the command's project argument, else the nearest config upward. */
export async function findProject(
  argv: readonly string[], cwd: string, fs: FormatFs, projectArg?: string,
): Promise<string | null> {
  const explicit = optionValue(argv) ?? projectArg;
  if (explicit !== undefined) return path.resolve(cwd, explicit);
  let dir = path.resolve(cwd);
  for (;;) {
    if ((await fs.readText(path.join(dir, CONFIG_FILE))) !== null) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The first positional argument after the command name that names an existing folder (old engine). */
export async function guessProjectArg(argv: readonly string[], cwd: string, fs: FormatFs) {
  const positional = argv.filter((arg) => !arg.startsWith("-")).slice(1);
  for (const arg of positional) {
    if (await fs.isDir(path.resolve(cwd, arg))) return arg;
  }
  return undefined;
}

export interface FormatResult {
  readonly format: Format | "none";
  readonly message?: string;
}

/** The marker alone decides: `format_version: 1` (the integer) is 1.0; no marker is 0.10.x. */
export async function readFormat(projectDir: string, fs: FormatFs): Promise<FormatResult> {
  const text = await fs.readText(path.join(projectDir, CONFIG_FILE));
  if (text === null) return { format: "none" };
  let value: unknown;
  try {
    value = parse(text);
  } catch (error) {
    return { format: "invalid", message: `${CONFIG_FILE} isn't valid YAML: ${String((error as Error).message)
      .split("\n")[0]}` };
  }
  const marker = value && typeof value === "object" ? (value as Record<string, unknown>).format_version : undefined;
  if (marker === 1) return { format: "1.0" };
  if (marker === undefined) return { format: "0.10.x" };
  return { format: "invalid", message: `${CONFIG_FILE}: format_version must be the number 1.` };
}
