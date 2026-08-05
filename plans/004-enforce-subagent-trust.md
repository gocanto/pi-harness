# Plan 004: Enforce trust before granting autonomous subagent access

> **Executor instructions**: Read the complete TypeScript standards at `/Users/gocanto/Sites/pi-harness/.agents/skills/typescript-coding-standards/SKILL.md` before changing TypeScript. Implement only this security boundary. Do not weaken it to preserve an untrusted workflow.
>
> **Drift check (run first)**: `git diff --stat ca2d0b2..HEAD -- extensions/subagents/index.ts extensions/subagents/src/backends/claude.ts extensions/subagents/src/backends/codex.ts extensions/subagents/*.test.ts`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `ca2d0b2`, 2026-07-31
- **Ollin state**: DONE
- **Merged**: `ded627b` (PR #5) into `main`
- **Worktree**: `/Users/gocanto/Sites/pi-harness-ollin-004`
- **Branch**: `ollin/004-enforce-subagent-trust`
- **Base**: `ollin/003-add-ci-verification` at `19e400b`
- **Commit**: `7247bbe Enforce trust before granting autonomous subagent host access`
- **Review**: APPROVE; security boundary, focused tests, full verification, and scope verified by parent
- **Pull request**: https://github.com/gocanto/pi-harness/pull/5
- **Gates**: GitHub Actions `Verify` passed; merge state CLEAN; no actionable reviews or comments

## Why this matters

`subagent_spawn` accepts a resolved working directory and passes a trust decision only as metadata. Claude is started with permission bypass and Codex with `danger-full-access`, so an untrusted or merely existing directory can receive autonomous host-wide access. A prompt-injected task must not be able to turn that surface into unrestricted filesystem and command access.

## Current state

- `extensions/subagents/index.ts:303-323` resolves and validates `working_dir`, computes `projectTrusted`, then always calls `manager.spawn`.
- `extensions/subagents/index.ts:124-143` trusts the same directory only when the parent decision or trust store says so; alternate paths fail closed in the lookup, but the result is not enforced.
- Claude `extensions/subagents/src/backends/claude.ts:329-342` uses `bypassPermissions`; Codex `src/backends/codex.ts:892-896` uses `danger-full-access`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `pnpm run check` | exit 0 |
| Tests | `pnpm --filter subagents test` | all deterministic subagent tests pass |
| Formatting | `pnpm run format:check` | exit 0 |

## Scope

**In scope**: subagent tool trust enforcement, backend permission selection, and focused subagent tests.

**Out of scope**: changing Pi’s global trust store, redesigning provider APIs, workflow sandboxing, or adding an interactive approval UI.

## Steps

### Step 1: Define and enforce the policy at the tool boundary

Reject spawn before reserving/starting a child when the resolved cwd is not explicitly trusted. Preserve same-directory inheritance only when `ctx.isProjectTrusted()` is true; preserve alternate-directory trust only when `ProjectTrustStore` explicitly returns true. Return a bounded error naming that trust is required, not sensitive path contents beyond the existing user-visible path policy.

**Verify**: add tests for trusted same-directory, untrusted same-directory, trusted alternate directory, untrusted alternate directory, and nonexistent directory; `pnpm --filter subagents test` → pass.

### Step 2: Make backend permissions match the enforced policy

Keep the existing autonomous permission mode only for an approved trusted cwd. If the SDK offers a safe restricted mode, use it for any supported non-trusted case; otherwise ensure non-trusted tasks cannot reach the backend. Do not rely on `settingSources` alone as an access-control boundary.

**Verify**: backend option tests or injected request fixtures prove untrusted tasks cannot receive bypass/full-access options; `pnpm run check` → exit 0.

## Test plan

Cover the trust matrix and prove denied requests consume no concurrency slot and do not create a provider session. Preserve existing backend live tests without making them part of this plan.

## Done criteria

- [ ] Untrusted cwd spawn is rejected before backend execution.
- [ ] Trusted cwd behavior remains available.
- [ ] Claude/Codex permission options cannot grant full access to an untrusted task.
- [ ] Focused tests, typecheck, and format check pass.

## STOP conditions

- The host API cannot distinguish explicit trust from mere cwd existence.
- A provider only supports unrestricted mode and the implementation would need to expose it to untrusted paths.
- A safe fix requires changing workflow or Pi global trust semantics.

## Maintenance notes

Review this boundary whenever adding a backend or a new working-directory parameter. Security tests must remain deterministic and must not use real credentials.
