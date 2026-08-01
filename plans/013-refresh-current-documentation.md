# Plan 013: Replace obsolete implementation documentation

> **Executor instructions**: Documentation-only plan. Do not alter source behavior or copy machine-specific paths into new docs.
>
> **Drift check (run first)**: `git diff --stat 58520b8..HEAD -- extensions/subagents/docs extensions/background-terminals/docs README.md SETUP.md`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/001-separate-live-provider-tests.md, plans/002-standardize-pnpm-setup.md, plans/009-workflows-package-boundary.md
- **Category**: docs
- **Planned at**: commit `58520b8`, 2026-07-31
- **Drift reconciliation**: refreshed after plans 001–012; preserve the current pnpm/Corepack setup and deterministic/live testing documentation.
- **Ollin state**: PR READY
- **Worktree**: `/Users/gocanto/Sites/pi-harness-ollin-013`
- **Branch**: `ollin/013-refresh-current-documentation`
- **Base**: `ollin/012-batch-changed-file-diffs` at `58520b8`
- **Commit**: `230f068 Refresh subagents and background-terminals implementation docs`
- **Review**: APPROVE; documentation facts, stale-reference audit, scope, and full verification verified by parent
- **Pull request**: https://github.com/gocanto/pi-harness/pull/15
- **Gates**: GitHub Actions `Verify` passed; merge state CLEAN; no actionable reviews or comments

## Why this matters

Maintainers and coding agents can follow stale guidance instead of the committed implementation. The subagents design document describes stub-only backends and a machine-specific path, while the background-terminal guide references older versions and an unchecked acceptance list.

## Current state

- `extensions/subagents/docs/design-plan.md:8-19` says real backends now exist but continues with a stub-only v1 scope and `/Users/davis` paths.
- `design-plan.md:500-570` presents old migration/open questions that no longer describe current implementation decisions.
- `extensions/background-terminals/docs/implementation-guide.md:3-15` references older Effect/dependency details and `:917-943` retains an unchecked acceptance checklist.
- `SETUP.md` now documents the pnpm/Corepack prerequisites and deterministic versus live test commands from plans 001–002.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Tests | `pnpm test` | pass |
| Formatting | `pnpm run format:check` | pass |
| Link/path audit | search docs for `/Users/davis`, `npm install`, and obsolete beta versions | no stale operational references |

## Scope

**In scope**: the two implementation documents and minimal README/SETUP links if needed.

**Out of scope**: source code, dependency changes, historical design decisions that are clearly labeled historical, and new product commitments.

## Steps

### Step 1: Reclassify historical content

Mark the original plans as historical or replace them with current architecture/status documents. Describe actual backend files, current commands, trust/permission behavior, persistence behavior, and test commands using repository-relative paths.

**Verify**: all documented commands and file paths resolve against this repository.

### Step 2: Update operational guidance

Replace old dependency/version claims with references to manifests/lockfile and current package scripts. Convert the acceptance checklist into a completed status/maintenance checklist or remove items that are no longer meaningful.

**Verify**: documentation search finds no machine-specific paths or obsolete install/test commands.

## Test plan

Run format check and existing verification; docs require no new runtime tests.

## Done criteria

- [ ] Docs describe the current implementations, not stub-only scope.
- [ ] No machine-specific paths or obsolete package-manager instructions remain.
- [ ] Open questions are clearly marked current versus historical.
- [ ] Existing verification passes.

## STOP conditions

- A statement cannot be verified from current source/configuration.
- Removing an old section would erase a still-active compatibility constraint.
- Product decisions are required rather than documentation correction.

## Maintenance notes

Date architecture decisions and link to the owning source/tests. Update docs in the same change as future backend or package-boundary changes.
