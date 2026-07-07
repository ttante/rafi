# Releasing

Use this checklist for every user-visible release.

## Required checks

```sh
pnpm -r build
pnpm -r test
pnpm -r typecheck
```

## Release checklist

1. Update package versions in the packages being released.
2. Update `CHANGELOG.md` with user-facing changes, migrations, fixes, and known risks.
3. Confirm package metadata points at `https://github.com/ttante/rafi`.
4. Run the required checks from a clean working tree.
5. Publish npm packages from the intended package directories.
6. Create signed or annotated git tags for released package versions.
7. Push tags to GitHub.
8. Create GitHub Releases from the pushed tags and paste the matching changelog entries.

## Tag naming

Use package-scoped tags when package versions differ:

```sh
git tag -a rafi-cli-v0.3.6 -m "@rafi-ai/cli v0.3.6"
git tag -a special-agents-v0.3.6 -m "special-agents v0.3.6"
git tag -a ai-foreman-v1.0.7 -m "ai-foreman v1.0.7"
```

If every public package is released together at the same version, a repo-wide tag such as `v0.4.0` is acceptable.

## GitHub Packages

Rafi currently publishes packages to npm. GitHub Packages is not the canonical package registry for this repository unless that publishing target is added later.
