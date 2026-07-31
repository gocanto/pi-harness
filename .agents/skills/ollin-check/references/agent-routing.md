# Agent Routing

Read this reference before executing an Improve plan with a `routing` block or
`--partial`. Full routing assigns one executor to each plan. Partial routing
sends bounded read-only prompts to advisors and never creates an implementation.

## Contents

- [Contract and validation](#contract-and-validation)
- [Authenticated CLI defaults](#authenticated-cli-defaults)
- [Partial prompt routing](#partial-prompt-routing)
- [Weighted assignment](#weighted-assignment)
- [Recorded state and resume](#recorded-state-and-resume)
- [Worktree boundary](#worktree-boundary)
- [Harness examples](#harness-examples)

## Contract and validation

Accept this shape after an exact `execute` command:

```yaml
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

This is an example, not a default. Require:

- an exact, non-empty model identifier;
- a level the selected live harness can enforce;
- positive integer ratios totalling `100%` for a mix;
- no duplicate model identifiers.

A single entry may omit `ratio` and receives `100%`. Reject a missing ratio in
a mix, zero or fractional ratios, totals other than `100%`, and duplicates
before creating any worktree.

Inspect the live harness schema, local model catalogue, and CLI help without
invoking inference. Classify each entry as eligible or ineligible. An entry is
eligible only when the harness can enforce its exact model, requested level,
working directory, source-writing permissions, bounded execution, and required
task tools.

Remove ineligible entries and preserve the relative weights of the remaining
user-listed routes. Report the removed entries and reason, raw remaining
weights, and effective percentages. Do not introduce an unlisted fallback.
Block before dispatch if no entry remains.

## Authenticated CLI defaults

Use the installed, already-authenticated CLI as the default harness for its
model family:

| Model family | Default harness | Safe authentication check                    |
| ------------ | --------------- | -------------------------------------------- |
| `gpt-*`      | `codex`         | `codex login status`                         |
| `claude-*`   | `claude`        | `claude auth status`                         |
| `gemini-*`   | `gemini`        | Use the CLI's existing authenticated session |

Run the CLI directly from the parent-created worktree. Never start an
interactive login, print credentials, add API keys, switch providers, or copy
authentication state. If the matching CLI is absent, logged out, or cannot
enforce the requested model and level, classify that route as ineligible. A
native or custom harness is used only when the caller explicitly requests it
and its live interface satisfies the same controls.

These are harness defaults, not a default model mix. The caller still chooses
the exact model, level, and full-executor ratios.

## Partial prompt routing

`execute <exact-plan-or-directory> --partial` accepts a `prompts` list:

```yaml
prompts:
    - id: security-review
      stage: parent-review
      model: claude-opus-4-8
      level: high
      prompt: |
          Review the supplied plan and branch diff for exploitable trust-boundary
          mistakes. Return evidence-backed findings only.
    - id: test-gap-review
      stage: parent-review
      model: gpt-5.6-terra
      level: high
      prompt: |
          Find material test gaps in the supplied diff and completion evidence.
          Do not propose unrelated refactors.
```

Require a unique `id`, exact `model`, supported `level`, and bounded `prompt`
for every entry. An optional `stage` selects `pre-implementation`,
`parent-review`, or `remediation`; it defaults to `parent-review`. Prompt
entries do not accept ratios. They run independently through the model family's
authenticated default CLI and do not participate in weighted assignment or
renormalization.

The parent supplies only the context needed for the question: the confirmed
plan, relevant diff, test or CI evidence, and repository conventions. It also
sets the exact worktree as the CLI working directory, uses read-only controls,
bounds elapsed time and retries, and requests structured findings with file,
line, severity, evidence, and recommendation. Never include secrets or
unrelated conversation history.

A partial advisor may inspect and report. It must not edit files, create a
worktree, commit, push, manage a PR, alter Improve artifacts, direct the
executor, or issue `APPROVE`, `REVISE`, or `BLOCK`. The assigned executor alone
implements changes. The parent independently verifies every advisor finding
before adding it to an executor revision or remediation batch.

If a partial route is unavailable or uncontrollable, report that prompt as
skipped with the reason. Continue other prompts unless the caller marked that
specific review as required; a required unavailable prompt blocks at its
declared stage. Partial results never change a started or undispatched executor
assignment.

## Weighted assignment

Use Improve's recommended plan order. For the current routing-profile segment,
let `w(i)` be a route's remaining raw weight and `W` their total. For each
unassigned plan at one-based position `n`:

1. Calculate `target(i) = n * w(i) / W`.
2. Calculate `deficit(i) = target(i) - assigned(i)`.
3. Choose the route with the greatest deficit.
4. Break an exact tie by routing-block order.
5. Increment that route's assigned count and record the assignment.

This weighted-deficit schedule gives the `40/20/20/10/10` example exactly
`4/2/2/1/1` assignments over ten plans while remaining deterministic for small
or resumed sets. Do not create extra agents to make a percentage exact.

## Recorded state and resume

Record Ollin routing state only in the existing Improve-created plan and index:

```text
Routing profile: <ordered model@level=ratio entries>
Effective routing: <eligible entries and normalized percentages>
Model: <exact identifier>
Level: <requested level>
Harness: <verified tool, CLI, or adapter>
```

Never ask the executor to edit this metadata. On resume, retain every recorded
assignment and continue the same deficit schedule. If the user supplies a new
routing block, keep dispatched plans unchanged and start a new profile segment
at position one for the undispatched remainder.

If a route becomes ineligible before its assigned plan starts, remove it,
renormalize the remaining listed routes, and recalculate only undispatched
assignments. If the plan already started, keep its assignment and report or
block the executor failure through the normal Ollin review loop.

## Worktree boundary

The parent creates and verifies the worktree before dispatch. Require:

- the process working directory and `git rev-parse --show-toplevel` to equal the
  recorded worktree;
- one executor process or native agent for the assigned plan;
- the complete Improve plan and Ollin executor override in the prompt;
- a bounded timeout and retry count;
- no provider-created worktree, nested clone, push, PR, or plan-file edit.

Use a host-managed isolated worktree when the harness exposes one without
delegating worktree ownership to the executor. Otherwise respect the active
repository's approved worktree root and create it explicitly before launch:

```text
git worktree add -b <branch> <worktree> <base-branch-or-sha>
git -C <worktree> rev-parse --show-toplevel
git -C <worktree> rev-parse --absolute-git-dir
git -C <worktree> rev-parse --git-common-dir
```

Verify the returned paths and record them before assigning `IN PROGRESS`.

Do not use permission-bypass flags. If the verified harness cannot perform the
plan within its ordinary approved permissions, mark the route ineligible.

## Harness examples

Treat commands as shapes, not proof of availability. Recheck live help and the
model catalogue immediately before dispatch. Supply prompts without exposing
secret values and capture structured output when the harness supports it.

The implementation commands below use ordinary authenticated CLI sessions.
For `--partial`, use the read-only variants in
[Partial advisor command shapes](#partial-advisor-command-shapes).

### Codex CLI

The current Codex catalogue exposes `gpt-5.6-sol`, `gpt-5.6-terra`, and
`gpt-5.6-luna`. Invoke the selected exact model from the parent-created
worktree:

```text
codex --strict-config --ask-for-approval never \
  --cd <worktree> \
  --model gpt-5.6-sol \
  --sandbox workspace-write \
  exec --ephemeral --ignore-user-config \
  -c 'model_reasoning_effort="high"' \
  --output-schema <executor-report-schema> \
  --json -
```

Use the requested exact GPT-5.6 identifier in place of the example. Confirm the
selected model supports the requested reasoning level. Supply the executor
prompt on standard input. Approval policy is a global option and must precede
`exec`. Run with a parent-owned timeout and bounded retry count; do not use
dangerous bypass options.

### Claude Code

Run Claude from the assigned process working directory. Do not pass Claude's
worktree option because Ollin already owns the worktree:

```text
claude -p \
  --model claude-opus-4-8 \
  --effort high \
  --permission-mode dontAsk \
  --allowedTools <scoped-tool-list> \
  --no-session-persistence \
  --max-budget-usd <approved-cap> \
  --output-format json \
  <executor-prompt>
```

Verify `claude-opus-4-8`, the requested effort, and non-interactive permission
behaviour through live help before dispatch. Set the process working directory
to the recorded worktree and bound elapsed time and retries externally.

### Gemini and Antigravity

Use an Antigravity or native agent route only when its exposed controls select
`gemini-3.5-flash` and the requested `high` level. Record the actual harness.

Gemini CLI currently exposes the model flag but may not expose a reasoning
level flag:

```text
gemini --model gemini-3.5-flash \
  --prompt <executor-prompt> \
  --approval-mode auto_edit \
  --policy <scoped-policy> \
  --output-format json
```

This CLI shape is ineligible for `level: high` unless live help or configuration
proves that High is enforceable. Do not substitute a prompt-only request for a
real level control, and do not use `yolo` to avoid permission prompts. Set the
process working directory to the recorded worktree and bound elapsed time and
retries externally. Treat Antigravity as ineligible until it exposes a callable
headless interface with enforceable model, level, and working-directory
controls.

### Native and custom sub-agents

Inspect the active delegation tool schema. Use a native or custom sub-agent
only when the call can enforce the requested exact model, level, working
directory, and tools. A task-only spawn interface cannot satisfy routed model
or level requirements and is ineligible; never invent unsupported call fields.

### Partial advisor command shapes

Pass the self-contained partial advisor packet on standard input. Run each
command from the recorded worktree with a parent-owned timeout and bounded
retry count.

Codex:

```text
codex --strict-config --ask-for-approval never \
  --cd <worktree> \
  --model gpt-5.6-terra \
  --sandbox read-only \
  exec --ephemeral --ignore-user-config \
  -c 'model_reasoning_effort="high"' \
  --output-schema <advisor-report-schema> \
  --json -
```

Claude:

```text
claude -p \
  --model claude-opus-4-8 \
  --effort high \
  --permission-mode plan \
  --tools "Read,Glob,Grep" \
  --disallowedTools "Edit,Write,Bash,NotebookEdit" \
  --no-session-persistence \
  --max-budget-usd <approved-cap> \
  --output-format json \
  <advisor-prompt>
```

Gemini:

```text
gemini --model gemini-3.5-flash \
  --prompt <advisor-prompt> \
  --approval-mode plan \
  --policy <read-only-policy> \
  --output-format json
```

Keep the requested-level eligibility rules from the full harness examples.
Read-only mode does not excuse an unenforceable model or level.
