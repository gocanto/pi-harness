import { assert } from '../test-assert.ts';
import { test } from 'vitest';
import { DEFAULT_WORKFLOW_DEADLINE_MS, runWorkflowSandbox } from './sandbox.ts';

function run(source: string, overrides: Partial<Parameters<typeof runWorkflowSandbox>[0]> = {}) {
	const abort = new AbortController();

	return runWorkflowSandbox(
		{
			source,
			args: undefined,
			cwd: process.cwd(),
			signal: abort.signal,
			onAgent: async (prompt) => ({ ok: true, output: `reply:${prompt}` }),
			onPhase: () => {},
			...overrides,
		},
	);
}

test('sandbox exposes only workflow capabilities and validates results', async () => {
	const phases: string[] = [];

	const result = await run(
		`
      phase("Gather");
      const replies = await parallel([
        () => agent("one"),
        () => agent("two"),
      ], { concurrency: 99 });
      return {
        replies: replies.map((reply) => reply.output),
        processType: typeof process,
        requireType: typeof require,
        fetchType: typeof fetch,
      };
    `,
		{ onPhase: (title) => phases.push(title) },
	);

	assert.deepEqual(result, {
		replies: ['reply:one', 'reply:two'],
		processType: 'undefined',
		requireType: 'undefined',
		fetchType: 'undefined',
	});
	assert.deepEqual(phases, ['Gather']);
});

test('sandbox result serialization handles cycles and bigint', async () => {
	const result = await run(`
    const value = { count: 7n };
    value.self = value;
    return value;
  `);

	assert.deepEqual(result, { count: '7n', self: '[circular]' });
});

test('sandbox rejects unawaited agent calls', async () => {
	let calls = 0;

	await assert.rejects(
		run(`agent("orphan"); return "done";`, {
			onAgent: async () => {
				calls++;

				return { ok: true, output: 'unexpected' };
			},
		}),
		/unawaited agent/,
	);

	assert.equal(calls, 0);
});

test('sandbox source cannot escape the host accounting wrapper', async () => {
	let calls = 0;

	await assert.rejects(
		run(`}), agent("orphan"), Promise.resolve("bypass"); (async function () {`, {
			onAgent: async () => {
				calls++;

				return { ok: true, output: 'unexpected' };
			},
		}),
		/unawaited agent/,
	);

	assert.equal(calls, 0);
});

test('sandbox VM still rejects non-yielding synchronous code', async () => {
	await assert.rejects(run(`while (true) {}`), /timed out/);
});

test('workflow agent invocations have no per-request wall timer', async () => {
	let signalAborted = false;

	const result = await run(
		`return (await agent("delayed")).output;`,
		{
			onAgent: async (_prompt, _options, signal) => {
				await new Promise((resolve) => setTimeout(resolve, 30));

				signalAborted = signal.aborted;

				return { ok: true, output: 'completed' };
			},
		},
	);

	assert.equal(result, 'completed');
	assert.equal(signalAborted, false);
});

test('workflow cancellation aborts a pending agent request', async () => {
	const controller = new AbortController();

	let startedResolve: (() => void) | undefined;

	const started = new Promise<void>((resolve) => {
		startedResolve = resolve;
	});

	let requestAborted = false;

	const pending = run(
		`return await agent("pending");`,
		{
			signal: controller.signal,
			onAgent: async (_prompt, _options, signal) => {
				startedResolve?.();

				await new Promise<void>((resolve) => {
					signal.addEventListener(
						'abort',
						() => {
							requestAborted = true;
							resolve();
						},
						{ once: true },
					);
				});

				return { ok: false, output: '', error: 'Agent was aborted' };
			},
		},
	);

	await started;

	controller.abort(new Error('cancel fixture'));

	await assert.rejects(pending, /Workflow was aborted/);

	assert.equal(requestAborted, true);
});

test('the documented default workflow deadline is 30 minutes', () => {
	assert.equal(DEFAULT_WORKFLOW_DEADLINE_MS, 30 * 60 * 1000);
});

test('a never-settling workflow rejects once its deadline elapses', async () => {
	await assert.rejects(
		run(`await new Promise(() => {}); return "unreachable";`, {
			deadlineMs: 150,
		}),
		/exceeded its 150ms execution deadline/,
	);
});

test('the deadline aborts a pending agent request and tears down the sandbox', async () => {
	let startedResolve: (() => void) | undefined;

	const started = new Promise<void>((resolve) => {
		startedResolve = resolve;
	});

	let requestAborted = false;

	const pending = run(
		`return await agent("pending");`,
		{
			deadlineMs: 150,
			onAgent: async (_prompt, _options, signal) => {
				startedResolve?.();

				await new Promise<void>((resolve) => {
					signal.addEventListener(
						'abort',
						() => {
							requestAborted = true;
							resolve();
						},
						{ once: true },
					);
				});

				return { ok: false, output: '', error: 'Agent was aborted' };
			},
		},
	);

	await started;

	await assert.rejects(pending, /exceeded its 150ms execution deadline/);

	assert.equal(requestAborted, true);
});

test('a workflow that finishes well before its deadline still resolves', async () => {
	const result = await run(
		`return "done";`,
		{ deadlineMs: 5_000 },
	);

	assert.equal(result, 'done');
});

test('an earlier abort settles the workflow before a later deadline can fire', async () => {
	const controller = new AbortController();

	const pending = run(
		`await new Promise(() => {}); return "unreachable";`,
		{
			signal: controller.signal,
			deadlineMs: 200,
		},
	);

	setTimeout(() => controller.abort(new Error('cancel before deadline')), 20);

	await assert.rejects(pending, /Workflow was aborted/);
});

test('a protocol failure settles once even with a deadline pending', async () => {
	let calls = 0;

	await assert.rejects(
		run(`agent("orphan"); return "done";`, {
			deadlineMs: 5_000,
			onAgent: async () => {
				calls++;

				return { ok: true, output: 'unexpected' };
			},
		}),
		/unawaited agent/,
	);

	assert.equal(calls, 0);
});
