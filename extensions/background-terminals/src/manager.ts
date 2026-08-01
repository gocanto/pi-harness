/**
 * TerminalManager — owns the registry of running/settled background
 * terminals.
 *
 * Each terminal is a raw `node:child_process` spawn (own process group on
 * POSIX, stdin ignored) whose stdout/stderr 'data' callbacks fold into two
 * bounded OutputBuffers. Closing a terminal's scope kills the whole process
 * tree (SIGTERM → SIGKILL escalation).
 *
 * The manager also exposes a synchronous `TerminalReadModel` so the
 * imperative TUI components (which render synchronously) can read snapshots
 * and issue fire-and-forget kills without touching the Effect runtime.
 */

import { spawn } from 'node:child_process';
import type * as fs from 'node:fs';
import { OutputBuffer, OutputSpillManager, RETAINED_PER_STREAM } from './terminal-output/index.ts';
import { ProcessTreeController } from './process-tree/index.ts';
import { TerminalEntry, TerminalRegistry, type MutableTerminalSnapshot } from './terminal-manager/index.ts';

import { Context, Deferred, Effect, Exit, FiberSet, Layer, Scope } from 'effect';

import { ConcurrencyLimitError, formatExit, SpawnError, UnknownTerminalError, type TerminalSnapshot, type TerminalStatus } from './domain.ts';

export const MAX_RUNNING = 8;

export const MAX_TRACKED = 32;

/** In-memory retained cap per stream. */
export { MAX_SPILL_BYTES_PER_STREAM, RETAINED_PER_STREAM } from './terminal-output/index.ts';

const STOP_TIMEOUT_MS = 5_000;
/** SIGTERM is normally enough; the second deadline covers a wedged process. */
/** After termination, how long to wait for the natural close→flush→settle
 * path before force-settling (a grandchild can hold the stdio pipes open). */
const SETTLE_GRACE_MS = 1_000;
const ERROR_TEXT_MAX_LENGTH = 4_096;

function bounded(text: string) {
	return text.slice(0, ERROR_TEXT_MAX_LENGTH);
}

function boundedError(error: unknown) {
	return bounded(error instanceof Error ? error.message : String(error));
}

// --- Internal state -----------------------------------------------------------

export interface StartOptions {
	readonly command: string;
	readonly title: string;
	readonly cwd: string;
}

export interface KillResult {
	readonly id: string;
	readonly title: string;
	readonly status: TerminalStatus;
	/** True when the entry was still running when this kill began. */
	readonly wasRunning: boolean;
	/** True when this call initiated the termination AND the entry settled as
	 * killed (a natural exit that won the race reports killed: false). */
	readonly killed: boolean;
	/** Final exit rendering ("exit 0", "SIGTERM", ...) captured at settle time,
	 * so reports stay accurate even if the entry is pruned afterwards. */
	readonly exit: string;
}

// --- Read model ----------------------------------------------------------------

/** Synchronous bridge for the TUI. Snapshots are live objects; do not mutate. */
export interface TerminalReadModel {
	list(): ReadonlyArray<TerminalSnapshot>;
	get(id: string): TerminalSnapshot | undefined;
	size(): number;
	/** Any-change notification (widget, /ps list). */
	subscribe(listener: () => void): () => void;
	/** Per-terminal notification (/ps detail view). */
	subscribeTo(id: string, listener: () => void): () => void;
	/** Fire-and-forget kill (dashboard/detail `x`). Not marked consumed: the
	 * settle still flows back to the model as a follow-up message. */
	requestKill(id: string): void;
	/**
	 * Register the settle hook. `consumed` is true when an active bg_kill is
	 * collecting the result (so it must not also be delivered as a follow-up).
	 */
	setOnSettled(hook: ((snap: TerminalSnapshot, consumed: boolean) => void) | undefined): void;
}

// --- Service --------------------------------------------------------------------

export interface TerminalManagerShape {
	start(options: StartOptions): Effect.Effect<TerminalSnapshot, SpawnError | ConcurrencyLimitError>;
	status(id: string): Effect.Effect<TerminalSnapshot, UnknownTerminalError>;
	/** Kill running terminals; resolves only after they have settled. */
	kill(ids: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<KillResult>>;
	readonly list: Effect.Effect<ReadonlyArray<TerminalSnapshot>>;
	readonly disposeAll: Effect.Effect<void>;
	readonly view: TerminalReadModel;
}

export class TerminalManager extends Context.Service<TerminalManager, TerminalManagerShape>()('background-terminals/TerminalManager') {}

// --- Implementation --------------------------------------------------------------

const makeManager = Effect.gen(function* () {
	const processTree = new ProcessTreeController();
	const cleanupFibers = yield* FiberSet.make();
	const runCleanup = yield* FiberSet.runtime(cleanupFibers)();
	const closeEntryScope = (entry: TerminalEntry) => Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
	const registry = new TerminalRegistry(closeEntryScope);
	const entries = registry;
	const outputSpills = new OutputSpillManager();

	let counter = 0;
	let reserved = 0;
	let disposed = false;

	const notify = (id?: string) => registry.notify(id);
	const runningCount = () => registry.runningCount();
	const addKillInterest = (ids: ReadonlyArray<string>) => registry.addInterest(ids);
	const releaseKillInterest = (ids: ReadonlyArray<string>) => registry.releaseInterest(ids);
	const pruneSettled = () => registry.prune(MAX_TRACKED, runCleanup);

	const settle = (entry: TerminalEntry) => {
		const s = entry.snapshot;

		if (s.status !== 'running') {
			return;
		}

		s.settledAt = Date.now();
		s.status = entry.killSignaled ? 'killed' : entry.processErrored ? 'failed' : s.exitCode === 0 ? 'done' : 'failed';
		registry.recordSettled(s, formatExit(s));
		// Completing the Deferred can immediately resume kill waiters, whose
		// ensuring blocks release interest. Snapshot consumption first so the
		// settle hook observes the interest that existed when settlement won.
		const consumed = registry.hasInterest(s.id);

		Deferred.doneUnsafe(entry.settled, Effect.void);
		notify(s.id);
		try {
			// During teardown, don't queue results into a shutting-down session.
			if (!disposed) {
				registry.deliverSettled(s, consumed);
			}
		} catch {
			// The parent session may be unavailable; settlement stays final.
		}

		pruneSettled();
	};

	const settleAfterFlush = (entry: TerminalEntry) => {
		if (entry.settling || entry.snapshot.status !== 'running') {
			return;
		}

		entry.settling = true;
		runCleanup(
			outputSpills.flush(entry).pipe(Effect.andThen(Effect.sync(() => settle(entry)))),
		);
	};

	const scheduleExitCleanup = (entry: TerminalEntry) => {
		if (entry.exitCleanupStarted) {
			return;
		}

		entry.exitCleanupStarted = true;
		runCleanup(
			Effect.sleep(SETTLE_GRACE_MS).pipe(
				Effect.andThen(
					Effect.suspend(() => (entry.snapshot.status === 'running' && !entry.stdioClosed ? closeEntryScope(entry).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore) : Effect.void)),
				),
			),
		);
	};

	const start = (options: StartOptions) =>
		Effect.gen(function* () {
			// Reserve synchronously (before the first yield inside doStart) so
			// parallel tool calls cannot race past the cap.
			yield* Effect.suspend((): Effect.Effect<void, SpawnError | ConcurrencyLimitError> => {
				if (disposed) {
					return new SpawnError({
						message: 'Background terminal manager is shutting down.',
					});
				}

				if (runningCount() + reserved >= MAX_RUNNING) {
					return new ConcurrencyLimitError({
						message: `Max ${MAX_RUNNING} background terminals can run concurrently. Stop one with bg_kill before starting another.`,
					});
				}

				reserved++;

				return Effect.void;
			});

			const doStart = Effect.gen(function* () {
				const { shell, args } = processTree.shellInvocation(options.command);

				const child = yield* Effect.try({
					try: () =>
						spawn(shell, args, {
							cwd: options.cwd,
							env: process.env,
							// stdin IGNORED: there is no input surface, ever. A process
							// that reads stdin sees EOF immediately.
							stdio: ['ignore', 'pipe', 'pipe'],
							// Own process group on POSIX → group kill takes the whole tree.
							detached: process.platform !== 'win32',
						}),
					catch: (error) => new SpawnError({ message: boundedError(error) }),
				});

				const id = `bt-${++counter}`;
				const entryRef = () => entries.get(id);
				const stdoutSpill = outputSpills.create(entryRef, id, 'stdout', () => child.stdout?.resume());
				const stderrSpill = outputSpills.create(entryRef, id, 'stderr', () => child.stderr?.resume());
				const stdoutBuf = new OutputBuffer(RETAINED_PER_STREAM, stdoutSpill?.write);
				const stderrBuf = new OutputBuffer(RETAINED_PER_STREAM, stderrSpill?.write);

				stdoutBuf.spillPath = stdoutSpill?.spillPath;
				stderrBuf.spillPath = stderrSpill?.spillPath;

				const snapshot: MutableTerminalSnapshot = {
					id,
					command: options.command,
					title: options.title,
					cwd: options.cwd,
					pid: child.pid,
					status: 'running',
					createdAt: Date.now(),
					get stdout() {
						return stdoutBuf.view();
					},
					get stderr() {
						return stderrBuf.view();
					},
				};

				const scope = yield* Scope.make();
				const settled = yield* Deferred.make<void>();

				const entry = new TerminalEntry(
					snapshot,
					child,
					scope,
					stdoutBuf,
					stderrBuf,
					[stdoutSpill?.file, stderrSpill?.file].filter((file): file is fs.WriteStream => file !== undefined),
					settled,
				);

				// Plain-callback stream plumbing (the codex-backend precedent):
				// setEncoding's internal StringDecoder is multibyte-safe across
				// chunk boundaries.
				child.stdout?.setEncoding('utf8');
				child.stdout?.on('data', (chunk: string) => {
					if (!stdoutBuf.push(chunk)) {
						child.stdout?.pause();
					}

					notify(id);
				});
				child.stderr?.setEncoding('utf8');
				child.stderr?.on('data', (chunk: string) => {
					if (!stderrBuf.push(chunk)) {
						child.stderr?.pause();
					}

					notify(id);
				});
				// Spawn failures (ENOENT etc.) arrive via 'error', not a throw. Node
				// still emits 'close' afterwards (with a bogus errno as code), so
				// record the failure here and let the close path do the one settle.
				child.once('error', (error) => {
					entry.processErrored = true;
					snapshot.errorText ??= boundedError(error);
					entry.exited = true;
					settleAfterFlush(entry);
				});
				// Record code/signal on 'exit'; settle on 'close' so the completion
				// notification always carries the final flushed output.
				child.once('exit', (code, signal) => {
					entry.exited = true;
					snapshot.exitCode = code ?? undefined;
					snapshot.signal = signal ?? undefined;
					// A descendant can keep the pipes open after the shell exits. Give
					// close a short natural grace, then close the scope to terminate
					// the surviving process group and force a bounded settlement.
					scheduleExitCleanup(entry);
				});
				child.once('close', (code, signal) => {
					entry.exited = true;
					entry.stdioClosed = true;
					// Only trust close's code/signal when 'exit' never fired (a spawn
					// 'error' close reports the errno, e.g. -2, as its code).
					if (!entry.processErrored) {
						snapshot.exitCode ??= code ?? undefined;
						snapshot.signal ??= signal ?? undefined;
					}

					settleAfterFlush(entry);
				});

				// One teardown path: kill(), requestKill, pruning, disposeAll, and
				// runtime.dispose() all converge on closing this scope.
				yield* Scope.provide(
					Effect.addFinalizer(() =>
						Effect.gen(function* () {
							// Only claim "killed" when we are actually about to signal a
							// live process; a natural exit that already happened (still
							// waiting on 'close') keeps its truthful done/failed status.
							yield* processTree.terminate(
								child,
								() => entry.stdioClosed,
								() => {
									entry.killSignaled ||= !entry.exited && entry.snapshot.status === 'running';
								},
							);
							// Give the natural close→flush→settle path a bounded grace,
							// then force the settle: a grandchild holding the pipe open
							// (detached into a new group) must not leave the entry
							// "running" forever.
							if (entry.snapshot.status === 'running') {
								yield* Deferred.await(entry.settled).pipe(Effect.timeout(SETTLE_GRACE_MS), Effect.ignore);
							}

							if (entry.snapshot.status === 'running' && !entry.settling) {
								// Force the settle ourselves. When `settling` is set, the
								// close path's flush→settle is already in flight — settling here
								// first would cite a spill file that is still being flushed.
								if (!entry.stdioClosed) {
									entry.snapshot.errorText ??= 'stdio did not close after termination; output may be incomplete';
								}

								entry.settling = true;
								yield* outputSpills.flush(entry);
								settle(entry);
							}
						}),
					),
					scope,
				);

				// disposeAll may have swept the entries map while we were setting up;
				// an entry added after the sweep would never be torn down. Close our
				// own scope (kills the child) and fail instead (subagents precedent).
				if (disposed) {
					yield* closeEntryScope(entry);

					return yield* new SpawnError({
						message: 'Background terminal manager shut down while starting.',
					});
				}

				entries.set(id, entry);
				notify(id);

				return snapshot as TerminalSnapshot;
			});

			// Uninterruptible: between spawn() and entries.set there must be no
			// window where an interrupt (tool abort, runtime dispose) leaves a
			// live child that no scope/registry knows about. All steps are sync.
			return yield* doStart.pipe(
				Effect.uninterruptible,
				Effect.ensuring(
					Effect.sync(() => {
						reserved--;
						notify();
					}),
				),
			);
		});

	const status = (id: string) =>
		Effect.suspend((): Effect.Effect<TerminalSnapshot, UnknownTerminalError> => {
			const entry = entries.get(id);

			if (!entry) {
				const known = [...entries.keys()];

				return new UnknownTerminalError({
					message: `Unknown terminal id "${id}". Known: ${known.join(', ') || 'none'}.`,
				});
			}

			return Effect.succeed(entry.snapshot as TerminalSnapshot);
		});

	const killEntry = (entry: TerminalEntry) =>
		Effect.sync(() => {
			if (entry.snapshot.status !== 'running') {
				return;
			}

			runCleanup(
				closeEntryScope(entry).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore),
			);
		});

	const kill = (ids: ReadonlyArray<string>) =>
		Effect.suspend(() => {
			const unique = [...new Set(ids)];

			const byId = new Map(
				unique
					.map((id) => entries.get(id))
					.filter((entry): entry is TerminalEntry => entry !== undefined)
					.map((entry) => [entry.snapshot.id, entry]),
			);

			const running = [...byId.values()].filter((entry) => entry.snapshot.status === 'running');
			const runningIds = running.map((entry) => entry.snapshot.id);
			// Mark consumed before signaling so this kill's settlements are not
			// ALSO queued as automatic follow-up messages to the model.
			addKillInterest(runningIds);

			const work = Effect.gen(function* () {
				yield* Effect.forEach(running, killEntry, {
					concurrency: 'unbounded',
				});
				// Every caller waits on the entries that were running when its kill
				// began. Deferred completion cannot be missed and supports concurrent
				// overlapping/multi-id kill calls.
				yield* Effect.forEach(running, (entry) => Deferred.await(entry.settled), { concurrency: 'unbounded', discard: true });
				// Capture the report BEFORE the ensuring below releases interest and
				// prunes — a just-settled entry must not vanish out from under it.
				return unique.map((id): KillResult => {
					const snapshot = byId.get(id)?.snapshot;
					const history = registry.history(id);
					const status = snapshot?.status ?? history?.status ?? 'killed';
					const wasRunning = runningIds.includes(id);

					return {
						id,
						title: snapshot?.title ?? history?.title ?? '?',
						status,
						wasRunning,
						// A natural exit can win the race with our SIGTERM; report what
						// actually happened rather than claiming the kill did it.
						killed: wasRunning && status === 'killed',
						exit: snapshot ? formatExit(snapshot) : (history?.exit ?? 'unknown'),
					};
				});
			});

			return work.pipe(
				Effect.ensuring(
					Effect.sync(() => {
						releaseKillInterest(runningIds);
						pruneSettled();
					}),
				),
			);
		});

	const disposeAll = Effect.gen(function* () {
		disposed = true;

		const all = [...entries.values()];

		entries.clear();
		yield* Effect.forEach(all, (entry) => closeEntryScope(entry).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore), { concurrency: 'unbounded' });
		// Detached kill/prune/flush work is scoped to the manager. Wait for it
		// within the shutdown bound; the FiberSet finalizer interrupts anything
		// still live when the manager scope closes, so cleanup cannot leak.
		yield* FiberSet.awaitEmpty(cleanupFibers).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore);
		yield* outputSpills.dispose();
		yield* Effect.sync(() => notify());
	});

	const view = registry.readModel();

	registry.setRequestKillHandler((entry) => {
		// UI-initiated kills are not consumed: the result flows back as a follow-up.
		runCleanup(
			killEntry(entry).pipe(Effect.ignore),
		);
	});

	// Safety net: disposing the ManagedRuntime tears everything down even if
	// the extension forgot to call disposeAll explicitly.
	yield* Effect.addFinalizer(() => disposeAll);

	return TerminalManager.of({
		start,
		status,
		kill,
		list: Effect.sync(() => [...entries.values()].map((e) => e.snapshot)),
		disposeAll,
		view,
	});
});

export const TerminalManagerLive: Layer.Layer<TerminalManager> = Layer.effect(TerminalManager, makeManager);
