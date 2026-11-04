// The scripted deps.checks (SCN 2.1 F-TESTS, ARCH 8.2): `fake-test` (and `npx jest`, `npm test`) with per-test
// outcomes the scenario sets, on the fake clock, so hung and slow tests take no real time. Writes are real (the
// worktree, the cache, the harness home); the network is denied unless the grants allow it or no sandbox is used.
//   tests: { "t1.test": { outcomes: ["fail(2)", "pass"], writes: ["coverage/"], homeCache, edits, creates, network,
//     related } }
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CheckResult, CheckRun, Clock, SandboxFacts } from "@rafi-ai/engine";

export interface FakeTest {
  /** Consumed one per run of this file; the last repeats. `pass`, `fail(n)`, `hang`, `slow(8m)`. */
  outcomes: string[];
  writes?: string[];
  homeCache?: boolean;
  edits?: string;
  /** A new file the run writes (untracked until rafi's snapshot). */
  creates?: string;
  network?: boolean;
  /** Source files this test is related to (`--findRelatedTests`). */
  related?: string[];
  /** Extra text a failing run prints (for instruction-injection tests). */
  output?: string;
  /** Prints variables from the run's environment in these forms on every run (S-SEC-2's hostile test). */
  prints?: readonly { env: string; forms: readonly ("raw" | "base64" | "base64url" | "hex" | "url")[] }[];
}

const FORMS = Object.freeze({ raw: (v: string) => v, base64: (v: string) => Buffer.from(v).toString("base64"),
  base64url: (v: string) => Buffer.from(v).toString("base64url"), hex: (v: string) => Buffer.from(v).toString("hex"),
  url: (v: string) => encodeURIComponent(v) });

function printed(tests: Record<string, FakeTest>, files: readonly string[], env: CheckRun["env"]): string {
  return files.flatMap((f) => (tests[f]?.prints ?? []).flatMap((p) => {
    const value = env[p.env];
    return value === undefined ? [`${p.env} is unset`]
      : p.forms.map((form) => `${p.env} ${form}: ${FORMS[form](value)}`);
  })).map((line) => `${line}\n`).join("");
}

export interface CheckLogEntry {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly sandbox: readonly string[];
  readonly needs: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Where the run ran (C128: a QA copy's runs run in the copy). */
  readonly cwd: string;
}

export interface ScriptedChecksOptions {
  readonly clock: Clock;
  readonly home: string;
  readonly tests: Record<string, FakeTest>;
  /** "missing" reports a Linux machine without bubblewrap (S-CHK-11). */
  readonly sandbox?: "available" | "missing";
  readonly log?: CheckLogEntry[];
  /** "hang": the related-tests query (`--listTests`) never prints and ends only when aborted. */
  readonly listing?: "hang";
}

const RUNNERS: ReadonlySet<string> = new Set(["fake-test", "jest"]);

interface Parsed {
  readonly files: string[];
  readonly json: string | null;
  readonly list: boolean;
}

function parse(cmd: string, args: readonly string[]): Parsed | null {
  let rest = [...args];
  if (cmd === "npx" && rest[0] && RUNNERS.has(rest[0])) rest = rest.slice(1);
  else if (!RUNNERS.has(cmd)) return null;
  const json = rest.find((a) => a.startsWith("--outputFile="))?.slice("--outputFile=".length) ?? null;
  return { files: rest.filter((a) => !a.startsWith("-")), json: rest.includes("--json") ? json : null,
    list: rest.includes("--listTests") };
}

interface Case {
  readonly file: string;
  readonly name: string;
  readonly passed: boolean;
  readonly error: string | null;
}

function report(cwd: string, cases: readonly Case[]) {
  const files = [...new Set(cases.map((c) => c.file))];
  return {
    numFailedTests: cases.filter((c) => !c.passed).length, numPassedTests: cases.filter((c) => c.passed).length,
    numTotalTests: cases.length, success: cases.every((c) => c.passed),
    testResults: files.map((file) => ({
      name: path.join(cwd, file), status: cases.some((c) => c.file === file && !c.passed) ? "failed" : "passed",
      assertionResults: cases.filter((c) => c.file === file).map((c) => ({ ancestorTitles: [file], title: c.name,
        fullName: `${file} ${c.name}`, status: c.passed ? "passed" : "failed",
        failureMessages: c.error ? [c.error] : [] })),
    })),
  };
}

function text(cases: readonly Case[]): string {
  const lines: string[] = [];
  for (const file of new Set(cases.map((c) => c.file))) {
    const mine = cases.filter((c) => c.file === file);
    lines.push(`${mine.every((c) => c.passed) ? "PASS" : "FAIL"} ${file}`);
    for (const c of mine.filter((m) => !m.passed)) lines.push(`  ● ${file} › ${c.name}`, `    ${c.error}`);
  }
  const failed = cases.filter((c) => !c.passed).length;
  lines.push(`Tests: ${failed ? `${failed} failed, ` : ""}${cases.length - failed} passed, ${cases.length} total`);
  return `${lines.join("\n")}\n`;
}

const untilAborted = (run: CheckRun) => new Promise<void>((resolve) => {
  if (run.signal.aborted) return resolve();
  run.signal.addEventListener("abort", () => resolve(), { once: true });
});

export function scriptedChecks(o: ScriptedChecksOptions) {
  const used = new Map<string, number>();
  const outcome = (file: string): string => {
    const list = o.tests[file]?.outcomes ?? ["pass"];
    const n = used.get(file) ?? 0;
    used.set(file, n + 1);
    return list[Math.min(n, list.length - 1)] ?? "pass";
  };
  const sideEffects = (cwd: string, file: string, run: CheckRun): string | null => {
    const t = o.tests[file];
    if (!t) return null;
    for (const dir of t.writes ?? []) {
      mkdirSync(path.join(cwd, dir), { recursive: true });
      writeFileSync(path.join(cwd, dir, "lcov.info"), `TN:${file}\n`);
    }
    if (t.homeCache) {
      const cache = run.env.npm_config_cache ?? path.join(o.home, ".npm");
      if (run.sandbox.length && !cache.startsWith(cwd)) return `EPERM: operation not permitted, mkdir '${cache}'`;
      mkdirSync(path.join(cache, "_cacache"), { recursive: true });
      writeFileSync(path.join(cache, "_cacache", "index"), file);
    }
    if (t.edits) appendFileSync(path.join(cwd, t.edits), "// edited by a test run\n");
    if (t.creates) writeFileSync(path.join(cwd, t.creates), "// created by a test run\n");
    if (t.network && run.sandbox.length && !run.grants.needs.includes("internet")) {
      return "Error: connect EPERM 1.1.1.1:443 - Local (0.0.0.0:0)";
    }
    return null;
  };
  const cases = (cwd: string, files: readonly string[], run: CheckRun): Case[] => files.flatMap((file): Case[] => {
    const failure = sideEffects(cwd, file, run);
    const m = /^fail\((\d+)\)$/.exec(outcome(file));
    if (failure) return [{ file, name: "reaches the network", passed: false, error: failure }];
    if (!m) return [{ file, name: "works", passed: true, error: null }];
    return Array.from({ length: Number(m[1]) }, (_, i) => ({ file, name: `case ${i + 1}`, passed: false,
      error: `Error: expect(received).toBe(expected) — case ${i + 1} of ${file}\n    at Object.<anonymous> (${file}:${
        i + 3}:5)${o.tests[file]?.output ? `\n${o.tests[file]!.output}` : ""}${o.tests[file]?.prints
        ? `\nReceived: ${printed(o.tests, [file], run.env).trim()}` : ""}` }));
  });
  /** hang: never prints, ends only when aborted. slow(Nm): a line every 30 s of fake time for N minutes. */
  const wait = (files: readonly string[], run: CheckRun, started: number): Promise<"done" | "aborted"> => {
    const kinds = files.map((f) => o.tests[f]?.outcomes ?? []).map((list, i) => list[Math.min(used.get(files[i]!)
      ?? 0, list.length - 1)] ?? "pass");
    const slow = kinds.map((k) => /^slow\((\d+)m\)$/.exec(k)).find(Boolean);
    if (!kinds.includes("hang") && !slow) return Promise.resolve("done");
    return new Promise((resolve) => {
      const cancels: (() => void)[] = [];
      const end = (how: "done" | "aborted") => { for (const c of cancels) c(); resolve(how); };
      if (run.signal.aborted) return end("aborted");
      run.signal.addEventListener("abort", () => end("aborted"), { once: true });
      if (!slow) return;
      const until = started + Number(slow[1]) * 60_000;
      const tick = () => {
        run.onOutput(`  … still running (${(o.clock.now().getTime() - started) / 1000}s)\n`);
        if (o.clock.now().getTime() >= until) return end("done");
        cancels.push(o.clock.timer(30_000, tick, "agent"));
      };
      cancels.push(o.clock.timer(30_000, tick, "agent"));
    });
  };
  return {
    async run(cmd: string, args: string[], run: CheckRun): Promise<CheckResult> {
      o.log?.push({ cmd, args, sandbox: run.sandbox, needs: run.grants.needs, env: run.env, cwd: run.cwd });
      const started = o.clock.now().getTime();
      const result = (code: number | null, output: string, aborted = false): CheckResult => {
        if (!aborted && output) run.onOutput(output);
        return { code, signal: aborted ? "SIGKILL" : null, aborted, output,
          durationMs: o.clock.now().getTime() - started };
      };
      const parsed = parse(cmd, args);
      if (!parsed) {
        const key = [cmd, ...args].join(" ");
        const fail = Boolean(o.tests[key]) && /^fail/.test(outcome(key));
        return result(fail ? 1 : 0, fail ? "1 failing\n" : "ok\n");
      }
      if (parsed.list && o.listing === "hang") return untilAborted(run).then(() => result(null, "", true));
      if (parsed.list) {
        const changed = parsed.files;
        const related = Object.entries(o.tests).filter(([, t]) => (t.related ?? []).some((f) => changed.includes(f)));
        return result(0, related.map(([file]) => path.join(run.cwd, file)).join("\n") + (related.length ? "\n" : ""));
      }
      const how = await wait(parsed.files, run, started);
      if (how === "aborted") {
        for (const file of parsed.files) outcome(file);
        return result(null, "", true);
      }
      const all = cases(run.cwd, parsed.files, run);
      if (parsed.json) {
        mkdirSync(path.dirname(parsed.json), { recursive: true });
        writeFileSync(parsed.json, JSON.stringify(report(run.cwd, all)));
      }
      return result(all.every((c) => c.passed) ? 0 : 1, printed(o.tests, parsed.files, run.env) + text(all));
    },
    async sandbox(): Promise<SandboxFacts> {
      return o.sandbox === "missing" ? { platform: "linux", bwrap: null, bwrapWorks: false }
        : { platform: "darwin", sandboxExec: true };
    },
  };
}
