# Plan 017: Replace hidden workflow activation with explicit policy

> **Executor instructions**: Read `/Users/gocanto/Sites/pi-harness/.agents/skills/typescript-coding-standards/SKILL.md` before changing TypeScript or prompt/UI code. Preserve the workflow’s cost and fan-out safeguards.
>
> **Drift check (run first)**: `git diff --stat a1f639e..HEAD -- extensions/workflows/prompt.ts extensions/workflows/index.ts README.md SETUP.md extensions/workflows/*.test.ts`

## Status

- **Priority**: P3
- **Effort**: S/M
- **Risk**: MED
- **Depends on**: plans/003-add-ci-verification.md, plans/005-bound-workflow-execution.md
- **Category**: direction
- **Planned at**: commit `a1f639e`, 2026-07-31
- **Drift reconciliation**: refreshed after plans 003–016; preserve workflow deadlines, artifact/privacy policy, package boundary, performance behavior, and current docs.
- **Ollin state**: PR READY
- **Worktree**: `/Users/gocanto/Sites/pi-harness-ollin-017`
- **Branch**: `ollin/017-explicit-workflow-activation`
- **Base**: `ollin/016-design-unified-job-surface` at `a1f639e`
- **Commit**: `3eac49c Replace hidden workflow activation phrase with an explicit opt-in policy`
- **Review**: APPROVE; user-visible opt-in gate, persisted/env precedence, guardrail-preserving docs, and environment-policy command enforcement verified by parent
- **Pull request**: https://github.com/gocanto/pi-harness/pull/19
- **Gates**: GitHub Actions `Verify` passed; merge state CLEAN; no actionable reviews or comments

## Why this matters

The repository advertises workflows, but the model-facing description says to call the tool only when the user says “ultracode” or explicitly requests a workflow. A hidden magic phrase makes the feature hard to discover and creates inconsistent activation behavior. An explicit setting, command, or permission mode can improve discoverability while controlling cost.

## Current state

- `extensions/workflows/prompt.ts:20` contains the hidden activation rule.
- The same prompt documents real workflow capabilities, fan-out, and background execution.
- `README.md` advertises workflows without explaining activation policy.

## Commands you will need

| Purpose    | Command                        | Expected |
| ---------- | ------------------------------ | -------- |
| Tests      | `pnpm --filter workflows test` | pass     |
| Typecheck  | `pnpm run check`               | pass     |
| Formatting | `pnpm run format:check`        | pass     |

## Scope

**In scope**: activation policy, prompt/help text, configuration or explicit command design, and focused tests/docs.

**Out of scope**: changing workflow execution, increasing concurrency, removing budgets, or changing provider permissions.

## Steps

### Step 1: Choose an explicit activation surface

Prefer a documented user-controlled setting or command that can be represented in tool metadata and tested. Define default behavior, opt-in/opt-out precedence, and how the policy interacts with background runs and untrusted projects.

**Verify**: design/implementation tests cover default, explicit enable, explicit disable, and ordinary single-agent requests.

### Step 2: Update prompt and documentation

Remove reliance on the magic phrase while retaining guidance to avoid workflows for small tasks. Explain cost/fan-out implications and the user control in README/SETUP.

**Verify**: search prompt/docs → no instruction requires the opaque phrase; focused tests pass.

## Test plan

Add prompt/config tests and, if a command is added, registration/permission tests. Ensure existing workflow DSL and sandbox tests remain green.

## Done criteria

- [ ] Activation is user-visible and explicit.
- [ ] Cost/fan-out guardrails remain documented and enforced.
- [ ] Prompt/help/docs agree.
- [ ] Tests, typecheck, and formatting pass.

## STOP conditions

- The host API cannot expose an explicit policy without changing global Pi configuration.
- The proposed default would cause unbounded cost or fan-out.
- Product owners prefer workflows to remain intentionally hidden; record that decision instead.

## Maintenance notes

Keep activation policy in one source of truth. Review it whenever workflow concurrency, billing, or trust behavior changes.
