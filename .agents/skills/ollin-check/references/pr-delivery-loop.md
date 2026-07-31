# Pull Request Delivery Loop

Read this reference only after the parent has approved an executor worktree and
recorded the plan as `READY FOR PR` under Ollin's delivery extension.

## Preconditions

Before pushing, confirm:

- `gh auth status` succeeds with repository, pull-request, Actions, and review
  permissions;
- the repository has the expected GitHub remote and target branch;
- the worktree, branch, reviewed commits, and plan metadata agree;
- the branch contains only the approved plan changes;
- the applicable local verification still passes.

If delivery is unavailable, preserve the worktree at `READY FOR PR` and report
the exact blocker. Never push unreviewed work merely to obtain remote feedback.

## Build the stack

Use Improve's recommended order as a deterministic linear stack:

1. Push the first approved plan branch and open a draft PR against the normal
   target branch.
2. Stabilize that PR completely before starting the next plan.
3. Start each later worktree from the preceding `PR READY` plan branch and open
   its draft PR against that branch.

Use the plan title for the PR title and a concise body containing the objective,
scope, verification evidence, and stack relationship. Never mention Codex or
other tooling as author or attribution. Never merge automatically.

After opening the PR, record its URL, branch, worktree, commits, and `PR DRAFT`
status under Ollin's delivery extension.

## Discover gates

Inspect live repository configuration before applying labels:

- workflow triggers and conditions under `.github/workflows/`;
- available repository labels;
- branch protection and required checks when accessible;
- configured code-quality and automated-review integrations.

Apply only labels proven to gate CI, completion checks, code-quality analysis,
or automated review. Do not invent labels. Stop for separate authorization
before applying a deployment, release, destructive, or externally mutating
label.

## Observe the latest head

Evaluate every cycle against the PR's current head SHA:

- use GitHub Actions check and job logs for Actions failures;
- record inaccessible external checks with their URLs instead of guessing;
- inspect check runs, completion checks, and code-quality reports;
- read reviews, top-level comments, and every paginated review thread;
- identify configured bot reports, including CodeRabbit, for the current head.

Use `gh-fix-ci`, `gh-address-comments`, and
`resolve-github-pr-reviews` when they are available. A local or CLI review does
not substitute for a configured PR bot report. Treat stale-head reports as
historical evidence, not current approval.

## Remediate in batches

When any actionable failure or review entry exists:

1. If the PR is ready for review, mark it draft before source-changing work.
2. Collect all current CI failures, completion-check failures, code-quality
   issues, and actionable human or bot feedback into one evidence-backed batch.
3. Give that batch to the plan's executor worktree. Keep every fix inside the
   confirmed plan scope; request new authorization for material expansion.
4. Let the parent review the full batch using Improve's review contract and run
   the relevant local checks.
5. Create logical commits, but push the reviewed batch once so remote checks and
   bots do not run for every small fix.
6. After the push and verification, resolve only threads whose request is fully
   addressed. Resolve them one by one with recorded evidence, then refetch all
   threads and confirm the intended state.

Reply with evidence instead of resolving when feedback is ambiguous, disputed,
partially addressed, or asks for a decision. Top-level comments are not review
threads and cannot be marked resolved.

Repeat while each cycle produces new evidence or safe progress. Block on
missing permissions, contradictory requirements, unavailable required logs,
unsafe scope expansion, or repeated non-progress.

## Promote and recheck

Before marking a draft PR ready, require for its latest head:

- all CI and completion checks succeeded or are intentionally neutral/skipped;
- code-quality checks have no unresolved actionable issue;
- current automated-review reports completed;
- no actionable unresolved review thread remains.

Mark the PR ready, record `IN PROGRESS` under Ollin's delivery extension, and
monitor every check or review triggered by that transition. If new actionable
feedback appears, return the PR to draft before fixing it and repeat the batch
loop.

Record `PR READY` only when the PR remains ready and all conditions above still
hold after the ready transition. Human approval and merge remain outside this
skill.

## Upstream changes

If an earlier PR changes after a descendant exists, pause and draft affected
descendants. Incorporate the updated parent branch without rewriting history
when repository policy permits, delegate conflicts to an executor, and rerun
the complete delivery loop from the earliest affected PR.
