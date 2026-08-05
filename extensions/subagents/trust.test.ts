/**
 * The trust matrix `subagent_spawn` enforces before it ever reserves a
 * concurrency slot or reaches a backend: same-directory children inherit the
 * live parent decision, alternate directories require an explicit saved
 * trust entry, and anything else (including a directory that does not
 * exist) fails closed as untrusted. This reuses the same
 * `resolveStandaloneChildProjectTrust` seam `index.ts`'s `subagent_spawn`
 * handler calls.
 */

import { assert } from '@tests/test-assert.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'vitest';
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent';
import { resolveStandaloneChildProjectTrust } from '@shared/child-session.ts';

async function withTempDir(run: (directory: string) => Promise<void>) {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'pi-subagent-trust-'),
	);

	try {
		await run(directory);
	} finally {
		await rm(
			directory,
			{ recursive: true, force: true },
		);
	}
}

test("trusted same-directory: inherits the parent's live trust decision", async () => {
	await withTempDir(async (directory) => {
		const parentCwd = path.join(directory, 'project');

		assert.equal(
			resolveStandaloneChildProjectTrust({
				parentCwd,
				childCwd: parentCwd,
				parentTrusted: true,
				agentDir: path.join(directory, 'agent'),
			}),
			true,
		);
	});
});

test('untrusted same-directory: an untrusted parent stays untrusted', async () => {
	await withTempDir(async (directory) => {
		const parentCwd = path.join(directory, 'project');

		assert.equal(
			resolveStandaloneChildProjectTrust({
				parentCwd,
				childCwd: parentCwd,
				parentTrusted: false,
				agentDir: path.join(directory, 'agent'),
			}),
			false,
		);
	});
});

test('trusted alternate directory: only an explicit saved trust entry counts', async () => {
	await withTempDir(async (directory) => {
		const parentCwd = path.join(directory, 'project');
		const childCwd = path.join(directory, 'alternate');
		const agentDir = path.join(directory, 'agent');

		new ProjectTrustStore(agentDir).set(childCwd, true);

		assert.equal(
			resolveStandaloneChildProjectTrust({
				parentCwd,
				childCwd,
				// Even an untrusted parent cannot block an explicitly trusted
				// alternate directory: the store, not the parent, is authoritative
				// once the paths differ.
				parentTrusted: false,
				agentDir,
			}),
			true,
		);
	});
});

test('untrusted alternate directory: no saved trust entry denies by default', async () => {
	await withTempDir(async (directory) => {
		const parentCwd = path.join(directory, 'project');
		const childCwd = path.join(directory, 'alternate');

		assert.equal(
			resolveStandaloneChildProjectTrust({
				parentCwd,
				childCwd,
				// Even a trusted parent cannot vouch for an alternate directory it
				// never explicitly trusted.
				parentTrusted: true,
				agentDir: path.join(directory, 'agent'),
			}),
			false,
		);
	});
});

test('nonexistent directory: an unresolvable alternate path fails closed', async () => {
	await withTempDir(async (directory) => {
		const parentCwd = path.join(directory, 'project');
		const childCwd = path.join(directory, 'does-not-exist', 'nested');

		assert.equal(
			resolveStandaloneChildProjectTrust({
				parentCwd,
				childCwd,
				parentTrusted: true,
				agentDir: path.join(directory, 'agent'),
			}),
			false,
		);
	});
});
