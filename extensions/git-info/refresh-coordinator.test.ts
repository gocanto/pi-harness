import { assert } from '@tests/test-assert.ts';
import { test } from 'vitest';
import { makeRefreshCoordinator } from '@git-info/src/refresh-coordinator.ts';

test('an explicit refresh waits for an active background refresh', async () => {
	const coordinator = makeRefreshCoordinator();

	let state = 0;
	let resolveStarted: (() => void) | undefined;
	let resolveRelease: (() => void) | undefined;

	const started = new Promise<void>((resolve) => {
		resolveStarted = resolve;
	});
	const release = new Promise<void>((resolve) => {
		resolveRelease = resolve;
	});

	const background = coordinator.run(async () => {
		resolveStarted?.();

		await release;

		state = 1;
	});

	await started;

	await coordinator.runIfIdle(async () => {
		state = 99;
	});

	const forced = coordinator.run(async () => {
		state += 1;

		return state;
	});

	resolveRelease?.();

	await background;

	const result = await forced;

	assert.equal(result, 2);
	assert.equal(state, 2);
});
