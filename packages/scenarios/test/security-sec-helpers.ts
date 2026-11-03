// Shared setup for M2 plan 11.4's secrets-floor attack tests (ARCH 7.12), split across security-sec-*.test.ts so
// the fast suite spreads them over its workers. No module-level mutable state.
import type { EventsExport } from "../checks/invariants.js";
import { B, on } from "../fakes/script/behaviors.js";
import type { Computer } from "../harness/deps.js";
import type { Rafi } from "../harness/rafi.js";

export type Data = Record<string, unknown>;

export const events = async (rafi: Rafi) => (JSON.parse((await rafi("stats export")).out) as EventsExport).events;

/** run_check's and check_output's replies to the agent, as the Codex fake received them. */
export function toolReplies(computer: Computer): string[] {
  const texts: string[] = [];
  const post = computer.serve.post.bind(computer.serve);
  (computer.serve as { post: typeof post }).post = async (url, headers, body) => {
    const out = await post(url, headers, body);
    if ((body as { method?: string }).method === "tools/call" && out.status === 200) {
      texts.push(String((JSON.parse(out.body) as { result: { content: { text: string }[] } }).result.content[0]!.text));
    }
    return out;
  };
  return texts;
}

/** Build fails once in the builder's run_check and once in the check step; the fix's run passes, then an edit. */
export function failTwiceThenFix(computer: Computer, extra: Data = {}): void {
  computer.checks.tests["t1.test"] = { outcomes: ["fail(1)", "fail(1)", "pass"], ...extra };
  computer.checks.tests["t2.test"] = { outcomes: ["pass"], related: ["src/T1.txt"] };
  computer.script.rules.push(on("builder T1#1", B.runCheck("fake-test t1.test")));
  computer.script.rules.push(on("builder T1 @fix", { steps: [{ runCheck: "fake-test t1.test" }, { checkOutput: 2 },
    { edit: "src/T1.txt", content: "fixed\n" }], reply: { kind: "done", summary: "fixed", runs: "$runs", block: null,
    question: null } }));
}

export const SHELL = { PATH: "/usr/bin:/bin", HOME: "/home/u", LANG: "en_US.UTF-8" } as const;

export const DSN = "https://abc123def456@o1.ingest.sentry.example/42";
