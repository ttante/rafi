// The seams of ARCH 8.2. The engine reaches time, files, processes, SQLite and agents only through these. The MCP
// endpoint's request types live in tools/mcp-types.ts and the grant and sandbox facts in ask/grants.ts (M5: room
// for the fetch seam); they're re-exported here.
import type { Grants, SandboxFacts } from "../ask/grants.js";
import type { InProcessTool, McpHandler } from "../tools/mcp-types.js";

export type { Grants, Need, SandboxFacts } from "../ask/grants.js";
export type { InProcessTool, McpHandler, McpRequest, McpResponse } from "../tools/mcp-types.js";

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
  /** Stdin's end and SIGTERM to its process group; kill(): SIGKILL to it (ARCH 8.5; Windows: deps/real/agents.ts). */
  close(): Promise<void>;
  kill(): void;
}

/** A provider as rafi ends it (ARCH 8.5): terminate asks, kill forces; onGone: at once if it exited or never ran. */
export interface ProviderProcess { terminate(): void; kill(): void; onGone(fn: () => void): void }

/** The Agent SDK's query(), as the Claude adapter calls it; `process` is the `claude` it spawned. */
export type ClaudeQuery = (params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) =>
  AsyncIterable<unknown> & { interrupt(): Promise<void>; readonly process?: ProviderProcess };

export interface Terminal {
  write(text: string): void;
  error(text: string): void;
  readonly isTTY: boolean;
  readonly columns: number;
  readonly rows: number;
  setTitle(title: string): void;
  /** Ctrl+C's SIGINT, or the signals given (SIGHUP and SIGTERM for a build's owner, C183). */
  onInterrupt(fn: () => void, signals?: readonly NodeJS.Signals[]): Cancel;
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

/** No-ops in production. At each boundary the engine awaits `pause`, then calls `crash` (P34, C164). */
export interface Hooks {
  crash(boundary: string): void;
  pause(boundary: string): void | Promise<void>;
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

export interface CheckRun {
  cwd: string;
  env: Env;
  /** The build's grants (ARCH 8.2); the prefix below enforces them where the machine has a sandbox. */
  grants: Grants;
  /** The sandbox argv prefix from ask/grants.ts (C40); empty when the no-sandbox warning was accepted. */
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

/** The `fetch` seam (ARCH 8.2, P47): never follows a redirect; a 3xx comes back with its Location. */
export interface FetchOptions {
  method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal;
  /** For URL sources: every address the host resolves to must pass, else nothing is sent (today's public check). */
  allowAddress?: (address: string) => boolean;
}
export interface FetchResponse {
  readonly status: number; readonly headers: Record<string, string>; text(): Promise<string>;
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
  fetch(url: string, o: FetchOptions): Promise<FetchResponse>;
  checks: {
    run(cmd: string, args: string[], o: CheckRun): Promise<CheckResult>;
    /** What this machine has for a test sandbox (6.9); ask/grants.ts decides if it's usable. */
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
