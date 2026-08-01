# Durable workflow recovery — design spike

> **Status:** design/spike (plan `plans/015-design-durable-workflow-recovery.md`). No
> execution, resume, or retry behavior is implemented by this document. Every schema
> below is **proposed** and unimplemented unless a fact is explicitly cited against
> current source (file:line). Do not treat artifact existence as permission to execute
> — see [Maintenance notes](#maintenance-notes).

## 1. Why this matters, and why it is hard

`extensions/workflows` persists enough state to *inspect* a run after the fact
(`extensions/workflows/artifacts.ts`, `extensions/workflows/model.ts`), but the tool
description is explicit that there is no resume:

> "There is no resume: a failed run is simply re-run." — `extensions/workflows/prompt.ts:29`

Interruptions today (crash, `/reload`, `/new`, `/fork`, quit, host restart) force a full
rerun of the orchestration script. Because `agent()` calls have real side effects (file
edits, shell commands, network calls made by child tool use), a naive "just resume
where the JSON left off" design would silently duplicate work — this is the central
risk this spike has to design around before any implementation plan is written.

## 2. Ground truth: what the current system actually persists and guarantees

This section is the authoritative baseline every later section builds on. It is
extracted from the current source at the base commit (`8f40cc1`, no drift since — see
the plan's drift check).

### 2.1 What's on disk per run

`~/.pi/agent/workflows/<runId>/` (`runId` = `wf_<12-hex>`, `index.ts:403`), written via
`writeFileAtomic` (owner-only `0600`/`0700` modes, atomic rename —
`extensions/workflows/serialization.ts:5-7,172-196`):

| File | Written by | Contents | Update cadence |
|---|---|---|---|
| `script.js` | `index.ts:419` | the exact model-authored script | once, at launch |
| `args.json` | `index.ts:420-421` | raw `args` tool parameter | once, at launch |
| `workflow.json` | `artifacts.ts:persistWorkflowJson` | compact `WorkflowDetails` (no inline transcripts; `result` replaced with a pointer once `result.json` exists) | coalesced every `WORKFLOW_CHECKPOINT_INTERVAL_MS` (500ms, `artifacts.ts:11`), plus an **immediate** flush when each agent starts (`index.ts:505`), plus a synchronous final flush (`index.ts:667-675`) |
| `transcripts.json` | `artifacts.ts:persistWorkflowJson` | per-agent transcript, bounded to 32KB/agent with an 8KB/entry cap (`boundedArtifactTranscript`, `artifacts.ts:9-10,31-84`) | same cadence as `workflow.json` (single combined `persist()` call) |
| `result.json` | `artifacts.ts:persistWorkflowJson` | the script's `return` value, capped at 1MB | written once the field is set (checkpoint or final flush) |

`WorkflowDetails` (`model.ts:80-97`) is the authoritative persisted shape:
`runId`, `sessionId`, `name`, `description`, `background`, `status`
(`"running"|"completed"|"failed"|"aborted"`), `startedAt`, `finishedAt?`, `phases`,
`currentPhase?`, `agents: AgentRecord[]`, `result?`, `error?`. Each `AgentRecord`
(`model.ts:63-78`) carries `index`, `label`, `phase?`, `state`
(`"running"|"done"|"error"`), `model?`, `startedAt`, `finishedAt?`, `error?`, `preview`,
`usage`, `transcript`.

**What is *not* persisted today, and matters for recovery:** there is no `pid`, no
hostname, no heartbeat timestamp, and no lease/expiry field anywhere in
`WorkflowDetails`. The only ownership signal on disk is `sessionId` — the pi *session*
that launched the run, not a process or a point in time.

### 2.2 What "active" means today, and its blast radius

Liveness is tracked **only** in an in-memory `Map` inside one extension instance
(`activeRuns` in `index.ts:248-256`), scoped to the current process's lifetime. There is
no cross-process registry, lock file, or database. Three consequences:

1. A crash (SIGKILL, OOM, power loss) leaves `workflow.json` with `status: "running"`
   on disk forever — nothing ever transitions it, because the only code that would
   transition it (`runScript`'s `finally`, `index.ts:665-675`) never runs.
2. `session_shutdown` (fired on `/new`, `/resume`, `/fork`, `/reload`, and quit) aborts
   and settles every run this *process* still has in `activeRuns`, bounded to 8s
   (`RUN_SHUTDOWN_TIMEOUT_MS`, `controller.ts:3`, wired at `index.ts:304-326`). This is
   a clean, deterministic shutdown path — the gap is only the crash case above, where
   `session_shutdown` never fires at all.
3. `cleanupExpiredWorkflowRuns` (`retention.ts`) runs on every `session_start`
   (`index.ts:293-302`) and deletes run directories older than 14 days
   (`WORKFLOW_RETENTION_MS`, `retention.ts:10`) **unless** the run id is in the current
   process's `activeRuns` — which, per point 1, a crashed run's id never is once the
   process restarts. A crashed run is not treated specially; it just ages out on the
   same clock as a normal completed run.

`index.ts`'s `listRuns()` (`index.ts:175-228`) already does a narrow, **read-only**
form of orphan inference for display purposes: any `workflow.json` still marked
`"running"` that isn't in the current process's `activeRuns` is *shown* as `"aborted"`
in `/workflows` — but only when `parsed.sessionId === sessionId` (the viewing session
resumed the same session file) or the run id is explicitly referenced elsewhere in the
transcript (`sessionWorkflowRunIds`, `dashboard.ts:227` and `index.ts:207`). This
inference is cosmetic: it does not rewrite `workflow.json`, does not affect retention,
and does not run in a different session. It is the closest thing to "stale-run
detection" that exists today, and it is a useful precedent for §4's read-only lease
model — it proves the codebase already treats "no longer in this process's memory" as
the practical definition of "not running," it just doesn't persist that inference or
generalize it across sessions.

### 2.3 What "resume" would actually have to reattach to — and why it can't today

Each `agent()` call runs through `runner.ts`'s `runAgent()`, which creates a **fully
in-memory** child session: `sessionManager: SessionManager.inMemory(options.cwd)`
(`runner.ts:737`) via `createAgentSession` (`runner.ts:21,719`). This is a structural
difference from the sibling `subagents` extension, whose pi backend uses
`SessionManager.create(cwd)` to produce real, on-disk, `/resume`-able session files
(`extensions/subagents/docs/design-plan.md:65-67`). A workflow's child agent runs have
**no session file to reattach to, ever** — even mid-run, before a crash. The only
record of a child's conversation is the bounded `transcripts.json` excerpt (32KB/agent)
written for human inspection, which is deliberately truncated (oldest-middle entries
dropped, `artifacts.ts:31-84`) and is not a replayable event log.

This is the single fact that most constrains this design: **there is no provider-level
session to resume**, independent of any lease/ownership work. Recovery of an
in-flight agent call cannot mean "reconnect and keep streaming" — at best it can mean
"observe that it was interrupted and decide whether to re-run it," which is a
retry/idempotency problem (§4), not a resume problem.

### 2.4 Bounded deadlines already in place (do not weaken)

- Whole-script wall-clock deadline: `DEFAULT_WORKFLOW_DEADLINE_MS = 30 * 60 * 1000`
  (30 minutes, `sandbox.ts:20`), covering the sandboxed VM plus any async continuation.
- Per-run agent-call budget: `MAX_AGENT_CALLS = 32` (`controller.ts:2`).
- Per-agent first-response timeout: `FIRST_RESPONSE_TIMEOUT_MS = 45_000`
  (`runner.ts:48`); after the first assistant event, an individual `agent()` call has no
  further deadline of its own, but it is still inside the 30-minute run deadline above.
  (`prompt.ts:28`'s model-facing text — "has no overall deadline" — describes this
  per-call absence of an *additional* timeout, not the run-level 30-minute bound; both
  facts are true simultaneously and any recovery design must keep both.)
- Run-settle bound on abort: `RUN_SHUTDOWN_TIMEOUT_MS = 8_000` (`controller.ts:3`).
- Global fan-out concurrency cap: 4 (`DEFAULT_CONCURRENCY`, `controller.ts:1`).

Any recovery design (including the prototype in §6) must compose with these, not
relax them — see the STOP condition on weakening kill-on-shutdown safety.

### 2.5 The comparable system: background-terminals

`extensions/background-terminals` spawns real OS child processes and is unambiguous
about their lifecycle: `session_shutdown` disposes the whole manager, which tree-kills
every process (SIGTERM → grace → SIGKILL), and there is **no reattach-after-reload
path** (`extensions/background-terminals/index.ts:181-201`,
`extensions/background-terminals/docs/implementation-guide.md:808-810`). Workflows'
`session_shutdown` handler (`index.ts:304-326`) is the same shape (abort + bounded
settle, no reattach), applied to in-process agent calls instead of child processes. Any
future workflow recovery design should preserve this parity rather than making
workflows resumable while background terminals stay kill-only — a mixed model would be
confusing and would reopen exactly the process-ownership ambiguity §4 tries to close.

---

## 3. Terminology

- **Run** — one `workflow` tool invocation, identified by `runId`. Currently modeled by
  `WorkflowDetails` (`model.ts:80-97`).
- **Owner (proposed)** — the specific process instance that is allowed to keep writing
  checkpoints for a run and is responsible for settling it. Today this is implicit
  (whichever process still has the run in `activeRuns`); §4 proposes making it explicit
  and persisted.
- **Lease (proposed)** — a time-bounded claim of ownership, renewed by a heartbeat.
  Does not exist today.
- **Checkpoint** — a persisted snapshot of `WorkflowDetails` written by
  `createWorkflowPersistence` (`artifacts.ts:125-179`). Exists today; §4 proposes adding
  owner/lease fields to it, not changing its cadence or format otherwise.
- **Resumable** — recovery can safely continue orchestration (phase sequencing,
  already-completed agent results) without repeating side effects.
- **Non-resumable** — recovery can only observe/report; safe continuation is not
  possible without re-running the underlying operation. Per §2.3, every in-flight
  `agent()` call is non-resumable today.

---

## 4. Recovery state machine and lease model (proposed design)

### 4.1 Run states — tagged union, not booleans

The current `WorkflowStatus` (`model.ts:42`) is a 4-way tagged union
(`"running"|"completed"|"failed"|"aborted"`), which already follows the "state
machines, not boolean blindness" convention. A durable-recovery design should extend
this shape rather than bolt booleans onto it. Proposed states (additions marked `NEW`;
everything else is the current type unchanged):

```ts
type WorkflowStatus =
  | "running"     // existing: an owner holds the lease and is actively advancing the run
  | "completed"   // existing: terminal, script returned
  | "failed"      // existing: terminal, script threw or settle deadline exceeded
  | "aborted"     // existing: terminal, controller.abort() was called
  | "orphaned"    // NEW, derived only, never itself checkpointed: workflow.json says
                   //     "running" but the lease has expired and no owner is renewing it
  | "recovering"; // NEW: a process has claimed an orphaned run for the bounded,
                   //     read-only recovery prototype in §6 (metadata-only; this state
                   //     never authorizes re-entering the sandbox)
```

`"orphaned"` is deliberately **derived, not written to `workflow.json`** by the process
that observes it — only the owner that holds the lease may write `status`. This mirrors
`listRuns()`'s existing read-only inference (§2.2) instead of inventing a new mutation
path that could race with a still-alive owner whose heartbeat is merely late.

### 4.2 Per-agent checkpoint states

`AgentState` (`model.ts:41`) is `"running"|"done"|"error"`. Proposed addition:

```ts
type AgentState =
  | "running" | "done" | "error" // existing
  | "unknown";                    // NEW, derived only: the owning run's lease expired
                                    //   while this agent record was "running" — its true
                                    //   outcome (did the side effect happen or not?) is
                                    //   unknowable from the checkpoint alone (§2.3).
```

`index.ts:658-664` already has a version of this problem for the *same-process* case
(a run settles with an agent still `"running"` because it didn't finish before the
shutdown deadline) and resolves it by marking that agent `"error"` with
`"Agent did not settle before run cleanup"`. `"unknown"` is a distinct, more honest
label for the *cross-process* case: `"error"` asserts the side effect did not
succeed, which the owning process can assert because it controls the abort; a
different, later process cannot make that claim about a checkpoint it did not write.

### 4.3 Ownership and lease fields (proposed additions to `WorkflowDetails`)

```ts
/** Process-identity claim over a run's checkpoint, renewed by heartbeat. Proposed; not implemented. */
interface RunLease {
  readonly sessionId: string;   // already exists as WorkflowDetails.sessionId
  readonly hostId: string;      // NEW: stable per-install identifier, not raw hostname (§5.3)
  readonly pid: number;         // NEW: OS process id, for local diagnostics only — never trusted alone (PIDs recycle)
  readonly ownerToken: string;  // NEW: random value minted at lease acquisition, distinguishes
                                 //   two processes that briefly share a pid after a fast restart
  readonly acquiredAt: number;  // NEW
  readonly heartbeatAt: number; // NEW: last renewal; recomputed every checkpoint tick
  readonly leaseMs: number;     // NEW: expiry window (proposed default: 3x the checkpoint
                                 //   interval headroom below, not the checkpoint interval itself)
}
```

**Lease renewal cadence:** piggyback on the existing checkpoint timer
(`WORKFLOW_CHECKPOINT_INTERVAL_MS = 500ms`, `artifacts.ts:11`) rather than adding a
second timer — every `persist()` call rewrites `heartbeatAt`. **Proposed
`leaseMs`: 5000ms** (10x the checkpoint interval), long enough to absorb normal
event-loop jitter and the coalescing delay, short enough that an operator or a
recovery scan doesn't wait long after a real crash. This is a starting number for
maintainer review, not a settled constant.

**What is authoritative:** the on-disk `workflow.json` lease fields, written by the
current owner, are authoritative for "who may keep advancing this run." The in-memory
`activeRuns` map remains authoritative for "what this process is doing right now"
(unchanged) but stops being the only source of truth for cross-process/cross-restart
questions. A run with no on-disk lease fields (every run created before this design
ships) is treated as **unleased-legacy**: recoverable only via the same read-only
inference `listRuns()` already does today, never lease-claimable.

### 4.4 State transition table

| From | Event | To | Who may write it | Notes |
|---|---|---|---|---|
| *(none)* | `workflow` tool invoked | `running` | launching process (owner) | unchanged; owner also mints the initial lease |
| `running` | script returns | `completed` | owner | unchanged (`index.ts:633`) |
| `running` | script throws / controller aborts | `failed` \| `aborted` | owner | unchanged (`index.ts:643-656`) |
| `running` | owner's `session_shutdown` fires | `aborted` (bounded 8s) or `failed` (settle deadline exceeded) | owner | unchanged (`index.ts:304-326`, `controller.ts:161-183`) |
| `running` (on disk) | a *different* process observes `heartbeatAt` older than `leaseMs` | `orphaned` (derived, in-memory only, for display/decision) | any reader | never mutates `workflow.json`; matches today's `listRuns()` inference generalized across processes |
| `orphaned` | the original owner's process is actually still alive and checkpoints again | back to `running` (the "orphaned" label simply stops applying) | owner | race is resolved by the lease, not by a lock — see §4.5 |
| `orphaned` | a recovery process claims it under the §6 prototype | `recovering` (in-memory only in the claiming process; still bounded, read-only) | claimant, using `ownerToken` compare-and-swap semantics (§4.5) | never re-enters the sandbox; never resumes agent calls |
| `recovering` | prototype finishes reading metadata | *(prototype has no write-back state — see §6)* | — | out of scope beyond metadata read |
| any terminal state | retention sweep, age > 14 days, not in `activeRuns` | *(directory deleted)* | any process on `session_start` | unchanged (`retention.ts`) — §4.6 covers whether `orphaned` should get its own, shorter window |

### 4.5 Duplicate-resume and stale-owner races

The dangerous case is two processes both believing they may act on the same `runId` —
either two owners (a crashed owner whose process actually un-froze, e.g. resumed from a
suspended laptop) or two recovery attempts. Proposed guard, modeled after
`controller.ts`'s existing pattern of "no locks, just a single mutable claim checked at
the point of action" (see `sealed` in `RunController.schedule`, `controller.ts:114`):

1. **Compare-and-swap the lease, not a separate lock file.** To acquire or renew,
   a process reads the current `RunLease` from `workflow.json`, and only writes a new
   lease if either (a) no lease exists (fresh run) or (b) the existing lease's
   `heartbeatAt` is already past `leaseMs` **and** the write uses
   `writeFileAtomic`'s existing atomic-rename semantics so a lost race just gets
   silently overwritten by whichever writer's rename lands last — acceptable because
   the loser immediately re-reads and discovers it lost.
2. **After writing, re-read and verify `ownerToken` matches.** If it doesn't, this
   process lost the race; it must not act as owner (or, for the recovery prototype,
   must not claim `recovering`). This closes the classic "TOCTOU" gap of a plain
   read-then-write without a real distributed lock — cheap enough for a local
   single-host filesystem, not a substitute for a real lock if this ever needs to work
   over a shared/networked artifact store (explicitly out of scope, see §6.4).
3. **A genuinely-alive "orphaned" owner wins ties.** Because renewal only requires
   matching the *current* `ownerToken` before writing further checkpoints (not
   contending for anything else), an owner that was merely slow (not crashed) simply
   fails its next renewal if a recovery process has already claimed the lease, and
   must treat that as equivalent to an external abort — surface it to the user as
   "this run was claimed by another process" rather than silently continuing to mutate
   a `workflow.json` it no longer owns.
4. **This scheme does not, by itself, make anything resumable.** It only answers "who
   is allowed to write the next checkpoint." Re-running side effects safely is §5's
   problem, not this section's.

### 4.6 Stale-run handling and cancellation

- A run inferred `orphaned` should be **user-cancelable** without ambiguity: cancellation
  only ever needs to flip persisted `status` to `"aborted"` and does not require the
  original process to be alive (there is nothing left to abort at the process level —
  it's already gone). This is a pure metadata write, safe under the same CAS rule as
  §4.5, and is a reasonable candidate for the §6 prototype's write surface *if*
  maintainers want write access at all (see the prototype's explicit non-goals — the
  spike's default recommendation is to ship read-only first and revisit this in a
  follow-up plan).
- Retention (§2.2) should **not** treat `orphaned` differently from `completed` for
  the purposes of the 14-day sweep by default — an orphaned run is not more sensitive
  than a completed one, and inventing a shorter window adds a second retention clock to
  reason about for uncertain benefit. This is called out as an explicit open question
  in §7 in case maintainers disagree (e.g., wanting orphaned runs cleaned up sooner
  because they're more likely to be abandoned experiments).

---

## 5. Side-effect and security policy

### 5.1 Idempotency requirements

Per §2.3, no in-flight `agent()` call can be safely resumed — only re-run or abandoned.
Any future "recover and continue orchestration" design (beyond this spike's read-only
prototype) would have to satisfy **all** of the following before it could re-run a
single already-attempted agent step automatically:

1. **Idempotency key per agent call.** The script has no natural key today (`label` is
   free-form, model-authored, and not guaranteed unique or stable across script
   re-evaluation, since `agentFn` derives `label` from call order —
   `const label = ... ?? \`agent-${index}\`` at `index.ts:484-487`). A durable design
   would need the orchestration DSL itself to expose a caller-supplied idempotency key
   (e.g. a required `id` string per `agent()` call, hashed together with `runId`), not
   an inferred one — inferring from call order breaks the moment a recovered script
   takes a different branch (§5.2).
2. **Side-effect classification the tool author cannot get wrong.** `agent()` invokes a
   full child session with normal tool access (`runner.ts` builds real
   `loader`/`settingsManager` resources, `index.ts:432-437`) — file writes, shell
   commands, and network calls are all in scope and indistinguishable from the
   orchestrator's point of view (`ScriptAgentResult` has no side-effect metadata,
   `index.ts:98-103`). Without a way to know "did this agent call only read things," a
   recovery engine cannot decide re-running is safe by inspecting the record; that
   decision would have to come from the *tools the child used*, which is a much bigger
   surface (see `dependencies/002` and similar prior plans on tool trust) than this
   spike can settle.
3. **Deterministic replay of the orchestration script is not guaranteed.** The
   sandboxed script (`sandbox.ts`) may branch on `agent()` results, wall-clock time, or
   any other runtime value; re-executing it from the top with cached results substituted
   in for completed agent calls only works if the script is written to be safely
   re-entrant, which nothing in the DSL or `WORKFLOW_TOOL_DESCRIPTION` currently
   requires or documents (`prompt.ts:19-39`).

**Conclusion for this spike:** automatic re-run of partially-completed orchestration
is not safe to build without DSL changes (idempotency keys, explicit re-entrancy
contract) that are themselves a separate, larger design decision. This is one of the
scenarios in the plan's STOP conditions ("safe resume requires ... idempotency
guarantees unavailable in the current code") — recorded here, not worked around.

### 5.2 Credential reauthorization and trust checks

- Each `agent()` call resolves resources fresh, per call, from the **parent's live
  trust decision** (`projectTrusted = ctx.isProjectTrusted()`, captured once at
  `index.ts:431` and reused for the whole run via `getResources`). A recovery process
  in a different session (or the same session after `/reload`) has its own,
  independently-evaluated `ctx.isProjectTrusted()` — it must **never** reuse a trust
  flag baked into a checkpoint on disk, because trust can change between runs (a
  project can be untrusted after the checkpoint was written) and a stale "trusted"
  bit is a privilege-escalation bug waiting to happen. Any recovery/resume design must
  re-derive trust at claim time, not persist and replay it.
- `cwd` is likewise re-derived from the *claiming* session's live `ctx.cwd`, never
  taken verbatim from a checkpoint — see §5.3's unauthorized-cwd threat.
- Model/provider credentials are resolved through the running process's
  `ctx.modelRegistry` (`index.ts:529-563`); there is nothing to "reauthorize" for a
  read-only recovery prototype since it wouldn't call a model at all (§6).

### 5.3 Threat model

| Threat | Scenario | Mitigation (proposed / existing) |
|---|---|---|
| **Duplicate execution** | Two processes both believe they own `runId` after a crash-and-restart race (laptop sleep/wake, two pi instances pointed at the same `~/.pi/agent` dir) and both re-run `agent()` calls with real side effects. | §4.5's lease CAS closes the "who may write the next checkpoint" race. Combined with §5.1's conclusion that automatic re-run isn't safe yet, the practical mitigation for *this spike's scope* is: don't build auto re-run at all; the prototype (§6) is read-only, so it structurally cannot duplicate a side effect. |
| **Stale owner** | A process is suspended (not crashed) — e.g. a laptop sleeps mid-run — and wakes up believing it still owns the run after a recovery process has already claimed it. | §4.5 point 3: the stale owner's next checkpoint write fails the `ownerToken` re-read check; it must treat that as an external abort and stop, never "fight" for the lease. This needs an explicit code path (checked at every `persistence.checkpoint()` call site) that doesn't exist today — noted as a build item for any real resume implementation, not solved by this doc alone. |
| **Unauthorized cwd** | A recovered/resumed run re-derives `cwd` from a stale checkpoint value instead of the claiming session's live, trust-checked `ctx.cwd`, letting a script continue operating against a directory the current session was never granted access to (e.g. the checkpoint's `cwd` points at a path the recovering user/session shouldn't touch). | §5.2: `cwd` and trust must always come from the claiming session's live context, never from the checkpoint. The prototype (§6) doesn't execute anything, so it has no `cwd` to authorize in the first place — this only becomes a live risk once a future plan adds actual resume, and that plan must re-verify trust/cwd exactly like a fresh `workflow` tool call does today (`index.ts:431`). |
| **Leaked artifacts** | A lease/heartbeat field, or a future recovery UI, exposes another session's run metadata (script, args, transcript excerpts, results) to a process/user that shouldn't see it — e.g. a multi-user host where `~/.pi/agent` is shared, or a recovery scan that lists runs across sessions without the existing `sessionId`/`referencedRunIds` filter (`index.ts:207`, `dashboard.ts:310`). | Files are already owner-only at the OS level (`0600`/`0700`, `serialization.ts:5-7`) — that boundary is per-OS-user, not per-session, and this design does not change it. Any recovery listing must reuse the existing `sessionId`/`referencedRunIds` visibility filter (§2.2) rather than inventing a broader "list all runs on disk" surface; the §6 prototype explicitly keeps this filter (see its non-goals). New lease fields (`hostId`, `pid`, `ownerToken`) are process/host diagnostics, not secrets, but should still not be surfaced to the model/tool layer beyond what `/workflows` already exposes today, to avoid growing the model-visible surface incidentally. |
| **Background-terminal drift** | A future change makes workflows resumable while leaving background-terminals kill-only (or vice versa), producing an inconsistent mental model ("why does one interrupted tool survive a reload and the other doesn't?") and, worse, an implementer "fixing" background-terminals to match by adding process reattachment, which is a much larger and riskier change than anything in this doc. | Not a data-security threat, but a design-integrity one: §2.5 records the current parity explicitly so a future PR reviewer has something concrete to check against. This spike's own recommendation (§6) preserves parity by staying read-only. |

---

## 6. Bounded prototype: read-only recovery of workflow metadata

This is the smallest safe step the plan's Step 3 asks for. It changes **zero**
execution behavior and requires **zero** production source changes to define (this
spike is documentation-only, per the executor instructions) — it is a specification a
maintainer can approve or reject, and a future implementation plan would build exactly
this and nothing more.

### 6.1 What it does

Given a `runId` (or "all runs visible to this session," reusing the existing
`listRuns`/`sessionWorkflowRunIds` visibility rule), report:

- current persisted `status`, and the **derived** `orphaned` label per §4.1 when
  `status === "running"` and (once leases exist) the lease has expired, or — for
  **legacy runs with no lease fields** — using exactly today's `listRuns()` heuristic
  (not in `activeRuns` ⇒ shown as `"aborted"`) unchanged.
- phase/agent progress as already computed by `countStates`/`phaseGroups`
  (`model.ts:182-223`) — this is a read path that already exists and ships today via
  `/workflows`; the prototype's only addition is exposing the derived `orphaned`/
  `unknown` labels described in §4.1–4.2 alongside it.
- the lease block (`hostId`, `pid` (diagnostic only), `acquiredAt`, `heartbeatAt`, age)
  when present, so a human can see *why* something is being called orphaned.

### 6.2 API surface (proposed; documentation only)

```ts
/** Read-only recovery metadata for one run. Never mutates workflow.json. Proposed; unimplemented. */
interface RunRecoverySnapshot {
  readonly runId: string;
  readonly status: WorkflowStatus;         // includes the derived "orphaned" value (§4.1)
  readonly lease?: RunLease;                // absent for legacy (pre-lease) runs
  readonly agents: ReadonlyArray<{
    readonly index: number;
    readonly label: string;
    readonly state: AgentState;             // includes the derived "unknown" value (§4.2)
  }>;
  readonly resumable: false;                // always false — see non-goals
}

/** Static-only read path; no side effects, no lease acquisition. Proposed; unimplemented. */
class WorkflowRecoveryInspector {
  /** Inspect one run's on-disk checkpoint without claiming its lease. */
  inspect(runId: string): RunRecoverySnapshot | undefined;
  /** List every run visible to the given session, reusing the existing visibility rule. */
  listOrphaned(sessionId: string, referencedRunIds: ReadonlySet<string>): ReadonlyArray<RunRecoverySnapshot>;
}
```

`resumable` is hardcoded `false` and typed as the literal, not `boolean`, precisely to
make "this prototype cannot be mistaken for an execution API" a type-level fact, per
the "make illegal states unrepresentable" principle — a future resume implementation
would need a new type, not a flipped flag on this one.

### 6.3 Compatibility constraints

- **Must not require lease fields to exist.** Every run created before this ships has
  no `lease` block; the inspector must treat that as "unleased-legacy," not an error,
  and fall back to the existing `listRuns()` heuristic.
- **Must not change `workflow.json`'s schema in a way older `pi` binaries can't read.**
  New fields (`lease`) are additive and optional; nothing existing is renamed or
  removed. `safeStringify`'s existing byte caps (`serialization.ts:130`) are unaffected
  since the lease block is small and fixed-shape.
- **Must reuse, not duplicate, the existing visibility filter.** `listOrphaned` takes
  the same `sessionId`/`referencedRunIds` inputs `listRuns()` already takes
  (`index.ts:175-179`) rather than defining a new authorization rule.
- **Must not acquire a lease.** Inspection is read-only; it must not write
  `workflow.json` at all, including to record "someone looked." This keeps the
  prototype safe to run speculatively (e.g. on every `session_start`, for a future
  "you have an interrupted run" notice) without any CAS/race reasoning from §4.5
  applying to it.

### 6.4 Telemetry

None proposed beyond what already exists. `/workflows` is a local, single-user
diagnostic surface with no telemetry pipeline today; this prototype should stay that
way. If a later implementation plan wants aggregate signal (e.g. "how often do runs
end up orphaned"), that is a new, separate decision requiring its own privacy review —
not something to bundle into a read-only inspector by default.

### 6.5 Explicit non-goals

- Does **not** claim a lease, write `status`, or mutate `workflow.json` in any way.
- Does **not** re-enter `runWorkflowSandbox` or call `agent()`/`runAgent()`.
- Does **not** attempt cross-host/networked artifact stores — everything assumes the
  single local `~/.pi/agent` filesystem, matching every other assumption in this
  extension today.
- Does **not** offer a cancel/abort action (see §4.6 — deliberately deferred to a
  follow-up plan even though it would be a small, safe metadata write, so this
  prototype's review surface stays purely read-only).
- Does **not** change `WORKFLOW_TOOL_DESCRIPTION` or any model-facing text; recovery
  metadata is a human/`/workflows`-surface concern only, not something the model should
  be told it can act on (a model given a "resumable-looking" surface would be exactly
  the "artifact existence as permission to execute" failure this doc's maintenance note
  warns against).

---

## 7. Open questions for maintainers

1. **Lease window (`leaseMs`).** §4.3 proposes 5000ms (10x the 500ms checkpoint
   interval) as a starting point. Is that too aggressive for slow/loaded hosts, or too
   lax for a snappy "you have an orphaned run" notice?
2. **Should `orphaned` get a shorter retention window than `completed`/`failed`?** §4.6
   recommends no (reuse the 14-day sweep) but flags this as a judgment call.
3. **Does the read-only prototype (§6) belong behind a flag/command, or should it run
   passively on every `session_start` and surface a notice?** This spike does not
   recommend either; it only specifies the read path itself.
4. **Idempotency-key design for the DSL (§5.1.1).** If a future plan wants to make even
   a subset of agent calls safely re-runnable (e.g. only `agent()` calls the script
   marks read-only via some new option), what should that option's contract be, and who
   verifies a script's claim of "read-only" is honest? This spike does not propose an
   answer — it is flagged as the next hard design problem, likely warranting its own
   plan.
5. **Should `hostId` be derived from something stable across reinstalls (e.g. a
   generated UUID cached in `~/.pi`) or accept that a reinstalled host looks like a new
   host?** Not resolved here; either choice is compatible with §4.3's shape.

---

## 8. Test plan (scenario tables, design-level)

No executable tests are added by this spike — it is a documentation-only change and
the plan's existing verification (`pnpm test`, `pnpm run check`, `pnpm run format:check`)
must stay green with no production files touched. The tables below are the scenario
coverage a future implementation plan (lease persistence, then the §6 prototype) would
need, so a reviewer can check completeness before code exists.

### 8.1 Lease/state-machine scenarios (future `artifacts`/`controller` tests)

| Scenario | Setup | Expected |
|---|---|---|
| Crash mid-run | Kill the process after a checkpoint but before `finally` runs | On-disk `status` stays `"running"`; lease `heartbeatAt` stops advancing |
| Reload/`/reload` in the same session | Owner process's `session_shutdown` fires normally | `status` becomes `"aborted"` within `RUN_SHUTDOWN_TIMEOUT_MS`; lease is not left dangling (owner writes final checkpoint before exit) |
| Timeout (30-minute deadline) | `sandbox.ts` deadline fires | `status` becomes `"failed"` with the existing deadline error text (`sandbox.ts:182`) — lease fields, once added, must reflect the same terminal write, not linger as `"running"` |
| Duplicate resume attempt | Two processes race to claim an expired lease | Exactly one wins the CAS (§4.5); the loser observes `ownerToken` mismatch on re-read and does not act |
| Legacy run, no lease fields | Run created before this design ships | Inspector/`listRuns()` fall back to today's heuristic; no crash, no lease assumed |
| Orphan inference across sessions | Session B (different `sessionId`, not referencing the run) inspects a run left `"running"` by session A's crash | Read-only `orphaned` label is computed correctly by `WorkflowRecoveryInspector`, but **hidden** from `/workflows` unless B is in `referencedRunIds` — visibility rule from §2.2 still applies to the *inspector*, not just the dashboard |

### 8.2 Threat-model regression scenarios (future security tests)

| Scenario | Expected |
|---|---|
| Recovery inspector never writes `workflow.json` | Assert `fs.writeFileSync`/`writeFileAtomic` is never called by `inspect`/`listOrphaned` (a real seam test, not a spy — e.g. assert the file's mtime is unchanged after inspection) |
| Stale owner after wake-from-sleep loses a contested lease | Owner's next `persistence.checkpoint()` call after losing the CAS surfaces an explicit "claimed by another process" state rather than silently continuing |
| Trust/cwd never read from a checkpoint | A future resume path's cwd/trust must trace back to the claiming session's live `ctx`, not the persisted `WorkflowDetails` — regression-testable once resume exists by asserting the resumed run's resource loader was constructed from the *current* `ctx.cwd`/`ctx.isProjectTrusted()` call, not a deserialized value |
| Artifact visibility filter reused, not reimplemented | `listOrphaned` and `listRuns` produce identical visible-run-id sets for the same `(sessionId, referencedRunIds)` input on a shared fixture directory |

---

## Done criteria mapping

- [x] Recovery state machine and lease model are specified — §4.
- [x] Duplicate side effects and trust/credential risks are addressed — §5.
- [x] Resumable versus non-resumable capabilities are explicit — §2.3, §3, §5.1.
- [x] Prototype scope and open decisions are listed — §6, §7.

## Maintenance notes

- Do not turn artifact existence into permission to execute — see §6.5's explicit
  non-goal and the threat-model row on background-terminal drift (§5.3).
- Any future implementation needs **separate plans** for: storage migration (adding the
  `lease` block to `WorkflowDetails` without breaking older readers, §6.3), lease
  enforcement (the CAS/renewal code paths sketched in §4.5, which do not exist yet),
  and per-backend resume semantics (currently moot — there is exactly one backend,
  in-process `agent()` calls, and §2.3 establishes it has no resumable session to begin
  with; this becomes relevant only if workflows ever gain a second execution backend).
- If a future change adds the `lease` fields to `WorkflowDetails` for real, update
  §2.1's "not persisted today" note and §6.3's compatibility section in the same
  change, matching the maintenance discipline in
  `extensions/subagents/docs/design-plan.md`'s §8/Maintenance notes precedent.
