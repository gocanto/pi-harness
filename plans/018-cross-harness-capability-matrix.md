# Plan 018: Define a cross-harness capability and cost matrix

> **Executor instructions**: Design/spike first; do not force behavioral parity or modify provider backends without a follow-up implementation plan. Read `/Users/gocanto/Sites/pi-harness/.agents/skills/typescript-coding-standards/SKILL.md` only if the approved spike changes TypeScript.
>
> **Drift check (run first)**: `git diff --stat 3eac49c..HEAD -- extensions/subagents/src/backends extensions/subagents/src/prompt.ts extensions/subagents/docs/design-plan.md extensions/subagents/*.test.ts`

## Status

- **Priority**: P3
- **Effort**: M/L
- **Risk**: MED
- **Depends on**: plans/004-enforce-subagent-trust.md, plans/013-refresh-current-documentation.md
- **Category**: direction
- **Planned at**: commit `3eac49c`, 2026-07-31
- **Drift reconciliation**: refreshed after plans 004 and 013–017; preserve provider permissions, live-test opt-in, trust boundaries, and explicit workflow activation.
- **Ollin state**: PR READY
- **Worktree**: `/Users/gocanto/Sites/pi-harness-ollin-018`
- **Branch**: `ollin/018-cross-harness-capability-matrix`
- **Base**: `ollin/017-explicit-workflow-activation` at `3eac49c`
- **Commit**: `3b89d19 Define a cross-harness capability and cost matrix for subagents`
- **Review**: APPROVE; evidence-cited three-backend matrix, explicit unknowns/security boundaries, rejected one-shot recommendation, bounded follow-up backlog, and docs-only scope verified by parent
- **Pull request**: https://github.com/gocanto/pi-harness/pull/20
- **Gates**: GitHub Actions `Verify` passed on rerun after one unrelated flaky test failure; merge state CLEAN; no actionable reviews or comments

## Why this matters

The subagent tool presents Pi, Claude, and Codex as one choice, but their permissions, model mapping, steering, persistence, latency, and cost differ. The design document explicitly leaves these questions open. A capability matrix makes outcomes predictable and identifies the smallest useful parity work.

## Current state

- `extensions/subagents/src/prompt.ts:4-25` presents the backend choices and generic options.
- `extensions/subagents/docs/design-plan.md:528-570` lists unresolved questions for one-shot mode, permissions, steering, defaults, discovery, budgets, and persistence.
- Claude and Codex backends use distinct native session/protocol behavior and permission settings.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Tests | `pnpm --filter subagents test` | pass |
| Typecheck | `pnpm run check` | pass |
| Formatting | `pnpm run format:check` | pass |

## Scope

**In scope**: current behavior inventory, capability/cost matrix, user-facing caveats, recommended defaults, and one-shot prototype decision.

**Out of scope**: provider upgrades, forced permission parity, new billing telemetry, or implementing all open questions.

## Steps

### Step 1: Measure/document current capabilities

For each backend record model selection, reasoning levels, context reporting, tool access, trust/permission mode, cancellation, steering, persistence/session path, output limits, availability checks, and likely cost/latency. Cite source/tests and label unknowns.

**Verify**: every matrix cell is either evidenced, explicitly unknown, or marked backend-dependent; no undocumented parity claim remains.

### Step 2: Define user-facing policy

Recommend which options are common, which are backend-specific, how unsupported options fail, and whether a cheap one-shot mode is worth a separate API. Include security implications and default model behavior.

**Verify**: docs/tests can express the recommended behavior without changing provider code.

### Step 3: Produce an implementation backlog

Split approved changes into bounded follow-up plans: capability metadata, one-shot mode, model defaults, steering, and telemetry. Include rejection criteria for changes whose cost exceeds user value.

**Verify**: the spike ends with explicit decisions, open questions, and no accidental source changes.

## Test plan

Use existing deterministic backend tests as evidence and run them after documentation changes. Add no live provider dependency.

## Done criteria

- [ ] Matrix covers all three backends and relevant user-visible differences.
- [ ] Unsupported options and security boundaries are explicit.
- [ ] One-shot/steering/persistence recommendations are actionable.
- [ ] Follow-up implementation scope is split and bounded.

## STOP conditions

- Provider behavior cannot be verified without credentials; mark it unknown rather than guessing.
- The matrix would expose secrets, tokens, or private session paths.
- Product/cost decisions require maintainer input; record questions and stop.

## Maintenance notes

Update the matrix whenever a backend changes permissions, model routing, cancellation, or persistence. Treat it as a compatibility contract, not a promise of identical provider behavior.
