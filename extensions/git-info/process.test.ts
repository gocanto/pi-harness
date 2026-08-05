import { assert } from '@tests/test-assert.ts';
import { test } from 'vitest';
import { runCommand } from '@git-info/src/process.ts';

const runNode = (source: string, timeout = 1_000) => runCommand(
	process.execPath,
	['--input-type=module', '--eval', source],
	process.cwd(),
	timeout,
);

test('captures output and tolerates command failures', async () => {
	const success = await runNode('process.stdout.write("out"); process.stderr.write("err")');

	assert.deepEqual(success, { code: 0, stderr: 'err', stdout: 'out' });

	const failure = await runNode('process.exitCode = 7');

	assert.equal(failure.code, 7);
});

test('renders platform failures without making callers handle them', async () => {
	const command = 'git-info-command-that-does-not-exist';

	const result = await runCommand(
		command,
		[],
		process.cwd(),
		1_000,
	);

	assert.equal(result.code, 1);
	assert.match(result.stderr, new RegExp(`Failed to run ${command}:`));
	assert.match(result.stderr, /NotFound|not found|ENOENT/i);
});

test('reports command timeouts as failures', async () => {
	const result = await runNode('setTimeout(() => {}, 1_000)', 20);

	assert.equal(result.code, -1);
});
