# Plan 012: Batch and lazily load changed-file diffs

> **Executor instructions**: Read `/Users/gocanto/Sites/pi-harness/.agents/skills/typescript-coding-standards/SKILL.md` before changing TypeScript/UI code. Preserve path sanitization and command argument separators.
>
> **Drift check (run first)**: `git diff --stat ca2d0b2..HEAD -- extensions/git-info/src/changed-files-view.ts extensions/git-info/changed-files-view.test.ts extensions/git-info/src/process.ts`

## Status

- **Priority**: P2
- **Effort**: M/L
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `ca2d0b2`, 2026-07-31
- **Ollin state**: PR READY
- **Worktree**: `/Users/gocanto/Sites/pi-harness-ollin-012`
- **Branch**: `ollin/012-batch-changed-file-diffs`
- **Base**: `ollin/011-incremental-workflow-progress` at `f071d22`
- **Commit**: `58520b8 Batch and lazily load changed-file diffs in the /lg viewer`
- **Review**: APPROVE; lazy loading, bounded concurrency/cancellation, path safety, focused tests, full verification, and scope verified by parent
- **Pull request**: https://github.com/gocanto/pi-harness/pull/14
- **Gates**: GitHub Actions `Verify` passed; merge state CLEAN; no actionable reviews or comments

## Why this matters

`/lg` currently loads every changed file before showing the viewer. Each file launches separate diff and numstat commands, sequentially, and each diff can retain up to 20,000 lines. Large worktrees therefore cause slow startup and high memory use even when the user selects one file.

## Current state

- `extensions/git-info/src/changed-files-view.ts:111-114` launches diff and stat commands per file.
- `:159-163` awaits `loadFile` sequentially for every changed path.
- `MAX_DIFF_LINES` is 20,000 and truncates only after full stdout is collected.

## Commands you will need

| Purpose    | Command                       | Expected |
| ---------- | ----------------------------- | -------- |
| Tests      | `pnpm --filter git-info test` | pass     |
| Typecheck  | `pnpm run check`              | exit 0   |
| Formatting | `pnpm run format:check`       | exit 0   |

## Scope

**In scope**: changed-file status/stat loading, selected-file diff loading, bounds/cancellation, and focused tests.

**Out of scope**: Git status semantics, terminal sanitization, viewer styling, and unrelated Git-info polling.

## Steps

### Step 1: Separate cheap file listing from expensive diff loading

Return changed paths and cheap stats in a bounded first pass. Load a file’s textual diff only when selected, or use one batched command where Git semantics remain correct. Keep `--` separators and `--no-ext-diff` protections.

**Verify**: fixtures show the initial listing does not invoke per-file diff commands; selecting a file loads only that diff.

### Step 2: Bound memory and preserve cancellation

Apply a streaming or bounded capture strategy before building the 20,000-line array. Propagate cancellation and render a clear unavailable/truncated state on command failure.

**Verify**: large-diff and abort tests pass without retaining more than the documented bound.

## Test plan

Extend `changed-files-view.test.ts` beyond ANSI sanitization with rename/copy, untracked, no-HEAD, binary, Git failure, lazy selection, and cancellation fixtures.

## Done criteria

- [ ] `/lg` does not run two commands per file before the viewer opens.
- [ ] Selected diff behavior and truncation remain correct.
- [ ] Memory and command output are bounded.
- [ ] Tests, typecheck, and format check pass.

## STOP conditions

- Git cannot provide required status/stat data in a batch without changing displayed semantics.
- Lazy loading conflicts with the existing UI API and requires a UI redesign.
- Cancellation cannot safely stop outstanding Git processes.

## Maintenance notes

Keep command construction centralized and test every path-derived argument. Revisit bounds if the viewer later supports paging from disk.
