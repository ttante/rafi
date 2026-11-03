// Real agent transports: `codex app-server` over stdio, and the Agent SDK's query() loaded on first use.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ClaudeQuery, CodexSpawn, InProcessTool, JsonRpcStream } from "../types.js";

export function realCodex(o: CodexSpawn): JsonRpcStream {
  const child = spawn(o.executable, o.args, { cwd: o.cwd, env: { ...o.env }, shell: false, windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"] });
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
      if (child.exitCode === null) child.kill("SIGTERM");
    },
  };
}

export const realClaudeQuery: ClaudeQuery = (params) => {
  type Inner = AsyncIterable<unknown> & { interrupt(): Promise<void> };
  let inner: Inner | undefined;
  const load = async () => {
    if (!inner) {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      inner = sdk.query(params as Parameters<typeof sdk.query>[0]) as unknown as Inner;
    }
    return inner;
  };
  return {
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
