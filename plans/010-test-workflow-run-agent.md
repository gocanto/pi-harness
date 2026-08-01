# Plan 010: Add end-to-end coverage for workflow agent execution

> **Executor instructions**: Read `/Users/gocanto/Sites/pi-harness/.agents/skills/typescript-coding-standards/SKILL.md` before changing TypeScript. Use deterministic fakes; do not call external providers.
>
> **Drift check (run first)**: `git diff --stat a9316e0..HEAD -- extensions/workflows/index.ts extensions/workflows/runner.ts extensions/workflows/runner.test.ts extensions/workflows/*.test.ts`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/009-workflows-package-boundary.md
- **Category**: tests
- **Planned at**: commit `a9316e0`, 2026-07-31
- **Drift reconciliation**: refreshed after plans 005–009; preserve workflow deadlines, artifact retention hooks, and the new package boundary.
- **Ollin state**: PR READY
- **Worktree**: `/Users/gocanto/Sites/pi-harness-ollin-010`
- **Branch**: `ollin/010-test-workflow-run-agent`
- **Base**: `ollin/009-workflows-package-boundary` at `a9316e0`
- **Commit**: `7242394 Add deterministic end-to-end coverage for workflow runAgent`
- **Review**: APPROVE; injectable session seam, lifecycle/failure coverage, full verification, and scope verified by parent
- **Pull request**: https://github.com/gocanto/pi-harness/pull/12
- **Gates**: GitHub Actions `Verify` passed; merge state CLEAN; no actionable reviews or comments

## Why this matters

The workflow execution path is central but current tests mostly exercise pure helpers, serialization, sandbox protocol, and controller utilities. Session creation, structured output, progress, abort, provider failure, and disposal can regress while those tests remain green.

## Current state

- `extensions/workflows/index.ts:570-590` invokes `runAgent` from the production workflow tool and now also wires artifact-retention lifecycle behavior.
- `extensions/workflows/runner.ts:431-476` creates and disposes the child session.
- `runner.test.ts` does not invoke the full `runAgent` path.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Focused tests | `pnpm --filter workflows test` | pass |
| Root tests | `pnpm test` | pass |
| Typecheck | `pnpm run check` | exit 0 |
| Formatting | `pnpm run format:check` | exit 0 |

## Scope

**In scope**: test seams/fakes around workflow `runAgent`, `runner.test.ts`, and minimal dependency injection required for deterministic testing.

**Out of scope**: provider SDK behavior, real Claude/Codex tests, workflow DSL changes, and production refactors not needed for testability.

## Steps

### Step 1: Introduce a narrow deterministic session seam

Model the minimum `AgentSession` lifecycle used by `runAgent`: creation, subscription events, prompt/steering, abort, wait/flush, and disposal. Prefer injected factory/resource functions over broad casts or `any`. Keep the production default unchanged.

**Verify**: a fake session can complete a simple run and records disposal exactly once.

### Step 2: Cover failure and cancellation paths

Add tests for normal output, structured output, progress updates, session-creation failure, provider/session error, abort during request, tool timeout, and final cleanup. Assert returned `AgentOutcome` fields rather than only no-throw behavior.

**Verify**: `pnpm --filter workflows test` → all focused tests pass.

## Test plan

Follow existing `runner.test.ts`, `sandbox.test.ts`, and serialization test style. Ensure no test launches a provider CLI or reads user settings/credentials.

## Done criteria

- [ ] Full `runAgent` lifecycle has deterministic coverage.
- [ ] Abort and setup-failure cleanup are asserted.
- [ ] Structured output and progress data are asserted.
- [ ] Root checks and tests pass.

## STOP conditions

- The Pi session API cannot be injected without a broad production rewrite.
- A fake would assert implementation details instead of observable outcomes.
- A test requires real credentials or network access.

## Maintenance notes

Update the fake when Pi session lifecycle contracts change. Keep at least one test for every cleanup branch before refactoring runner internals.
