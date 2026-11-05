// Your shell's credentials stay out of every test run (C342, made the default in part 4d, plan 10.12): provider
// tokens (GH_*, GITHUB_*, GITLAB_*, GLAB_*) and model or agent credentials (ANTHROPIC_*, OPENAI_*, CODEX_*,
// CLAUDE_*, CLAUDECODE). The fakes need none of them; a test that wants one passes it on purpose in its own `env`,
// which is added after this. Plain ESM, shared by the process launchers and the test runners.
export const SHELL_SECRETS = /^(?:GH_|GITHUB_|GITLAB_|GLAB_|ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_|CLAUDECODE$)/;

/** `env` (default: this process's) without SHELL_SECRETS' names. */
export function shellEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SHELL_SECRETS.test(k)));
}
