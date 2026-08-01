# Plan 007: Preserve deferred subagent results across delivery failures

> **Executor instructions**: Read `/Users/gocanto/Sites/pi-harness/.agents/skills/typescript-coding-standards/SKILL.md` before changing TypeScript. Do not change exactly-once semantics for successful delivery.
>
> **Drift check (run first)**: `git diff --stat 4c1205e..HEAD -- extensions/subagents/index.ts extensions/subagents/src/result-delivery.ts extensions/subagents/result-delivery.test.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `4c1205e`, 2026-07-31
- **Drift reconciliation**: refreshed after plans 001–006 merged; preserve the enforced trusted-working-directory boundary and current deterministic test selection.
- **Ollin state**: PR READY
- **Worktree**: `/Users/gocanto/Sites/pi-harness-ollin-007`
- **Branch**: `ollin/007-preserve-subagent-delivery`
- **Base**: `main` at `4c1205e`
- **Commit**: `c2b24e0 Preserve deferred subagent results across delivery failures`
- **Review**: APPROVE; transactional delivery, consumed semantics, focused tests, full verification, and scope verified by parent
- **Pull request**: https://github.com/gocanto/pi-harness/pull/9
- **Gates**: GitHub Actions `Verify` passed; merge state CLEAN; no actionable reviews or comments

## Why this matters

`flushResults` drains the deferred map before calling `pi.sendMessage`. If delivery throws during a transient session/runtime state, the completed subagent result is lost and cannot be retried. Successful results must still be delivered once and consumed waits must not be duplicated.

## Current state

- `extensions/subagents/index.ts:180-196` sends a follow-up without catching delivery errors.
- `:198-200` iterates `resultDelivery.drain()`, which clears pending results first.
- `src/result-delivery.ts` provides `defer`, `consume`, `drain`, and `clear`, with tests for normal exactly-once behavior.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Tests | `pnpm --filter subagents test` | pass |
| Typecheck | `pnpm run check` | exit 0 |
| Formatting | `pnpm run format:check` | exit 0 |

## Scope

**In scope**: deferred result delivery and focused tests.

**Out of scope**: changing subagent manager state, follow-up message format, or provider backends.

## Steps

### Step 1: Make delivery transactional

Change the delivery loop so a result is removed only after `pi.sendMessage` succeeds. On failure, retain/requeue the exact snapshot for a later `agent_settled`/idle flush, while preventing duplicate map entries by id. Bound error handling so a bad result does not prevent later results from being attempted.

**Verify**: focused unit tests simulate a throwing sender, then a successful retry; the result is delivered once after retry.

### Step 2: Preserve consumed semantics

Confirm `subagent_wait` and cancellation consume IDs before flush and that a consumed result cannot be requeued by a later failed delivery path.

**Verify**: `pnpm --filter subagents test` → all pass.

## Test plan

Add tests for failed first delivery, retry, multiple result ordering, sender failure for one result, and consumed-result suppression. Use the existing `result-delivery.test.ts` patterns.

## Done criteria

- [ ] Failed sends remain pending.
- [ ] Successful sends are removed exactly once.
- [ ] One failed result does not discard or block unrelated pending results.
- [ ] Existing delivery tests, typecheck, and format check pass.

## STOP conditions

- The Pi API reports ambiguous send success and no safe idempotency key can be used.
- Retrying would duplicate a message that the host may already have accepted.
- The change requires altering session-manager internals outside this extension.

## Maintenance notes

Keep result IDs as the deduplication key. Any new delivery channel must define its acknowledgement/failure behavior before using `drain`.
