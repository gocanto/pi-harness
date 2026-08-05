# Plan 009: Give workflows an explicit workspace package boundary

> **Executor instructions**: Read `/Users/gocanto/Sites/pi-harness/.agents/skills/typescript-coding-standards/SKILL.md` before changing TypeScript. Preserve the extension’s runtime loading behavior while making package ownership explicit.
>
> **Drift check (run first)**: `git diff --stat c153b67..HEAD -- extensions/workflows pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.json`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: architecture
- **Planned at**: commit `c153b67`, 2026-07-31
- **Drift reconciliation**: refreshed after plans 005–008; preserve the workflow sandbox deadline and all merged baseline/package metadata changes.
- **Ollin state**: PR READY
- **Worktree**: `/Users/gocanto/Sites/pi-harness-ollin-009`
- **Branch**: `ollin/009-workflows-package-boundary`
- **Base**: `ollin/008-retry-pull-request-lookups` at `c153b67`
- **Commit**: `a9316e0 Give workflows an explicit workspace package boundary`
- **Review**: APPROVE; package discovery, local typecheck, lockfile scope, full verification, and runtime import verified by parent
- **Pull request**: https://github.com/gocanto/pi-harness/pull/11
- **Gates**: GitHub Actions `Verify` passed; merge state CLEAN; no actionable reviews or comments

## Why this matters

The workspace treats each `extensions/*` directory as a package, but workflows has no package manifest or local tsconfig. Root dependencies and the root catch-all compiler hide this boundary; `pnpm --filter workflows check` currently matches no project. An explicit package makes the extension independently verifiable and maintainable.

## Current state

- `pnpm-workspace.yaml:1-2` includes `extensions/*`.
- `extensions/workflows/index.ts` is the extension entry point and imports root dependencies plus `../shared`.
- `extensions/workflows/sandbox.ts` now includes the bounded workflow deadline from plan 005.
- `tsconfig.json:13` includes all extension TypeScript files from the root.
- `extensions/workflows` has tests but no `package.json` or `tsconfig.json`.

## Commands you will need

| Purpose             | Command                         | Expected                          |
| ------------------- | ------------------------------- | --------------------------------- |
| Workspace discovery | `pnpm --filter workflows check` | succeeds after the package exists |
| Root typecheck      | `pnpm run check`                | exit 0                            |
| Tests               | `pnpm test`                     | all pass                          |
| Formatting          | `pnpm run format:check`         | exit 0                            |

## Scope

**In scope**: `extensions/workflows/package.json`, `extensions/workflows/tsconfig.json`, dependency declarations, and the minimum root workspace/typecheck adjustment required for consistency.

**Out of scope**: splitting `extensions/shared`, refactoring dashboard/runner code, or changing runtime APIs.

## Steps

### Step 1: Define the package manifest and local compiler config

Add a private ESM workspace manifest with the dependencies actually imported by workflows (`@earendil-works/pi-*`, `acorn`, `effect`, `typebox`, and any other direct imports). Add a local strict no-emit tsconfig matching the neighboring extensions and including the package’s `.ts` files. Do not duplicate dependencies unnecessarily if pnpm workspace resolution permits a documented shared policy.

**Verify**: `pnpm --filter workflows check` → exit 0; `pnpm install --frozen-lockfile` → exit 0.

### Step 2: Prevent accidental root-only masking

Confirm the package check covers all workflow source/tests and that root check still passes. If root config must retain shared-file coverage, document why rather than deleting it blindly.

**Verify**: `pnpm run check && pnpm test` → exit 0.

## Test plan

No behavior changes are intended. Run the new filtered check plus the root test suite and verify package discovery with `pnpm list --depth 0 --filter workflows`.

## Done criteria

- [ ] `pnpm --filter workflows check` matches and passes.
- [ ] Direct dependencies are declared by the package or documented workspace policy.
- [ ] Root check/tests remain green.
- [ ] Lockfile changes are limited to the new workspace package metadata.

## STOP conditions

- A direct import cannot be assigned to a package dependency without changing runtime architecture.
- Local package checking exposes pre-existing errors that require source refactoring.
- Shared-helper ownership must be redesigned to make the package valid.

## Maintenance notes

New workflow imports must be added to this package manifest. Keep the local tsconfig aligned with other extension packages and avoid relying solely on the root catch-all check.
