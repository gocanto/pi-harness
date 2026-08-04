/**
 * SubagentManager — owns the registry of running/finished subagents.
 *
 * Each subagent is a scoped `SubagentSession` from a `SubagentBackend` plus a
 * pump fiber that folds its normalized event stream into a mutable
 * `SubagentSnapshot`. Closing a subagent's scope kills the underlying
 * session/process and stops the pump.
 *
 * The manager also exposes a synchronous `SubagentReadModel` so the
 * imperative TUI components (which render synchronously) can read snapshots
 * and issue fire-and-forget commands without touching the Effect runtime.
 */

import type { SubagentBackend, SubagentSession } from '@subagents/src/backend.ts';
import { BackendRegistry } from '@subagents/src/backend.ts';

import { Context, Effect, Exit, Fiber, Layer, Result, Scope, Stream } from 'effect';

import type { BackendName, LiveToolState, RunOutcome, SpawnTask, SubagentSnapshot, SubagentStatus } from '@subagents/src/domain.ts';

import { BackendUnavailableError, ConcurrencyLimitError, SendError, SpawnError } from '@subagents/src/domain.ts';

import { SubagentSnapshotReducer, type MutableSubagentSnapshot } from '@subagents/src/snapshot-reducer.ts';

export const MAX_RUNNING = 4;

export const MAX_TRACKED = 64;

const STOP_TIMEOUT_MS = 5_000;
const ERROR_TEXT_MAX_LENGTH = 4_096;
const FINAL_TEXT_MAX_LENGTH = 1_024 * 1_024;

function bounded(text: string) {
	return text.slice(0, ERROR_TEXT_MAX_LENGTH);
}

// --- Internal state -----------------------------------------------------------

interface Entry {
	snapshot: MutableSubagentSnapshot;
	session: SubagentSession;
	scope: Scope.Closeable;
	pump?: Fiber.Fiber<void>;
	liveToolMap: Map<string, LiveToolState>;
	reducer?: SubagentSnapshotReducer;
	/** Idle restart dispatched but RunStarted not folded yet; counts as running
	 * so concurrent restarts cannot race past the cap. */
	restarting?: boolean;
}

// --- Read model ----------------------------------------------------------------

/** Synchronous bridge for the TUI. Snapshots are live objects; do not mutate. */
export interface SubagentReadModel {
	list(): ReadonlyArray<SubagentSnapshot>;
	get(id: string): SubagentSnapshot | undefined;
	size(): number;
	/** Any-change notification (footer status, dashboard). */
	subscribe(listener: () => void): () => void;
	/** Per-subagent notification (takeover view). */
	subscribeTo(id: string, listener: () => void): () => void;
	/** Fire-and-forget: steer/continue a subagent (takeover input). */
	requestSend(id: string, text: string): void;
	/** Fire-and-forget: abort a running subagent (dashboard `x`, takeover). */
	requestAbort(id: string): void;
	/**
	 * Register the settle hook. `consumed` is true when an active
	 * subagent_wait/cancel is collecting the result (so it must not also be
	 * delivered as a follow-up message).
	 */
	setOnSettled(hook: ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined): void;
}

// --- Service --------------------------------------------------------------------

export interface CancelResult {
	readonly id: string;
	readonly title: string;
	readonly status: SubagentStatus;
	readonly cancelled: boolean;
}

export interface SubagentManagerShape {
	spawn(backend: BackendName, task: SpawnTask): Effect.Effect<SubagentSnapshot, SpawnError | ConcurrencyLimitError | BackendUnavailableError>;
	/**
	 * Wait until all listed subagents are settled. Unknown ids are treated as
	 * settled (the tool layer validates ids first). While waiting, settles for
	 * these ids are marked "consumed". Interruption (tool abort) releases the
	 * interest and leaves the subagents running.
	 */
	waitFor(ids: ReadonlyArray<string>, onPending?: (pending: string[]) => void): Effect.Effect<void>;
	/** Cancel running subagents; resolves when they have settled. */
	cancel(ids: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<CancelResult>>;
	send(id: string, text: string): Effect.Effect<void, SendError>;
	get(id: string): Effect.Effect<SubagentSnapshot | undefined>;
	readonly list: Effect.Effect<ReadonlyArray<SubagentSnapshot>>;
	readonly disposeAll: Effect.Effect<void>;
	readonly view: SubagentReadModel;
}

export class SubagentManager extends Context.Service<SubagentManager, SubagentManagerShape>()('subagents/SubagentManager') {}

// --- Implementation --------------------------------------------------------------

const makeManager = Effect.gen(function* () {
	const registry = yield* BackendRegistry;
	// Detached forker for sync contexts (read-model commands, pruning) that
	// preserves the manager's services instead of using the global runtime.
	const runDetached = Effect.runForkWith(yield* Effect.context());

	const entries = new Map<string, Entry>();
	const waitInterest = new Map<string, number>();
	const listeners = new Set<() => void>();
	/** One-shot nextChange waiters, swapped out before invocation so waiters
	 * re-registering during notification are not visited in the same sweep. */
	let changeWaiters: Array<() => void> = [];

	const idListeners = new Map<string, Set<() => void>>();
	const cleanups = new Set<Fiber.Fiber<unknown>>();

	let modelCounter = 0;
	let btwCounter = 0;
	let reserved = 0;
	let disposed = false;
	let onSettled: ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined;

	const notify = (id?: string) => {
		const waiters = changeWaiters;

		changeWaiters = [];

		for (const waiter of waiters) {
			waiter();
		}
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch {
				// A failed status/render listener must not corrupt lifecycle state.
			}
		}

		if (id) {
			for (const listener of idListeners.get(id) ?? []) {
				try {
					listener();
				} catch {
					// Same.
				}
			}
		}
	};

	const nextChange = Effect.callback<void>((resume) => {
		const waiter = () => resume(Effect.void);

		changeWaiters.push(waiter);

		return Effect.sync(() => {
			const index = changeWaiters.indexOf(waiter);

			if (index >= 0) {
				changeWaiters.splice(index, 1);
			}
		});
	});

	const runningCount = () => [...entries.values()].filter((e) => e.snapshot.status === 'running' || e.restarting === true).length;

	const addInterest = (ids: ReadonlyArray<string>) => {
		for (const id of ids) {
			waitInterest.set(id, (waitInterest.get(id) ?? 0) + 1);
		}
	};

	const releaseInterest = (ids: ReadonlyArray<string>) => {
		for (const id of ids) {
			const count = (waitInterest.get(id) ?? 1) - 1;

			if (count <= 0) {
				waitInterest.delete(id);
			} else {
				waitInterest.set(id, count);
			}
		}
	};

	const closeEntryScope = (entry: Entry) => Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);

	const pruneSettled = () => {
		if (entries.size <= MAX_TRACKED) {
			return;
		}

		const candidates = [...entries.values()]
			.filter((e) => e.snapshot.status !== 'running' && !waitInterest.has(e.snapshot.id))
			.sort((a, b) => (a.snapshot.settledAt ?? a.snapshot.createdAt) - (b.snapshot.settledAt ?? b.snapshot.createdAt));

		for (const entry of candidates) {
			if (entries.size <= MAX_TRACKED) {
				break;
			}

			entries.delete(entry.snapshot.id);

			const fiber = runDetached(
				closeEntryScope(entry),
			);

			cleanups.add(fiber);
			fiber.addObserver(() => cleanups.delete(fiber));
		}
	};

	const settle = (entry: Entry, outcome: RunOutcome) => {
		const s = entry.snapshot;

		entry.restarting = false;
		if (s.status !== 'running') {
			return;
		}

		s.settledAt = Date.now();

		switch (outcome._tag) {
			case 'Completed':
				s.status = 'done';
				s.errorText = undefined;
				s.finalText = outcome.finalText.slice(0, FINAL_TEXT_MAX_LENGTH);
				break;

			case 'Failed':
				s.status = 'error';
				s.errorText = bounded(outcome.errorText);
				// Never let a failed run report the previous run's successful output.
				s.finalText = (outcome.partialText ?? '').slice(0, FINAL_TEXT_MAX_LENGTH);
				break;

			case 'Interrupted':
				s.status = 'error';
				s.errorText = 'Run was aborted';
				s.finalText = (outcome.partialText ?? '').slice(0, FINAL_TEXT_MAX_LENGTH);
				break;
		}

		s.liveAssistant = undefined;
		entry.liveToolMap.clear();
		s.liveTools = [];
		s.queued = [];

		const consumed = (waitInterest.get(s.id) ?? 0) > 0;

		notify(s.id);
		try {
			// During teardown, don't queue results into a shutting-down session.
			if (!disposed) {
				onSettled?.(s, consumed);
			}
		} catch {
			// The parent session may be unavailable; settlement stays final.
		}

		pruneSettled();
	};

	const spawn = (backendName: BackendName, task: SpawnTask) =>
		Effect.gen(function* () {
			// Reserve synchronously (before the first yield inside doSpawn) so
			// parallel tool calls cannot race past the global cap.
			yield* Effect.suspend((): Effect.Effect<void, SpawnError | ConcurrencyLimitError> => {
				if (disposed) {
					return new SpawnError({
						message: 'Subagent manager is shutting down.',
					});
				}

				if (runningCount() + reserved >= MAX_RUNNING) {
					return new ConcurrencyLimitError({
						message: `Max ${MAX_RUNNING} subagents can run concurrently. Wait for one to finish before spawning another.`,
					});
				}

				reserved++;

				return Effect.void;
			});

			// Holds the entry scope only while nothing else owns the live child: set
			// the moment the scope exists, cleared once the entry is in the registry.
			// `yield* session.meta` between those points is an interruption point (a
			// tool abort, ESC, or runtime dispose lands there), and without this the
			// backend process would survive for the life of the pi process owned by
			// nobody -- no scope, no registry entry, nothing to close it.
			let unownedScope: Scope.Scope | undefined;

			const doSpawn = Effect.gen(function* () {
				const backend: SubagentBackend | undefined = registry.get(backendName);

				if (!backend) {
					return yield* new BackendUnavailableError({
						message: `Unknown backend "${backendName}".`,
					});
				}

				const available = yield* backend.available;

				if (!available) {
					return yield* new BackendUnavailableError({
						message: `Backend "${backendName}" is not available on this machine (binary/SDK/credentials missing).`,
					});
				}

				const scope = yield* Scope.make();

				unownedScope = scope;

				const session = yield* Scope.provide(backend.spawn(task), scope);

				if (disposed) {
					return yield* new SpawnError({
						message: 'Subagent manager shut down while spawning.',
					});
				}

				const origin = task.origin ?? 'model';
				const id = origin === 'btw' ? `btw-${++btwCounter}` : `sa-${++modelCounter}`;
				const meta = yield* session.meta;
				const liveToolMap = new Map<string, LiveToolState>();

				const snapshot: MutableSubagentSnapshot = {
					id,
					origin,
					backend: backendName,
					title: task.title,
					prompt: task.prompt,
					cwd: task.cwd,
					status: 'running',
					createdAt: Date.now(),
					meta,
					usage: { contextWindow: meta.contextWindow },
					transcript: [],
					liveTools: [],
					queued: [],
					finalText: '',
					turns: 0,
				};

				const entry: Entry = {
					snapshot,
					session,
					scope,
					liveToolMap,
				};

				entry.reducer = new SubagentSnapshotReducer(
					snapshot,
					liveToolMap,
					(outcome) => settle(entry, outcome),
					() => notify(id),
					() => {
						entry.restarting = false;
					},
				);
				entries.set(id, entry);
				// The registry owns the scope from here; disposeAll will close it.
				unownedScope = undefined;

				// Pump: reduce the event stream into the snapshot. Tied to the entry
				// scope, so closing the scope stops it. If the stream ends while the
				// subagent still looks running, the backend died out from under us.
				const pump = Stream.runForEach(session.events, (event) => Effect.sync(() => entry.reducer?.apply(event))).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							if (entry.snapshot.status === 'running') {
								settle(
									entry,
									{
										_tag: 'Failed',
										errorText: 'Backend event stream ended unexpectedly',
									},
								);
							}
						}),
					),
				);

				entry.pump = yield* Scope.provide(Effect.forkScoped(pump), scope);

				notify(id);

				return entry.snapshot as SubagentSnapshot;
			});

			return yield* doSpawn.pipe(
				Effect.onExit((exit) => {
					const orphan = unownedScope;

					unownedScope = undefined;

					return orphan && !Exit.isSuccess(exit) ? Scope.close(orphan, Exit.void) : Effect.void;
				}),
				Effect.ensuring(
					Effect.sync(() => {
						reserved--;
						notify();
					}),
				),
			);
		});

	const waitFor = (ids: ReadonlyArray<string>, onPending?: (pending: string[]) => void) =>
		Effect.suspend(() => {
			const unique = [...new Set(ids)];

			addInterest(unique);

			const loop = Effect.gen(function* () {
				while (true) {
					const pending = unique.filter((id) => entries.get(id)?.snapshot.status === 'running');

					if (pending.length === 0) {
						return;
					}

					onPending?.(pending);
					yield* nextChange;
				}
			});

			return loop.pipe(
				Effect.ensuring(
					Effect.sync(() => {
						releaseInterest(unique);
						pruneSettled();
					}),
				),
			);
		});

	const abortEntry = (entry: Entry) =>
		Effect.gen(function* () {
			if (entry.snapshot.status !== 'running') {
				return;
			}

			const graceful = yield* entry.session.interrupt.pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.result);

			if (Result.isFailure(graceful)) {
				// Settle before closing the scope so the pump's stream-ended
				// fallback ("Backend event stream ended unexpectedly") cannot win
				// the race and report the wrong terminal reason.
				yield* Effect.sync(() => {
					settle(
						entry,
						{ _tag: 'Interrupted' },
					);
					entry.snapshot.errorText = 'Abort deadline exceeded; session was force-disposed';
					notify(entry.snapshot.id);
				});
				// Bound the close like disposeAll does: a stuck backend finalizer
				// must not hang cancel after the run is already settled.
				yield* closeEntryScope(entry).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore);
			}
		});

	const cancel = (ids: ReadonlyArray<string>) =>
		Effect.suspend(() => {
			const unique = [...new Set(ids)];

			const running = unique.map((id) => entries.get(id)).filter((entry): entry is Entry => entry?.snapshot.status === 'running');

			const runningIds = running.map((entry) => entry.snapshot.id);
			// Mark consumed before interrupting so cancellation does not also
			// enqueue duplicate automatic result messages into the parent.
			addInterest(runningIds);

			const work = Effect.gen(function* () {
				yield* Effect.forEach(running, abortEntry, {
					concurrency: 'unbounded',
				});

				while (running.some((entry) => entry.snapshot.status === 'running')) {
					yield* nextChange;
				}
			});

			return work.pipe(
				Effect.ensuring(
					Effect.sync(() => {
						releaseInterest(runningIds);
						pruneSettled();
					}),
				),
				Effect.map(
					(): ReadonlyArray<CancelResult> =>
						unique.map((id) => {
							const snapshot = entries.get(id)?.snapshot;

							return {
								id,
								title: snapshot?.title ?? '?',
								status: snapshot?.status ?? 'error',
								cancelled: runningIds.includes(id),
							};
						}),
				),
			);
		});

	const send = (id: string, text: string) =>
		Effect.suspend((): Effect.Effect<void, SendError> => {
			const entry = entries.get(id);

			if (!entry || disposed) {
				return new SendError({
					message: `Subagent "${id}" is no longer tracked.`,
				});
			}
			// Restarting a settled subagent occupies a running slot again, so it
			// must respect the same cap as spawn. Steering an already-running one
			// does not consume additional capacity.
			if (entry.snapshot.status !== 'running') {
				if (runningCount() + reserved >= MAX_RUNNING) {
					return new SendError({
						message: `Max ${MAX_RUNNING} subagents can run concurrently; restarting "${id}" would exceed that.`,
					});
				}
				// Occupy the slot synchronously: the RunStarted that flips status
				// arrives via the async pump, and two concurrent restarts must not
				// both pass the check in that window. Cleared by RunStarted/settle,
				// or here when the backend rejects the send.
				entry.restarting = true;

				return entry.session.send(text).pipe(
					Effect.onError(() =>
						Effect.sync(() => {
							entry.restarting = false;
						}),
					),
				);
			}

			return entry.session.send(text);
		});

	const disposeAll = Effect.gen(function* () {
		disposed = true;

		const all = [...entries.values()];

		entries.clear();
		yield* Effect.forEach(all, (entry) => closeEntryScope(entry).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore), { concurrency: 'unbounded' });
		// Pruning cleanups are detached; bound them like everything else so a
		// stuck backend finalizer cannot block runtime shutdown indefinitely.
		yield* Effect.forEach([...cleanups], (fiber) => Fiber.await(fiber).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore), { concurrency: 'unbounded' }).pipe(Effect.ignore);
		yield* Effect.sync(() => notify());
	});

	const view: SubagentReadModel = {
		list: () => [...entries.values()].map((entry) => entry.snapshot),
		get: (id) => entries.get(id)?.snapshot,
		size: () => entries.size,
		subscribe: (listener) => {
			listeners.add(listener);

			return () => listeners.delete(listener);
		},
		subscribeTo: (id, listener) => {
			let set = idListeners.get(id);

			if (!set) {
				set = new Set();
				idListeners.set(id, set);
			}

			set.add(listener);

			return () => {
				set.delete(listener);
				if (set.size === 0) {
					idListeners.delete(id);
				}
			};
		},
		requestSend: (id, text) => {
			runDetached(
				send(id, text).pipe(Effect.ignore),
			);
		},
		requestAbort: (id) => {
			const entry = entries.get(id);

			if (!entry) {
				return;
			}
			// UI-initiated aborts are not "consumed": the failed result still
			// flows back to the parent as a follow-up message, matching v1.
			runDetached(
				abortEntry(entry).pipe(Effect.ignore),
			);
		},
		setOnSettled: (hook) => {
			onSettled = hook;
		},
	}; // Safety net: disposing the ManagedRuntime tears everything down even if
	// the extension forgot to call disposeAll explicitly.
	yield* Effect.addFinalizer(() => disposeAll);

	return SubagentManager.of({
		spawn,
		waitFor,
		cancel,
		send,
		get: (id) => Effect.sync(() => entries.get(id)?.snapshot),
		list: Effect.sync(() => [...entries.values()].map((e) => e.snapshot)),
		disposeAll,
		view,
	});
});

export const SubagentManagerLive: Layer.Layer<SubagentManager, never, BackendRegistry> = Layer.effect(SubagentManager, makeManager);
