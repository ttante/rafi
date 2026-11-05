// The scripted `fetch` (ARCH 8.2's seam row, P47; M5 plan C230): answers by URL (exact, else origin and path), 3xx
// answers with their Location included, never follows a redirect itself, and records every request with the
// headers it carried. Hosts resolve to the addresses the scenario gives (a public one by default), so a private
// destination is refused through the engine's own address rule, as the real seam does.
import type { Deps, FetchOptions } from "@rafi-ai/engine";

export interface HttpRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export interface HttpAnswer {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface FakeHttp {
  readonly routes: Map<string, HttpAnswer | ((r: HttpRequest) => HttpAnswer)>;
  /** Host → the address it resolves to; unlisted hosts resolve to a public address. */
  readonly addresses: Record<string, string>;
  readonly log: HttpRequest[];
}

export const fakeHttp = (): FakeHttp => ({ routes: new Map(), addresses: {}, log: [] });

export function httpFetch(http: FakeHttp): Deps["fetch"] {
  return async (url: string, o: FetchOptions) => {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    const address = http.addresses[host] ?? (/^[\d.]+$|:/.test(host) ? host : "93.184.216.34");
    if (o.allowAddress && !o.allowAddress(address)) throw new Error(`${host} isn't a public address (${address}).`);
    const request = { url, method: o.method ?? "GET", headers: { ...(o.headers ?? {}) }, body: o.body ?? null };
    http.log.push(request);
    const route = http.routes.get(url) ?? http.routes.get(`${parsed.origin}${parsed.pathname}`);
    const answer = typeof route === "function" ? route(request) : route ?? { status: 404, body: "not found" };
    return { status: answer.status, headers: { ...(answer.headers ?? {}) }, text: async () => answer.body ?? "" };
  };
}
