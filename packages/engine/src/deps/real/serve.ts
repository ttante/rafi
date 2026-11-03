// The real deps.serve (ARCH 8.2, 6.9): a node:http server on 127.0.0.1 and a random port around one
// McpHandler. The URL is http://127.0.0.1:<port>/mcp; close() stops it and refuses new connections.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpHandler } from "../types.js";

const MCP_PATH = "/mcp";
const BODY_LIMIT = 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) { resolve(null); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

export async function realServe(o: { host: "127.0.0.1"; handler: McpHandler }):
  Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      if (body === null) { res.writeHead(413).end(); return; }
      const port = (server.address() as AddressInfo).port;
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        headers[name] = Array.isArray(value) ? value.join(", ") : value;
      }
      const out = await o.handler({ method: req.method ?? "GET", path: req.url ?? "/", headers, body,
        remote: req.socket.remoteAddress ?? "", port });
      res.writeHead(out.status, out.headers).end(out.body);
    })().catch(() => { if (!res.headersSent) res.writeHead(500).end(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, o.host, () => resolve());
  });
  const { address, port } = server.address() as AddressInfo;
  return {
    url: `http://${address}:${port}${MCP_PATH}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
