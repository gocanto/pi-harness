/**
 * `abortEntry` only force-settles when the backend's `interrupt` fails. A
 * backend that acknowledges the interrupt and then never emits RunSettled is
 * therefore invisible to it -- and codex's interrupt does exactly that, arming
 * a timer and resolving immediately. Without a deadline on the wait loop,
 * subagent_cancel never returns.
 */

import { assert } from '@tests/test-assert.ts';
import { test } from 'vitest';
import { Effect, Layer, ManagedRuntime, Stream } from 'effect';
import { BackendRegistry, type SubagentBackend, type SubagentSession } from '@subagents/src/backend.ts';
import type { BackendName, ParentContext, SpawnTask } from '@subagents/src/domain.ts';

import { SubagentManager, SubagentManagerLive } from '@subagents/src/manager.ts';

const parent: ParentContext = { parentCwd: process.cwd(), projectTrusted: false };
const task: SpawnTask = { prompt: 'p', title: 'test', cwd: process.cwd(), parent };

const silentBackend: SubagentBackend = {
	name: 'claude' as BackendName,
	capabilities: { steering: true, modelSelection: true, reasoningEffort: true },
	available: Effect.succeed(true),
	spawn: () =>
		Effect.sync(() => {
			const session: SubagentSession = {
				meta: Effect.succeed({ contextWindow: 1000 } as never),
				// Never ends and never carries a RunSettled.
				events: Stream.never,
				send: () => Effect.void,
				// Resolves, so abortEntry considers the interrupt successful.
				interrupt: Effect.void,
			};

			return session;
		}),
};

test('cancel returns even when the backend never reports the run as settled', async () => {
	const registry = Layer.sync(BackendRegistry, () => new Map<BackendName, SubagentBackend>([[silentBackend.name, silentBackend]]));
	const runtime = ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(registry)));

	const results = await runtime.runPromise(
		Effect.gen(function* () {
			const manager = yield* SubagentManager;
			const snapshot = yield* manager.spawn('claude' as BackendName, task);

			return yield* manager.cancel([snapshot.id]);
		}),
	);

	assert.equal(results.length, 1);
	assert.equal(results[0]?.cancelled, true);
	// Force-settled rather than left running.
	assert.notEqual(results[0]?.status, 'running', 'the subagent was left running after cancel returned');

	await runtime.dispose();
});
