// The fake `gh` and `glab` state machine (M5 plan C216), shared by the in-process handler (`fakes/gh.ts`, the fast
// suite) and the executables of the process set (C340): one state, one JSON file format `{prs, calls, notReady,
// mergeAfterViews}`. As an executable, `gh-cli.mjs <state.json> <gh|glab> [args…]` loads the state file, records the
// call (its arguments, cwd, the names and values of the environment it got), answers it, and saves the file. The
// PATH entries `gh` and `glab` that `writeGhExecutables` writes bake in the state file's path, since rafi passes the
// provider only C199's allowlisted environment (no variable could carry it).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const no = (stderr, code = 1) => ({ code, stdout: "", stderr });
const flag = (args, name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] ?? null : null;
};

/** Opens a PR as the provider would (a race test's competitor uses it too). */
export function openPr(gh, o) {
  const number = gh.prs.length + 1;
  const pr = { number, url: `https://github.example/acme/fixture/pull/${number}`, head: o.head, base: o.base,
    title: o.title ?? o.head, body: o.body ?? "", draft: o.draft ?? false, state: "OPEN", autoMerge: null, views: 0,
    mergeable: "MERGEABLE" };
  gh.prs.push(pr);
  return pr;
}

const json = (pr) => ({ url: pr.url, state: pr.state, isDraft: pr.draft, mergeable: pr.mergeable,
  number: pr.number, headRefName: pr.head, baseRefName: pr.base });

const byRef = (gh, ref) => gh.prs.find((p) => p.url === ref || String(p.number) === ref || p.head === ref);

/** `gh` (and `glab`'s same verbs under `mr`): one call against the state, which it changes in place. */
export function handle(gh, args) {
  const [group, verb] = args;
  if (group === "auth" && verb === "status") {
    return gh.notReady ? no("You are not logged into any GitHub hosts.") : ok();
  }
  if (group !== "pr" && group !== "mr") return no(`unknown command ${group}`);
  if (verb === "list") {
    const head = flag(args, "--head") ?? flag(args, "--source-branch");
    return ok(JSON.stringify(gh.prs.filter((p) => p.head === head).map(json)));
  }
  if (verb === "create") {
    const head = flag(args, "--head") ?? flag(args, "--source-branch");
    const existing = gh.prs.find((p) => p.head === head && p.state === "OPEN");
    if (existing) return no(`a pull request for branch "${head}" into branch "${existing.base}" already exists:\n` +
      existing.url);
    const file = flag(args, "--body-file") ?? flag(args, "--description-file");
    const pr = openPr(gh, { head, base: flag(args, "--base") ?? flag(args, "--target-branch") ?? "main",
      title: flag(args, "--title") ?? head, body: file ? readFileSync(file, "utf8") : "",
      draft: args.includes("--draft") });
    return ok(`${pr.url}\n`);
  }
  const pr = byRef(gh, args[2]);
  if (!pr) return no(`no pull requests found for ${args[2]}`);
  if (verb === "view") {
    pr.views += 1;
    // A provider never auto-merges a PR that conflicts with its base.
    if (pr.autoMerge && pr.state === "OPEN" && pr.mergeable === "MERGEABLE" && gh.mergeAfterViews !== null &&
      pr.views >= gh.mergeAfterViews) {
      pr.state = "MERGED";
    }
    return ok(JSON.stringify(json(pr)));
  }
  if (pr.state !== "OPEN") return no(`Pull request #${pr.number} is ${pr.state.toLowerCase()}`);
  if (verb === "ready" || (verb === "update" && args.includes("--ready"))) { pr.draft = false; return ok(); }
  if (verb === "merge" && (args.includes("--auto") || args.includes("--when-pipeline-succeeds"))) {
    pr.autoMerge = args.find((a) => ["--merge", "--squash", "--rebase"].includes(a))?.slice(2) ?? "merge";
    return ok();
  }
  return no(`unknown command ${group} ${verb}`);
}

/** The call as recorded: the same fields in both modes. */
export function record(cmd, args, cwd, env) {
  return { cmd, args: [...args], env: Object.keys(env ?? {}).sort(), envValues: { ...(env ?? {}) }, cwd };
}

/** The state file's data fields (functions such as `onCall` stay in-process only). */
export const stateOf = (gh) => ({ prs: gh.prs, calls: gh.calls, notReady: gh.notReady,
  mergeAfterViews: gh.mergeAfterViews });

export function loadState(file) {
  return { prs: [], calls: [], notReady: false, mergeAfterViews: null, ...JSON.parse(readFileSync(file, "utf8")) };
}

export function saveState(gh, file) {
  writeFileSync(file, `${JSON.stringify(stateOf(gh), null, 2)}\n`);
}

/** The executable: rafi calls the provider one call at a time, so a plain read-modify-write is enough. */
export function main(file, cmd, args) {
  const gh = loadState(file);
  gh.calls.push(record(cmd, args, process.cwd(), process.env));
  const r = handle(gh, args);
  saveState(gh, file);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(`${r.stderr}\n`);
  process.exitCode = r.code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [file, cmd, ...args] = process.argv.slice(2);
  main(file, cmd, args);
}
