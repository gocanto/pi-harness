# A unified job surface — design spike

> **Status:** design/spike (plan `plans/016-design-unified-job-surface.md`). No
> shared abstraction, tool rename, or UI change is implemented by this
> document. Every interface below is **proposed** and unimplemented unless a
> fact is explicitly cited against current source (file:line). This spike's
> own conclusion (§5) is a **conditional recommendation to defer**, not an
> endorsement to build — see [Maintenance notes](#maintenance-notes).

## 1. Why this matters, and why it is hard

`extensions/workflows`, `extensions/subagents`, and `extensions/background-terminals`
all let the model start long-running work and let the human inspect it later
(`/workflows`, `/subagents`, `/ps`), but each grew its own identifiers, status
enum, cancellation contract, output-retention policy, and trust boundary,
independently, on top of independently-shaped Effect/manager code. README
lists all three as separate capabilities. A user watching three different
status widgets and running three different slash commands to answer "what is
still running?" is the concrete confusion this spike was asked to scope.

The hard part is that "long-running work" is not one thing here:

- A workflow agent call is an **in-process, in-memory child session** with no
  provider-level persistence (`extensions/workflows/docs/durable-recovery-design.md`
  §2.3 — "there is no provider-level session to resume").
- A subagent is a **real backend session** (pi in-process SDK session, a
  Claude Agent SDK session, or a `codex app-server` JSON-RPC process),
  `extensions/subagents/index.ts:1-21`.
- A background terminal is a **real OS child process** with no session
  concept at all — just stdout/stderr streams,
  `extensions/background-terminals/index.ts:1-19`.

A design that papers over this with one enum risks exactly what the plan's
executor instructions warn against: replacing tools or weakening
backend-specific security boundaries. This document's job is to find the
smallest read-only common surface that does *not* require doing that, and to
say plainly where the differences are load-bearing and must stay separate.

---

## 2. Inventory: current contracts, side by side

This section is the authoritative baseline every later section builds on,
extracted from the current source at the base commit (`bdadf5f`, no drift —
see the plan's drift check) plus the durable-recovery design from plan 015.

### 2.1 Identifiers

| | Format | Source | Scope |
|---|---|---|---|
| Workflow run | `wf_<12-hex>` | `randomBytes(6).toString("hex")`, `extensions/workflows/index.ts:403` | one `workflow` tool call |
| Subagent | backend-prefixed id minted by `SubagentManager.spawn` | `extensions/subagents/src/manager.ts` (id space shared across all three backends) | one `subagent_spawn` call |
| Background terminal | id minted by `TerminalManager.start` | `extensions/background-terminals/src/manager.ts` | one `bg_start` call |

None of the three id formats overlap or are drawn from a shared namespace;
each manager mints and owns its own ids. A unified surface would need to
either wrap these opaquely (safe) or invent a fourth namespacing scheme
(unnecessary — see §4).

### 2.2 Lifecycle / state models

| | States | Type shape | Derived/inferred states |
|---|---|---|---|
| Workflow (run) | `"running" \| "completed" \| "failed" \| "aborted"` | `WorkflowStatus`, `extensions/workflows/model.ts:42` | `listRuns()` infers a stale `"running"` on disk as `"aborted"` for display only, never rewrites it — `extensions/workflows/index.ts:207-217` |
| Workflow (agent) | `"running" \| "done" \| "error"` | `AgentState`, `extensions/workflows/model.ts:41` | none today (plan 015 §4.2 proposes an `"unknown"` derived state for cross-process recovery — unimplemented) |
| Subagent | `"running" \| "done" \| "error"` | `SubagentStatus`, `extensions/subagents/src/domain.ts:36` | none — a subagent can be restarted via `send()` after settling idle (`extensions/subagents/manager.test.ts:231` "idle restarts respect the concurrency cap"), which workflows and background-terminals have no equivalent of |
| Background terminal | `"running" \| "done" \| "failed" \| "killed"` | `TerminalStatus`, `extensions/background-terminals/src/domain.ts:11-14` | none — states are OS-exit-code-driven, not model/session-driven |

All four are already tagged unions, not booleans, which is good precedent for
a common model (§3) — but the *number* of states differs (3, 3, 3, 4) and
their *meaning* differs even where the label matches: subagent `"error"` means
the backend session itself failed; background-terminal `"failed"` means the
OS process exited non-zero or a spawn-level error occurred; workflow-run
`"failed"` means the orchestration script threw or the shutdown-settle
deadline was exceeded (`extensions/workflows/index.ts:643-656`). Collapsing
these into one shared enum would blur three different failure semantics that
today's descriptions and tests each pin down separately.

### 2.3 Result delivery

All three follow the same *pattern* — deferred queue, flush on
`agent_settled`/idle, consumed-vs-deferred bookkeeping to avoid double
delivery — but each has its **own independent implementation**, not a shared
one:

- `extensions/workflows/index.ts:691-714` (background follow-up via
  `pi.sendUserMessage`, no separate result-delivery module — the workflow
  case is simpler because there is exactly one result per run, not N).
- `extensions/subagents/src/result-delivery.ts` +
  `extensions/subagents/result-delivery.test.ts` (6 scenarios, including
  "a result stays pending after a failed send and delivers once on retry").
- `extensions/background-terminals/src/result-delivery.ts` +
  `extensions/background-terminals/result-delivery.test.ts` (4 scenarios,
  including "a drained result can be retained for retry after delivery
  fails").

This is the single clearest case of *convergent design without shared code*.
`createDeferredResultDelivery<T>()` is duplicated verbatim in spirit between
subagents and background-terminals — a genuine candidate for extraction *as
a small generic utility*, independent of whether any broader job-surface
unification happens (see §4.4 and §5.3's rejection criteria — this is called
out explicitly because it is the one place unification is safe and cheap,
unlike the read-model itself).

### 2.4 Cancellation guarantees

| | Tool | Mechanism | Bound | What happens to output |
|---|---|---|---|---|
| Workflow | *(no direct cancel tool — only whole-session shutdown or Esc on a blocking call)* | `RunController.abort()` + `settle()` | `RUN_SHUTDOWN_TIMEOUT_MS = 8_000` (`extensions/workflows/controller.ts:3`) | in-flight agent left `"error"`, `"Agent did not settle before run cleanup"` (`index.ts:658-664`) |
| Subagent | `subagent_cancel` | `manager.cancel(ids)` → Effect fiber interrupt | `STOP_TIMEOUT_MS = 5_000` (`extensions/subagents/src/manager.ts:47`) | reports `cancelled: true`/status per id; a Claude/Codex backend session is torn down, not just interrupted in-process |
| Background terminal | `bg_kill` | SIGTERM → `SETTLE_GRACE_MS` grace → SIGKILL tree-kill | `STOP_TIMEOUT_MS = 5_000` + `SETTLE_GRACE_MS = 1_000` (`extensions/background-terminals/src/manager.ts:45-50`) | stdout/stderr captured up to the kill; `killed` recorded, spill file finalized within `SPILL_FLUSH_TIMEOUT_MS = 1_500` |

Workflows has **no per-run cancel tool at all** today — only the parent
session's Esc (blocking runs) or `session_shutdown` (background runs) can
stop one. This is a real capability gap relative to the other two, not a
unification question — see §4's "capability flags, not lowest common
denominator."

### 2.5 Output retention

| | Where | Cap | Sweep |
|---|---|---|---|
| Workflow | `~/.pi/agent/workflows/<runId>/` on disk, owner-only `0600`/`0700` (`extensions/workflows/serialization.ts:5-7`) | `transcripts.json` 32KB/agent, 8KB/entry (`artifacts.ts:9-10`); `result.json` 1MB | `cleanupExpiredWorkflowRuns`, 14 days (`WORKFLOW_RETENTION_MS`, `retention.ts:10`), run on every `session_start`, skips anything in `activeRuns` |
| Subagent | in-memory only; session file lives with the backend (pi session file / Claude projects JSONL / Codex rollout path, `extensions/subagents/src/domain.ts` `sessionFilePath`) | `SUBAGENT_OUTPUT_MAX_BYTES = 24 * 1024` truncation on read (`extensions/subagents/index.ts:78`); `MAX_TRACKED = 64` in-memory entries, pruned oldest-settled-first (`src/manager.ts:39-40`) | no disk sweep owned by this extension — backend session files are the backend's own retention story, out of scope here |
| Background terminal | in-memory ring buffer + optional private spill file under `os.tmpdir()/pi-background-terminals/session-*` (`src/manager.ts:459-462`) | in-memory view bounded (head-truncated, `truncatedBytes` reported); spill is the full capture | spill directory removed on runtime disposal (`fs.rmSync(dir, { recursive: true, force: true })`, `src/manager.ts:853`) — a **session**-scoped sweep, not a time-based one like workflows' 14-day retention |

Three genuinely different retention *policies* (disk-persistent + time-swept,
backend-owned + memory-pruned, tmpdir-scoped + disposal-swept) driven by three
different durability guarantees. A shared "output pointer" concept (§3) can
represent "where is the full output" without unifying *how long it lives*.

### 2.6 Trust policy

| | Cross-directory trust check | Enforcement point |
|---|---|---|
| Workflow | none — every `agent()` call always runs in the parent's `ctx.cwd` with the parent's live `ctx.isProjectTrusted()` captured once per run (`extensions/workflows/index.ts:431`); there is no `working_dir` parameter at all | implicit: no cwd param means no cross-directory question exists |
| Subagent | explicit — `resolveStandaloneChildProjectTrust` (`extensions/shared/child-session.ts`) fails closed for any `working_dir` outside the parent's trusted directory unless an explicit `ProjectTrustStore` entry exists; enforced **before** a concurrency slot is reserved or a backend session starts (`extensions/subagents/index.ts:290-302`, regression-tested in `extensions/subagents/trust.test.ts`: same-dir/alt-dir/trusted/untrusted × 5 scenarios) | `subagent_spawn`'s `execute`, ahead of `manager.spawn` |
| Background terminal | **none** — `bg_start` resolves `working_dir` and only checks it exists and is a directory (`extensions/background-terminals/index.ts:231-234`); there is no `resolveStandaloneChildProjectTrust` call anywhere in this extension | none — the process runs as an OS child of the current session with no separate trust gate |

This is the sharpest asymmetry in the whole inventory, and the one a unified
surface must **never** paper over: subagents can point at an arbitrary
directory and therefore must clear an explicit trust gate; background
terminals accept an arbitrary shell command string and rely entirely on the
existing session-level trust already granted to reach `bg_start` at all
(there is no additional directory-hop to re-authorize, since running a
command *is* the dangerous operation, not visiting a directory). A shared
read model must **not** expose a single "trusted: boolean" flag that implies
these are the same check — see §3.3 and §5's rejection note.

### 2.7 UI surfaces

| | Command | Widget | Full view |
|---|---|---|---|
| Workflow | `/workflows [runId]` | below-editor status line via `formatActivityStatus` (`extensions/shared/activity-status.ts`) | TUI dashboard, `extensions/workflows/dashboard.ts` |
| Subagent | `/subagents`, `/btw` | below-editor status line via a **separate**, self-contained `formatActivityStatus` copy (`extensions/subagents/src/format.ts:1-4`, explicitly commented "self-contained copies of the v1 shared helpers") | full-screen picker + interactive takeover, `extensions/subagents/src/ui/takeover.ts` |
| Background terminal | `/ps` | above-editor one-line widget (`extensions/background-terminals/index.ts:84-117`), a different UI slot (`setWidget`, not `setStatus`) from the other two | two-stage picker → read-only stdout/stderr detail, `extensions/background-terminals/src/ui/ps.ts` |

Note the widget-vs-status split: workflows and subagents both use
`ctx.ui.setStatus(...)` (a slot presumably meant for one line per category),
while background-terminals uses `ctx.ui.setWidget(...)` (a different
above-editor slot). `extensions/subagents/src/format.ts`'s own comment
records that it duplicated `extensions/shared/activity-status.ts` rather than
importing it — evidence that even the *existing* shared-helpers effort
(`extensions/shared/`) didn't fully take, likely because subagents needed a
different call shape (`formatActivityStatus(theme, counts)`, no `label`
parameter) once it grew independently. This is a preview of the coupling risk
§5 flags: a shared abstraction only stays shared if every caller's shape
stays compatible, and here one already drifted and forked.

### 2.8 Session-shutdown behavior

All three register a `session_shutdown` handler and none of them offer a
reattach-after-reload path — this parity is explicitly called out as
something to preserve in
`extensions/workflows/docs/durable-recovery-design.md` §2.5:

- Workflow: abort every `activeRuns` entry, settle bounded to 8s, best-effort
  final flush (`extensions/workflows/index.ts:304-326`).
- Subagent: `runtime.dispose()` runs the manager finalizer, tearing down every
  scope (real backend session close) (`extensions/subagents/index.ts:239-244`).
- Background terminal: `runtime.dispose()` runs `disposeAll` → SIGTERM →
  grace → SIGKILL tree-kill for every entry
  (`extensions/background-terminals/index.ts:196-201`).

No process, session, or in-memory child survives a session transition in any
of the three systems today. A unified surface's "cancellation capability"
flag (§3) can safely assume this invariant already holds everywhere.

---

## 3. A minimal common read model (proposed)

The goal is **observability**, not control: a single place a human (or a
future dashboard) can ask "what long-running things exist and what state are
they in," while every mutating action (cancel, spawn, kill, wait) stays on
its existing, backend-specific tool. This is deliberately narrower than a
"job queue" abstraction.

### 3.1 Candidate interface

```ts
/** Which system produced a JobSummary. Not a queue — just provenance. */
type JobKind = "workflow" | "subagent" | "background-terminal";

/**
 * Coarse, cross-kind lifecycle bucket. Deliberately fewer states than any
 * one backend's own status enum (§2.2) — this is a rollup for a combined
 * list view, not a replacement for each tool's own status field, which
 * remains the authoritative, richer value returned by e.g. subagent_check.
 */
type JobLifecycle = "running" | "settled";
// "settled" covers workflow completed/failed/aborted, subagent done/error,
// and background-terminal done/failed/killed alike — deliberately collapsed
// because a combined list view's first question is "still going or not,"
// and the per-kind detail view (existing /workflows, /subagents, /ps) is
// where the real status word belongs.

/** Read-only rollup row. Never returned in place of a kind-specific detail
 * view; only used to answer "what's out there right now." */
interface JobSummary {
  readonly id: string;               // opaque; format is kind-specific (§2.1)
  readonly kind: JobKind;
  readonly title: string;            // workflow name / subagent title / terminal title
  readonly lifecycle: JobLifecycle;
  readonly startedAt: number;
  readonly settledAt?: number;
  readonly progress?: string;        // kind-specific one-line summary, e.g.
                                      // "3/5 agents", "12 turns", "exit 0" —
                                      // pre-formatted by the owning extension,
                                      // never parsed back out by a consumer
  readonly errorText?: string;
  /** Where to find full output. A pointer, not the output itself — matches
   * §2.5's finding that retention policy differs per kind and must stay so. */
  readonly outputPointer?:
    | { readonly type: "artifact-dir"; readonly path: string }   // workflow
    | { readonly type: "session-file"; readonly path: string }  // subagent
    | { readonly type: "spill-file"; readonly path?: string };  // terminal
  /** Capability flags, not booleans-as-behavior. A consumer must branch on
   * these before offering an action, never assume every kind supports every
   * verb (§2.4's cancel-tool gap is exactly why this exists). */
  readonly capabilities: {
    readonly cancelable: boolean;   // workflows: false today (§2.4)
    readonly resumable: false;      // always false; see plan 015 — no kind
                                     // has a safe resume path today
    readonly restartable: boolean;  // true only for subagents (idle restart)
  };
}

/** Read-only aggregator. Never mutates any manager's state; never exposes
 * a generic "cancel(id)" — that would require guessing which kind's cancel
 * tool to call and, worse, imply a uniform trust/authorization story that
 * §2.6 shows does not exist. */
interface JobSurface {
  list(): ReadonlyArray<JobSummary>;
  get(id: string): JobSummary | undefined;
}
```

`resumable` is hardcoded to the literal `false` type, following the same
"make illegal states unrepresentable" precedent set by plan 015's
`RunRecoverySnapshot.resumable` — a future resume capability for any one kind
would need a new, explicit type, not a flipped flag on this one.

### 3.2 Mapping the current tools onto it

| Current source | Maps to `JobSummary` how |
|---|---|
| `WorkflowDetails` (`model.ts:80-97`) via `listRuns()`'s `RunSummary` | `id: runId`, `title: name ?? runId`, `lifecycle: status === "running" ? "running" : "settled"`, `progress: "${done}/${total} agents"`, `outputPointer: {type: "artifact-dir", path: runDir}`, `capabilities.cancelable: false` (§2.4), `capabilities.restartable: false` |
| `SubagentSnapshot` (`extensions/subagents/src/domain.ts:192-214`) | `id`, `title`, `lifecycle` from `status`, `progress: "${turns} turns"`, `outputPointer: {type: "session-file", path: meta.sessionFilePath}` (absent for a still-live in-memory-only pi session, matching today's optional field), `capabilities.cancelable: true`, `capabilities.restartable: true` (idle restart via `send()`) |
| `TerminalSnapshot` (`extensions/background-terminals/src/domain.ts:27-47`) | `id`, `title`, `lifecycle` from `status`, `progress: formatExit(snap)`, `outputPointer: {type: "spill-file", path: stdout.spillPath}`, `capabilities.cancelable: true`, `capabilities.restartable: false` |

No mapping requires inventing new behavior on any backend, inferring an
unsafe capability, or losing a field a current tool relies on — each row is a
pure, lossy *projection* of state that already exists, computed by the owning
extension (not by a new shared engine reading foreign internals). This
satisfies Step 2's verification requirement.

### 3.3 What this model deliberately does *not* unify

- **No shared trust flag.** §2.6 showed three different trust postures.
  `JobSummary` has no `trusted: boolean` field at all — trust is an
  authorization decision made once, at spawn time, by the owning tool's
  `execute()`, and re-exposing it on a read model risks exactly the "stale
  trusted bit" privilege-escalation shape plan 015 §5.2 already flagged for
  workflow recovery. If a future consumer needs to show "was this trusted,"
  it should show the *decision's provenance* (e.g. "ran in project dir" vs.
  "ran in externally-trusted dir"), not a boolean that could be mistaken for
  a live authorization check.
- **No generic cancel/resume verb.** §2.4 and §3.1 above.
- **No shared identifier namespace.** §2.1 — ids stay opaque and
  kind-scoped; a consumer must know `kind` before doing anything with `id`
  beyond display.
- **No shared retention/output storage.** §2.5 — `outputPointer` only says
  *where*, never reads or caches the content itself, and never implies a
  common TTL.

---

## 4. Migration plan (additive, staged, reversible)

### 4.1 Phase 0 (this document)

Design only. No source changes. A maintainer reviews and either approves
continuing to Phase 1, rejects the direction (§5), or defers indefinitely
(the default if no maintainer opts in — see Maintenance notes).

### 4.2 Phase 1 — extract the one already-duplicated utility

Independent of whether `JobSurface` (§3) is ever built: promote
`createDeferredResultDelivery<T>()` (currently forked verbatim between
`extensions/subagents/src/result-delivery.ts` and
`extensions/background-terminals/src/result-delivery.ts`, §2.3) into
`extensions/shared/`, generic over the settled-item type. This is the
smallest possible unification, has independent value, and is a good
low-risk test of whether `extensions/shared/` can hold generic utilities
without the `extensions/subagents/src/format.ts` fork problem (§2.7)
recurring. If this phase reveals friction (e.g. the two `onSettled`
call sites need genuinely different consumed/deferred semantics once
examined closely), that is itself evidence for §5's rejection criteria and
a reason to stop before Phase 2.

### 4.3 Phase 2 — read-only `JobSurface` behind existing UI, additively

Each extension keeps its own tool set, manager, and UI (`/workflows`,
`/subagents`, `/ps` all unchanged). A new, small aggregator module (candidate
location: `extensions/shared/job-surface.ts`) exposes `list()`/`get()` by
calling into each extension's **existing** view/listing function
(`listRuns`, `manager.view.list()`, `manager.view.list()` again for
terminals) — not by duplicating their state. This requires each extension to
export one pure mapping function (`toJobSummary(details): JobSummary`,
colocated with its own model), which is a small, additive, backward-compatible
change (new export, nothing removed or renamed).

A first consumer could be a combined `/jobs` command that lists all three
kinds in one place and links to the kind-specific detail view/command for
anything beyond read-only rollup — deliberately not a replacement for
`/workflows`, `/subagents`, or `/ps`.

### 4.4 Phase 3 — event delivery and dashboard integration (optional, deferred)

If Phase 2 ships and proves useful, a further step could push `JobSummary`
changes through the same status/widget update paths each extension already
has (`ui.setStatus`, `ui.setWidget`) into one combined indicator — but only
after reconciling the `setStatus` vs. `setWidget` split noted in §2.7, which
is itself a UI-layer question outside this spike's scope (`ExtensionUIContext`
is defined in `@earendil-works/pi-coding-agent`, not this repo's extensions).
This phase is explicitly **not required** by Phase 2's value and should not be
started until a maintainer has used Phase 2 and asked for it.

### 4.5 What is never on the migration path

- Removing `workflow`, `subagent_*`, or `bg_*` tools.
- Renaming any tool, command, or on-disk artifact path.
- Merging `RunController`, `SubagentManager`, and `TerminalManager` into one
  class or one Effect service.
- Adding a generic cancel/resume tool that dispatches by `kind`.
- Any change to trust enforcement, retention windows, or shutdown-kill
  behavior in the name of consistency (§2.6, §2.5, §2.8 are load-bearing).

---

## 5. Rejection criteria — reasons not to unify further than Phase 2

A maintainer should feel free to stop at Phase 0 (this document, filed for
reference) or Phase 1 (the one genuinely duplicated utility) and explicitly
decline Phase 2+ if any of the following hold, now or after trying Phase 2:

1. **The aggregator becomes a second source of truth.** If `JobSurface.list()`
   ever needs to cache, transform, or independently track state instead of
   projecting live from each manager's existing view, it has stopped being a
   read model and started being a parallel system that can drift from the
   real one — worse than the status quo of three separate, honest views.
2. **A consumer wants a generic action verb.** The moment someone asks for
   `JobSurface.cancel(id)` or `.resume(id)`, the design has re-introduced the
   exact cross-backend dispatch problem §3.3 rejected, and the trust/lease
   reasoning from plan 015 §5 and this doc's §2.6 would need to be redone
   per-verb, per-kind — a much bigger design than this spike, and reason to
   treat it as a new plan rather than an extension of this one.
3. **`extensions/shared/` keeps forking instead of sharing.** §2.7 already
   shows one prior shared-helper fork (`subagents/src/format.ts`). If a
   second consumer of a new shared module immediately forks it too (because
   its shape doesn't fit), that's evidence the abstraction boundary is wrong,
   not that the fork should be reconciled by force.
4. **Broad source changes become a prerequisite.** Per this plan's STOP
   conditions, if making `JobSummary` accurate for any one kind requires
   restructuring that kind's manager (as opposed to adding one small mapping
   function), the unification is not "additive" anymore and should be
   re-scoped as its own implementation plan with its own review, not folded
   into this direction silently.
5. **It doesn't reduce confusion in practice.** The original motivation
   (§1) is a UX hypothesis, not a proven need. If a maintainer ships Phase 2
   and finds nobody uses `/jobs` over the existing three commands, that's a
   legitimate, low-cost way to falsify the premise — better to have spent one
   small additive phase finding that out than a larger up-front rewrite.

None of these are hard blockers *today* — this section exists so a future
implementer (or reviewer) has explicit language to invoke if any of them
start to bite mid-implementation, per the plan's STOP-condition discipline.

---

## 6. Open questions for maintainers

1. Is a combined `/jobs` view (Phase 2) worth building at all, or does
   showing three separate widgets/commands already serve users well enough
   that this entire direction should stop at Phase 1 (§4.2)?
2. Should `JobLifecycle` really collapse to two buckets (`running`/`settled`),
   or is a three-bucket split (`running`/`done`/`failed`) worth the extra
   cross-kind mapping complexity for a combined list view?
3. If Phase 2 ships, should the `setStatus`/`setWidget` split (§2.7) be
   reconciled first, or is showing the combined indicator in whichever slot
   is more visible (probably `setWidget`, since it's already above the
   editor) an acceptable interim answer?
4. Does `extensions/subagents/src/format.ts`'s existing fork of
   `extensions/shared/activity-status.ts` get reconciled as part of Phase 1,
   or is it explicitly left alone as a "two shapes that happened to look
   similar once" case per §5 point 3?

---

## Done criteria mapping

- [x] Current lifecycle differences are documented — §2.
- [x] Common model is minimal and capability-aware — §3.
- [x] Migration does not require removing existing tools in one step — §4.
- [x] Security and cleanup boundaries remain explicit — §2.5, §2.6, §2.8, §3.3.

## Maintenance notes

- Treat this as an optional architectural direction, not a justification for
  speculative refactoring (per the plan's own maintenance note). Revisit
  after workflow recovery (plan 015) and trust plans (plan 004) actually
  ship, since both inform what a `JobSummary.capabilities` flag can honestly
  claim.
- If a future change adds fields to any of the three domain models cited
  here (`WorkflowDetails`, `SubagentSnapshot`, `TerminalSnapshot`), and a
  `JobSurface` mapping (§4.3) exists by then, update that mapping in the same
  change — the same discipline this doc's sibling
  (`extensions/workflows/docs/durable-recovery-design.md`) asks for its own
  schema notes.
- Do not treat this document's existence as approval to start Phase 2 or
  later. Per §4.1, only Phase 0 (this document) is complete by writing it;
  every later phase needs its own explicit maintainer go-ahead and, for
  Phase 2+, its own implementation plan.
