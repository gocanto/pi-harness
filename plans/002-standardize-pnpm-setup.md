# Plan 002: Standardize setup on pnpm and declare prerequisites

> **Executor instructions**: Follow this plan exactly. Do not edit source implementation. Stop if the supported runtime cannot be inferred safely.
>
> **Drift check (run first)**: `git diff --stat 2ca3a7b..HEAD -- SETUP.md package.json pnpm-workspace.yaml pnpm-lock.yaml`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plan 001 (stack base includes its test-command/docs changes)
- **Category**: dx
- **Planned at**: commit `2ca3a7b`, 2026-07-31
- **Drift reconciliation**: refreshed after plan 001; preserve its `test`/`test:live` scripts and SETUP testing section.
- **Ollin state**: DONE
- **Merged**: `06ebe0d` (PR #3) into `main`
- **Worktree**: `/Users/gocanto/Sites/pi-harness-ollin-002`
- **Branch**: `ollin/002-standardize-pnpm-setup`
- **Base**: `ollin/001-separate-live-provider-tests` at `2ca3a7b`
- **Commit**: `3b134de Standardize setup on pnpm and declare prerequisites`
- **Review**: APPROVE; scope, diff, frozen install, tests, typecheck, and format check verified by parent
- **Pull request**: https://github.com/gocanto/pi-harness/pull/3
- **Gates**: local checks pass; GitHub reports no configured CI, completion checks, or reviews; branch merge state CLEAN

## Why this matters

The repository is a pnpm workspace, but setup tells users to run `npm install`. Dependencies such as Effect and the Claude SDK live in workspace package manifests, so following the documented command is not the supported installation path. Clear runtime and package-manager prerequisites make fresh installs reproducible.

## Current state

- `pnpm-workspace.yaml:1-2` includes `extensions/*` as workspace packages.
- `SETUP.md:3-8` still says `npm install` in `~/.pi/agent`; plan 001 additionally added a Testing section documenting `pnpm test` and `pnpm test:live`.
- `Makefile` uses pnpm for install and verification.
- `package.json` now contains the plan 001 deterministic test selection and root `test:live` script, but still has no `packageManager` or `engines` metadata.

## Commands you will need

| Purpose             | Command                          | Expected                     |
| ------------------- | -------------------------------- | ---------------------------- |
| Clean install check | `pnpm install --frozen-lockfile` | exit 0                       |
| Typecheck           | `pnpm run check`                 | exit 0                       |
| Tests               | `pnpm test`                      | all deterministic tests pass |
| Formatting          | `pnpm run format:check`          | exit 0                       |

## Scope

**In scope**: `SETUP.md`, root `package.json`, and only lockfile changes required by metadata.

**Out of scope**: dependency version upgrades, workspace layout changes, extension source, and generated artifacts.

## Steps

### Step 1: Declare the package manager and supported Node range

Add `packageManager` using the repository’s verified pnpm major/version and an `engines` entry for Node and pnpm. Use the current supported runtime evidence (`node --version`, package APIs, and the lockfile) rather than inventing an incompatible minimum. Do not change dependency ranges.

**Verify**: `pnpm install --frozen-lockfile` → exit 0 with no lockfile mutation.

### Step 2: Correct the setup guide

Replace `npm install` with the supported pnpm installation flow, explain Corepack or the required pnpm installation, and state the Node prerequisite. Keep the existing clone/copy and settings instructions.

**Verify**: search `SETUP.md` for `npm install` → no setup command remains; `pnpm run format:check` → exit 0.

## Test plan

Use the frozen clean-install check, then run the existing typecheck and deterministic tests. No source test additions are needed.

## Done criteria

- [ ] Setup documents pnpm consistently.
- [ ] Root metadata declares supported package manager/runtime.
- [ ] `pnpm install --frozen-lockfile`, `pnpm run check`, `pnpm test`, and `pnpm run format:check` pass.
- [ ] No dependency versions change unintentionally.

## STOP conditions

- The supported Node minimum cannot be established from repository/runtime requirements.
- Adding metadata requires resolving an unrelated lockfile conflict.
- The frozen install fails for a reason unrelated to this plan.

## Maintenance notes

Keep setup, `packageManager`, `engines`, and CI runtime versions synchronized when upgrading Node or pnpm.
