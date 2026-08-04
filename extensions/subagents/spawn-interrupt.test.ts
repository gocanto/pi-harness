/**
 * The window between `backend.spawn()` and the manager registering the entry
 * contains an interruption point (`yield* session.meta`). If a tool abort or
 * runtime dispose lands there, nothing owns the live child: the entry scope is
 * still a local and the registry has never seen it. These tests pin the
 * contract that the scope is closed on that path.
 */

import { assert } from '@tests/test-assert.ts';
import { test } from 'vitest';
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Stream } from 'effect';
import { BackendRegistry, type SubagentBackend, type SubagentSession } from '@subagents/src/backend.ts';
import type { BackendName, ParentContext, SpawnTask } from '@subagents/src/domain.ts';

import { SubagentManager, SubagentManagerLive } from '@subagents/src/manager.ts';

const parent: ParentContext = { parentCwd: process.cwd(), projectTrusted: false };
const task: SpawnTask = { prompt: 'p', title: 'test', cwd: process.cwd(), parent };

/**
 * A backend whose session is acquired with a release finalizer, and whose
 * `meta` blocks until the test releases it. `released` therefore reports
 * whether the "child process" was cleaned up.
 */
function makeBlockingBackend() {
	const state = {
		released: false,
		spawned: undefined as Deferred.Deferred<void> | undefined,
	};

	const backend: SubagentBackend = {
		name: 'claude' as BackendName,
		capabilities: { steering: true, modelSelection: true, reasoningEffort: true },
		available: Effect.succeed(true),
		spawn: () =>
			Effect.gen(function* () {
				const spawned = yield* Deferred.make<void>();

				state.spawned = spawned;

				// Models the live child: the finalizer is what kills it.
				yield* Effect.acquireRelease(
					Effect.sync(() => undefined),
					() =>
						Effect.sync(() => {
							state.released = true;
						}),
				);

				const session: SubagentSession = {
					// Blocks forever: the manager parks here, still holding an
					// unregistered scope, which is exactly the vulnerable window.
					meta: Effect.gen(function* () {
						yield* Deferred.succeed(spawned, undefined);
						yield* Effect.never;

						return { contextWindow: 1000 } as never;
					}),
					events: Stream.never,
					send: () => Effect.void,
					interrupt: Effect.void,
				};

				return session;
			}),
	};

	return { backend, state };
}

test('interrupting a spawn before the entry is registered closes the backend scope', async () => {
	const { backend, state } = makeBlockingBackend();
	const registry = Layer.sync(BackendRegistry, () => new Map<BackendName, SubagentBackend>([[backend.name, backend]]));
	const runtime = ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(registry)));

	const spawning = runtime.runFork(
		Effect.gen(function* () {
			const manager = yield* SubagentManager;

			return yield* manager.spawn('claude' as BackendName, task);
		}),
	);

	// Wait until the backend has spawned and the manager is parked in `meta`.
	await runtime.runPromise(
		Effect.gen(function* () {
			while (state.spawned === undefined) {
				yield* Effect.sleep('5 millis');
			}

			yield* Deferred.await(state.spawned);
		}),
	);

	assert.equal(state.released, false, 'precondition: the child is still live');

	await Effect.runPromise(Fiber.interrupt(spawning));

	assert.equal(state.released, true, 'the unregistered backend scope was leaked on interrupt');

	await runtime.dispose();
});

test('a manager disposed mid-spawn does not leak the backend scope', async () => {
	const { backend, state } = makeBlockingBackend();
	const registry = Layer.sync(BackendRegistry, () => new Map<BackendName, SubagentBackend>([[backend.name, backend]]));
	const runtime = ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(registry)));

	const spawning = runtime.runFork(
		Effect.gen(function* () {
			const manager = yield* SubagentManager;

			return yield* manager.spawn('claude' as BackendName, task);
		}),
	);

	await runtime.runPromise(
		Effect.gen(function* () {
			while (state.spawned === undefined) {
				yield* Effect.sleep('5 millis');
			}

			yield* Deferred.await(state.spawned);
		}),
	);

	await Effect.runPromise(Fiber.interrupt(spawning));

	await runtime.dispose();

	assert.equal(state.released, true, 'the backend scope survived manager disposal');
});
