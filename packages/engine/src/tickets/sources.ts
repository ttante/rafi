// Tracker-source access checks for `rafi tickets setup:*` (FLAG-TK-1; M5 plan C230, item 31b; P47). Each source
// gets one request through `deps.fetch`, which never follows a redirect; rafi follows them itself, as today's
// `sourceFetch.ts:54-73`: at most 5, each `Location` http(s) with no credentials in it, and a URL source's every hop
// must resolve to a public address. A token goes only to the origin (scheme, host and port) it's configured for;
// once a hop leaves that origin, the token is never sent again in that check. Tokens come from `deps.env` by the
// variable name saved in `rafi-config.yaml`, never the value.
import { isIP } from "node:net";
import path from "node:path";
import type { Deps } from "../deps/types.js";

export const MAX_REDIRECTS = 5;

export type Source =
  | { type: "local"; paths: string[] }
  | { type: "linear"; api_key_env?: string; team_key?: string | null; filter?: string | null }
  | { type: "jira"; site: string; email_env?: string; token_env?: string; jql: string }
  | { type: "url"; url: string };

/** Today's public-address rule (`sourceFetch.ts:106`): loopback, private, link-local, CGNAT, multicast and the
 * documentation ranges are refused. */
export function isPublicAddress(address: string): boolean {
  const a = address.toLowerCase().split("%")[0]!;
  if (a.startsWith("::ffff:")) return isPublicAddress(a.slice(7));
  if (isIP(a) === 6) {
    return !(a === "::1" || a === "::" || /^(f[c-f]|ff)/.test(a) || a.startsWith("2001:db8:") ||
      a.startsWith("2001:10:") || a.startsWith("2001:2:") || a.startsWith("100:") || a.startsWith("64:ff9b:1:"));
  }
  const p = a.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [x, y] = p as [number, number];
  return !(x === 0 || x === 10 || x === 127 || x >= 224 || (x === 169 && y === 254) || (x === 172 && y >= 16 &&
    y <= 31) || (x === 192 && (y === 0 || y === 88 || y === 168)) || (x === 100 && y >= 64 && y <= 127) ||
    (x === 198 && (y === 18 || y === 19 || y === 51)) || (x === 203 && y === 0));
}

/** A URL rafi may request: http or https, a host, no credentials. */
export function checkedUrl(input: string): URL | string {
  let url: URL;
  try { url = new URL(input); } catch { return `${input} isn't a URL.`; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return `${url.protocol} isn't http or https.`;
  if (url.username || url.password) return "a URL with credentials in it is refused.";
  if (!url.hostname) return "the URL has no host.";
  url.hash = "";
  return url;
}

export interface Request {
  readonly url: string;
  readonly method?: string;
  readonly body?: string;
  readonly headers?: Record<string, string>;
  /** Sent only while the request's origin is `origin`'s. */
  readonly token?: { header: string; value: string; origin: string };
  readonly publicOnly?: boolean;
}

export type Fetched = { ok: true; status: number; text: string; url: string } | { ok: false; message: string };

/** One request, with rafi's redirect rules. */
export async function fetchChecked(deps: Pick<Deps, "fetch">, r: Request): Promise<Fetched> {
  let url = checkedUrl(r.url);
  let token = r.token;
  for (let hops = 0; ; hops += 1) {
    if (typeof url === "string") return { ok: false, message: url };
    if (token && url.origin !== token.origin) token = undefined;
    const headers = { ...(r.headers ?? {}), ...(token ? { [token.header]: token.value } : {}) };
    let answer;
    try {
      answer = await deps.fetch(url.toString(), { method: hops ? "GET" : r.method, body: hops ? undefined : r.body,
        headers, allowAddress: r.publicOnly ? isPublicAddress : undefined });
    } catch (error) {
      return { ok: false, message: String((error as Error).message) };
    }
    if (answer.status < 300 || answer.status >= 400) {
      return { ok: true, status: answer.status, text: await answer.text(), url: url.toString() };
    }
    const location = Object.entries(answer.headers).find(([k]) => k.toLowerCase() === "location")?.[1];
    if (!location) return { ok: false, message: `${url.host} answered ${answer.status} with no Location.` };
    if (hops === MAX_REDIRECTS) return { ok: false, message: `more than ${MAX_REDIRECTS} redirects.` };
    url = checkedUrl(new URL(location, url).toString());
  }
}

/** The one request that checks a source; null for a local source (checked on disk). */
export function accessRequest(source: Source, env: Deps["env"]): Request | string | null {
  if (source.type === "local") return null;
  if (source.type === "url") return { url: source.url, publicOnly: true, headers: { Accept: "text/html,text/plain," +
    "text/markdown,application/json,application/pdf;q=0.9" } };
  if (source.type === "linear") {
    const name = source.api_key_env ?? "LINEAR_API_KEY";
    const key = env[name];
    if (!key) return `Linear: ${name} isn't set.`;
    return { url: "https://api.linear.app/graphql", method: "POST",
      body: JSON.stringify({ query: "{ viewer { id } }" }),
      headers: { "Content-Type": "application/json" }, token: { header: "Authorization", value: key,
        origin: "https://api.linear.app" } };
  }
  const email = env[source.email_env ?? "JIRA_EMAIL"];
  const token = env[source.token_env ?? "JIRA_API_TOKEN"];
  if (!email || !token) {
    return `Jira: ${source.email_env ?? "JIRA_EMAIL"} and ${source.token_env ?? "JIRA_API_TOKEN"} must both be set.`;
  }
  const site = checkedUrl(source.site);
  if (typeof site === "string") return `Jira: ${site}`;
  return { url: `${site.origin}/rest/api/3/myself`, headers: { Accept: "application/json" }, token: {
    header: "Authorization", value: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
    origin: site.origin } };
}

/** Checks one source; a line saying how it went, and whether it's fatal (a URL source that can't be read). */
export async function checkSource(deps: Pick<Deps, "fetch" | "env" | "fs">, project: string, source: Source):
  Promise<{ line: string; fatal: boolean }> {
  if (source.type === "local") {
    const missing = [];
    for (const p of source.paths) if (!(await deps.fs.stat(path.resolve(project, p)))) missing.push(p);
    return missing.length ? { line: `local source: ${missing.join(", ")} not found.`, fatal: true }
      : { line: `local source: ${source.paths.join(", ")} found.`, fatal: false };
  }
  const request = accessRequest(source, deps.env);
  if (typeof request === "string") return { line: `${request} Access not checked.`, fatal: false };
  const got = await fetchChecked(deps, request!);
  const fatal = source.type === "url";
  if (!got.ok) return { line: `${source.type} access check failed: ${got.message}`, fatal };
  if (got.status >= 400) return { line: `${source.type} access check failed: HTTP ${got.status}.`, fatal };
  return { line: `${source.type} access checked (HTTP ${got.status}).`, fatal: false };
}
