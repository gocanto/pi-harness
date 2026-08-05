# Plan 005: Bound asynchronous workflow execution

> **Executor instructions**: Read `/Users/gocanto/Sites/pi-harness/.agents/skills/typescript-coding-standards/SKILL.md` before changing TypeScript. Do not remove existing cancellation or child-process cleanup.
>
> **Drift check (run first)**: `git diff --stat ca2d0b2..HEAD -- extensions/workflows/sandbox.ts extensions/workflows/sandbox-child.cjs extensions/workflows/sandbox.test.ts extensions/workflows/index.ts extensions/workflows/runner.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `ca2d0b2`, 2026-07-31
- **Ollin state**: DONE
- **Merged**: `fe5b82e` (PR #6) into `main`
- **Worktree**: `/Users/gocanto/Sites/pi-harness-ollin-005`
- **Branch**: `ollin/005-bound-workflow-execution`
- **Base**: `ollin/004-enforce-subagent-trust` at `7247bbe`
- **Commit**: `53c1d2e Bound asynchronous workflow execution with a parent watchdog deadline`
- **Review**: APPROVE; timeout behavior, cleanup races, focused tests, full verification, and scope verified by parent
- **Pull request**: https://github.com/gocanto/pi-harness/pull/6
- **Gates**: GitHub Actions `Verify` passed; merge state CLEAN; no actionable reviews or comments

## Why this matters

The VM timeout protects only initial script invocation. The workflow promise may remain pending forever, including after an asynchronous continuation. Since the sandbox child is a separate process, a bounded parent watchdog can terminate it and abort active agent requests without relying on the child event loop to cooperate.

## Current state

- `extensions/workflows/sandbox.ts:76-81` documents that workflows have no wall-clock deadline.
- `sandbox-child.cjs:245-263` runs the async workflow and only applies `vm` timeouts to synchronous bootstrap/invocation calls.
- `runWorkflowSandbox` already has `AbortSignal`, `finish`, `cleanup`, and `terminateChild` paths.

## Commands you will need

| Purpose    | Command                        | Expected                |
| ---------- | ------------------------------ | ----------------------- |
| Tests      | `pnpm --filter workflows test` | all workflow tests pass |
| Typecheck  | `pnpm run check`               | exit 0                  |
| Formatting | `pnpm run format:check`        | exit 0                  |

## Scope

**In scope**: sandbox deadline option/default, parent watchdog cleanup, documentation, and sandbox tests.

**Out of scope**: changing the workflow DSL, provider per-call timeout, or removing the existing synchronous VM limits.

## Steps

### Step 1: Add a bounded deadline with a test override

Add a documented default workflow deadline (use 30 minutes unless current product configuration establishes another value) and an optional internal/test override to `RunWorkflowSandboxOptions`. Start an unref'd timer after the child is spawned; on expiry call the same idempotent `finish` path used by abort, with a clear timeout error.

**Verify**: a test workflow that awaits a never-settling promise rejects with the timeout error and the child is terminated; a normal short workflow still resolves.

### Step 2: Make cleanup complete and race-safe

Clear the watchdog on every finish path. Preserve active agent aborts, listener removal, and no duplicate resolve/reject behavior when timeout, abort, child exit, or IPC error race.

**Verify**: tests cover timeout/abort/exit races; `pnpm --filter workflows test` → pass.

## Test plan

Add deterministic tests for never-settling async code, completion before timeout, parent abort, child protocol failure, and cleanup after timeout. Keep the existing synchronous non-yielding VM test.

## Done criteria

- [ ] No workflow can remain active beyond the configured deadline.
- [ ] Timeout aborts requests and terminates the sandbox child.
- [ ] Existing cancellation and normal completion semantics remain intact.
- [ ] Tests, typecheck, and format check pass.

## STOP conditions

- Product requirements explicitly require unbounded workflows and provide a separate external watchdog.
- A watchdog implementation cannot terminate the child on the supported Node runtime.
- Existing tests reveal an intentional long-running workflow contract that needs configuration rather than a fixed default.

## Maintenance notes

Any future workflow that legitimately needs more time must use a reviewed configuration extension, not remove the deadline. Keep timeout errors actionable and avoid embedding prompts or result data.
