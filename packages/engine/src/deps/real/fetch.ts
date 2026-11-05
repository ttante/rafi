// The real `fetch` seam (ARCH 8.2, P47): Node's fetch with `redirect: "manual"`, so rafi checks every hop itself
// (tickets/sources.ts). With `allowAddress` (URL sources), the host's every address is checked before any request.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Deps } from "../types.js";

export const realFetch: Deps["fetch"] = async (url, o) => {
  if (o.allowAddress) {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    const found = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
    const bad = found.find((a) => !o.allowAddress!(a.address));
    if (!found.length || bad) {
      throw new Error(`${host} isn't a public address (${bad?.address ?? "it didn't resolve"}).`);
    }
  }
  const r = await fetch(url, { method: o.method, headers: o.headers, body: o.body, signal: o.signal,
    redirect: "manual" });
  return { status: r.status, headers: Object.fromEntries(r.headers), text: () => r.text() };
};
