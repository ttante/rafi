// The Codex builder's permission profile (ARCH 7.11, threat 30; M2 plan C83): rafi defines it in the thread config
// and selects it on thread/start, thread/resume and every turn/start, never the legacy `sandbox`/`sandboxPolicy`
// (a later sandboxPolicy silently clears a profile). The builder writes its worktree; `.rafi/`, `.tickets/` and
// `.git/` stay read-only and `.rafi/cache/` writable. `.git` needs its own `read` entry: without it the root's write
// entry makes `.git/` writable, which `:workspace` alone denies (M2 plan 10.8 e+). Free probes, macOS, codex-cli
// 0.164.0; Linux and Windows unverified until CI. Worktree builds (M5, where `.git` is a file) recheck the entry.
// P48 (M5): `rafi-config.yaml` gets a single-file `read` entry, so a builder can't widen its own settings; the free
// probe (engine/test/deps/codex-profile.real.test.ts, codex-cli 0.164.0, macOS) confirms the file is denied and a
// file beside it isn't.

export const BUILDER_PROFILE = "rafi_builder";
export const BUILDER_INTERNET_PROFILE = "rafi_builder_internet";

const ROOTS: Readonly<Record<string, "read" | "write">> = Object.freeze({
  ".": "write", ".rafi": "read", ".rafi/cache": "write", ".tickets": "read", ".git": "read",
  "rafi-config.yaml": "read",
});

/** The thread config's `permissions` table: both profiles, so a turn can switch to the internet one. */
export function builderProfiles(): Record<string, unknown> {
  const filesystem = { ":project_roots": { ...ROOTS } };
  return {
    [BUILDER_PROFILE]: { extends: ":workspace", filesystem },
    [BUILDER_INTERNET_PROFILE]: { extends: ":workspace", filesystem, network: { enabled: true } },
  };
}

/** The profile a builder turn runs under: internet only when the build granted it. */
export function builderProfile(grants: readonly string[]): string {
  return grants.includes("internet") ? BUILDER_INTERNET_PROFILE : BUILDER_PROFILE;
}

/**
 * Codex's shells (C79): what the app-server got, minus Codex's API key, set in the thread config. Free probe
 * S0.2 (codex-cli 0.164.0): the app-server honors it, and a project `.codex/config.toml` can't widen it.
 */
export function codexShellPolicy(): Record<string, unknown> {
  return { inherit: "all", exclude: ["OPENAI_*"] };
}
