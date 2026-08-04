import { assert } from '@tests/test-assert.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { cleanupExpiredWorkflowRuns } from '@workflows/retention.ts';

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

const RETENTION_MS = 1_000;
const NOW = 10_000_000;

function makeRun(baseDir: string, runId: string, summary: Record<string, unknown> | undefined) {
	const runDir = join(baseDir, runId);

	mkdirSync(
		runDir,
		{ recursive: true },
	);
	if (summary !== undefined) {
		writeFileSync(
			join(runDir, 'workflow.json'),
			JSON.stringify(summary),
		);
	}

	return runDir;
}

test('cleanup removes runs older than the retention window', () => {
	const baseDir = mkdtempSync(
		join(
			tmpdir(),
			'pi-workflow-retention-',
		),
	);

	try {
		const stale = makeRun(
			baseDir,
			'wf_stale',
			{
				status: 'completed',
				finishedAt: NOW - RETENTION_MS - 1,
			},
		);

		const removed = cleanupExpiredWorkflowRuns(
			baseDir,
			new Set(),
			{
				retentionMs: RETENTION_MS,
				now: NOW,
			},
		);

		assert.deepEqual(removed, ['wf_stale']);
		assert.equal(existsSync(stale), false);
	} finally {
		rmSync(
			baseDir,
			{ recursive: true, force: true },
		);
	}
});

test('cleanup preserves runs within the retention window', () => {
	const baseDir = mkdtempSync(
		join(
			tmpdir(),
			'pi-workflow-retention-',
		),
	);

	try {
		const fresh = makeRun(
			baseDir,
			'wf_fresh',
			{
				status: 'completed',
				finishedAt: NOW - RETENTION_MS + 1,
			},
		);

		const removed = cleanupExpiredWorkflowRuns(
			baseDir,
			new Set(),
			{
				retentionMs: RETENTION_MS,
				now: NOW,
			},
		);

		assert.deepEqual(removed, []);
		assert.equal(existsSync(fresh), true);
	} finally {
		rmSync(
			baseDir,
			{ recursive: true, force: true },
		);
	}
});

test('cleanup never removes a run tracked as active, however old', () => {
	const baseDir = mkdtempSync(
		join(
			tmpdir(),
			'pi-workflow-retention-',
		),
	);

	try {
		const active = makeRun(
			baseDir,
			'wf_active',
			{
				status: 'running',
				startedAt: NOW - RETENTION_MS * 100,
			},
		);

		const removed = cleanupExpiredWorkflowRuns(
			baseDir,
			new Set(['wf_active']),
			{ retentionMs: RETENTION_MS, now: NOW },
		);

		assert.deepEqual(removed, []);
		assert.equal(existsSync(active), true);
	} finally {
		rmSync(
			baseDir,
			{ recursive: true, force: true },
		);
	}
});

test('cleanup is idempotent across repeated calls', () => {
	const baseDir = mkdtempSync(
		join(
			tmpdir(),
			'pi-workflow-retention-',
		),
	);

	try {
		makeRun(
			baseDir,
			'wf_stale',
			{
				status: 'failed',
				finishedAt: NOW - RETENTION_MS - 1,
			},
		);

		const first = cleanupExpiredWorkflowRuns(
			baseDir,
			new Set(),
			{
				retentionMs: RETENTION_MS,
				now: NOW,
			},
		);
		const second = cleanupExpiredWorkflowRuns(
			baseDir,
			new Set(),
			{
				retentionMs: RETENTION_MS,
				now: NOW,
			},
		);

		assert.deepEqual(first, ['wf_stale']);
		assert.deepEqual(second, []);
	} finally {
		rmSync(
			baseDir,
			{ recursive: true, force: true },
		);
	}
});

test('cleanup falls back to directory mtime for unreadable workflow.json', () => {
	const baseDir = mkdtempSync(
		join(
			tmpdir(),
			'pi-workflow-retention-',
		),
	);

	try {
		const runDir = makeRun(baseDir, 'wf_no_summary', undefined);

		const removed = cleanupExpiredWorkflowRuns(
			baseDir,
			new Set(),
			{
				retentionMs: RETENTION_MS,
				now: Date.now() + RETENTION_MS + 5_000,
			},
		);

		assert.deepEqual(removed, ['wf_no_summary']);
		assert.equal(existsSync(runDir), false);
	} finally {
		rmSync(
			baseDir,
			{ recursive: true, force: true },
		);
	}
});

test('cleanup tolerates a missing workflows base directory', () => {
	const missingDir = join(
		tmpdir(),
		'pi-workflow-retention-missing-nonexistent',
	);

	const removed = cleanupExpiredWorkflowRuns(
		missingDir,
		new Set(),
		{
			retentionMs: RETENTION_MS,
			now: NOW,
		},
	);

	assert.deepEqual(removed, []);
});
