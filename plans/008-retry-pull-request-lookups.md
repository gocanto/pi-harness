# Plan 008: Retry failed pull-request lookups

> **Executor instructions**: Read `/Users/gocanto/Sites/pi-harness/.agents/skills/typescript-coding-standards/SKILL.md` before changing TypeScript. Keep GitHub CLI failures non-fatal to the extension.
>
> **Drift check (run first)**: `git diff --stat ca2d0b2..HEAD -- extensions/git-info/index.ts extensions/git-info/refresh-coordinator.test.ts extensions/git-info/process.test.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `ca2d0b2`, 2026-07-31
- **Ollin state**: PR READY
- **Worktree**: `/Users/gocanto/Sites/pi-harness-ollin-008`
- **Branch**: `ollin/008-retry-pull-request-lookups`
- **Base**: `ollin/007-preserve-subagent-delivery` at `c2b24e0`
- **Commit**: `c153b67 Retry failed pull-request lookups instead of poisoning the branch cache`
- **Review**: APPROVE; retry state machine, stale-generation protection, focused tests, full verification, and scope verified by parent
- **Pull request**: https://github.com/gocanto/pi-harness/pull/10
- **Gates**: GitHub Actions `Verify` passed; merge state CLEAN; no actionable reviews or comments

## Why this matters

The first refresh marks a branch as queried before `gh pr view` completes. Because command failures become `null`, a transient timeout or authentication failure suppresses all later automatic lookups on the same branch. The footer should retry without creating an uncontrolled request loop.

## Current state

- `extensions/git-info/index.ts:128` computes whether the branch changed using `queriedPrBranch`.
- `:148-150` sets `queriedPrBranch` before `lookupPullRequest`.
- `lookupPullRequest` returns `null` for nonzero command results, and polling runs every three seconds.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Tests | `pnpm --filter git-info test` | pass |
| Typecheck | `pnpm run check` | exit 0 |
| Formatting | `pnpm run format:check` | exit 0 |

## Scope

**In scope**: PR lookup state, bounded retry/backoff or retry eligibility, and Git-info tests.

**Out of scope**: GitHub authentication UX, Git status counting, `/pr` command behavior, and unrelated polling.

## Steps

### Step 1: Track lookup success separately from attempted lookup

Only mark a branch as successfully queried after the result is available, or introduce explicit retry state with a bounded backoff. Preserve the distinction between “no PR exists” and “lookup failed” so a valid no-PR result does not retry every poll.

**Verify**: tests prove transient failure retries on a later refresh, successful no-PR lookup does not retry continuously, and branch changes reset state.

### Step 2: Preserve stale-state and generation behavior

Ensure a session generation change or branch change cannot apply an old lookup result. Keep existing refresh serialization.

**Verify**: `pnpm --filter git-info test` → pass.

## Test plan

Use injected command fixtures to cover success, no PR, nonzero `gh`, timeout, repeated polling, branch change, and forced `/pr` lookup.

## Done criteria

- [ ] Transient lookup failures recover automatically.
- [ ] Successful no-PR results do not cause a tight retry loop.
- [ ] Old generations cannot overwrite current state.
- [ ] Focused tests, typecheck, and format check pass.

## STOP conditions

- The command layer cannot distinguish a failed `gh` invocation from a valid empty result.
- Retry policy would exceed the existing polling rate without a bounded backoff.
- Existing refresh tests reveal a different intentional PR-cache contract.

## Maintenance notes

Keep retry policy conservative during GitHub outages. Review cache state whenever PR fields or branch identity semantics change.
