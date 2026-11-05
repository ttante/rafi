// M5 plan item 31b (C230, P47): rafi's own redirect rules over a fetch that never follows one. A scripted fetch
// answers by URL and records each request's headers.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Deps, FetchOptions } from "../../src/deps/types.js";
import { accessRequest, checkSource, fetchChecked, isPublicAddress } from "../../src/tickets/sources.js";

type Answer = { status: number; location?: string };
function scripted(routes: Record<string, Answer>, addresses: Record<string, string> = {}) {
  const log: { url: string; headers: Record<string, string> }[] = [];
  const fetch: Deps["fetch"] = async (url: string, o: FetchOptions) => {
    const host = new URL(url).hostname;
    if (o.allowAddress && !o.allowAddress(addresses[host] ?? "93.184.216.34")) throw new Error(`${host} is private`);
    log.push({ url, headers: { ...(o.headers ?? {}) } });
    const a = routes[url] ?? { status: 404 };
    const headers: Record<string, string> = a.location ? { Location: a.location } : {};
    return { status: a.status, headers, text: async () => "ok" };
  };
  return { fetch, log };
}
const token = { header: "Authorization", value: "secret-1", origin: "https://api.linear.app" };

test("a same-origin redirect keeps the token", async () => {
  const s = scripted({ "https://api.linear.app/a": { status: 302, location: "/b" }, "https://api.linear.app/b":
    { status: 200 } });
  const r = await fetchChecked(s, { url: "https://api.linear.app/a", token });
  assert.ok(r.ok);
  assert.deepEqual(s.log.map((x) => x.headers.Authorization), ["secret-1", "secret-1"]);
});

test("a redirect to another host, or from https to http, drops the token for the rest of the check", async () => {
  const s = scripted({ "https://api.linear.app/a": { status: 302, location: "https://evil.example/x" },
    "https://evil.example/x": { status: 302, location: "https://api.linear.app/c" },
    "https://api.linear.app/c": { status: 200 } });
  assert.ok((await fetchChecked(s, { url: "https://api.linear.app/a", token })).ok);
  assert.deepEqual(s.log.map((x) => x.headers.Authorization), ["secret-1", undefined, undefined],
    "never sent again once a hop left the origin");
  const down = scripted({ "https://api.linear.app/a": { status: 301, location: "http://api.linear.app/a" },
    "http://api.linear.app/a": { status: 200 } });
  assert.ok((await fetchChecked(down, { url: "https://api.linear.app/a", token })).ok);
  assert.deepEqual(down.log.map((x) => x.headers.Authorization), ["secret-1", undefined]);
});

test("a redirect to a private address is refused for URL sources", async () => {
  const s = scripted({ "https://docs.example/a": { status: 302, location: "https://intranet.example/b" } },
    { "intranet.example": "10.0.0.5" });
  const r = await fetchChecked(s, { url: "https://docs.example/a", publicOnly: true });
  assert.equal(r.ok, false);
  assert.equal(s.log.length, 1, "nothing was sent to the private host");
  for (const a of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "169.254.169.254", "::1", "fd00::1",
    "::ffff:127.0.0.1", "100.64.0.1"]) assert.equal(isPublicAddress(a), false, a);
  assert.equal(isPublicAddress("93.184.216.34"), true);
});

test("the sixth redirect is refused; a Location with credentials, or none, is an error", async () => {
  const loop: Record<string, Answer> = {};
  for (let n = 0; n <= 6; n += 1) loop[`https://a.example/${n}`] = { status: 302, location: `/${n + 1}` };
  const s = scripted(loop);
  const r = await fetchChecked(s, { url: "https://a.example/0" });
  assert.equal(r.ok, false);
  assert.match((r as { message: string }).message, /more than 5 redirects/);
  assert.equal(s.log.length, 6, "the first request and five redirects");
  const creds = scripted({ "https://a.example/x": { status: 302, location: "https://u:p@a.example/y" } });
  assert.match((await fetchChecked(creds, { url: "https://a.example/x" }) as { message: string }).message,
    /credentials/);
  const none = scripted({ "https://a.example/x": { status: 302 } });
  assert.match((await fetchChecked(none, { url: "https://a.example/x" }) as { message: string }).message,
    /no Location/);
});

test("Linear and Jira tokens come from the environment by name; each check is one request", async () => {
  const s = scripted({ "https://api.linear.app/graphql": { status: 200 }, "https://acme.atlassian.net/rest/api/3/myself":
    { status: 200 } });
  const env = { LINEAR_API_KEY: "lin-1", JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "jt" };
  const fs = { stat: async () => null } as unknown as Deps["fs"];
  const linear = await checkSource({ ...s, env, fs }, "/p", { type: "linear" });
  const jira = await checkSource({ ...s, env, fs }, "/p", { type: "jira", site: "https://acme.atlassian.net",
    jql: "project = X" });
  assert.equal(linear.fatal || jira.fatal, false);
  assert.equal(s.log.length, 2);
  assert.equal(s.log[0]!.headers.Authorization, "lin-1");
  assert.match(String(s.log[1]!.headers.Authorization), /^Basic /);
  assert.equal(accessRequest({ type: "linear", api_key_env: "MISSING" }, env), "Linear: MISSING isn't set.");
});
