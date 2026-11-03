// The in-memory deps.serve (ARCH 8.2): each session's MCP handler under a fake 127.0.0.1 port. The in-process
// Codex fake posts to it with the token from its thread config, through the same handler the real server uses.
import type { McpHandler } from "@rafi-ai/engine";

export function memoryServe() {
  const handlers = new Map<number, McpHandler>();
  let next = 40_000;
  const calls: { port: number; method: string }[] = [];
  const portOf = (url: string) => Number(new URL(url).port);
  return {
    async serve(o: { host: "127.0.0.1"; handler: McpHandler }) {
      const port = ++next;
      handlers.set(port, o.handler);
      return { url: `http://127.0.0.1:${port}/mcp`, close: async () => { handlers.delete(port); } };
    },
    /** One JSON-RPC POST, as Codex's MCP client sends it. Rejects like a closed port once the session ended. */
    async post(url: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; body: string }> {
      const port = portOf(url);
      const handler = handlers.get(port);
      if (!handler) throw Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:${port}`), { code: "ECONNREFUSED" });
      calls.push({ port, method: String((body as { method?: unknown }).method ?? "") });
      const out = await handler({ method: "POST", path: new URL(url).pathname, remote: "127.0.0.1", port,
        body: JSON.stringify(body), headers: { host: `127.0.0.1:${port}`, "content-type": "application/json",
          accept: "application/json, text/event-stream",
        ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) } });
      return { status: out.status, body: out.body };
    },
    /** Every request the fake Codex posted (S-CHK-9: Codex reaches the tools through the endpoint). */
    calls,
  };
}

export type MemoryServe = ReturnType<typeof memoryServe>;
