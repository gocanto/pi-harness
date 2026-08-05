# Plan 015: Design durable workflow recovery

> **Executor instructions**: This is a design/spike plan. Do not implement resume or retry side effects. Produce a reviewable design artifact only unless the spike explicitly identifies a safe, bounded prototype.
>
> **Drift check (run first)**: `git diff --stat 8f40cc1..HEAD -- extensions/workflows/index.ts extensions/workflows/prompt.ts extensions/workflows/artifacts.ts extensions/background-terminals/index.ts README.md`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans/005-bound-workflow-execution.md, plans/006-retain-limit-sensitive-artifacts.md, plans/011-incremental-workflow-progress.md
- **Category**: direction
- **Planned at**: commit `8f40cc1`, 2026-07-31
- **Drift reconciliation**: refreshed after plans 005–014; preserve bounded deadlines, artifact retention/privacy, package boundaries, and current docs.
- **Ollin state**: PR READY
- **Worktree**: `/Users/gocanto/Sites/pi-harness-ollin-015`
- **Branch**: `ollin/015-design-durable-workflow-recovery`
- **Base**: `ollin/014-align-effect-version-policy` at `8f40cc1`
- **Commit**: `bdadf5f Design durable workflow recovery: state machine, leases, and a bounded read-only prototype`
- **Review**: APPROVE; design grounding, state machine, threat model, bounded prototype, full verification, and documentation-only scope verified by parent
- **Pull request**: https://github.com/gocanto/pi-harness/pull/17
- **Gates**: GitHub Actions `Verify` passed; merge state CLEAN; no actionable reviews or comments

## Why this matters

Workflows persist artifacts for inspection but explicitly cannot resume; interruptions force a rerun, which can duplicate side effects. Durable recovery could make long-running orchestration more useful, but only if state, leases, idempotency, credentials, and process ownership are defined first.

## Current state

- `extensions/workflows/prompt.ts:20-21` says there is no resume and failed runs must be rerun.
- `workflows/index.ts` writes scripts, args, workflow state, transcripts, and results under `~/.pi/agent/workflows/<runId>` and now runs retention cleanup on session start.
- `extensions/workflows` has an explicit workspace package boundary and bounded sandbox deadline.
- `background-terminals/index.ts:181-185` documents process termination on session transitions.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Tests | `pnpm test` | pass |
| Typecheck | `pnpm run check` | pass |
| Formatting | `pnpm run format:check` | pass |

## Scope

**In scope**: a design document under `extensions/workflows/docs/` or `docs/`, state-machine proposal, threat model, prototype boundary, and open questions.

**Out of scope**: changing execution behavior, reattaching provider sessions, automatic retries, or changing artifact retention.

## Steps

### Step 1: Specify recovery states and leases

Define run/checkpoint states, ownership/session identity, heartbeat/lease expiry, stale-run handling, cancellation, and what data is authoritative. Distinguish resumable orchestration from non-resumable provider/tool calls.

**Verify**: the document contains a state transition table and recovery behavior for crash, reload, timeout, and duplicate resume.

### Step 2: Specify side-effect and security policy

Define idempotency requirements, credential reauthorization, trust checks, artifact permissions/retention, and whether background terminals can be reattached or must remain kill-on-shutdown.

**Verify**: threat-model review lists duplicate execution, stale owner, unauthorized cwd, and leaked artifact cases with mitigations.

### Step 3: Define a bounded prototype

Propose the smallest safe prototype, such as read-only recovery of workflow metadata before executable resume. List APIs, compatibility constraints, telemetry, and explicit non-goals.

**Verify**: maintainers can reject or approve the prototype without needing unstated assumptions; no production source changes are required.

## Test plan

The spike should include scenario tables or design-level tests. Existing verification must remain green if only docs are changed.

## Done criteria

- [ ] Recovery state machine and lease model are specified.
- [ ] Duplicate side effects and trust/credential risks are addressed.
- [ ] Resumable versus non-resumable capabilities are explicit.
- [ ] Prototype scope and open decisions are listed.

## STOP conditions

- Safe resume requires provider APIs or idempotency guarantees unavailable in the current code.
- The requested outcome is implementation rather than design; obtain a new scoped plan.
- The design would weaken current kill-on-shutdown safety.

## Maintenance notes

Do not turn artifact existence into permission to execute. Any future implementation needs separate plans for storage migration, lease enforcement, and per-backend resume semantics.
