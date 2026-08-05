# Plan 014: Align the Effect beta version policy

> **Executor instructions**: Read `/Users/gocanto/Sites/pi-harness/.agents/skills/typescript-coding-standards/SKILL.md` before changing TypeScript. Do not upgrade Effect opportunistically; this plan is about making the chosen policy explicit and verified.
>
> **Drift check (run first)**: `git diff --stat 230f068..HEAD -- extensions/*/package.json pnpm-lock.yaml extensions/subagents/docs/effect-v4-extension-guide.md`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: plans/002-standardize-pnpm-setup.md, plans/009-workflows-package-boundary.md
- **Category**: migration
- **Planned at**: commit `230f068`, 2026-07-31
- **Drift reconciliation**: refreshed after plans 001–013; preserve the declared pnpm/runtime policy, workflow package importer, and current lockfile.
- **Ollin state**: PR READY
- **Worktree**: `/Users/gocanto/Sites/pi-harness-ollin-014`
- **Branch**: `ollin/014-align-effect-version-policy`
- **Base**: `ollin/013-refresh-current-documentation` at `230f068`
- **Commit**: `8f40cc1 Align Effect version-policy docs with the actual floating beta range`
- **Review**: APPROVE; synchronized dependency policy, lockfile uniqueness, doc scope, full verification, and frozen install verified by parent
- **Pull request**: https://github.com/gocanto/pi-harness/pull/16
- **Gates**: GitHub Actions `Verify` passed; merge state CLEAN; no actionable reviews or comments

## Why this matters

The manifests use floating `^4.0.0-beta.99` ranges while the lockfile resolves a later beta, and the extension guide recommends exact beta.98 pins. For a beta API, contradictory policy creates unreviewed breakage and misleading migration instructions.

## Current state

- Several extension manifests declare `effect: ^4.0.0-beta.99` and matching platform packages.
- `pnpm-lock.yaml` resolves a later beta and now also includes the workflows importer from plan 009.
- `extensions/subagents/docs/effect-v4-extension-guide.md` recommends exact beta.98 pins, while current manifests follow the existing beta range policy.
- Root `package.json` now declares the pnpm/runtime policy from plan 002.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Dependency graph | `pnpm why effect -r` | all workspace consumers listed |
| Frozen install | `pnpm install --frozen-lockfile` | exit 0 |
| Verification | `pnpm run verify` | exit 0 |
| Formatting | `pnpm run format:check` | exit 0 |

## Scope

**In scope**: Effect-related workspace manifests, lockfile, and the stale version-policy documentation.

**Out of scope**: unrelated dependency upgrades, source migration beyond what the selected version requires, and provider SDK upgrades.

## Steps

### Step 1: Choose and record one policy

Based on current lockfile compatibility and repository support requirements, choose either synchronized exact beta pins or an intentionally floating range. Record the decision in the guide with the exact rationale and upgrade procedure. Do not silently downgrade to beta.98 merely because the old guide says so.

**Verify**: all Effect package manifests and lockfile conform to the recorded policy; `pnpm why effect -r` shows no accidental duplicate beta lines.

### Step 2: Validate the selected version

If a version change is required, apply it as one synchronized dependency change and run typecheck, all deterministic tests, and format check. Review the diff for API migrations before accepting it.

**Verify**: `pnpm run verify` → exit 0; `pnpm install --frozen-lockfile` → exit 0.

## Test plan

Existing verification is the regression suite. Add migration tests only if an API behavior changes and no current test covers it.

## Done criteria

- [ ] One Effect beta policy is explicit and consistent.
- [ ] Docs no longer prescribe a conflicting beta.
- [ ] Lockfile is reproducible and verification passes.
- [ ] No unrelated dependency changes land.

## STOP conditions

- Current source is incompatible with the selected version and migration exceeds this plan’s bounded scope.
- The supported beta cannot be established without maintainer product input.
- Multiple incompatible versions are required by direct dependencies.

## Maintenance notes

Every Effect beta bump requires a deliberate lockfile review and the full verification suite. Keep the policy document close to the manifests it governs.
