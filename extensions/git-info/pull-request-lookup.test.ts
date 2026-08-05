import { assert } from '@tests/test-assert.ts';
import { test } from 'vitest';
import { lookupPullRequest, PullRequestQueryTracker, type PullRequestLookupResult } from '@git-info/src/pull-request-lookup.ts';
import type { CommandRunner, CommandResult } from '@git-info/src/process.ts';

const OPEN_PR = {
	number: 42,
	url: 'https://github.com/acme/repo/pull/42',
	state: 'OPEN',
	isDraft: false,
};

function fixture(result: CommandResult): CommandRunner {
	return { run: async () => result };
}

test('lookupPullRequest: reports the open PR when gh succeeds', async () => {
	const lookup = await lookupPullRequest(
		'/repo',
		'feature',
		1_000,
		undefined,
		fixture(
			{
				code: 0,
				stdout: JSON.stringify(OPEN_PR),
				stderr: '',
			},
		),
	);

	assert.deepEqual(lookup, {
		_tag: 'found',
		pullRequest: { number: 42, url: OPEN_PR.url, isDraft: false },
	});
});

test('lookupPullRequest: a confirmed absence of an open PR is not a failure', async () => {
	const lookup = await lookupPullRequest(
		'/repo',
		'feature',
		1_000,
		undefined,
		fixture(
			{
				code: 0,
				stdout: JSON.stringify({ ...OPEN_PR, state: 'MERGED' }),
				stderr: '',
			},
		),
	);

	assert.deepEqual(lookup, { _tag: 'notFound' });
});

test('lookupPullRequest: a nonzero gh exit is a failure, not a confirmed absence', async () => {
	const lookup = await lookupPullRequest(
		'/repo',
		'feature',
		1_000,
		undefined,
		fixture(
			{
				code: 1,
				stdout: '',
				stderr: 'authentication required',
			},
		),
	);

	assert.deepEqual(lookup, { _tag: 'failed' });
});

test('lookupPullRequest: a timed-out command (code -1) is a failure', async () => {
	const lookup = await lookupPullRequest(
		'/repo',
		'feature',
		1_000,
		undefined,
		fixture(
			{
				code: -1,
				stdout: '',
				stderr: '',
			},
		),
	);

	assert.deepEqual(lookup, { _tag: 'failed' });
});

test('PullRequestQueryTracker: reports changed before any confirmed lookup', () => {
	const tracker = new PullRequestQueryTracker();

	assert.equal(tracker.hasChanged('main'), true);
});

test('PullRequestQueryTracker: stops reporting changed after a confirmed lookup', () => {
	const tracker = new PullRequestQueryTracker();

	tracker.recordSuccess('main');
	assert.equal(tracker.hasChanged('main'), false);
});

test('PullRequestQueryTracker: reports changed again for a different branch', () => {
	const tracker = new PullRequestQueryTracker();

	tracker.recordSuccess('main');
	assert.equal(tracker.hasChanged('feature'), true);
});

test('PullRequestQueryTracker: reset makes every branch report changed', () => {
	const tracker = new PullRequestQueryTracker();

	tracker.recordSuccess('main');
	tracker.reset();
	assert.equal(tracker.hasChanged('main'), true);
});

/** Mirrors the real caller contract, including stale refresh handling. */
async function pollOnce(tracker: PullRequestQueryTracker, branch: string, force: boolean, options: { readonly stale?: boolean } = {}) {
	const lookup = await tracker.queryIfNeeded('/repo', branch, 1_000, force);

	if (!options.stale && lookup !== null && lookup._tag !== 'failed') {
		tracker.recordSuccess(branch);
	}

	return lookup;
}

test('queryIfNeeded: a transient gh failure retries on a later call instead of sticking', async () => {
	let calls = 0;

	const responses: CommandResult[] = [
		{ code: 1, stdout: '', stderr: 'timed out' },
		{ code: 0, stdout: JSON.stringify(OPEN_PR), stderr: '' },
	];

	const runner: CommandRunner = {
		run: async () => {
			const response = responses[calls];

			if (!response) {
				throw new Error('unexpected command count');
			}

			calls += 1;

			return response;
		},
	};

	const tracker = new PullRequestQueryTracker(runner);

	const first = await pollOnce(tracker, 'feature', false);

	assert.deepEqual(first, { _tag: 'failed' });
	assert.equal(tracker.hasChanged('feature'), true);

	const second = await pollOnce(tracker, 'feature', false);

	assert.deepEqual(second satisfies PullRequestLookupResult | null, {
		_tag: 'found',
		pullRequest: { number: 42, url: OPEN_PR.url, isDraft: false },
	});
	assert.equal(tracker.hasChanged('feature'), false);
	assert.equal(calls, 2);
});

test('queryIfNeeded: a confirmed no-PR result does not retry on every later poll', async () => {
	let calls = 0;

	const tracker = new PullRequestQueryTracker({
		run: async () => {
			calls += 1;

			return {
				code: 0,
				stdout: JSON.stringify({ ...OPEN_PR, state: 'CLOSED' }),
				stderr: '',
			};
		},
	});

	const first = await pollOnce(tracker, 'feature', false);

	assert.deepEqual(first, { _tag: 'notFound' });

	const second = await pollOnce(tracker, 'feature', false);

	assert.equal(second, null);
	assert.equal(calls, 1);
});

test('queryIfNeeded: a branch change re-queries even after a confirmed result', async () => {
	let calls = 0;

	const tracker = new PullRequestQueryTracker({
		run: async () => {
			calls += 1;

			return { code: 0, stdout: JSON.stringify(OPEN_PR), stderr: '' };
		},
	});

	await pollOnce(tracker, 'main', false);

	assert.equal(calls, 1);

	await pollOnce(tracker, 'feature', false);

	assert.equal(calls, 2);
	assert.equal(tracker.hasChanged('feature'), false);
	assert.equal(tracker.hasChanged('main'), true);
});

test('queryIfNeeded: an explicit /pr force re-queries an already-confirmed branch', async () => {
	let calls = 0;

	const tracker = new PullRequestQueryTracker({
		run: async () => {
			calls += 1;

			return { code: 0, stdout: JSON.stringify(OPEN_PR), stderr: '' };
		},
	});

	tracker.recordSuccess('main');

	const forced = await pollOnce(tracker, 'main', true);

	assert.deepEqual(forced, {
		_tag: 'found',
		pullRequest: { number: 42, url: OPEN_PR.url, isDraft: false },
	});
	assert.equal(calls, 1);
});

test("queryIfNeeded: a superseded (stale) refresh's completed lookup does not confirm the branch", async () => {
	const tracker = new PullRequestQueryTracker({
		run: async () => ({ code: 0, stdout: JSON.stringify(OPEN_PR), stderr: '' }),
	});

	const lookup = await pollOnce(
		tracker,
		'main',
		false,
		{ stale: true },
	);

	assert.deepEqual(lookup, {
		_tag: 'found',
		pullRequest: { number: 42, url: OPEN_PR.url, isDraft: false },
	});
	assert.equal(tracker.hasChanged('main'), true);
});
