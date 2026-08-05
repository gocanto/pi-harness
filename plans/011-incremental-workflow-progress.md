# Plan 011: Make workflow progress and dashboard reads incremental

> **Executor instructions**: Read `/Users/gocanto/Sites/pi-harness/.agents/skills/typescript-coding-standards/SKILL.md` before changing TypeScript or UI code. Preserve dashboard correctness and bounded artifact limits.
>
> **Drift check (run first)**: `git diff --stat 7242394..HEAD -- extensions/workflows/runner.ts extensions/workflows/dashboard.ts extensions/workflows/*.test.ts`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/009-workflows-package-boundary.md, plans/010-test-workflow-run-agent.md
- **Category**: perf
- **Planned at**: commit `7242394`, 2026-07-31
- **Drift reconciliation**: refreshed after plans 005–010; preserve workflow deadline, retention, package boundary, and deterministic runAgent seam.
- **Ollin state**: PR READY
- **Worktree**: `/Users/gocanto/Sites/pi-harness-ollin-011`
- **Branch**: `ollin/011-incremental-workflow-progress`
- **Base**: `ollin/010-test-workflow-run-agent` at `7242394`
- **Commits**: `58cbd71 Make workflow runAgent progress tracking incremental`; `f071d22 Cache persisted workflow runs in the /workflows dashboard`
- **Review**: APPROVE; incremental tracker, compaction fallback, dashboard cache/lazy hydration, focused tests, full verification, and scope verified by parent
- **Pull request**: https://github.com/gocanto/pi-harness/pull/13
- **Gates**: GitHub Actions `Verify` passed; merge state CLEAN; no actionable reviews or comments

## Why this matters

Long-running workflows repeatedly rebuild usage, output, transcripts, and persisted dashboard state from complete histories. While a live dashboard is open, it also synchronously reads every run and optional artifact every 500 ms. This can make input/rendering janky as histories grow.

## Current state

- `extensions/workflows/runner.ts:487-555` scans all child messages during each progress sync and rebuilds final output/transcripts.
- `extensions/workflows/dashboard.ts:229-304` reads each run and artifacts synchronously.
- `dashboard.ts:417-440` refreshes live entries on a 500 ms interval.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Tests | `pnpm --filter workflows test` | pass |
| Typecheck | `pnpm run check` | exit 0 |
| Formatting | `pnpm run format:check` | exit 0 |

## Scope

**In scope**: incremental runner accounting/transcript updates, active dashboard cache/invalidation, and performance-focused tests.

**Out of scope**: changing persisted artifact schema, dashboard visual design, workflow timeout policy, or provider behavior.

## Steps

### Step 1: Characterize current output and persistence behavior

Use existing tests and add measurements/fixtures for a long message history, parallel tool events, compaction, and finalization. Record that output, usage, and transcript results remain equivalent before optimizing.

**Verify**: characterization tests pass on current behavior before implementation.

### Step 2: Maintain incremental runner state

Update usage/transcript/progress state from newly observed events rather than rescanning all messages every event. Retain a safe full rebuild on finalization/recovery if needed for correctness; handle compaction and branch replacement explicitly.

**Verify**: incremental tests compare each progress snapshot and final result to the characterized expected values.

### Step 3: Cache dashboard persistence reads

Keep active run details in memory, refresh persisted runs on open/invalidation or file-change signals, and avoid loading unselected result/transcript artifacts for list rendering. Preserve stale-run recovery and selected-entry behavior.

**Verify**: dashboard tests assert no repeated artifact reads when inputs are unchanged and correct refresh after invalidation.

## Test plan

Add tests for multiple progress updates, parallel calls, compaction, selected/unselected dashboard entries, unreadable artifacts, and stale running records.

## Done criteria

- [ ] Progress work is incremental on the hot path.
- [ ] Dashboard does not synchronously reread unchanged artifacts every tick.
- [ ] Output and persisted state remain equivalent.
- [ ] Tests, typecheck, and formatting pass.

## STOP conditions

- Session events do not provide enough information to update incrementally without losing data.
- Caching breaks stale-run recovery or artifact compatibility.
- A correctness-preserving change requires a persisted schema migration.

## Maintenance notes

Document cache invalidation triggers and keep a recovery/full-rebuild path for resumed or partially written runs.
