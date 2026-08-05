# Plan 001: Separate live provider tests from default verification

> **Executor instructions**: Follow this plan step by step. Do not edit the plan index unless the reviewer explicitly asks you to. Run each verification gate. Stop on any STOP condition.
>
> **Drift check (run first)**: `git diff --stat ca2d0b2..HEAD -- package.json extensions/subagents/claude.test.ts extensions/subagents/codex.test.ts`

## Status

- **Priority**: P1
- **Effort**: S/M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `ca2d0b2`, 2026-07-31
- **Ollin state**: DONE
- **Merged**: `82a2cf5` (PR #2) into `feat/add-config`, then reachable from `main`
- **Worktree**: `/Users/gocanto/Sites/pi-harness-ollin-001`
- **Branch**: `ollin/001-separate-live-provider-tests`
- **Base**: `feat/add-config` at `ca2d0b2`
- **Commit**: `2ca3a7b Separate live provider tests from default test command`
- **Pull request**: https://github.com/gocanto/pi-harness/pull/2
- **Review**: APPROVE; scope, diff, tests, typecheck, and format check verified by parent
- **Gates**: local checks pass; GitHub reports no configured CI, completion checks, or reviews; branch merge state CLEAN

## Why this matters

The root test command currently globs every top-level extension test, including Claude and Codex tests that start real provider sessions. That makes the default verification dependent on local binaries, credentials, provider availability, and external latency. Deterministic tests must remain a reliable gate; live provider smoke tests should be explicit.

## Current state

- `package.json:21` runs `node --test --experimental-strip-types extensions/*/*.test.ts`, which includes `extensions/subagents/claude.test.ts` and `codex.test.ts`.
- Those files call real provider backends and skip only when the executable is unavailable; when available they perform live work.
- `extensions/subagents/package.json` already has deterministic `test` and explicit `test:live` scripts.

## Commands you will need

| Purpose       | Command                                 | Expected                                                                |
| ------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| Typecheck     | `pnpm run check`                        | exit 0                                                                  |
| Default tests | `pnpm test`                             | deterministic tests pass without invoking Claude/Codex                  |
| Live tests    | `pnpm --filter subagents run test:live` | explicit command; pass or skip according to local provider availability |
| Formatting    | `pnpm run format:check`                 | all files formatted                                                     |

## Scope

**In scope**: `package.json`, root test-selection configuration, and the existing subagent test scripts if needed.

**Out of scope**: provider implementations, live test assertions, dependency upgrades, and source behavior.

## Steps

### Step 1: Make the root test command deterministic

Replace the broad top-level glob with a maintainable selection that runs each workspace package's deterministic test script, or an equivalent explicit list. Preserve the existing file-search Vitest suite. Do not silently remove deterministic tests. Add a root `test:live` command that delegates to the existing subagents live script if no suitable command already exists.

**Verify**: `pnpm test` → exit 0 and no Claude/Codex live session starts.

### Step 2: Document the split

Update the root README or SETUP documentation with the default test command and the explicit live-provider command, including requirements that live tests need installed/authenticated provider CLIs.

**Verify**: `pnpm run format:check` → exit 0.

## Test plan

Run deterministic tests and explicitly run the live command. The default command must not require provider credentials or binaries; live tests may skip when unavailable.

## Done criteria

- [ ] `pnpm test` exits 0 without invoking live provider tests.
- [ ] An explicit live command remains available.
- [ ] `pnpm run check` and `pnpm run format:check` exit 0.
- [ ] Only in-scope files are modified.

## STOP conditions

- Existing package test scripts cannot be composed without dropping a deterministic suite.
- A provider test is found that is deterministic but would be excluded by the proposed selection.
- The change requires modifying provider behavior.

## Maintenance notes

When adding a new external-provider test, place it behind the explicit live command rather than the default suite. Review the root test selection whenever a new workspace package gains tests.
