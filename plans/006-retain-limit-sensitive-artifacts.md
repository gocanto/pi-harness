# Plan 006: Retain-limit and protect captured artifacts

> **Executor instructions**: Read `/Users/gocanto/Sites/pi-harness/.agents/skills/typescript-coding-standards/SKILL.md` before changing TypeScript. Keep all existing output-size bounds and atomic-write behavior.
>
> **Drift check (run first)**: `git diff --stat ca2d0b2..HEAD -- extensions/workflows/artifacts.ts extensions/workflows/serialization.ts extensions/workflows/dashboard.ts extensions/file-search/src/process.ts extensions/file-search/src/output.ts extensions/file-search/index.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `ca2d0b2`, 2026-07-31
- **Ollin state**: DONE
- **Merged**: `4c1205e` (PR #7) into `main`
- **Worktree**: `/Users/gocanto/Sites/pi-harness-ollin-006`
- **Branch**: `ollin/006-retain-limit-sensitive-artifacts`
- **Base**: `ollin/005-bound-workflow-execution` at `53c1d2e`
- **Commit**: `983546d Retain-limit and protect captured workflow/file-search artifacts`
- **Review**: APPROVE; permissions, retention, cleanup, focused tests, full verification, and scope verified by parent
- **Pull request**: https://github.com/gocanto/pi-harness/pull/7
- **Gates**: GitHub Actions `Verify` passed; merge state CLEAN; no actionable reviews or comments

## Why this matters

Workflow transcripts/results and truncated file-search output can contain repository secrets or private data. Workflow artifacts are retained under the agent directory and file-search intentionally retains full output after truncation, with no session/age cleanup policy. The fix must preserve useful inspection while reducing exposure and ensuring files are private.

## Current state

- `workflows/artifacts.ts:90-120` persists bounded transcripts, results, and workflow metadata.
- `workflows/serialization.ts:148-153` creates parent directories and atomically writes files; the temp file mode is private, but directory permissions and existing-file modes are not explicitly hardened.
- `file-search/src/process.ts:90-132` retains truncated output directories after success.
- `file-search/src/output.ts:39-43` writes full output to a temporary file and returns its path to the model.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Tests | `pnpm --filter file-search test && pnpm --filter workflows test` | pass |
| Typecheck | `pnpm run check` | exit 0 |
| Formatting | `pnpm run format:check` | exit 0 |

## Scope

**In scope**: artifact/output permission modes, explicit session/age cleanup ownership, and tests for cleanup and privacy.

**Out of scope**: changing transcript content semantics, increasing output limits, or adding secret scanning that can corrupt legitimate source text without a documented policy.

## Steps

### Step 1: Harden file and directory creation

Ensure workflow run directories and files are created with private permissions, including existing-file replacement behavior. Ensure file-search full-output files are private. Verify on POSIX without relying on umask; preserve Windows compatibility.

**Verify**: tests inspect mode bits where supported; existing atomic-write tests remain green.

### Step 2: Add bounded cleanup

Define and document a retention policy: session shutdown cleanup for session-scoped search captures and an age/explicit cleanup policy for workflow runs. Preserve the full-output pointer until cleanup and make cleanup idempotent. Avoid deleting active workflow artifacts.

**Verify**: tests cover successful cleanup, repeated cleanup, failed search cleanup, and retained active artifacts.

### Step 3: Audit model-visible paths

Ensure notices explain that full output is temporary and that no path is retained without the policy. Do not log or copy captured content during cleanup.

**Verify**: `pnpm run check`, both focused test commands, and `pnpm run format:check` pass.

## Test plan

Add focused tests for private modes, retention expiry/session cleanup, active-run preservation, and cleanup failure handling. Keep current truncation and spill tests.

## Done criteria

- [ ] Captured artifacts have private permissions where the platform supports them.
- [ ] Retention is bounded and documented.
- [ ] Cleanup is idempotent and cannot remove active workflow state.
- [ ] Existing output/truncation behavior remains tested.

## STOP conditions

- The host lifecycle provides no safe session-shutdown hook for file-search cleanup.
- A retention policy would make returned model-visible paths unusable before the user can inspect them.
- Permission behavior cannot be tested safely on the supported platform matrix.

## Maintenance notes

Review every new artifact writer against the same permissions and retention policy. Never add raw transcript or search-result logging while debugging this code.
