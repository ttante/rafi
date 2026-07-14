# Releasing

Use this checklist for every user-visible release.

## Required checks

```sh
pnpm -r build
pnpm -r test
pnpm -r typecheck
```

For packages being published, also run npm dry-runs from each package directory:

```sh
npm publish --dry-run --access public
```

## Release checklist

1. Update package versions in the packages being released.
2. Verify each intended version is not already on npm, for example `npm view @rafi-ai/cli@0.5.0 version`.
3. Update `CHANGELOG.md` with user-facing changes, migrations, fixes, and known risks.
4. Confirm package metadata points at `https://github.com/ttante/rafi`.
5. Run the required checks from the release-candidate working tree.
6. Publish npm packages from the intended package directories. Publish dependency packages before packages that depend on them. For example, publish `ai-foreman` before `@rafi-ai/cli` when the CLI depends on a new `ai-foreman` version.
7. Create signed or annotated git tags for released package versions.
8. Push tags to GitHub.
9. Create GitHub Releases from the pushed tags and paste the matching changelog entries.

## Tag naming

Use package-scoped tags when package versions differ:

```sh
git tag -a rafi-cli-v0.5.0 -m "@rafi-ai/cli v0.5.0"
git tag -a ai-foreman-v1.2.0 -m "ai-foreman v1.2.0"
```

If every public package is released together at the same version, a repo-wide tag such as `v0.4.0` is acceptable.

## GitHub Packages

Rafi currently publishes packages to npm. GitHub Packages is not the canonical package registry for this repository unless that publishing target is added later.
