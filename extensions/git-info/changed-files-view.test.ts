import { assert } from '../../tests/test-assert.ts';
import { test } from 'vitest';
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from 'effect';
import { CommandRunner, type CommandResult } from './src/process.ts';

import { loadChangedFiles, loadFileDiff, MAX_DIFF_LINES, sanitizeTerminalText } from './src/changed-files-view.ts';

test('repository text cannot inject terminal control sequences', () => {
	const input = 'before]52;c;Y2xpcGJvYXJkafter[31mred[0m';

	assert.equal(sanitizeTerminalText(input), 'beforeafterred');
});

const OK: CommandResult = { code: 0, stdout: '', stderr: '' };

// Builds one `git status --porcelain=v1 -z` record: "<XY> <path>".
function statusRecord(xy: string, path: string) {
	return `${xy} ${path}`;
}

// Builds a rename/copy pair of records: "<XY> <newPath>\0<oldPath>".
function renameRecord(xy: string, newPath: string, oldPath: string) {
	return `${statusRecord(xy, newPath)}\0${oldPath}`;
}

interface Fixture {
	diffFor?: (path: string) => CommandResult;
	hasHead?: boolean;
	root?: string;
	statFor?: (path: string) => CommandResult;
	statusResult?: CommandResult;
	toplevelResult?: CommandResult;
}

function makeFixture(options: Fixture = {}) {
	const { diffFor, hasHead = true, root = '/repo', statFor, statusResult, toplevelResult } = options;
	const calls: string[][] = [];

	const layer = Layer.succeed(
		CommandRunner,
		CommandRunner.of({
			run: (_command, args) =>
				Effect.sync(() => {
					calls.push(args);

					if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) {
						return toplevelResult ?? { code: 0, stdout: `${root}\n`, stderr: '' };
					}

					if (args[0] === 'rev-parse' && args.includes('--verify')) {
						return hasHead
							? { code: 0, stdout: 'abc123\n', stderr: '' }
							: {
									code: 128,
									stdout: '',
									stderr: "fatal: ambiguous argument 'HEAD'\n",
								};
					}

					if (args[0] === 'status') {
						return statusResult ?? OK;
					}

					if (args[0] === 'diff' && args.includes('--numstat')) {
						const path = args[args.length - 1]!;

						return (
							statFor?.(path) ?? {
								code: 0,
								stdout: `0\t0\t${path}\n`,
								stderr: '',
							}
						);
					}

					if (args[0] === 'diff' && args.includes('--unified=3')) {
						const path = args[args.length - 1]!;

						return diffFor?.(path) ?? OK;
					}

					throw new Error(`unexpected command: git ${args.join(' ')}`);
				}),
		}),
	);

	return { calls, layer };
}

function runLoadChangedFiles(cwd: string, fixture: ReturnType<typeof makeFixture>) {
	return Effect.runPromise(loadChangedFiles(cwd).pipe(Effect.provide(fixture.layer)));
}

function runLoadFileDiff(repoRoot: string, file: { rawPath: string; status: string }, hasHead: boolean, fixture: ReturnType<typeof makeFixture>) {
	return Effect.runPromise(loadFileDiff(repoRoot, file, hasHead).pipe(Effect.provide(fixture.layer)));
}

test('loadChangedFiles: the initial pass is cheap stats only, with no per-file diff commands', async () => {
	const statusOutput = [
		statusRecord('M ', 'modified.ts'),
		statusRecord('??', 'untracked.ts'),
		renameRecord('R ', 'renamed-new.ts', 'renamed-old.ts'),
		statusRecord('M ', 'binary.png'),
		statusRecord('M ', 'src/weird\ttab.ts'),
	].join('\0');

	const fixture = makeFixture(
		{
			statusResult: { code: 0, stdout: statusOutput, stderr: '' },
			statFor: (path) => {
				switch (path) {
					case 'modified.ts':
						return { code: 0, stdout: '3\t1\tmodified.ts\n', stderr: '' };

					case 'untracked.ts':
						return { code: 0, stdout: '10\t0\tuntracked.ts\n', stderr: '' };

					case 'renamed-new.ts':
						return { code: 0, stdout: '2\t2\trenamed-new.ts\n', stderr: '' };

					case 'binary.png':
						return { code: 0, stdout: '-\t-\tbinary.png\n', stderr: '' };

					case 'src/weird\ttab.ts':
						return { code: 0, stdout: '1\t0\tsrc/weird\ttab.ts\n', stderr: '' };

					default:
						throw new Error(`unexpected stat path: ${path}`);
				}
			},
		},
	);

	const result = await runLoadChangedFiles('/repo', fixture);

	assert.ok(result !== null);
	assert.equal(result.hasHead, true);
	assert.equal(result.repoRoot, '/repo');
	assert.deepEqual(
		result.files.map(({ name, path, rawPath, status, additions, deletions }) => ({
			name,
			path,
			rawPath,
			status,
			additions,
			deletions,
		})),
		[
			{
				name: 'modified.ts',
				path: 'modified.ts',
				rawPath: 'modified.ts',
				status: 'M ',
				additions: 3,
				deletions: 1,
			},
			{
				name: 'untracked.ts',
				path: 'untracked.ts',
				rawPath: 'untracked.ts',
				status: '??',
				additions: 10,
				deletions: 0,
			},
			{
				name: 'renamed-new.ts',
				path: 'renamed-new.ts',
				rawPath: 'renamed-new.ts',
				status: 'R ',
				additions: 2,
				deletions: 2,
			},
			{
				name: 'binary.png',
				path: 'binary.png',
				rawPath: 'binary.png',
				status: 'M ',
				additions: null,
				deletions: null,
			},
			{
				// Control characters are sanitized for display only; the raw path
				// used to build git command arguments is preserved untouched.
				name: 'weird tab.ts',
				path: 'src/weird tab.ts',
				rawPath: 'src/weird\ttab.ts',
				status: 'M ',
				additions: 1,
				deletions: 0,
			},
		],
	);

	const numstatCalls = fixture.calls.filter((args) => args[0] === 'diff' && args.includes('--numstat'));

	assert.equal(numstatCalls.length, 5);

	// The initial listing must never load a full textual diff.
	const fullDiffCalls = fixture.calls.filter((args) => args.includes('--unified=3'));

	assert.equal(fullDiffCalls.length, 0);

	const untrackedStat = numstatCalls.find((args) => args[args.length - 1] === 'untracked.ts')!;

	assert.ok(untrackedStat.includes('--no-index'));
	assert.ok(untrackedStat.includes('/dev/null'));

	const modifiedStat = numstatCalls.find((args) => args[args.length - 1] === 'modified.ts')!;

	assert.ok(!modifiedStat.includes('--no-index'));
	assert.ok(modifiedStat.includes('HEAD'));

	const weirdStat = numstatCalls.find((args) => args[args.length - 1] === 'src/weird\ttab.ts')!;

	assert.ok(weirdStat, 'stat command must target the raw, unsanitized path');
});

test('loadChangedFiles: no HEAD forces no-index diffs even for tracked paths', async () => {
	const fixture = makeFixture(
		{
			hasHead: false,
			statusResult: {
				code: 0,
				stdout: statusRecord('M ', 'modified.ts'),
				stderr: '',
			},
			statFor: () => ({ code: 0, stdout: '4\t0\tmodified.ts\n', stderr: '' }),
		},
	);

	const result = await runLoadChangedFiles('/repo', fixture);

	assert.ok(result !== null);
	assert.equal(result.hasHead, false);

	const statCall = fixture.calls.find((args) => args[0] === 'diff' && args.includes('--numstat'))!;

	assert.ok(statCall.includes('--no-index'));
	assert.ok(statCall.includes('/dev/null'));
});

test('loadChangedFiles: a git status failure is reported as "not a repository"', async () => {
	const fixture = makeFixture(
		{
			statusResult: {
				code: 128,
				stdout: '',
				stderr: 'fatal: not a git repository\n',
			},
		},
	);

	const result = await runLoadChangedFiles('/repo', fixture);

	assert.equal(result, null);
});

test('loadChangedFiles: a rev-parse --show-toplevel failure is reported as "not a repository"', async () => {
	const fixture = makeFixture(
		{
			toplevelResult: {
				code: 128,
				stdout: '',
				stderr: 'fatal: not a git repository\n',
			},
		},
	);

	const result = await runLoadChangedFiles('/somewhere', fixture);

	assert.equal(result, null);
});

test("loadFileDiff: selecting a file loads only that file's diff", async () => {
	const statusOutput = [statusRecord('M ', 'a.ts'), statusRecord('M ', 'b.ts')].join('\0');

	const fixture = makeFixture(
		{
			statusResult: { code: 0, stdout: statusOutput, stderr: '' },
			diffFor: (path) => ({
				code: 0,
				stdout: `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
				stderr: '',
			}),
		},
	);

	const result = await runLoadChangedFiles('/repo', fixture);

	assert.ok(result !== null);
	assert.equal(fixture.calls.filter((args) => args.includes('--unified=3')).length, 0, 'listing changed files must not load any diff text');

	const selected = result.files.find((file) => file.rawPath === 'a.ts')!;

	const diff = await runLoadFileDiff('/repo', selected, result.hasHead, fixture);

	assert.deepEqual(diff, {
		_tag: 'loaded',
		lines: ['diff --git a/a.ts b/a.ts', '@@ -1 +1 @@', '-old', '+new'],
	});

	const fullDiffCalls = fixture.calls.filter((args) => args.includes('--unified=3'));

	assert.equal(fullDiffCalls.length, 1);
	assert.equal(fullDiffCalls[0]![fullDiffCalls[0]!.length - 1], 'a.ts');
});

test('loadFileDiff: an empty diff renders a clear unavailable message', async () => {
	const fixture = makeFixture(
		{
			diffFor: () => ({ code: 0, stdout: '', stderr: '' }),
		},
	);

	const diff = await runLoadFileDiff(
		'/repo',
		{ rawPath: 'empty.ts', status: 'M ' },
		true,
		fixture,
	);

	assert.deepEqual(diff, {
		_tag: 'loaded',
		lines: ['No textual diff available.'],
	});
});

test('loadFileDiff: a git failure renders a truncated/unavailable state instead of throwing', async () => {
	const fixture = makeFixture(
		{
			diffFor: () => ({
				code: 128,
				stdout: '',
				stderr: "fatal: bad revision 'HEAD'\n",
			}),
		},
	);

	const diff = await runLoadFileDiff(
		'/repo',
		{ rawPath: 'broken.ts', status: 'M ' },
		true,
		fixture,
	);

	assert.equal(diff._tag, 'unavailable');
	assert.match((diff as { message: string }).message, /^Diff unavailable: /);
	assert.match((diff as { message: string }).message, /bad revision 'HEAD'/);
});

test('loadFileDiff: bounds the retained diff to MAX_DIFF_LINES', async () => {
	const totalLines = MAX_DIFF_LINES + 5;
	const stdout = Array.from({ length: totalLines }, (_, index) => `+line ${index}`).join('\n');

	const fixture = makeFixture(
		{
			diffFor: () => ({ code: 0, stdout, stderr: '' }),
		},
	);

	const diff = await runLoadFileDiff(
		'/repo',
		{ rawPath: 'huge.ts', status: 'M ' },
		true,
		fixture,
	);

	assert.equal(diff._tag, 'loaded');

	const lines = (diff as { lines: string[] }).lines;

	assert.equal(lines.length, MAX_DIFF_LINES + 1);
	assert.equal(lines[0], '+line 0');
	assert.equal(lines[MAX_DIFF_LINES - 1], `+line ${MAX_DIFF_LINES - 1}`);
	assert.match(lines[MAX_DIFF_LINES]!, /truncated after 20,000 lines/);
});

test('loadFileDiff: cancellation interrupts the outstanding git command instead of hanging', async () => {
	const outcome = await Effect.runPromise(
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>();

			const layer = Layer.succeed(
				CommandRunner,
				CommandRunner.of({
					run: () =>
						Effect.gen(function* () {
							yield* Deferred.succeed(started, undefined);
							// Simulate a git process that never returns on its own; only
							// interruption should stop it.
							yield* Effect.never;

							return OK;
						}),
				}),
			);

			const fiber = yield* Effect.forkChild(loadFileDiff(
				'/repo',
				{ rawPath: 'big.ts', status: 'M ' },
				true,
			).pipe(Effect.provide(layer)));

			yield* Deferred.await(started);
			yield* Fiber.interrupt(fiber);

			return fiber.pollUnsafe();
		}),
	);

	assert.ok(outcome !== undefined);
	assert.ok(Exit.isFailure(outcome));
	assert.ok(Cause.hasInterruptsOnly(outcome.cause));
});
