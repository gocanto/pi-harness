# subagents — Architecture & Status

A pi extension that fires off background subagents from a parent pi session, where each
subagent can be powered by one of three backends — **pi** (in-process SDK session),
**Claude Code** (`@anthropic-ai/claude-agent-sdk`), or **Codex** (`codex app-server`) —
unified behind a single Effect v4 service interface.

> **Status (refreshed 2026-07-31):** all three backends are real, non-stub
> implementations — `src/backends/pi.ts`, `src/backends/claude.ts`,
> `src/backends/codex.ts` (roughly 575/720/1070 lines respectively). The scripted
> `src/backends/stub.ts` machinery survives only as a fast, deterministic fixture for
> `manager.test.ts` (see §7); it is not used at runtime. Section 1 of this document is
> the **original v1 planning record** (kept for historical context — most of it still
> accurately describes the shipped behavior, and any place it doesn't is called out
> inline). Section 6 (current architecture) and §7 (tests) describe the codebase as it
> exists today; verify any claim there against the referenced file before relying on it.

**Location:** `extensions/subagents/` in this repository (a pnpm workspace member —
see `SETUP.md` at the repo root for install/test commands). Mostly self-contained, but
not fully isolated the way the original v1 plan intended ("no imports from `../shared`"
— see §1): `index.ts`'s trust-boundary check imports `resolveStandaloneChildProjectTrust`
from `../shared/child-session.ts` directly (also imported by `trust.test.ts`), and
`src/backends/pi.ts` imports `createToolCallTimeoutGuard` from
`../../../shared/tool-call-timeout.ts` (its own child-session logic is a ported copy of
`shared/child-session.ts`, per that file's header comment, not an import of it).

---

## 1. V1 inventory (historical planning record)

> Written during the original design phase, before any backend was implemented. Kept
> for context on _why_ the shapes below look the way they do. Where the shipped tool
> surface diverged (parameter names, in particular), the divergence is noted inline;
> otherwise treat this section as historical rather than authoritative — prefer §6.

Source at the time: `extensions/subagents/` (`index.ts`, `manager.ts`, `prompt.ts`,
`result-delivery.ts`, `takeover.ts`) plus `../shared/` helpers.

### 1.1 Tools exposed to the parent LLM

> **Shipped tool parameters differ from this table** — see §6.1 for the current
> `subagent_spawn` schema (`prompt`, `name`, `harness`, `working_dir?`, `model?`,
> `reasoning_effort?`; no `provider` parameter, and `title`/`agent` became `name`/
> `harness`). The behavioral description below (caps, truncation, id scheme) still
> matches `src/manager.ts` and `index.ts`.

| Tool              | Parameters                                                                    | Behavior                                                                                                                                                                                                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagent_spawn`  | `prompt`, `title`, `working_dir?`, `model?`, `provider?`, `reasoning_effort?` | Fire-and-forget spawn. Returns immediately with an id (`sa-N`). Enforces `MAX_RUNNING = 4` with a synchronous reservation so parallel tool calls can't race past the cap. Validates `working_dir`, resolves model against the registry (inherit parent model/thinking level by default), truncates title to 160 chars.             |
| `subagent_wait`   | `ids[]` (max 64)                                                              | Blocks until all listed subagents settle; respects the tool `AbortSignal`; streams `Waiting for ...` via `onUpdate`. Marks the awaited results "consumed" so they are not also auto-delivered. Output budgets: 48KB total, 16KB per agent, with per-section fallbacks (`[omitted: ...]`). Errors on unknown ids (lists known ids). |
| `subagent_cancel` | `ids[]`                                                                       | Aborts running subagents (marks consumed first to avoid duplicate delivery), waits for settlement, reports per-id `Cancelled ...` / `was already <status>`. Partial transcripts remain on disk.                                                                                                                                    |
| `subagent_check`  | `id`                                                                          | Non-blocking peek: status line, turn count, error text, up to 2KB/20 lines of latest output (includes the live streaming assistant message). Does not consume the result.                                                                                                                                                          |
| `subagent_list`   | —                                                                             | One `describeSubagent()` line per agent: `id [status] "title" (provider/model, ctx%, elapsed, cwd)`.                                                                                                                                                                                                                               |

Prompt metadata (all strings live in `prompt.ts`): `subagent_spawn` has a
`promptSnippet` and two `promptGuidelines` (delegate self-contained tasks; don't block
on `subagent_wait` unless necessary). Tool descriptions explain fire-and-forget semantics,
the concurrency cap, and that children can't orchestrate/see the parent conversation.

### 1.2 State tracking (v1 `SubagentManager`)

- Plain class with `Map<string, Subagent>`; each `Subagent` = `{ id, title, prompt, cwd,
session: AgentSession, status: "running" | "done" | "error", createdAt, settledAt?,
errorText?, unsubscribeLifecycle }`.
- Children are **in-process pi `AgentSession`s** created via the SDK
  (`createAgentSession` + `SessionManager.create(cwd)` → real session files visible in
  `/resume`), with child resources loaded per-cwd (`DefaultResourceLoader`, trust-gated
  project resources) and a tool denylist (`excludeTools`: the subagent_* tools,
  `workflow`, `ask_user`).
- Settlement is driven by session lifecycle events (`agent_start` re-marks running;
  `agent_settled` settles). Failure detection: thrown prompt error, last assistant
  `stopReason === "error" | "aborted"`, error text bounded to 4096 chars.
- Change notification: `addChangeListener()` + `nextChange(signal)` promise — used by
  `waitFor`, the footer status, and the dashboard.
- `waitFor(ids, signal, onPending)` keeps a `waitInterest` refcount per id so settles
  during an active wait are marked consumed.
- `send(sub, text)`: steer via `session.steer()` while streaming, else start a fresh
  `prompt()` run (used by takeover).
- Caps and cleanup: `MAX_RUNNING = 4`, `MAX_TRACKED = 64` with LRU pruning of settled
  agents, `STOP_TIMEOUT_MS = 5s` bounded aborts, force-dispose fallback, idempotent
  `disposeAll()` on `session_shutdown`.

This is still an accurate description of `src/manager.ts`'s behavior (see §6.4), modulo
the pi-specific detail above now living in `src/backends/pi.ts` rather than directly in
the manager, since the manager is backend-agnostic in the shipped design.

### 1.3 Result delivery back to the parent

- When a child settles **unconsumed**, `onSettled` defers it into a tiny
  `createDeferredResultDelivery` buffer (defer/consume/drain/clear keyed by id).
- Flush happens when the parent goes idle: immediately if `sessionContext.isIdle()`,
  otherwise on the parent's `agent_settled` event. A later `subagent_wait` can still
  consume a deferred result before flush (that's why it is a buffer, not an immediate
  send).
- Delivery = `pi.sendMessage({ customType: "subagent-result", content, display: true,
details: { id, title, status } }, { deliverAs: "followUp", triggerTurn: true })`.
  Content is built by `buildSubagentResultMessage` (`Subagent sa-N "title"
finished/failed.` + optional `Error:` line + output truncated to 24KB/600 lines with a
  pointer to the child session file for the full transcript).

Still accurate; see `src/result-delivery.ts` and `index.ts`'s `deliverResult`/
`flushResults` (§6.5). The shipped version additionally routes `origin: "btw"` results
through a separate `deliverBtwResult` path (§6.6) that was not part of this plan.

### 1.4 UI (carried over into v2 essentially as-is)

1. **Footer status** (`ctx.ui.setStatus("subagents", ...)`): `subagents: ■ 2 running ·
■ 1 done · ■ 1 failed · /subagents to view` (warning/success/error colored squares;
   cleared when no subagents). Driven by manager change listener.
2. **`subagent-result` message renderer**: status icon (`■`/`x`) + bold accent header
   `subagent sa-N · title · finished/failed`; collapsed = first 8 body lines +
   `... (ctrl+o to expand)`; expanded = header + `Markdown` component render of the body.
3. **`/subagents` command** → `openSubagentPicker` loop (TUI mode only; notifies and
   bails in non-TUI or when there are no subagents):
    - **SubagentDashboard** — fullscreen overlay (`anchor: "center", width: "100%",
maxHeight: "100%"`), bordered list panel titled `agents · settled/total`. Each row:
      selection marker `❯`, status glyph, title, dim id on the left; model id · context
      utilization (`%/capacity`) · elapsed · status word on the right. Scroll window
      centered on the selection with `... N more` markers. 1Hz ticker re-render for
      elapsed/token columns + manager change subscription. Keys: `tui.select.up/down`
      **and** `j`/`k` to move, `tui.select.confirm` to take over, `x` to abort the
      selected running agent, `tui.select.cancel` to close. Hint line shows the
      _configured_ keys via `keybindings.getKeys()`.
    - **TakeoverView** — fullscreen overlay for one subagent: header line (status glyph,
      `id · title · status · elapsed · provider/model · ctx%`), fixed-height transcript
      viewport (error line and scroll indicator consume viewport rows so height never
      jumps), an `Input` line, and a hint row. Keys: `tui.input.submit` send (steer if
      streaming, new run if idle), `app.interrupt`/`tui.select.cancel` back to dashboard,
      `app.clear` abort run, `tui.editor.cursorUp/Down` scroll ±6 lines,
      `tui.editor.pageUp/Down` page. Renders are throttled to 50ms because streaming can
      emit per-token events.
    - **Transcript rendering** (`buildTranscriptLines`): sanitizes ANSI/tabs/control
      chars; user messages as `> ` accent-prefixed wrapped lines; assistant text wrapped
      plain; thinking as dim italic `~ ` lines; tool calls as `→ toolname {args}`; tool
      results as one dim `output:`/red `error:` first line. Includes the **live streaming
      assistant message**, **live tool executions** (running/done/error marker + first
      output line preview, tracked from `tool_execution_*` events until the final tool
      result message lands), and **queued steering/follow-up messages** (`> [queued
steer] ...`) so Enter visibly acknowledges input.

Shipped in `src/ui/takeover.ts` (dashboard + takeover view) and `src/ui/transcript.ts`
(transcript rendering) — see §6.7. `openSubagentTakeover` (the single-agent view) is
also reused directly by `/btw`, which this plan did not anticipate.

---

## 2. Backend integration facts

These shape the interface even though v1-of-v2 stubs the internals. (Traced from the
"T3 Code" codebase which integrates Codex and Claude Code.)

|                 | Interactive sessions                                                                                                                                                                                   | One-shot tasks                                                                          | Event shape                                                                                              | Interrupt                              | Steering                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| **pi**          | In-process `createAgentSession()` (pi SDK); real session files; `session.subscribe()`                                                                                                                  | `session.prompt()` and read final assistant message (or `pi -p` subprocess, not needed) | `AgentSessionEvent` (message_start/update/end, tool_execution_*, agent_start/settled, queue_update, ...) | `session.abort()`                      | `session.steer()` / `followUp()`                                      |
| **Claude Code** | `@anthropic-ai/claude-agent-sdk` `query()` — SDK launches the `claude` executable and streams JSON messages (assistant/user/result/system, streaming partials, tool_use blocks)                        | `claude -p --output-format json`                                                        | SDK message stream (async iterable)                                                                      | `query.interrupt()` / abort controller | streaming-input mode: push more user messages into the input iterable |
| **Codex**       | spawn `codex app-server` child process, JSON-RPC over stdin/stdout (`newConversation` / `sendUserTurn`, notifications: `agentMessageDelta`, `execCommandBegin/End`, `taskComplete`, `tokenCount`, ...) | `codex exec` (prints result to stdout, `--json` for events)                             | JSON-RPC notifications                                                                                   | `interruptConversation` request        | send another `sendUserTurn` on the same conversation                  |

Common denominator all three can supply:

- an async event stream with: lifecycle (started/turn/settled), assistant text
  (deltas and/or completed messages), reasoning text, tool execution begin/update/end,
  token usage, errors;
- a way to send a follow-up/steering user message into a live session;
- an interrupt operation;
- a final result text per run;
- metadata: backend name, model identifier, session/log file path (pi session file,
  Claude session id + projects dir JSONL, Codex rollout path), working dir.

That is exactly what the normalized event model in `src/domain.ts` (§6.2) encodes; see
§6.3 for how each backend's actual `steering`/`modelSelection`/`reasoningEffort`
capabilities landed (they are not identical across backends — Codex does not support
steering).

---

## 3. Effect v4 conventions used

- Single `effect` package (`^4.0.0-beta.99` in `package.json`; the lockfile currently
  resolves `4.0.0-beta.102` — see §6.9). Services defined with `Context.Service<T>()`;
  wiring via `Layer`; `ManagedRuntime.make(layer)` at the extension edge with
  `runtime.runPromise(effect, { signal })` inside `async execute()` tool handlers and
  `await runtime.dispose()` on `session_shutdown`.
- `Effect.gen` generators throughout the internals. `async`/`Promise` appears **only**
  in: tool `execute()` bodies, `pi.on(...)` handlers, the `/subagents`/`/btw` command
  handlers, and the imperative TUI component classes (which are callback-driven, not
  effectful).
- Streams: `Stream<SubagentEvent>` per subagent, produced by backends, consumed by a
  manager fiber per subagent.
- Errors: tagged error classes (`Data.TaggedError`) — `SpawnError`,
  `BackendUnavailableError`, `ConcurrencyLimitError`, `SendError` (see `src/domain.ts`).
  Tool handlers map these to thrown `Error`s with the same user-facing messages v1 uses.

See `docs/effect-v4-notes.md` and `docs/effect-v4-extension-guide.md` for the full API
cheat sheet and toolchain notes; those two documents are maintained separately from
this one and are out of scope for this refresh.

---

## 4. Domain model (`src/domain.ts`)

Matches the shipped source closely enough that the original sketch below is still a
useful summary; consult `src/domain.ts` directly for the authoritative shape (it adds
`SubagentOrigin` (`"model" | "btw"`), `REASONING_EFFORTS`/`ReasoningEffort`, and
`ParentContext.modelRegistry` beyond what is shown here).

```ts
type BackendName = 'pi' | 'claude' | 'codex';

type SubagentStatus = 'running' | 'done' | 'error';

interface SpawnTask {
	readonly prompt: string;
	readonly title: string;
	readonly cwd: string;
	readonly model?: string; // pi: "provider/model-id"; claude: model alias; codex: model slug
	readonly reasoningEffort?: ReasoningEffort; // shared effort scale; each backend maps it natively
	readonly parent: {
		readonly parentCwd: string;
		readonly projectTrusted: boolean;
		readonly inheritedModel?: { readonly provider: string; readonly id: string }; // pi only
		readonly inheritedThinkingLevel?: string;
		readonly modelRegistry?: ModelRegistry; // required by the pi backend to resolve models
	};
}

interface SubagentMeta {
	readonly backend: BackendName;
	readonly modelLabel?: string; // "anthropic/claude-opus-4-5", "gpt-5-codex", ...
	readonly contextWindow?: number; // for utilization %, when known
	readonly sessionFilePath?: string; // pi session file / claude JSONL / codex rollout path
	readonly nativeSessionId?: string; // claude session id, codex conversation id
}
```

### 4.1 Normalized event model

One discriminated union covers everything the UI and manager need. Backends translate
their native streams into this; nothing downstream knows which backend produced it.
See `src/domain.ts` for the exact `SubagentEvent`/`RunOutcome`/`TranscriptPart` unions —
they match the shape below field-for-field.

```ts
type SubagentEvent =
	| { _tag: 'RunStarted' }
	| { _tag: 'RunSettled'; outcome: RunOutcome }
	| { _tag: 'UserMessage'; text: string }
	| { _tag: 'AssistantDelta'; kind: 'text' | 'thinking'; delta: string }
	| { _tag: 'AssistantMessage'; parts: TranscriptPart[] }
	| { _tag: 'ToolStart'; toolId: string; name: string; argsPreview?: string }
	| { _tag: 'ToolUpdate'; toolId: string; outputPreview?: string }
	| { _tag: 'ToolEnd'; toolId: string; name: string; isError: boolean; outputPreview?: string }
	| { _tag: 'QueueChanged'; queued: ReadonlyArray<{ text: string; kind: 'steer' | 'follow-up' }> }
	| { _tag: 'UsageChanged'; tokens?: number; contextWindow?: number }
	| { _tag: 'MetaChanged'; meta: Partial<SubagentMeta> }
	| { _tag: 'BackendError'; message: string };

type RunOutcome = { _tag: 'Completed'; finalText: string } | { _tag: 'Failed'; errorText: string; partialText?: string } | { _tag: 'Interrupted'; partialText?: string };
```

---

## 5. The `SubagentBackend` service (`src/backend.ts`)

One interface; three implementations (`src/backends/{pi,claude,codex}.ts`); a registry
keyed by `BackendName` (`src/runtime.ts`'s `BackendRegistryLive`).

```ts
interface SubagentBackend {
	readonly name: BackendName;
	readonly capabilities: { steering: boolean; modelSelection: boolean; reasoningEffort: boolean };
	readonly available: Effect.Effect<boolean>; // probe binary/SDK/credentials, cheap
	spawn(task: SpawnTask): Effect.Effect<SubagentSession, SpawnError, Scope.Scope>;
}

interface SubagentSession {
	readonly meta: Effect.Effect<SubagentMeta>;
	readonly events: Stream.Stream<SubagentEvent>;
	send(text: string): Effect.Effect<void, SendError>;
	readonly interrupt: Effect.Effect<void>;
}
```

Design choices that carried through as-built:

- **`spawn` is scoped, not paired with an explicit `dispose`.** The manager opens one
  `Scope` per subagent and closes it on cancel/prune/disposeAll.
- **`send` unifies steer/new-run.** The interface keeps the decision inside the backend
  because "is a run active" is backend-native state.
- **Events, not message arrays, are the contract.** The manager folds events into
  snapshots; backends never expose native message types.

---

## 6. Current architecture (verified against `src/`, 2026-07-31)

### 6.1 Tool surface (`index.ts`, `src/prompt.ts`)

| Tool              | Parameters                                                                                                                                      | Notes                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `subagent_spawn`  | `prompt`, `name`, `harness` (`"pi" \| "claude" \| "codex"`, required), `working_dir?`, `model?`, `reasoning_effort?` (`REASONING_EFFORTS` enum) | `name` is truncated to 160 chars for the title. `working_dir` resolves against `ctx.cwd` and is validated (`fs.existsSync` + `isDirectory()`), then checked against `resolveStandaloneChildProjectTrust` **before** the manager reserves a concurrency slot — an untrusted cwd is rejected outright, never reaching a backend. |
| `subagent_wait`   | `ids[]` (max 64)                                                                                                                                | Same budgets as the historical record (§1.1): 48KB total / 16KB per agent, consumes deferred results for the waited ids.                                                                                                                                                                                                       |
| `subagent_cancel` | `ids[]`                                                                                                                                         | Unchanged from §1.1.                                                                                                                                                                                                                                                                                                           |
| `subagent_check`  | `id`                                                                                                                                            | Filters out `origin: "btw"` subagents via `isModelVisible` (§6.6) — the model cannot see or touch `/btw` asides through these tools.                                                                                                                                                                                           |
| `subagent_list`   | —                                                                                                                                               | Same filter as above.                                                                                                                                                                                                                                                                                                          |

There is no `provider`/`agent` split parameter as sketched in §1.1 — the shipped schema
uses `harness` for the backend selector and folds "provider" into the free-form `model`
string, interpreted per backend (see `resolvePiModel` in `src/backends/pi.ts`).

### 6.2 Trust and permission model

Confirmed in `extensions/shared/child-session.ts`,
`extensions/subagents/permission-policy.test.ts`, and the backends:

- `resolveStandaloneChildProjectTrust` (shared with the pi backend's child sessions):
  a subagent spawned in the **same cwd** as the parent inherits the parent's live trust
  decision; a **different cwd** is trusted only if pi's persisted trust store explicitly
  trusts it (or a containing directory) — unreadable/invalid trust data fails closed.
- `claudePermissionOptions(trusted)` (`src/backends/claude.ts`): a trusted cwd gets
  `{ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }`; an
  untrusted cwd gets `{ permissionMode: "dontAsk", settingSources: ["user"] }` — never
  `bypassPermissions`.
- `codexSandboxOptions(trusted)` (`src/backends/codex.ts`): a trusted cwd gets
  `{ approvalPolicy: "never", sandbox: "danger-full-access" }`; an untrusted cwd gets
  `{ approvalPolicy: "never", sandbox: "workspace-write" }` — never
  `danger-full-access`. `approvalPolicy` is always `"never"` because headless children
  cannot answer an interactive prompt either way.
- These two option builders are pure and covered by
  `extensions/subagents/permission-policy.test.ts` without touching a live SDK/process.

### 6.3 Backend capability matrix (`src/backends/*.ts`)

| Backend | `steering` | `modelSelection` | `reasoningEffort` | `available` probe                                                    |
| ------- | ---------- | ---------------- | ----------------- | -------------------------------------------------------------------- |
| pi      | `true`     | `true`           | `true`            | requires `task.parent.modelRegistry` (thrown `SpawnError` otherwise) |
| claude  | `true`     | `true`           | `true`            | resolves the `claude` CLI on `PATH` (`resolveClaudeBinary`)          |
| codex   | `false`    | `true`           | `true`            | resolves the `codex` binary on `PATH`                                |

For the full cross-harness matrix (cancellation semantics, persistence, output
budgets, security implications, cost/latency, and a bounded implementation
backlog — Plan 018), see `docs/capability-matrix.md`. This table stays as the
quick at-a-glance summary; that document is the authoritative, evidence-cited
version.

Model defaults when `model` is omitted: pi resolves against the parent's
`ModelRegistry` and inherits the parent's model/thinking level (`resolvePiModel`);
Claude and Codex simply omit the `model` option from the SDK/CLI call and let that
tool's own default apply — no extension-level default-model config block was added.

### 6.4 `SubagentManager` (`src/manager.ts`)

One `Context.Service` (`"subagents/SubagentManager"`) wrapping a `Map<string, Entry>`
plus the synchronous `SubagentReadModel` bridge for the TUI — there is no separate
`src/read-model.ts` file; the read model is implemented inline at the bottom of
`manager.ts` (`view: SubagentReadModel`), unlike the split sketched in the original
plan (§1.2, §6.8 file layout below).

- **Concurrency cap:** `MAX_RUNNING = 4`, enforced with a synchronous `reserved++`
  inside `Effect.suspend` before the first yield, so parallel tool calls cannot race
  past it. The cap is **global across all three backends** (not per-backend).
  Restarting a settled subagent via `send()` re-occupies a running slot and is subject
  to the same cap.
- **Pruning:** `MAX_TRACKED = 64`; oldest settled, non-wait-interested entries are
  pruned (scope closed) once the map exceeds that size.
- **Settlement:** the per-subagent event pump folds `SubagentEvent`s into a mutable
  snapshot; `RunSettled` computes `status`/`errorText` (bounded to 4096 chars) and
  invokes the `onSettled` hook with `consumed = waitInterest > 0`.
- **Cancel:** marks consumed → `session.interrupt` bounded to 5s → force-closes the
  scope on timeout → waits for settle. Reports `Cancelled ...` / `was already <status>`.
- **Transcript/text bounds:** transcript capped at 512 items; per-item text at 64KB;
  live-assistant buffer at 128KB; final text at 1MB — all in `manager.ts`'s constants.
- **Shutdown:** `disposeAll` closes every entry's scope (bounded 5s each, unbounded
  concurrency) and is also wired as an `Effect.addFinalizer`, so disposing the
  `ManagedRuntime` tears everything down even if the extension forgets to call it
  explicitly.

### 6.5 Persistence and lifecycle

Confirmed unchanged from the v1 decision (§1.2, resolving open question 10 below):
subagents (pi, Claude, and Codex children alike) do **not** survive a session
transition. `index.ts`'s `session_shutdown` handler clears the deferred-result queue,
unsubscribes the status listener, and `await`s `runtime.dispose()`, which runs the
manager's `disposeAll` finalizer and closes every subagent's scope (interrupting the
in-process pi session, or killing the Claude/Codex child process). There is no
reattach-after-reload path.

### 6.6 Result delivery and the `/btw` ("by the way") feature

`src/result-delivery.ts` is unchanged from §1.3. `index.ts` additionally introduces an
`origin` field (`"model" | "btw"`, `src/domain.ts` `SubagentOrigin`) not present in the
original plan:

- `origin: "model"` subagents (spawned via `subagent_spawn`) flow through the deferred
  delivery queue described in §1.3 and are visible to the `subagent_*` tools.
- `origin: "btw"` subagents are spawned by the `/btw` command (`runByTheWay` in
  `index.ts`) for one-off user asides that run alongside the main agent. Their results
  are delivered via `pi.appendEntry("btw-result", ...)` (a synchronous session-log
  entry, never entering the model's context or follow-up queue) instead of
  `pi.sendMessage`, and `src/by-the-way.ts`'s `isModelVisible()` hides them from
  `subagent_check`/`subagent_list`/`subagent_wait`/`subagent_cancel` entirely. `/btw`
  always spawns on the `pi` backend and reuses `openSubagentTakeover` for its
  single-agent view.

### 6.7 UI

`src/ui/takeover.ts` (dashboard + takeover view) and `src/ui/transcript.ts` (sanitize +
`buildTranscriptLines`) implement §1.4 as described, plus the `/btw` reuse noted above.
`src/format.ts` holds the elapsed/context-utilization/activity-status formatting
helpers referenced by both the tools and the UI.

### 6.8 File/module layout (as shipped)

```
extensions/subagents/
├── package.json                 # "effect": "^4.0.0-beta.99", "@anthropic-ai/claude-agent-sdk": "^0.3.216"
├── tsconfig.json
├── docs/
│   ├── design-plan.md            # this document
│   ├── effect-v4-notes.md        # Effect v4 API cheat sheet (maintained separately)
│   └── effect-v4-extension-guide.md  # toolchain + ManagedRuntime boundary notes
├── index.ts                      # extension factory: runtime lifecycle, 5 tools, /subagents, /btw
├── *.test.ts                     # manager, result-delivery, takeover, by-the-way, trust,
│                                  # permission-policy, context-usage (deterministic, in `pnpm test`);
│                                  # claude.test.ts / codex.test.ts (live provider tests, §7)
└── src/
    ├── domain.ts                 # BackendName, SpawnTask, SubagentEvent, RunOutcome, tagged errors
    ├── backend.ts                # SubagentBackend + SubagentSession interfaces, BackendRegistry key
    ├── backends/
    │   ├── stub.ts                # scripted fake-session backend, used only by manager.test.ts
    │   ├── pi.ts                  # real in-process pi SDK sessions
    │   ├── claude.ts               # real @anthropic-ai/claude-agent-sdk integration
    │   └── codex.ts                 # real codex app-server JSON-RPC integration
    ├── manager.ts                 # SubagentManager service/layer + inline SubagentReadModel
    ├── runtime.ts                 # AppLayer composition + ManagedRuntime create/dispose + runTool
    ├── result-delivery.ts         # deferred delivery buffer
    ├── by-the-way.ts               # /btw title derivation + isModelVisible origin filter
    ├── prompt.ts                   # all model-facing strings
    ├── format.ts                   # elapsed/context-utilization/activity-status formatting
    └── ui/
        ├── transcript.ts            # sanitize + buildTranscriptLines
        └── takeover.ts               # SubagentDashboard + TakeoverView + openSubagentPicker/Takeover
```

There is no `src/read-model.ts` (merged into `manager.ts`, §6.4) and no
`result-delivery.test.ts`-adjacent `read-model.test.ts` — behavior is covered through
`manager.test.ts`'s end-to-end assertions instead.

### 6.9 Dependencies and versions

From `extensions/subagents/package.json` (source of truth — do not hardcode a version
number anywhere else in this doc set):

```json
{
	"dependencies": {
		"@anthropic-ai/claude-agent-sdk": "^0.3.216",
		"effect": "^4.0.0-beta.99"
	},
	"devDependencies": {
		"@effect/tsgo": "^0.24.2",
		"typescript": "^7.0.2"
	}
}
```

The repo-root `pnpm-lock.yaml` currently resolves `effect` to `4.0.0-beta.102` and
`@anthropic-ai/claude-agent-sdk` to `0.3.220` — both satisfy the caret ranges above.
This resolves open question 9 below: the caret range is tracked and bumped via the
lockfile rather than pinned to an exact beta build.

---

## 7. Tests and commands

Run from the repository root (a pnpm workspace — see `SETUP.md`):

```sh
pnpm install   # first time / after a dependency or script change
pnpm test      # deterministic suite for every extension, including this one
pnpm test:live # extension-specific: extensions/subagents' claude.test.ts + codex.test.ts
```

- `pnpm test` runs this extension's `manager.test.ts`, `result-delivery.test.ts`,
  `context-usage.test.ts`, `takeover.test.ts`, `by-the-way.test.ts`, `trust.test.ts`,
  and `permission-policy.test.ts` (all deterministic, no external processes or
  credentials required — the manager tests use `src/backends/stub.ts`).
- `pnpm test:live` runs `claude.test.ts` and `codex.test.ts`, which spawn real Claude
  Code / Codex sessions and are skipped individually when the corresponding CLI is not
  installed/authenticated locally. These are excluded from `pnpm test` on purpose (per
  `plans/001-separate-live-provider-tests.md`).
- `pnpm run check` (repo root `tsc --noEmit`) and `pnpm run format:check` (fmtkit)
  should both stay green; there is no extension-local `npm install`/`npm run check`
  step — this package is a member of the root pnpm workspace, not an independently
  installed extension.

---

## 8. Open questions from the original plan — resolved status

Each item below was an open question in the original v1 planning document. All ten
have since been resolved by the shipped implementation; none is still an open product
decision as of this refresh. If a future change reopens one of these, update the
"Resolution" column in the same change (per the maintenance note at the end of this
document).

| #   | Original question                                | Resolution (verify against source)                                                                                                                                                                                           |
| --- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Per-backend spawn options shape                  | Option (a) shipped: one generic `model` string + `reasoning_effort` enum, interpreted per backend (`src/domain.ts` `SpawnTask`, §6.1).                                                                                       |
| 2   | One-shot `exec()` mode                           | Not added. Only the interactive-session path (`spawn`/`send`) exists; no `exec(task): Effect<RunOutcome>` in `src/backend.ts`.                                                                                               |
| 3   | Permissions/sandboxing for Claude/Codex children | Trusted cwds get `bypassPermissions` / `danger-full-access`; untrusted cwds never do (§6.2, `permission-policy.test.ts`). Not a global setting or per-spawn parameter — it is derived automatically from the trust boundary. |
| 4   | Concurrency cap scope                            | Kept as one global `MAX_RUNNING = 4` across all backends (`src/manager.ts`), not per-backend.                                                                                                                                |
| 5   | Steering parity across backends                  | `capabilities.steering` is `true` for pi and Claude, `false` for Codex (§6.3) — the UI is expected to reflect this rather than treating steering as a hard requirement for all three.                                        |
| 6   | Model/thinking inheritance across backends       | pi inherits the parent's model/thinking level via its `ModelRegistry`; Claude/Codex simply omit the model option and defer to that backend's own default when none is given — no extra config block was added (§6.3).        |
| 7   | Binary/SDK discovery + failure UX                | `available` probes the binary/registry per backend; `subagent_spawn` fails fast with a `BackendUnavailableError`-derived tool error rather than hiding the backend from the enum dynamically (`src/manager.ts` `spawn`).     |
| 8   | Result truncation budgets                        | Kept unchanged: 24KB result message, 48KB wait total / 16KB per agent, 2KB/20-line check preview (`index.ts` constants).                                                                                                     |
| 9   | Effect version pinning                           | Tracked via a caret range (`^4.0.0-beta.99`) and the lockfile, not an exact pin (§6.9).                                                                                                                                      |
| 10  | Persistence across reloads                       | Kept v1's kill-everything behavior; no reattach-after-reload support was added (§6.5).                                                                                                                                       |

---

## 9. Migration/coexistence note (historical, resolved)

> This section described a temporary-naming plan for while a hypothetical v1
> implementation and this design coexisted in `~/.pi/agent/extensions/`. No such v1
> duplicate was ever present in this repository — the tool names (`subagent_spawn`,
> `subagent_wait`, `subagent_cancel`, `subagent_check`, `subagent_list`) and the
> `/subagents` command shipped directly under their final names. This section is kept
> only as a historical record of the original concern; there is nothing left to act on.

---

## Maintenance notes

Date architecture decisions and link to the owning source/tests. When a future change
alters backend behavior, the manager's concurrency/persistence model, the trust
boundary, or the package boundary, update §6 (and, if it resolves or reopens one of the
items in §8, that table) in the same change.
