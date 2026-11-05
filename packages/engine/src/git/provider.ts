// `gh` and `glab` (C199, C201, C216; R14, R15): argument arrays through deps.exec with the provider allowlist of
// environment variables; a PR looked up by its head branch before one is made, and "already exists" adopted after a
// second lookup; failure text sorted into 5.1's categories. GitLab's merge requests take the same shape.
import { providerEnv } from "../agents/env.js";
import type { BuildContext } from "../build/context.js";

/** What a provider call needs (start's readiness check runs before the build's context exists). */
type Ctx = Pick<BuildContext, "engine" | "deps">;
import { gitTry } from "./run.js";

export type Provider = "github" | "gitlab";
export type Category = "transient" | "conflict" | "auth" | "rejected";

export interface Pr {
  readonly url: string;
  readonly state: "open" | "merged" | "closed";
  readonly draft: boolean;
  readonly conflicting: boolean;
}

export class ProviderFailed extends Error {
  constructor(readonly category: Category, message: string) { super(message); }
}

/** C201: network and rate limits → transient; login → auth; conflicts → conflict; anything else → rejected. */
export function categoryOf(text: string): Category {
  if (/rate limit|timed? ?out|could not resolve|connection|network|50[0234]\b|temporar/i.test(text)) return "transient";
  if (/auth|log ?in|credential|401|403|token/i.test(text)) return "auth";
  if (/conflict|not mergeable|merge commit cannot be cleanly/i.test(text)) return "conflict";
  return "rejected";
}

/** `auto`: the origin's host names the provider; a remote that names neither isn't a PR provider. */
export async function providerFor(ctx: Ctx, chosen: string): Promise<Provider | null> {
  if (chosen === "github" || chosen === "gitlab") return chosen;
  if (chosen === "local") return null;
  const at = { deps: ctx.deps, project: ctx.engine.projectDir };
  const r = await gitTry(at, ctx.engine.projectDir, ["remote", "get-url", "origin"]);
  const url = r.code === 0 ? r.stdout : "";
  return /gitlab/i.test(url) ? "gitlab" : /github/i.test(url) ? "github" : null;
}

const exe = (p: Provider) => (p === "github" ? "gh" : "glab");
const shown = (p: Provider) => (p === "github" ? "GitHub" : "GitLab");

async function call(ctx: Ctx, p: Provider, cwd: string, args: string[]) {
  const r = await ctx.deps.exec(exe(p), args, { cwd, env: providerEnv(ctx.deps.env, ctx.deps.machine.platform) });
  // The category comes from git's own text: a redaction marker ("[REDACTED:GH_TOKEN]") must not make it `auth`.
  const raw = (r.stderr || r.stdout).trim();
  return { ok: r.code === 0, out: r.stdout.trim(), err: ctx.engine.redact(raw), category: categoryOf(raw) };
}

async function must(ctx: Ctx, p: Provider, cwd: string, args: string[], what: string): Promise<string> {
  const r = await call(ctx, p, cwd, args);
  if (!r.ok) throw new ProviderFailed(r.category, `${shown(p)}: ${what} failed: ${r.err.split("\n")[0]}`);
  return r.out;
}

/** PRM-78's check: the provider's login is ready. */
export async function readiness(ctx: Ctx, p: Provider): Promise<string | null> {
  const r = await call(ctx, p, ctx.engine.projectDir, ["auth", "status"]);
  const why = (r.err.split("\n")[0] || "no login").replace(/\.+$/, "");
  return r.ok ? null : `${shown(p)} isn't ready: ${why}. Fix it with \`${exe(p)} ` +
    "auth login`, then run `rafi resume`.";
}

function parsePr(raw: unknown): Pr | null {
  const x = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
  // gh prints `url`, `isDraft`, `mergeable`; glab GitLab's `web_url`, `draft`, `has_conflicts`, merge statuses (C360).
  const url = x?.url ?? x?.web_url;
  if (!x || typeof url !== "string") return null;
  const state = String(x.state ?? "").toLowerCase();
  const conflicting = x.has_conflicts === true || /conflict|cannot_be_merged/i.test(String(x.mergeable ?? "") +
    String(x.detailed_merge_status ?? "") + String(x.merge_status ?? ""));
  return { url, state: state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
    draft: Boolean(x.isDraft ?? x.draft), conflicting };
}

/** The PR (or MR) whose head is `branch`, in any state, or null. */
export async function findPr(ctx: Ctx, p: Provider, cwd: string, branch: string): Promise<Pr | null> {
  const args = p === "github"
    ? ["pr", "list", "--head", branch, "--state", "all", "--json", "url,state,isDraft,mergeable", "--limit", "1"]
    : ["mr", "list", "--source-branch", branch, "--all", "--output", "json"];
  const out = await must(ctx, p, cwd, args, `looking up the PR for ${branch}`);
  try { return parsePr(JSON.parse(out || "[]")); } catch { return null; }
}

export async function viewPr(ctx: Ctx, p: Provider, cwd: string, url: string): Promise<Pr | null> {
  const args = p === "github" ? ["pr", "view", url, "--json", "url,state,isDraft,mergeable"]
    : ["mr", "view", url, "--output", "json"];
  const out = await must(ctx, p, cwd, args, `checking ${url}`);
  try { return parsePr(JSON.parse(out)); } catch { return null; }
}

/** R14: created, or (when the provider says one already exists for the head) the one found by a second lookup. */
export async function createPr(ctx: Ctx, p: Provider, cwd: string,
  o: { branch: string; base: string; title: string; bodyFile: string; draft: boolean }): Promise<Pr> {
  const args = p === "github"
    ? ["pr", "create", "--head", o.branch, "--base", o.base, "--title", o.title, "--body-file", o.bodyFile]
    : ["mr", "create", "--source-branch", o.branch, "--target-branch", o.base, "--title", o.title,
      "--description-file", o.bodyFile, "--yes"];
  if (o.draft) args.push("--draft");
  const r = await call(ctx, p, cwd, args);
  if (!r.ok && !/already exists/i.test(r.err)) {
    throw new ProviderFailed(r.category, `${shown(p)}: opening the PR for ${o.branch} failed: ` +
      `${r.err.split("\n")[0]}`);
  }
  const pr = await findPr(ctx, p, cwd, o.branch);
  if (pr) return pr;
  const url = r.out.split("\n").find((l) => /^https?:\/\//.test(l));
  if (!url) throw new ProviderFailed("rejected", `${shown(p)}: no PR was found for ${o.branch} after creating it.`);
  return { url, state: "open", draft: o.draft, conflicting: false };
}

export const readyPr = (ctx: Ctx, p: Provider, cwd: string, url: string) => must(ctx, p, cwd,
  p === "github" ? ["pr", "ready", url] : ["mr", "update", url, "--ready"], `marking ${url} ready`);

export const autoMerge = (ctx: Ctx, p: Provider, cwd: string, url: string, method: string) => must(ctx, p,
  cwd, p === "github" ? ["pr", "merge", url, "--auto", `--${method}`]
    : ["mr", "merge", url, "--when-pipeline-succeeds", ...(method === "squash" ? ["--squash"] : [])],
  `turning on auto-merge for ${url}`);
