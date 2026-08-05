# Plan 003: Add automated verification for the workspace

> **Executor instructions**: Implement only the CI configuration described here. Do not push or merge.
>
> **Drift check (run first)**: `git diff --stat 3b134de..HEAD -- .github package.json pnpm-lock.yaml Makefile`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/001-separate-live-provider-tests.md, plans/002-standardize-pnpm-setup.md
- **Category**: dx
- **Planned at**: commit `3b134de`, 2026-07-31
- **Drift reconciliation**: refreshed after plans 001–002; preserve their package scripts, metadata, and setup documentation.
- **Ollin state**: DONE
- **Merged**: `0910bf7` (PR #4) into `main`
- **Worktree**: `/Users/gocanto/Sites/pi-harness-ollin-003`
- **Branch**: `ollin/003-add-ci-verification`
- **Base**: `ollin/002-standardize-pnpm-setup` at `3b134de`
- **Commit**: `19e400b Add CI workflow to verify pull requests and main`
- **Review**: APPROVE; workflow, scope, YAML, verify script, and full local verification verified by parent
- **Pull request**: https://github.com/gocanto/pi-harness/pull/4
- **Gates**: GitHub Actions `Verify` passed; merge state CLEAN; no actionable reviews or comments

## Why this matters

The repository has a useful local `verify` target but no tracked CI workflow. Pull requests can therefore bypass typechecking, formatting, and tests. CI should run the deterministic baseline with the declared Node/pnpm versions and frozen lockfile.

## Current state

- `Makefile:33-36` defines `verify` as format check, typecheck, and tests.
- `package.json` exposes `check`, `format:check`, deterministic `test`, `test:live`, and now declares the package manager/runtime from plan 002.
- There is no `.github/workflows` file in the repository.
- `Makefile:33-36` remains the local `verify` entry point.
- The repository has GitHub remote `origin` at `gocanto/pi-harness`.

## Commands you will need

| Purpose            | Command                                                        | Expected       |
| ------------------ | -------------------------------------------------------------- | -------------- |
| Local baseline     | `pnpm run verify`                                              | exit 0         |
| YAML/config review | inspect the workflow and run a local syntax check if available | valid workflow |
| Formatting         | `pnpm run format:check`                                        | exit 0         |

## Scope

**In scope**: a new `.github/workflows/ci.yml` and, only if required, root package metadata from Plan 002.

**Out of scope**: deployment, release publishing, live provider tests, source code, and secret configuration.

## Steps

### Step 1: Add a pull-request and default-branch workflow

Create a CI workflow that runs on pull requests and pushes to the repository’s default branch. Check out the code, install the declared Node version, enable/install the declared pnpm version, run `pnpm install --frozen-lockfile`, then run `pnpm run verify`. Use dependency caching only through the official setup action inputs and do not add credentials.

**Verify**: inspect the YAML → triggers, runtime, frozen install, and verify command are present; `pnpm run format:check` → exit 0.

### Step 2: Keep external-provider tests opt-in

Ensure the workflow calls only `pnpm run verify`; it must not invoke `test:live` or provider CLIs.

**Verify**: search `.github/workflows/ci.yml` for `test:live`, `claude`, and `codex` → no matches.

## Test plan

Run `pnpm run verify` locally. The hosted workflow itself is the integration verification; do not require secrets or live provider access.

## Done criteria

- [ ] CI runs for pull requests and the default branch.
- [ ] CI uses the declared runtime and frozen lockfile.
- [ ] CI runs format check, typecheck, and deterministic tests.
- [ ] CI has no secret or live-provider dependency.

## STOP conditions

- The default branch cannot be determined safely from Git metadata.
- GitHub Actions policy forbids the selected action versions or requires organization-specific configuration.
- The workflow would need credentials or deployment permissions.

## Maintenance notes

Update the workflow whenever `packageManager`, `engines`, or the verification command changes. Keep live provider smoke tests in a separate manually invoked workflow if they later gain CI coverage.
