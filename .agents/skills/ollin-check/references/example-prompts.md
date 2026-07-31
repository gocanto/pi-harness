# Example Prompts

Use these examples for Ollin invocations and executor packets. Read
[agent-routing.md](agent-routing.md) for routing rules and
[pr-delivery-loop.md](pr-delivery-loop.md) for delivery behaviour.

## Contents

- [User invocations](#user-invocations)
- [Partial advisor packet](#partial-advisor-packet)
- [Initial executor packet](#initial-executor-packet)
- [Revision packet](#revision-packet)
- [Remediation packet](#remediation-packet)
- [Stopped report](#stopped-report)

## User invocations

### Run Improve first

```text
Use $ollin-check deep security on this repository. Let Improve create and
select the plans, then show me their exact paths and wait for my execute
command. Do not start implementation yet.
```

### Execute one plan with one model

```text
Use $ollin-check execute /absolute/path/plans/001-fix-session-rotation.md
routing:
  - model: gpt-5.6-sol
    level: high
```

The omitted ratio means `100%` because the block has one entry.

### Execute a directory with five models

```text
Use $ollin-check execute /absolute/path/plans/
routing:
  - model: gpt-5.6-sol
    level: high
    ratio: 40%
  - model: gpt-5.6-terra
    level: high
    ratio: 20%
  - model: gpt-5.6-luna
    level: high
    ratio: 20%
  - model: claude-opus-4-8
    level: high
    ratio: 10%
  - model: gemini-3.5-flash
    level: high
    ratio: 10%
```

### Execute a smaller mix

```text
Use $ollin-check execute /absolute/path/advisor-plans/
routing:
  - model: gpt-5.6-terra
    level: medium
    ratio: 75%
  - model: claude-opus-4-8
    level: high
    ratio: 25%
```

### Reconcile an interrupted execution

```text
Use $ollin-check reconcile /absolute/path/plans/. Preserve every recorded
model assignment and inspect the existing worktrees, branches, PRs, CI, code
quality, completion checks, and automated reviews before deciding the next
action.
```

### Resume after a route becomes unavailable

```text
Use $ollin-check execute /absolute/path/plans/ with the routing block already
recorded in its index. Preserve dispatched assignments. Remove any route that
is no longer enforceable, renormalize only the remaining listed routes, report
the effective mix, and continue the undispatched plans.
```

### Route bounded advisor prompts through logged-in CLIs

```text
Use $ollin-check execute /absolute/path/plans/001-fix-session-rotation.md --partial
prompts:
  - id: security-review
    stage: parent-review
    model: claude-opus-4-8
    level: high
    prompt: |
      Review the confirmed plan and implementation diff for exploitable
      trust-boundary mistakes. Return evidence-backed findings only.
  - id: test-gap-review
    stage: parent-review
    model: gpt-5.6-terra
    level: high
    prompt: |
      Review the diff and verification evidence for material test gaps.
      Ignore unrelated improvements.
  - id: completion-review
    stage: parent-review
    model: gemini-3.5-flash
    level: high
    prompt: |
      Check whether the supplied completion evidence proves every done
      criterion. Report only unsupported claims.
```

Ollin uses the existing authenticated `claude`, `codex`, and `gemini` CLI
sessions. Each partial advisor is read-only. The plan's assigned executor still
owns every implementation change. Partial prompts do not use ratios or alter
full-executor routing.

## Partial advisor packet

Wrap every user-supplied partial prompt in a self-contained packet like this:

```text
You are a read-only advisor for one confirmed Ollin Check execution.

ASSIGNMENT
- Prompt ID: {{PROMPT_ID}}
- Stage: {{STAGE}}
- Plan: {{PLAN_PATH}}
- Worktree: {{WORKTREE_PATH}}
- Branch: {{BRANCH}}
- Model: {{EXACT_MODEL}}
- Level: {{LEVEL}}
- Harness: {{AUTHENTICATED_CLI}}

BOUNDARY
- Inspect and report only. Do not edit files or execute mutating commands.
- Do not create a worktree, commit, push, manage a PR, or edit Improve artifacts.
- Do not direct the implementation executor or issue an Ollin verdict.
- Do not reveal secrets. Identify only their type and location when relevant.
- Stay within the supplied question and evidence.

QUESTION
{{BOUNDED_USER_PROMPT}}

CONTEXT
- Confirmed plan:
  {{RELEVANT_PLAN_TEXT}}
- Relevant diff:
  {{RELEVANT_DIFF}}
- Verification, CI, quality, or review evidence:
  {{RELEVANT_EVIDENCE}}
- Repository conventions:
  {{RELEVANT_CONVENTIONS}}

RETURN
- One finding per item: severity, file and line when applicable, evidence,
  impact, and bounded recommendation.
- State `NO ACTIONABLE FINDINGS` when the evidence supports no finding.
- List assumptions and missing evidence separately.
```

The parent checks every returned finding against the repository before it can
enter a revision or remediation packet. See
[agent-routing.md](agent-routing.md#partial-prompt-routing) for the authoritative
execution rules.

## Initial executor packet

Start every implementation executor with a self-contained packet shaped like
this. Replace every placeholder and inline the complete plan.

```text
You are the implementation executor for one confirmed Improve plan.

ASSIGNMENT
- Plan: {{PLAN_PATH}}
- Worktree: {{WORKTREE_PATH}}
- Branch: {{BRANCH}}
- Base: {{BASE_BRANCH_OR_SHA}}
- Model: {{EXACT_MODEL}}
- Level: {{LEVEL}}
- Harness: {{HARNESS}}

BOUNDARY
- Work only inside the assigned worktree and confirmed plan scope.
- Do not edit plans/, advisor-plans/, their indexes, or any Improve artifact.
- Do not create another worktree or clone.
- Do not push, open or modify a PR, merge, or rewrite history.
- Stop on every plan STOP condition or material scope expansion.
- Never reproduce secret values; identify only their type and location.

REQUIRED CONSTRAINTS
- TypeScript coding standards: {{TYPESCRIPT_CODING_STANDARDS_PATH}}
- Before writing or modifying browser, Electron renderer, or UI source or tests,
  including TypeScript, JavaScript, TSX, JSX, or Vue, read that skill completely
  and follow it as a binding constraint.
- If no frontend code is changed, do not load this unrelated constraint.
- If the skill is unreadable or conflicts irreconcilably with the confirmed
  scope, stop before changing frontend code and report the evidence.

WORKFLOW
1. Confirm the repository root equals the assigned worktree.
2. Run the plan's drift check and STOP on an unreconciled mismatch.
3. Follow every plan step in order and run its stated verification.
4. Commit logical changes inside the assigned branch.
5. Audit every completion claim against command, diff, and verification
   evidence.

PLAN
{{COMPLETE_IMPROVE_PLAN_TEXT}}

RETURN EXACTLY
STATUS: COMPLETE | STOPPED
MODEL: {{EXACT_MODEL}}
LEVEL: {{LEVEL}}
COMMITS: <sha and subject, or none>
FILES CHANGED: <list, or none>
STEPS: <each step and actual verification result>
DEVIATIONS: <none or explicit list>
RISKS: <none or explicit list>
STOPPED BECAUSE: <only when stopped>
```

## Revision packet

Use the same worktree and executor context after the parent returns `REVISE`.

```text
Continue the confirmed plan in the existing assigned worktree.

ASSIGNMENT
- Plan: {{PLAN_PATH}}
- Worktree: {{WORKTREE_PATH}}
- Branch: {{BRANCH}}
- Model: {{EXACT_MODEL}}
- Level: {{LEVEL}}

REQUIRED CONSTRAINTS
- TypeScript coding standards: {{TYPESCRIPT_CODING_STANDARDS_PATH}}
- Before writing or modifying browser, Electron renderer, or UI source or tests,
  including TypeScript, JavaScript, TSX, JSX, or Vue, read that skill completely
  and follow it as a binding constraint.
- If no frontend code is changed, do not load this unrelated constraint.
- If the skill is unreadable or conflicts irreconcilably with the confirmed
  scope, stop before changing frontend code and report the evidence.

PARENT VERDICT: REVISE
{{VERIFIED_REVIEW_FINDINGS_WITH_FILE_AND_LINE_EVIDENCE}}

Address every finding without broadening scope. Preserve passing behaviour and
tests, rerun the affected plan criteria, review the complete branch diff, and
create logical local commits. Do not edit Improve artifacts, push, or manage
the PR. Stop rather than improvise around a STOP condition.

Return STATUS, COMMITS, FILES CHANGED, verification evidence, deviations, risks,
and STOPPED BECAUSE when applicable.
```

## Remediation packet

Collect current-head failures and feedback into one packet so the executor can
produce one reviewed push batch.

```text
Remediate one evidence-backed batch in the existing assigned worktree.

ASSIGNMENT
- Plan: {{PLAN_PATH}}
- Worktree: {{WORKTREE_PATH}}
- Branch: {{BRANCH}}
- PR: {{PR_URL}}
- Current head: {{HEAD_SHA}}
- Model: {{EXACT_MODEL}}
- Level: {{LEVEL}}

REQUIRED CONSTRAINTS
- TypeScript coding standards: {{TYPESCRIPT_CODING_STANDARDS_PATH}}
- Before writing or modifying browser, Electron renderer, or UI source or tests,
  including TypeScript, JavaScript, TSX, JSX, or Vue, read that skill completely
  and follow it as a binding constraint.
- If no frontend code is changed, do not load this unrelated constraint.
- If the skill is unreadable or conflicts irreconcilably with the confirmed
  scope, stop before changing frontend code and report the evidence.

CONFIRMED PLAN SCOPE
{{PLAN_SCOPE_AND_STOP_CONDITIONS}}

CURRENT BATCH
- CI and completion failures:
  {{FAILURES_WITH_CHECK_NAMES_AND_LOG_EVIDENCE}}
- Code-quality findings:
  {{ACTIONABLE_QUALITY_FINDINGS}}
- Human and bot review feedback:
  {{ACTIONABLE_REVIEW_THREADS_AND_COMMENTS}}

Fix the complete batch without expanding scope. Run the relevant local checks,
create logical local commits, and report evidence for each item. Do not edit
Improve artifacts, push, change draft/ready state, reply to reviews, or resolve
threads; the parent performs those actions after review and pushes once.

Return STATUS, COMMITS, FILES CHANGED, each batch item's disposition,
verification evidence, deviations, risks, and STOPPED BECAUSE when applicable.
```

## Stopped report

Require this shape whenever an executor cannot proceed:

```text
STATUS: STOPPED
MODEL: {{EXACT_MODEL}}
LEVEL: {{LEVEL}}
COMMITS: <sha and subject, or none>
FILES CHANGED: <list, or none>
STEPS: <completed and skipped steps with evidence>
DEVIATIONS: <none or explicit list>
RISKS: <none or explicit list>
STOPPED BECAUSE: <exact STOP condition, observed evidence, and required decision>
```
