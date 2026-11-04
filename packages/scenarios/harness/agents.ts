// The default in-process agents of a harness "computer" (SCN 2.2, 7.3): the scenario's script rules first, the
// role happy paths otherwise, beneath the real adapters; every turn lands in the computer's transcript with its
// session (new or reused), model, effort, fast mode, sandbox and network settings.
import { existsSync } from "node:fs";
import type { ClaudeQuery, CodexSpawn, JsonRpcStream } from "@rafi-ai/engine";
import type { TranscriptEntry } from "../checks/transcript.js";
import { claudeQuery } from "../fakes/claude/query.js";
import { codexStream } from "../fakes/codex/stream.js";
import { scriptEngine, type MetaLike, type Rule } from "../fakes/script/engine.js";
import { happyPath } from "../fakes/script/roles.mjs";
import type { MemoryServe } from "../fakes/serve.js";

type Opt = Record<string, unknown>;

export interface ScriptState {
  readonly rules: Rule[];
  readonly transcript: TranscriptEntry[];
  /** Claude sessions opened and closed, in order, with their cwd; `exists`: the cwd was still there at close. */
  readonly sessions?: { op: "open" | "close"; cwd: string; exists: boolean }[];
}

function entry(meta: MetaLike, o: Partial<TranscriptEntry>): TranscriptEntry {
  return { role: meta.role ?? "?", ticket: meta.ticket ?? null, step: meta.step ?? null, attempt: meta.attempt ?? null,
    session: "new", instructions: "", message: "", sandbox: null, ...o };
}

/** A Codex turn's sandbox: rafi's permission profile (its project root writable, its network) or a legacy policy. */
function sandboxOf(thread: Opt, start: Opt): { writable: boolean; network: boolean; sandbox: Opt | null } {
  const id = (start.permissions ?? thread.permissions) as string | undefined;
  if (id && !start.sandboxPolicy) {
    const profile = ((thread.config as Opt | undefined)?.permissions as Opt | undefined)?.[id] as Opt | undefined;
    const roots = (profile?.filesystem as Opt | undefined)?.[":project_roots"] as Opt | undefined;
    return { writable: roots?.["."] === "write", network: Boolean((profile?.network as Opt | undefined)?.enabled),
      sandbox: { permissions: id } };
  }
  const policy = start.sandboxPolicy as Opt | undefined;
  return { writable: policy?.type === "workspaceWrite", network: Boolean(policy?.networkAccess),
    sandbox: policy ?? null };
}

export function defaultAgents(state: ScriptState, serve: MemoryServe, sleep: (ms: number) => Promise<void>) {
  const engine = () => scriptEngine(state.rules, happyPath as never);
  let shared: ReturnType<typeof engine> | null = null;
  const next = (meta: MetaLike, ctx: { cwd: string; message: string }) => (shared ??= engine()).next(meta, ctx);
  const codex = (_o: CodexSpawn): JsonRpcStream => {
    let turns = 0;
    return codexStream(next, { wire: [], metas: [] }, { sleep,
      callMcp: (url, headers, body) => serve.post(url, headers, body),
      onTurn: ({ meta, thread, start }) => {
        const policy = sandboxOf(thread, start);
        const text = String(((start.input as Opt[] | undefined)?.[0] as Opt | undefined)?.text ?? "");
        state.transcript.push(entry(meta, { runtime: "codex", session: turns++ === 0 ? "new" : "reused",
          model: (thread.model as string | undefined) ?? null, effort: (start.effort as string | undefined) ?? null,
          fast: start.serviceTier === "fast", writable: policy.writable, network: policy.network,
          sandbox: policy.sandbox, message: text, cwd: String(start.cwd ?? thread.cwd ?? ""),
          tools: (thread.config as Opt | undefined)?.mcp_servers ? ["run_check", "check_output"] : [],
          repair: /Don't run tools, read files or change anything\.$/.test(text) }));
      } }).stream;
  };
  const claude: ClaudeQuery = (params) => {
    const o = params.options;
    const cwd = String(o.cwd ?? "");
    state.sessions?.push({ op: "open", cwd, exists: existsSync(cwd) });
    (o.abortController as AbortController | undefined)?.signal.addEventListener("abort",
      () => state.sessions?.push({ op: "close", cwd, exists: existsSync(cwd) }), { once: true });
    let turns = 0;
    const prompt = (async function* () {
      for await (const message of params.prompt as AsyncIterable<Record<string | symbol, unknown>>) {
        const meta = (message[Symbol.for("rafi.turn-meta")] ?? {}) as MetaLike;
        const text = String((message.message as Opt | undefined)?.content ?? "");
        const sandbox = o.sandbox as { network?: Opt; filesystem?: Opt } | undefined;
        state.transcript.push(entry(meta, { runtime: "claude", session: turns++ === 0 ? "new" : "reused",
          model: (o.model as string | undefined) ?? null, effort: (o.effort as string | undefined) ?? null,
          fast: Boolean((o.settings as Opt | undefined)?.fastMode), sandbox: sandbox ?? null,
          writable: !((sandbox?.filesystem?.denyWrite as string[] | undefined)?.length),
          network: ((sandbox?.network?.allowedDomains as string[] | undefined) ?? []).includes("*"),
          cwd: String(o.cwd ?? ""), message: text,
          instructions: turns === 1 ? String((o.systemPrompt as Opt | undefined)?.append ?? "") : "",
          tools: o.mcpServers ? ["run_check", "check_output"] : [],
          repair: /Don't run tools, read files or change anything\.$/.test(text) }));
        yield message;
      }
    })();
    return claudeQuery(next)({ ...params, prompt, options: { ...o, __sleep: sleep } });
  };
  /** deps.agents.claudeTools: a plain object the in-process Claude fake calls (C38). */
  const claudeTools = (name: string, tools: { name: string; call(args: Opt): Promise<{ text: string;
    isError: boolean }> }[]) => ({ type: "fake-sdk", name,
    call: (tool: string, args: Opt) => tools.find((t) => t.name === tool)?.call(args) ??
      Promise.resolve({ text: `no tool ${tool}`, isError: true }) });
  return { codex, claudeQuery: claude, claudeTools };
}
