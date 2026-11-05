// Real agent transports: `codex app-server` over stdio, and the Agent SDK's query() loaded on first use. Each
// provider leads its own process group (POSIX), so rafi's SIGTERM and SIGKILL reach its children (M4 follow-up 2).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { ClaudeQuery, CodexSpawn, InProcessTool, JsonRpcStream } from "../types.js";

const GROUP = process.platform !== "win32";
const realSys = Object.freeze({ platform: process.platform, kill: (pid: number, s: NodeJS.Signals) =>
  process.kill(pid, s), taskkill: (pid: number) => spawnSync("taskkill", ["/PID", `${pid}`, "/T", "/F"],
  { stdio: "ignore", windowsHide: true }) });

/** POSIX: to the provider's whole group, strays too once it has exited. Windows has no groups and no polite signal
 * (kill() is TerminateProcess, stranding children): the ask is stdin's end alone, the force `taskkill /T /F`. */
export function signalGroup(child: { pid?: number; exitCode: number | null }, how: "term" | "kill",
  sys: { platform: string; kill(pid: number, s: NodeJS.Signals): void; taskkill(pid: number): void } = realSys) {
  try {
    if (child.pid && sys.platform !== "win32") sys.kill(-child.pid, how === "term" ? "SIGTERM" : "SIGKILL");
    else if (child.pid && how === "kill" && child.exitCode === null) sys.taskkill(child.pid);
  } catch { /* the group is gone */ }
}

export function realCodex(o: CodexSpawn): JsonRpcStream {
  const child = spawn(o.executable, o.args, { cwd: o.cwd, env: { ...o.env }, shell: false, windowsHide: true,
    detached: GROUP, stdio: ["pipe", "pipe", "pipe"] });
  const messageFns = new Set<(m: unknown) => void>();
  const closeFns = new Set<(info: { code: number | null; error?: string }) => void>();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message: unknown;
    try { message = JSON.parse(line); } catch { message = { invalidLine: line }; }
    for (const fn of messageFns) fn(message);
  });
  child.on("error", (error) => { for (const fn of closeFns) fn({ code: null, error: error.message }); });
  child.on("close", (code) => { for (const fn of closeFns) fn({ code }); });
  return {
    write(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onMessage(fn) { messageFns.add(fn); return () => messageFns.delete(fn); },
    onClose(fn) { closeFns.add(fn); return () => closeFns.delete(fn); },
    async close() {
      child.stdin.end();
      signalGroup(child, "term");
    },
    kill: () => signalGroup(child, "kill"),
  };
}

type SdkSpawn = { command: string; args: string[]; cwd?: string; env: NodeJS.ProcessEnv; signal: AbortSignal };
export const realClaudeQuery: ClaudeQuery = (params) => {
  type Inner = AsyncIterable<unknown> & { interrupt(): Promise<void> };
  let inner: Inner | undefined;
  let child: ChildProcess | undefined;
  // The SDK's own spawn (stdin and stdout piped, stderr ignored) in its own group; its kill() reaches the group.
  const spawnClaudeCodeProcess = (s: SdkSpawn) => (child = Object.assign(spawn(s.command, s.args, { cwd: s.cwd,
    env: s.env, signal: s.signal, windowsHide: true, detached: GROUP, stdio: ["pipe", "pipe", "ignore"] }),
  { kill: (signal?: NodeJS.Signals | number) => (signalGroup(child!, signal === "SIGKILL" ? "kill" : "term"), true) }));
  const load = async () => {
    if (inner) return inner;
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    return (inner = sdk.query({ ...params, options: { ...params.options, spawnClaudeCodeProcess } } as
      Parameters<typeof sdk.query>[0]) as unknown as Inner);
  };
  const running = () => child && child.exitCode === null && child.signalCode === null ? child : null;
  return {
    process: { terminate: () => child && signalGroup(child, "term"), kill: () => child && signalGroup(child, "kill"),
      onGone: (fn) => void (running()?.once("exit", () => fn()) ?? fn()) },
    async *[Symbol.asyncIterator]() {
      yield* await load();
    },
    async interrupt() {
      await (await load()).interrupt();
    },
  };
};

/** C38: rafi's tools as the SDK's in-process MCP server; inputs are the tools' simple string/integer fields. */
export async function realClaudeTools(name: string, tools: readonly InProcessTool[]): Promise<unknown> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const { z } = await import("zod");
  const shape = (schema: Record<string, unknown>) => Object.fromEntries(Object.entries(
    (schema.properties ?? {}) as Record<string, { type?: string }>).map(([key, p]) =>
    [key, p.type === "integer" ? z.number().int() : z.string()]));
  return sdk.createSdkMcpServer({ name, version: "1.0.0", tools: tools.map((t) => sdk.tool(t.name, t.description,
    shape(t.inputSchema), async (args: Record<string, unknown>) => {
      const out = await t.call(args);
      return { content: [{ type: "text" as const, text: out.text }], isError: out.isError };
    })) });
}
