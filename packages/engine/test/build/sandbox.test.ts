// C40 and item 28 (M2 plan): grants → the sandbox argv prefix (pure), and what's missing on a machine without one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { missingReason, sandboxInfo, sandboxPrefix } from "../../src/build/sandbox.js";
import { testEnv } from "../../src/build/env.js";

const W = "/work/proj";
const C = "/work/proj/.rafi/cache";

function profileOf(prefix: readonly string[]): string {
  const i = prefix.indexOf("-p");
  assert.ok(i >= 0, `no -p in ${prefix.join(" ")}`);
  return prefix[i + 1]!;
}

test("macOS: sandbox-exec with the worktree and cache writable, network denied with no grants", () => {
  const prefix = sandboxPrefix({ tool: "sandbox-exec", worktree: W, cache: C, grants: { needs: [] } });
  assert.equal(prefix[0], "/usr/bin/sandbox-exec");
  assert.ok(prefix.includes(`WORKTREE=${W}`) && prefix.includes(`CACHE=${C}`), prefix.join(" "));
  const profile = profileOf(prefix);
  assert.match(profile, /\(deny file-write\*\)/);
  assert.match(profile, /\(allow file-write\* \(subpath \(param "WORKTREE"\)\)/);
  assert.match(profile, /\(deny network\*\)/);
  assert.doesNotMatch(profile, /localhost/);
  assert.equal(prefix.at(-1), "--");
});

test("macOS: local-servers allows loopback only; internet allows the network", () => {
  const local = profileOf(sandboxPrefix({ tool: "sandbox-exec", worktree: W, cache: C,
    grants: { needs: ["local-servers"] } }));
  assert.match(local, /\(deny network\*\)/);
  assert.match(local, /\(allow network-outbound \(remote ip "localhost:\*"\)\)/);
  assert.doesNotMatch(local, /\(allow network\*/, "network* with a local-ip filter lets public connects through");
  const internet = profileOf(sandboxPrefix({ tool: "sandbox-exec", worktree: W, cache: C,
    grants: { needs: ["internet"] } }));
  assert.doesNotMatch(internet, /deny network/);
});

test("Linux: bwrap read-only root, worktree and cache writable, private /tmp, no network without internet", () => {
  const prefix = sandboxPrefix({ tool: "bwrap", worktree: W, cache: C, grants: { needs: ["local-servers"] } });
  const text = prefix.join(" ");
  assert.equal(prefix[0], "bwrap");
  assert.match(text, /--ro-bind \/ \//);
  assert.match(text, new RegExp(`--bind ${W} ${W}`));
  assert.match(text, new RegExp(`--bind ${C} ${C}`));
  assert.match(text, /--tmpfs \/tmp/);
  assert.match(text, /--unshare-net/);
  assert.match(text, /--die-with-parent/);
  assert.equal(prefix.at(-1), "--");
  const internet = sandboxPrefix({ tool: "bwrap", worktree: W, cache: C, grants: { needs: ["internet"] } });
  assert.ok(!internet.includes("--unshare-net"));
});

test("threat 9: rafi's records and git's folder in the worktree stay read-only; the cache stays writable", () => {
  const mac = sandboxPrefix({ tool: "sandbox-exec", worktree: W, cache: C, grants: { needs: [] } });
  for (const [name, dir] of [["GIT", ".git"], ["RAFI", ".rafi"], ["TICKETS", ".tickets"]]) {
    assert.ok(mac.includes(`${name}=${W}/${dir}`), `${name}: ${mac.join(" ")}`);
  }
  const profile = profileOf(mac);
  const deny = profile.indexOf('(deny file-write* (subpath (param "GIT")) (subpath (param "RAFI")) ' +
    '(subpath (param "TICKETS")))');
  assert.ok(deny > profile.indexOf('(allow file-write* (subpath (param "WORKTREE"))'), profile);
  assert.ok(profile.lastIndexOf('(allow file-write* (subpath (param "CACHE")))') > deny, "the cache re-allowed last");
  const linux = sandboxPrefix({ tool: "bwrap", worktree: W, cache: C, grants: { needs: [] } }).join(" ");
  for (const dir of [".git", ".rafi", ".tickets"]) {
    assert.match(linux, new RegExp(`--ro-bind-try ${W}/${dir} ${W}/${dir}`), dir);
  }
  assert.ok(linux.indexOf(`--bind ${C} ${C}`) > linux.indexOf(`--ro-bind-try ${W}/.rafi`), "cache bound after");
});

test("what's missing is named for each machine without a sandbox", () => {
  assert.equal(missingReason({ platform: "linux", bwrap: null, bwrapWorks: false }), "bubblewrap isn't installed");
  assert.match(missingReason({ platform: "linux", bwrap: "/usr/bin/bwrap", bwrapWorks: false })!,
    /user namespaces are blocked/);
  assert.match(missingReason({ platform: "win32", bwrap: null, bwrapWorks: false })!, /Windows/);
  assert.equal(missingReason({ platform: "linux", bwrap: "/usr/bin/bwrap", bwrapWorks: true }), null);
  assert.equal(missingReason({ platform: "darwin", sandboxExec: true }), null);
  assert.match(missingReason({ platform: "darwin", sandboxExec: false })!, /sandbox-exec/);
  assert.deepEqual(sandboxInfo({ platform: "linux", bwrap: null, bwrapWorks: false }),
    { available: false, missing: "bubblewrap isn't installed" });
  assert.deepEqual(sandboxInfo({ platform: "darwin", sandboxExec: true }), { available: true, tool: "sandbox-exec" });
});

test("C41: caches and TMPDIR point under .rafi/cache/", () => {
  const env = testEnv({ PATH: "/usr/bin", HOME: "/home/me" }, { checksEnv: [], cache: C, platform: "linux" })
    .env;
  assert.equal(env.npm_config_cache, `${C}/npm`);
  assert.equal(env.YARN_CACHE_FOLDER, `${C}/yarn`);
  assert.equal(env.XDG_CACHE_HOME, `${C}/xdg`);
  assert.equal(env.TMPDIR, `${C}/tmp`);
  assert.equal(env.PATH, "/usr/bin");
});
