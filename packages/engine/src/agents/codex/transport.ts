// JSON-RPC over a JsonRpcStream (ARCH 11.4, decision 2): request ids, responses, notifications and server
// requests. `meta` is passed beside each message; the real stream drops it (plan choice C11).
import type { Cancel, JsonRpcStream } from "../../deps/types.js";
import type { TurnMeta } from "../types.js";

type Params = Record<string, unknown>;
interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Params;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export class RpcError extends Error {
  constructor(readonly method: string, readonly code: number | undefined, message: string) {
    super(`${method}: ${message}`);
  }
}

export class CodexTransport {
  private nextId = 0;
  private readonly pending = new Map<number | string, { method: string; resolve(v: unknown): void;
    reject(e: Error): void }>();
  private readonly notificationFns = new Set<(method: string, params: Params) => void>();
  private readonly requestFns = new Set<(id: number | string, method: string, params: Params) => void>();
  private readonly closeFns = new Set<(code: number | null) => void>();
  private closed = false;
  private readonly cancels: Cancel[];

  constructor(private readonly stream: JsonRpcStream) {
    this.cancels = [
      stream.onMessage((message) => this.onMessage(message as RpcMessage)),
      stream.onClose((info) => this.onClose(info.code)),
    ];
  }

  request(method: string, params: Params, meta?: TurnMeta): Promise<unknown> {
    if (this.closed) return Promise.reject(new RpcError(method, undefined, "the app-server has exited"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.stream.write({ id, method, params }, meta);
    });
  }

  respond(id: number | string, result: unknown): void {
    if (!this.closed) this.stream.write({ id, result });
  }

  onNotification(fn: (method: string, params: Params) => void): Cancel {
    this.notificationFns.add(fn);
    return () => this.notificationFns.delete(fn);
  }

  onServerRequest(fn: (id: number | string, method: string, params: Params) => void): Cancel {
    this.requestFns.add(fn);
    return () => this.requestFns.delete(fn);
  }

  onExit(fn: (code: number | null) => void): Cancel {
    this.closeFns.add(fn);
    return () => this.closeFns.delete(fn);
  }

  async close(): Promise<void> {
    for (const cancel of this.cancels) cancel();
    await this.stream.close();
  }

  private onMessage(message: RpcMessage): void {
    if (message.method && message.id !== undefined) {
      for (const fn of this.requestFns) fn(message.id, message.method, message.params ?? {});
      return;
    }
    if (message.method) {
      for (const fn of this.notificationFns) fn(message.method, message.params ?? {});
      return;
    }
    const waiter = message.id === undefined ? undefined : this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id!);
    if (message.error) waiter.reject(new RpcError(waiter.method, message.error.code, message.error.message ?? "error"));
    else waiter.resolve(message.result);
  }

  private onClose(code: number | null): void {
    this.closed = true;
    for (const [, waiter] of this.pending) waiter.reject(new RpcError(waiter.method, undefined, `exited (${code})`));
    this.pending.clear();
    for (const fn of this.closeFns) fn(code);
  }
}
