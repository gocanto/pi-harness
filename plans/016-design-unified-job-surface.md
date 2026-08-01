# Plan 016: Design a unified job surface for long-running work

> **Executor instructions**: Design/spike only. Do not replace existing tools or weaken backend-specific security boundaries.
>
> **Drift check (run first)**: `git diff --stat bdadf5f..HEAD -- README.md extensions/workflows extensions/subagents extensions/background-terminals extensions/shared`

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/004-enforce-subagent-trust.md, plans/005-bound-workflow-execution.md, plans/015-design-durable-workflow-recovery.md
- **Category**: direction
- **Planned at**: commit `bdadf5f`, 2026-07-31
- **Drift reconciliation**: refreshed after plans 004–015; preserve trust, deadline, retention, package, performance, documentation, and recovery-design decisions.
- **Ollin state**: PR READY
- **Worktree**: `/Users/gocanto/Sites/pi-harness-ollin-016`
- **Branch**: `ollin/016-design-unified-job-surface`
- **Base**: `ollin/015-design-durable-workflow-recovery` at `bdadf5f`
- **Commit**: `a1f639e Design a unified job surface for workflows, subagents, and background terminals`
- **Review**: APPROVE; contract inventory, capability-aware read model, staged migration/rejection criteria, full verification, and documentation-only scope verified by parent
- **Pull request**: https://github.com/gocanto/pi-harness/pull/18
- **Gates**: GitHub Actions `Verify` passed; merge state CLEAN; no actionable reviews or comments

## Why this matters

README advertises workflows, subagents, and background terminals, but each has separate IDs, status models, inspection tools, result delivery, cancellation, and cleanup semantics. A common read model could make orchestration composable and reduce user confusion, but the design must not erase the distinction between a shell process, a provider session, and a restricted workflow sandbox.

## Current state

- `extensions/workflows/index.ts` owns orchestration and artifacts.
- `extensions/subagents/index.ts` owns spawn/wait/cancel/check and follow-up delivery.
- `extensions/background-terminals/index.ts` owns start/status/list/kill and process output.
- `extensions/shared/` already contains dashboard/activity helpers but no common job contract.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Tests | `pnpm test` | pass |
| Typecheck | `pnpm run check` | pass |
| Formatting | `pnpm run format:check` | pass |

## Scope

**In scope**: design document, capability comparison, candidate domain/read-model interfaces, migration phases, and compatibility analysis.

**Out of scope**: implementing a shared abstraction, renaming tools, changing UI, or merging lifecycle code.

## Steps

### Step 1: Inventory current contracts

Compare identifiers, states, result delivery, cancellation guarantees, output retention, trust policy, UI surfaces, and session-shutdown behavior for all three systems. Mark semantics that must remain backend-specific.

**Verify**: design contains a side-by-side matrix backed by source paths and existing tests.

### Step 2: Propose a minimal common read model

Define only shared observability concepts (id, title, kind, lifecycle, timestamps, progress, output pointer, error, cancellation capability). Keep capability flags and adapters for backend-specific operations.

**Verify**: each current tool can map to the candidate model without inventing unsafe behavior or losing required state.

### Step 3: Plan migration and rejection criteria

Describe additive compatibility, event delivery, dashboard integration, and staged rollout. Include reasons not to unify if the abstraction increases coupling or weakens sandboxing.

**Verify**: a maintainer can approve, reject, or defer the design with explicit trade-offs.

## Test plan

Use existing tests as contract evidence. No implementation tests are required for the spike; current verification must remain green.

## Done criteria

- [ ] Current lifecycle differences are documented.
- [ ] Common model is minimal and capability-aware.
- [ ] Migration does not require removing existing tools in one step.
- [ ] Security and cleanup boundaries remain explicit.

## STOP conditions

- The proposed model requires unsafe cross-backend assumptions.
- Durable recovery semantics are unresolved and the design depends on them.
- A common abstraction would require broad source changes before it can be validated.

## Maintenance notes

Treat this as an optional architectural direction, not a justification for speculative refactoring. Revisit after workflow recovery and trust plans settle.
