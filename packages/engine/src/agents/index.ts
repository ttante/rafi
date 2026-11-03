// The ./agents export: the real Codex and Claude adapters and the Codex transport, for the fidelity tests.
export { codexAgent, type CodexOptions } from "./codex/adapter.js";
export { CodexTransport, RpcError } from "./codex/transport.js";
export { claudeAgent, META } from "./claude/adapter.js";
export type * from "./types.js";
