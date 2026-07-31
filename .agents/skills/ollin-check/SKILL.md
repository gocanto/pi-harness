---
name: ollin-check
description: Execute plans created by the Improve skill through exact-model routed implementation sub-agents, optional read-only CLI advisors, isolated worktrees, independent parent review, stacked draft pull requests, and persistent CI, code-quality, completion-check, and automated-review remediation. Use when the user wants to run Improve and then deliver its plans, execute an exact Improve plan or plan directory with optional model routing or partial advisor prompts, or reconcile Improve plans with their worktrees and pull requests.
---

# Ollin Check

Act as the delivery advisor and quality gatekeeper. Let Improve understand the
repository and own every planning artifact. Delegate source implementation,
independently review it, and drive approved pull requests until their latest
state is clean.

## Load Improve first

Read [Improve](../improve/SKILL.md) completely before doing anything else. Use
its plan format, directory ownership, executor packet, and review criteria as
the planning source of truth. Read the Improve references required for the
active operation, then apply only the Ollin delivery extensions below.

Never create, select, rename, or invent a plan directory or plan file. Improve
alone creates `plans/`, `advisor-plans/`, their indexes, and plan files. Never
modify `.agents/skills/improve/` or copy custom Ollin instructions into it. If
Improve is unavailable, stop instead of recreating its behaviour here.

## Ollin delivery extension

When Ollin executes an Improve plan, the parent—not the executor—maintains the
existing plan and index. Tell the executor to skip Improve's index-update
instruction. The parent may add `Worktree`, `Branch`, `Commit`, and `Pull
request` metadata and use this extended lifecycle:

```text
TODO | IN PROGRESS | READY FOR PR | PR DRAFT
PR READY | DONE | BLOCKED | REJECTED
```

`READY FOR PR` means the parent approved the isolated implementation. `PR
READY` means the PR is ready and its current CI, code-quality, completion, and
automated-review gates are clean. `DONE` means the accepted commits are
reachable from the target branch. These are Ollin-only extensions; standalone
Improve remains unchanged.

## Invocation

- Bare invocation or Improve arguments: run the matching Improve planning
  workflow in the parent context. After Improve writes the selected plans,
  present their exact paths and wait for one `execute <exact path>` command.
- `execute <plan-or-directory>`: treat the explicit command as authorization to
  execute and deliver that exact current plan set. Do not ask for duplicate
  approval. Accept an optional `routing` block after the command.
- `execute <plan-or-directory> --partial`: execute the same confirmed plan set
  and route the supplied bounded analysis or review prompts through read-only
  advisors. The plan's one assigned executor remains the only agent allowed to
  change its worktree.
- `reconcile <directory>`: use Improve for its native planning states, then use
  the Ollin extension for recorded worktrees and pull requests in that exact
  directory.

Do not support numeric aliases, revision approvals, directory guessing, or an
Ollin-owned planning format. If a confirmed plan or selected set changes before
dispatch, present the changed paths and request confirmation again.

## Optional model routing

Before a routed execution, read [the agent-routing reference](references/agent-routing.md).
Read [the example prompts](references/example-prompts.md) before constructing the
first executor packet or when the user asks how to invoke Ollin.

Each routing entry contains an exact `model`, a per-model `level`, and, for a
mix, a positive integer `ratio`. Mixed ratios must total `100%`; one model may
omit its ratio and receive `100%`. Reject duplicate models or malformed ratios
before creating a worktree. With no routing block, preserve the existing
executor behaviour; Ollin has no default model mix.

Validate every model and level through a live, controllable harness. Remove
unavailable or uncontrollable entries, renormalize only the remaining
user-listed ratios, and report the effective mix. Block when none remain. Give
each Improve plan exactly one routed executor and one worktree; ratios
distribute plans, never competing implementations.

For the documented GPT, Claude, and Gemini identifiers, use the corresponding
already-authenticated `codex`, `claude`, or `gemini` CLI directly by default.
Do not start a login flow, inject credentials, or switch providers. `--partial`
uses those same CLI sessions in read-only mode for the explicit `prompts` list.
Partial prompts have no ratios, never change executor assignment, and cannot
return an implementation verdict. Follow the partial-routing contract in the
agent-routing reference.

## Parent boundary

The parent is the advisor and reviewer, never the source implementer. It may:

- run Improve, inspect the repository, and maintain Ollin execution and
  delivery state in Improve-created artifacts;
- provision isolated worktrees and manage their local Git metadata;
- dispatch and guide executors;
- run verification, inspect diffs, and collect evidence;
- push an approved executor branch, manage its PR state and labels, reply to or
  resolve verified review threads, and monitor checks.

The parent must never edit source, fix a conflict, merge a PR, push the target
branch, expose secrets, or broaden scope without new authorization.

## Frontend code constraint

Include the resolved path to
[the TypeScript coding standards](../typescript-coding-standards/SKILL.md) in
every packet sent to a write-capable executor. Before the executor writes or
modifies browser, Electron renderer, or UI source or tests—including
TypeScript, JavaScript, TSX, JSX, or Vue—it must read that skill completely and
treat its standards as binding. This requirement follows the code being
changed, even when the confirmed plan was not classified as frontend work, and
it remains in initial, revision, and remediation packets.

The standards do not broaden the confirmed scope. If the executor will not
change frontend code, it does not need to load them. If their path is unreadable
or their requirements conflict irreconcilably with the confirmed scope, the
executor must stop before changing frontend code and report the evidence. Do
not add this implementation constraint to read-only advisor packets. The
standards guide changes inside the confirmed scope and never authorize unrelated
cleanup.

During independent review, inspect every frontend diff and its tests against
the TypeScript coding standards. Return `REVISE` for a correctable violation or
`BLOCK` when compliance cannot be achieved safely within the confirmed scope.

## Execute Improve plans

Read [Improve's closing-the-loop reference](../improve/references/closing-the-loop.md).
Before dispatch, verify the Git repository, exact plan path, dependencies,
drift check, required tools, worktree isolation, GitHub remote, authentication,
permissions, and an enumerable in-scope source and test file set. Block before
source changes when the promised delivery path or bounded confirmed scope is
unavailable.

Process a directory in Improve's recommended order as one linear PR stack. The
first worktree starts from the target branch. After a plan reaches `PR READY`,
start the next worktree from that approved plan branch.

For a routed set, validate the complete routing block, assign models in plan
order, and record the routing profile and effective mix before creating the
first worktree. Preserve recorded assignments on resume. A changed routing
block applies only to undispatched plans.

For each plan:

1. Create one isolated worktree, then record `IN PROGRESS`, its path, and its
   branch in the existing Improve plan and index before dispatch. Also record
   its assigned model, level, and harness when routed. Give one executor the
   full plan text plus Improve's executor instructions using the initial packet
   in the example prompts. Include the Ollin override that forbids plan or
   index edits and the frontend code constraint above. Do not pass unrelated
   conversation state.
2. Require the executor to commit inside its worktree and report actual command
   evidence, changed files, deviations, and risks.
3. Independently rerun every done criterion, enforce scope, read the complete
   diff, tests, and in-scope source and test files, and assess correctness,
   security, maintainability, code quality, completion checks, repository
   conventions, and the frontend code constraint when applicable.
   When `--partial` is present, run each bounded advisor prompt at its requested
   stage, verify its evidence, and fold actionable findings into this review.
4. Return Improve's `APPROVE`, `REVISE`, or `BLOCK` verdict. Continue revisions
   while evidence shows safe progress; block repeated non-progress or a STOP
   condition rather than looping blindly.
5. On approval, record `READY FOR PR` under the Ollin extension, then read and
   follow [the PR delivery loop](references/pr-delivery-loop.md).

Only reviewer-approved commits may be pushed. Leave every PR unmerged for the
human.

## Report

Report each plan's native Improve state and Ollin delivery state, worktree,
branch, routing profile, model, level, harness, commits, PR and base PR,
verification evidence, CI and quality state, review-thread state, deviations,
partial-advisor results, blocked work, and remaining human action.
