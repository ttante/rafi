// The local MCP endpoint's request and response, as deps.serve hands them to the handler (C37), and one of rafi's
// tools for an in-process Claude session (C38). Moved here from deps/types.ts in M5 (tools/ owns tools in sessions).
/** One HTTP request to rafi's local MCP endpoint, as deps.serve hands it to the handler (C37). */
export interface McpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
  /** The peer's address, as the socket reports it. */
  readonly remote: string;
  /** The port the server listens on (for the Host check). */
  readonly port: number;
}

export interface McpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type McpHandler = (request: McpRequest) => Promise<McpResponse>;

/** One of rafi's tools for an in-process Claude session (C38). */
export interface InProcessTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  call(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}
