# Extension architecture

The repository is organized around concern slices. A slice owns one capability end to end; infrastructure and host integration are kept at its boundary.

## Object-oriented rules

- Stateful behaviour belongs to a class with constructor-injected dependencies.
- Domain values and presentation policies use immutable data or static-only classes.
- Process, filesystem, and SDK integrations are adapter classes behind narrow interfaces.
- Managers coordinate lifecycle and scheduling; they do not own formatting or protocol rendering.
- Shared stateful policies, such as exactly-once result delivery, live in `extensions/shared` and are reused by slices.
- Tests exercise public class seams with real adapters or small fakes.

Framework entrypoints (`index.ts` extension registrations, TUI render callbacks, and Vitest configuration) remain functions because the host requires those signatures. They are thin composition glue: validate input, resolve a service, call a class, and render the result.

## Current concern objects

- `DeferredResultDelivery` — shared exactly-once delivery state machine.
- `ProcessTreeController` — platform shell invocation and process-tree termination.
- `EffectCommandRunner` — command execution adapter for git.
- `RefreshCoordinator` — refresh concurrency policy.
- `SubagentSnapshotReducer` — normalized event-to-snapshot state transitions.
- `ContextUtilizationFormatter`, `ActivityStatusFormatter`, and snapshot formatters — pure presentation policies.
- `OutputBuffer` — bounded stream capture and spill coordination.

Concern packages prevent god files as features grow:

- `background-terminals/src/process-tree/` separates shell construction, signal delivery, and close observation.
- `background-terminals/src/terminal-output/` separates buffering, limits, and spill-file lifecycle.
- `background-terminals/src/terminal-manager/` separates terminal entry state from registry/read-model concerns.
- `workflows/dashboard/` owns run-cache parsing and artifact hydration, apart from dashboard rendering.
- `workflows/runner/` owns progress/transcript reduction, apart from session orchestration.
- `subagents/src/backends/codex/` owns binary discovery, protocol mapping, and process-tree shutdown.
- `subagents/src/backends/claude/` owns binary discovery, streaming input, protocol parsing, and bounded teardown.
- `subagents/src/backends/pi/` owns model resolution, child resources, transcript translation, and session lifecycle.
- `git-info/src/changed-files-view/` separates git loading, terminal sanitization, and TUI rendering.
- `workflows/registry.ts` owns live-run state and persisted run read models; `workflows/tool.ts` owns tool execution and presentation.

Effect `Context.Service` values remain the dependency-injection ports. Concrete classes are constructed in the corresponding runtime layer and injected into those ports; this keeps ambient process and runtime concerns out of domain objects.

Future refactors should extract another class only when it owns a cohesive policy or lifecycle. Do not create classes that merely forward one call, and do not turn host-required callbacks or tiny pure value helpers into artificial objects.
