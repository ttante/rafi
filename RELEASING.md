# Releasing

## Publish and tag (after the release PR is merged)

Run from the merged `main`. No install or build step is needed: `ai-foreman` and
`@rafi-ai/cli` build themselves on publish, and `rafi-spec` / `special-agents`
publish their existing local `dist` (rebuild them first only if their source
changed since the last build: `pnpm --filter rafi-spec build && pnpm --filter special-agents build`).

**Publish, in this order** (dependencies first). Only the scoped CLI needs
`--access public`; the other three are unscoped and public by default.

```sh
cd /Users/tyler/reps/activeWork/rafi/packages/spec && npm publish
cd ../special-agents && npm publish
cd ../ai-foreman && npm publish
cd ../rafi && npm publish --access public
```

Skip any package whose version did not change.

**Then tag.** Lightweight tags, named `<package>-v<version>`:

```sh
cd /Users/tyler/reps/activeWork/rafi && git tag rafi-spec-v<X> && git tag special-agents-v<X> && git tag ai-foreman-v<X> && git tag rafi-cli-v<X> && git push origin rafi-spec-v<X> special-agents-v<X> ai-foreman-v<X> rafi-cli-v<X>
```

| Package | Directory | Tag prefix |
|---|---|---|
| `rafi-spec` | `packages/spec` | `rafi-spec-v` |
| `special-agents` | `packages/special-agents` | `special-agents-v` |
| `ai-foreman` | `packages/ai-foreman` | `ai-foreman-v` |
| `@rafi-ai/cli` | `packages/rafi` | `rafi-cli-v` |

## Before the release PR

1. Bump versions in the packages being released (and `pnpm-lock.yaml`).
2. Check each version is not already on npm: `npm view @rafi-ai/cli@<version> version`.
3. Add a `CHANGELOG.md` entry: user-facing changes, migrations, fixes, known risks.
4. Run the checks:

   ```sh
   pnpm -r build && pnpm -r typecheck && pnpm -r test
   ```

   With authenticated local Claude and Codex runtimes, a release candidate can
   also run `pnpm run test:live-interview` (needs Linux `script`, Docker
   Compose, and both runtime CLIs logged in; on demand, not CI).

Packages are published to npm only, not GitHub Packages.
