import { isAbsolute, relative, resolve, sep, dirname, basename } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { canonicalSessionPath } from "../sessionIdentity.js";

type Segment = { words: string[]; followsPipe: boolean; endsPipe: boolean; hadBackslash: boolean };
/** Intentionally bounded shell grammar. No expansion, background jobs,
 * conditionals, substitutions, or filesystem redirects are normalized. */
function segments(command: string): Segment[] {
  const result: Segment[] = [];
  let words: string[] = [], word = "", started = false;
  let quote: "'" | '"' | undefined;
  let followsPipe = false;
  let hadBackslash = false;
  const flush = () => { if (started) words.push(word); word = ""; started = false; };
  const finish = (pipe: boolean) => {
    flush(); if (!words.length) throw new Error("empty shell command segment");
    result.push({ words, followsPipe, endsPipe: pipe, hadBackslash }); words = []; followsPipe = pipe; hadBackslash = false;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (char === "\\") hadBackslash = true;
    if (char === "\n" || char === "\r") throw new Error("multiline shell syntax needs approval");
    if (char === "\\" && quote !== "'") {
      const next = command[++i]; if (!next || next === "\n" || next === "\r") throw new Error("unsupported shell escape");
      word += next; started = true; continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else { if (quote === '"' && (char === "$" || char === "`")) throw new Error("shell expansion needs approval"); word += char; }
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/\s/.test(char)) { flush(); continue; }
    if (!started && command.slice(i, i + 4) === "2>&1" && (i + 4 === command.length || /\s|[&|;]/.test(command[i + 4]!))) { i += 3; continue; }
    if (command.slice(i, i + 2) === "&&") { finish(false); i++; continue; }
    if (char === "|" && command[i + 1] === "|") throw new Error("shell conditionals need approval");
    if (char === "|") { finish(true); continue; }
    if (/[&;<>$`(){}~#]/.test(char)) throw new Error("unsupported shell operator or expansion needs approval");
    word += char; started = true;
  }
  if (quote) throw new Error("unterminated shell quote");
  finish(false); return result;
}

export function canonicalToolPath(path: string): string {
  let ancestor = resolve(path); const missing: string[] = [];
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) { missing.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
  return resolve(canonicalSessionPath(ancestor), ...missing);
}
export function isWithinProject(root: string, path: string): boolean {
  const rel = relative(canonicalToolPath(root), canonicalToolPath(path));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
const inside = isWithinProject;

function validateRestrictedNodeTests(words: string[], root: string, cwd: string): string | undefined {
  if (words[1] !== "--test") return "QA permits Node's test runner, not arbitrary Node execution";
  let files = 0, literalFiles = false;
  for (const arg of words.slice(2)) {
    if (!literalFiles && arg === "--") { literalFiles = true; continue; }
    if (!literalFiles && arg.startsWith("-")) {
      if (/^--test-name-pattern=.+$/.test(arg) || /^--test-reporter=(?:tap|spec|dot)$/.test(arg)) continue;
      if (/^--test-concurrency=\d{1,2}$/.test(arg) && Number(arg.split("=")[1]) >= 1 && Number(arg.split("=")[1]) <= 32) continue;
      return "unapproved Node test option; use local test files without eval, preload, loader or output controls";
    }
    if (!/\.test\.(?:mjs|cjs|js|mts|cts|ts)$/.test(arg)) return "use explicit worktree-local .test files";
    const path = resolve(cwd, arg), directory = dirname(path), name = basename(path);
    if (!inside(root, directory) || /[?\[\]{}*]/.test(dirname(arg))) return "Node test path escapes the worktree or uses an unsupported directory glob";
    if (name.includes("*")) {
      if (/[?\[\]{}]/.test(name)) return "unsupported Node test glob";
      const pattern = new RegExp(`^${name.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
      try {
        if (existsSync(directory) && readdirSync(directory).some(entry => pattern.test(entry) && !inside(root, resolve(directory, entry)))) return "Node test glob resolves outside the worktree";
      } catch {
        return "Node test directory inventory is unavailable; inspect the local path before retrying";
      }
    } else if (!inside(root, path)) return "Node test path resolves outside the worktree";
    files++;
  }
  return files ? undefined : "use explicit worktree-local .test files";
}

export function classifySupportedShellForm(command: string, root: string, initialCwd: string, allowBash: string[]): string | undefined {
  if (!inside(root, initialCwd)) return "tool cwd is outside the worktree";
  let cwd = initialCwd;
  let parsed: Segment[];
  try { parsed = segments(command); } catch (error) { return (error as Error).message; }
  for (const segment of parsed) {
    const words = [...segment.words];
    if (words[0] === "cd") {
      if (words.length !== 2 || segment.followsPipe || segment.endsPipe) return "only a literal in-worktree cd followed by && is supported";
      const target = resolve(cwd, words[1]!);
      if (!inside(root, target)) return "directory change escapes the worktree";
      cwd = target; continue;
    }
    while (/^[A-Za-z_]\w*=/.test(words[0] ?? "")) {
      const assignment = words.shift()!;
      const split = assignment.indexOf("="); const key = assignment.slice(0, split), value = assignment.slice(split + 1);
      const simple = /^(?:CI|NO_COLOR|FORCE_COLOR|PYTHONUNBUFFERED|PYTHONDONTWRITEBYTECODE|PYTEST_DISABLE_PLUGIN_AUTOLOAD)$/;
      if (simple.test(key) && /^(?:0|1|true|false)$/.test(value)) continue;
      if ((key === "PYTHONPATH" || key === "UV_PROJECT_ENVIRONMENT") && value && value.split(process.platform === "win32" ? ";" : ":").every(path => path && inside(root, resolve(cwd, path)))) continue;
      return `environment assignment ${key} needs approval; use a literal project-local test environment`;
    }
    if (!words.length) return "unsupported shell executable";
    // Offline/no-sync uv is only an environment runner for an already allowed
    // command. Ordinary uv acquisition still requires its configured policy.
    if (words.slice(0, 4).join(" ") === "uv run --offline --no-sync") words.splice(0, 4);
    const executable = words[0] ?? "";
    if (/(?:^|[/\\])(?:python3?|pytest)$/.test(executable) && executable.includes("/")) {
      const path = resolve(cwd, executable);
      // POSIX virtualenvs normally symlink their Python binary to the native
      // interpreter. Keep the containing environment inside the worktree and
      // allow only that interpreter alias, never a directory escape or a
      // Python-named symlink to an unrelated executable.
      const nativePythonAlias = /^python(?:3)?$/.test(basename(executable))
        && /^python(?:\d+(?:\.\d+)*)?$/i.test(basename(canonicalSessionPath(path)))
        && inside(root, dirname(path));
      if (inside(root, path) || nativePythonAlias) words[0] = executable.split(/[/\\]/).at(-1)!;
    }
    if (!words.length || /\s/.test(words[0]!)) return "unsupported shell executable";
    if (words[0] === "node" && allowBash.includes("node --test") && !allowBash.includes("node ") && !allowBash.includes("node")) {
      const invalid = validateRestrictedNodeTests(words, root, cwd);
      if (process.platform === "win32" && segment.hadBackslash) return "restricted Node tests require forward-slash paths on Windows";
      if (invalid) return invalid;
    }
    const allowed = allowBash.some(prefix => {
      const expected = prefix.trim().split(/\s+/);
      return expected.every((word, index) => words[index] === word) && (words.length > expected.length || !prefix.endsWith(" "));
    });
    if (!allowed) return `command is not allow-listed: ${words.join(" ")}; use a configured project test command`;
  }
  return undefined;
}
