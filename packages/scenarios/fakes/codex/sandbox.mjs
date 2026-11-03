// The fake app-server's sandbox state, as real codex-cli 0.164 behaves in free probes (.rafi-build/
// threat30-options.md, M2 plan 10.8 e+): a permission profile (defined in the thread config's `permissions`, or the
// built-in `:workspace` and `:read-only`) or the legacy `sandbox`/`sandboxPolicy`; `permissions` can't be combined
// with either, and a later legacy `sandboxPolicy` clears the profile. Under `on-request`, a write the sandbox allows
// runs unasked, a write to a `read` path fails, and a write outside the root or under read-only asks.
import path from "node:path";

const BUILT_IN = { ":workspace": { ".": "write", ".git": "read" }, ":read-only": { ".": "read" } };

export function createSandbox() {
  let profile = null;
  let profiles = {};
  let legacy = "workspace-write";

  /** The `:project_roots` entry that covers `rel` (the longest key that is it or a parent folder). */
  const entryFor = (entries, rel) => {
    let best = null;
    for (const key of Object.keys(entries)) {
      const k = key === "." ? "" : key;
      if ((k === "" || rel === k || rel.startsWith(`${k}/`)) && (best === null || k.length > best.length)) best = k;
    }
    return best === null ? "read" : entries[best === "" ? "." : best];
  };

  return {
    /** thread/start or thread/resume; returns the refusal text, or null. */
    thread(params) {
      if (params.permissions && params.sandbox) return "`permissions` cannot be combined with `sandbox`";
      profiles = params.config?.permissions ?? {};
      profile = params.permissions ?? null;
      legacy = params.sandbox ?? "workspace-write";
      return null;
    },
    /** turn/start; a legacy sandboxPolicy replaces (clears) the profile. */
    turn(params) {
      if (params.permissions && params.sandboxPolicy) return "`permissions` cannot be combined with `sandboxPolicy`";
      if (params.permissions) profile = params.permissions;
      else if (params.sandboxPolicy) {
        profile = null;
        legacy = params.sandboxPolicy.type === "readOnly" ? "read-only" : "workspace-write";
      }
      return null;
    },
    profile: () => profile,
    active: () => (profile ? { id: profile, extends: profiles[profile]?.extends ?? null } : null),
    /** "write" (runs unasked), "read" (fails with EPERM) or "ask" (an approval request). */
    access(root, file) {
      const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join("/");
      if (rel.startsWith("..") || path.isAbsolute(rel)) return "ask";
      if (!profile && legacy === "read-only") return "ask";
      const entries = profile ? profiles[profile]?.filesystem?.[":project_roots"] ?? BUILT_IN[profile] ?? {}
        : BUILT_IN[":workspace"];
      return entryFor(entries, rel) === "write" ? "write" : "read";
    },
  };
}
