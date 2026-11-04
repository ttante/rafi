// The seams of ARCH 8.2. The engine reaches time, files, processes, SQLite and agents only through these.

export type Env = Readonly<Record<string, string | undefined>>;
export type Cancel = () => void;
export type TimerKind = "timeout" | "backoff" | "agent" | "reminder" | "heartbeat" | "poll";

export interface Clock {
  now(): Date;
  timer(ms: number, fn: () => void, kind: TimerKind): Cancel;
  sleep(ms: number, kind: TimerKind, signal?: AbortSignal): Promise<void>;
}

export interface FileStat {
  readonly kind: "file" | "dir" | "other";
  readonly size: number;
  readonly mtimeMs: number;
}

export interface Fs {
  read(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  writeAtomic(path: string, data: string | Uint8Array): Promise<void>;
  append(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string, o?: { recursive?: boolean }): Promise<void>;
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<FileStat | null>;
  /** The path with every symlink resolved; null when it doesn't exist. */
  realpath(path: string): Promise<string | null>;
  list(path: string): Promise<string[]>;
}

export interface ExecOptions {
  cwd: string;
  env?: Env;
  input?: string;
  timeoutMs?: number;
}

export interface ExecResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DbStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** A synchronous SQLite handle (better-sqlite3's shape, narrowed to what the log uses). */
export interface Db {
  exec(sql: string): void;
  prepare(sql: string): DbStatement;
  pragma(sql: string, o?: { simple?: boolean }): unknown;
  close(): void;
  readonly inTransaction: boolean;
}

export interface Owner {
  readonly instance: string;
  readonly host: string;
  readonly pid: number;
  /** Process start time, when the OS gives it; null on Windows (pid and host only). */
  readonly startedAt: string | null;
}

export interface Processes {
  self(): Owner;
  isAlive(owner: Owner): Promise<boolean>;
}

/** A JSON-RPC message stream beneath the Codex adapter. `meta` never reaches the wire (plan choice C11). */
export interface JsonRpcStream {
  write(message: unknown, meta?: unknown): void;
  onMessage(fn: (message: unknown) => void): Cancel;
  onClose(fn: (info: { code: number | null; error?: string }) => void): Cancel;
  close(): Promise<void>;
}

/** The Agent SDK's query(), as the Claude adapter calls it. */
export type ClaudeQuery = (params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) =>
  AsyncIterable<unknown> & { interrupt(): Promise<void> };

export interface Terminal {
  write(text: string): void;
  error(text: string): void;
  readonly isTTY: boolean;
  readonly columns: number;
  readonly rows: number;
  setTitle(title: string): void;
  onInterrupt(fn: () => void): Cancel;
  onResize(fn: () => void): Cancel;
  readonly input: NodeJS.ReadableStream | null;
}

export interface NotificationRequest {
  readonly question: string | null;
  readonly title: string;
  readonly text: string;
  readonly choices: readonly string[];
}

export interface Notifier {
  send(n: NotificationRequest): Promise<{ id: string; shown: string[]; more: boolean }>;
  update(id: string, text: string): Promise<void>;
  close(id: string): Promise<void>;
  onAnswer(fn: (id: string, choice: string) => void): Cancel;
}

export interface Hooks {
  crash(boundary: string): void;
  pause(boundary: string): void;
}

export interface Machine {
  readonly stateDir: string;
  readonly host: string;
  readonly platform: NodeJS.Platform;
}

export interface Random {
  id(): string;
  jitter(): number;
  /** 32 random bytes as hex, for session tokens (C39). */
  secret?(): string;
}

export interface CodexSpawn {
  cwd: string;
  executable: string;
  args: string[];
  env: Env;
}

/** A need a grant covers (Q-FLAG-2, ARCH 7.11). */
export type Need = "internet" | "local-servers" | "installs" | "services";

export interface Grants {
  readonly needs: readonly Need[];
}

export interface CheckRun {
  cwd: string;
  env: Env;
  /** The build's grants (ARCH 8.2); the prefix below enforces them where the machine has a sandbox. */
  grants: Grants;
  /** The sandbox argv prefix from build/sandbox.ts (C40); empty when the no-sandbox warning was accepted. */
  sandbox: readonly string[];
  onOutput(chunk: string): void;
  signal: AbortSignal;
}

export interface CheckResult {
  readonly code: number | null;
  readonly signal: string | null;
  /** The run was ended through `signal` (a time limit or a cancel). */
  readonly aborted: boolean;
  readonly durationMs: number;
  readonly output: string;
}

export type SandboxTool = "sandbox-exec" | "bwrap";
export type SandboxInfo = { available: true; tool: SandboxTool } | { available: false; missing: string };
/** What the machine has for a test sandbox; build/sandbox.ts turns it into a SandboxInfo. */
export type SandboxFacts =
  | { platform: "darwin"; sandboxExec: boolean }
  | { platform: NodeJS.Platform; bwrap: string | null; bwrapWorks: boolean };

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

export interface Deps {
  agents: {
    codex(o: CodexSpawn): JsonRpcStream;
    claudeQuery: ClaudeQuery;
    /** rafi's tools as an SDK MCP server for one Claude session (real: createSdkMcpServer). */
    claudeTools?(name: string, tools: readonly InProcessTool[]): Promise<unknown>;
  };
  clock: Clock;
  notifier: Notifier;
  terminal: Terminal;
  fs: Fs;
  git(args: string[], o: ExecOptions): Promise<ExecResult>;
  exec(cmd: string, args: string[], o: ExecOptions): Promise<ExecResult>;
  checks: {
    run(cmd: string, args: string[], o: CheckRun): Promise<CheckResult>;
    /** What this machine has for a test sandbox (6.9); build/sandbox.ts decides if it's usable. */
    sandbox(): Promise<SandboxFacts>;
  };
  serve(o: { host: "127.0.0.1"; handler: McpHandler }): Promise<{ url: string; close(): Promise<void> }>;
  spawnBackground(argv: string[], o: { cwd: string; log: string }): { pid: number };
  db: { open(path: string, o?: { readonly?: boolean }): Db };
  processes: Processes;
  hooks: Hooks;
  machine: Machine;
  env: Env;
  /** The folder rafi was started in (plan choice C29: runCli can't read process.cwd()). */
  cwd: string;
  random: Random;
  logChanged(dbPath: string, onChange: () => void): Cancel;
}
