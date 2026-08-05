import { assert } from '@tests/test-assert.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { persistWorkflowJson } from '@workflows/artifacts.ts';
import { emptyUsage, type AgentRecord, type WorkflowDetails } from '@workflows/model.ts';

import { loadRunEntries, WorkflowRunCache, type RunEntry } from '@workflows/dashboard.ts';

const SESSION_ID = 'session_fixture';

/** A minimal, realistic run with one settled agent and a real result/transcript. */
function fixtureDetails(overrides: Partial<WorkflowDetails> = {}): WorkflowDetails {
	const agent: AgentRecord = {
		index: 1,
		label: 'agent-1',
		state: 'done',
		startedAt: 1,
		finishedAt: 2,
		preview: 'done',
		usage: emptyUsage(),
		transcript: [{ role: 'assistant', text: 'hello from the agent' }],
	};

	return {
		runId: 'wf_fixture',
		sessionId: SESSION_ID,
		background: false,
		status: 'completed',
		startedAt: 1,
		finishedAt: 2,
		phases: [],
		agents: [agent],
		result: { answer: 42 },
		...overrides,
	};
}

function withTempRunsDir<T>(run: (baseDir: string) => T): T {
	const baseDir = mkdtempSync(
		join(
			tmpdir(),
			'pi-workflow-dashboard-',
		),
	);

	try {
		return run(baseDir);
	} finally {
		rmSync(
			baseDir,
			{ recursive: true, force: true },
		);
	}
}

function writeRun(baseDir: string, details: WorkflowDetails): string {
	const runDir = join(baseDir, details.runId);

	mkdirSync(
		runDir,
		{ recursive: true },
	);
	persistWorkflowJson(runDir, details);

	return runDir;
}

test('list() reuses the cached read when workflow.json is unchanged, and rereads once its mtime advances', () => {
	withTempRunsDir((baseDir) => {
		writeRun(
			baseDir,
			fixtureDetails(
				{ name: 'first name' },
			),
		);

		const cache = new WorkflowRunCache(() => baseDir);

		const first = cache.list(new Map(), SESSION_ID, new Set());
		const second = cache.list(new Map(), SESSION_ID, new Set());

		assert.equal(first.length, 1);
		// Same object reference back-to-back proves the second call skipped
		// JSON.parse/readFileSync entirely rather than rereading unchanged bytes.
		assert.equal(first[0]?.details, second[0]?.details);
		assert.equal(first[0]?.details.name, 'first name');

		// Rewriting the file naturally advances its mtime, so the *next* list()
		// must observe the new content instead of serving the stale cache.
		writeRun(
			baseDir,
			fixtureDetails(
				{ name: 'second name' },
			),
		);

		const third = cache.list(new Map(), SESSION_ID, new Set());

		assert.equal(third[0]?.details.name, 'second name');
		assert.notEqual(third[0]?.details, second[0]?.details);
	});
});

test("invalidate() forces a reread even when workflow.json's mtime hasn't changed", () => {
	withTempRunsDir((baseDir) => {
		writeRun(
			baseDir,
			fixtureDetails(
				{ name: 'original' },
			),
		);

		const cache = new WorkflowRunCache(() => baseDir);

		const first = cache.list(new Map(), SESSION_ID, new Set());
		const second = cache.list(new Map(), SESSION_ID, new Set());
		// Same reference: the second call served the cached read untouched.
		assert.equal(second[0]?.details, first[0]?.details);

		cache.invalidate('wf_fixture');

		const third = cache.list(new Map(), SESSION_ID, new Set());
		// A forced reread reparses workflow.json into a brand new object, even
		// though its content (and mtime) never changed.
		assert.notEqual(third[0]?.details, second[0]?.details);
		assert.equal(third[0]?.details.name, 'original');
	});
});

test('list() never reads result/transcript artifacts; hydrate() lazily loads them once per selection', () => {
	withTempRunsDir((baseDir) => {
		writeRun(
			baseDir,
			fixtureDetails(),
		);

		const cache = new WorkflowRunCache(() => baseDir);

		const [entry] = cache.list(new Map(), SESSION_ID, new Set());

		assert.ok(entry);
		// List rendering never needs result/transcript artifacts, so they must
		// still show the compact workflow.json placeholders at this point.
		assert.equal(entry.details.result, '[stored in result.json]');
		assert.deepEqual(entry.details.agents[0]?.transcript, []);

		cache.hydrate(entry);
		assert.deepEqual(entry.details.result, { answer: 42 });
		assert.deepEqual(entry.details.agents[0]?.transcript, [
			{
				role: 'assistant',
				text: 'hello from the agent',
				name: undefined,
				isError: false,
				timestamp: undefined,
			},
		]);
	});
});

test('hydrate() does not reread artifacts already hydrated at the current mtime', () => {
	withTempRunsDir((baseDir) => {
		const runDir = writeRun(
			baseDir,
			fixtureDetails(),
		);

		const cache = new WorkflowRunCache(() => baseDir);
		const [entry] = cache.list(new Map(), SESSION_ID, new Set());

		assert.ok(entry);
		cache.hydrate(entry);
		assert.deepEqual(entry.details.result, { answer: 42 });

		// Corrupt the artifact without touching workflow.json's mtime. A second
		// hydrate() call must not attempt to reread it, so the already-hydrated
		// value survives untouched.
		writeFileSync(
			join(runDir, 'result.json'),
			'{not valid json',
		);
		cache.hydrate(entry);
		assert.deepEqual(entry.details.result, { answer: 42 });
	});
});

test('an unreadable result/transcript artifact keeps the compact fallback instead of throwing', () => {
	withTempRunsDir((baseDir) => {
		const runDir = writeRun(
			baseDir,
			fixtureDetails(),
		);

		writeFileSync(
			join(runDir, 'result.json'),
			'{not valid json',
		);
		writeFileSync(
			join(runDir, 'transcripts.json'),
			'also not json',
		);

		const cache = new WorkflowRunCache(() => baseDir);

		const [entry] = cache.list(new Map(), SESSION_ID, new Set());

		assert.ok(entry);
		assert.doesNotThrow(() => cache.hydrate(entry));
		assert.equal(entry.details.result, '[stored in result.json]');
		assert.deepEqual(entry.details.agents[0]?.transcript, []);
	});
});

test('a running record with no active tracking is recovered as aborted', () => {
	withTempRunsDir((baseDir) => {
		writeRun(
			baseDir,
			fixtureDetails(
				{
					status: 'running',
					finishedAt: undefined,
					agents: [
						{
							index: 1,
							label: 'agent-1',
							state: 'running',
							startedAt: 1,
							preview: '',
							usage: emptyUsage(),
							transcript: [],
						},
					],
				},
			),
		);

		const cache = new WorkflowRunCache(() => baseDir);

		const [entry] = cache.list(new Map(), SESSION_ID, new Set());

		assert.ok(entry);
		assert.equal(entry.details.status, 'aborted');
		assert.match(entry.details.error ?? '', /Recovered stale run/);
		assert.equal(entry.details.agents[0]?.state, 'error');
	});
});

test('a live (active) run is served from memory and never read from disk', () => {
	withTempRunsDir((baseDir) => {
		// The on-disk file is deliberately corrupt: if list() ever tried to
		// parse it for this runId, the run would be dropped instead of shown.
		const runDir = join(baseDir, 'wf_live');

		mkdirSync(
			runDir,
			{ recursive: true },
		);
		writeFileSync(
			join(runDir, 'workflow.json'),
			'not valid json',
		);

		const liveDetails = fixtureDetails(
			{ runId: 'wf_live', status: 'running' },
		);

		const active = new Map<string, WorkflowDetails>([['wf_live', liveDetails]]);
		const cache = new WorkflowRunCache(() => baseDir);
		const [entry] = cache.list(active, SESSION_ID, new Set());

		assert.ok(entry);
		assert.equal(entry.live, true);
		assert.equal(entry.details, liveDetails);
	});
});

test('a persisted run outside this session and its referenced ids is excluded', () => {
	withTempRunsDir((baseDir) => {
		writeRun(
			baseDir,
			fixtureDetails(
				{ sessionId: 'someone-elses-session' },
			),
		);

		const cache = new WorkflowRunCache(() => baseDir);

		assert.deepEqual(cache.list(new Map(), SESSION_ID, new Set()), []);

		const referenced = cache.list(new Map(), SESSION_ID, new Set(['wf_fixture']));

		assert.equal(referenced.length, 1);
	});
});

test('list() drops cached runs the retention sweep already removed from disk', () => {
	withTempRunsDir((baseDir) => {
		const runDir = writeRun(
			baseDir,
			fixtureDetails(),
		);

		const cache = new WorkflowRunCache(() => baseDir);

		assert.equal(cache.list(new Map(), SESSION_ID, new Set()).length, 1);

		rmSync(
			runDir,
			{ recursive: true, force: true },
		);
		assert.deepEqual(cache.list(new Map(), SESSION_ID, new Set()), []);

		// Recreating the run must be picked up fresh, not served from a stale
		// entry the sweep should already have evicted.
		writeRun(
			baseDir,
			fixtureDetails(
				{ name: 'recreated' },
			),
		);

		const entries = cache.list(new Map(), SESSION_ID, new Set());

		assert.equal(entries[0]?.details.name, 'recreated');
	});
});

test('loadRunEntries() is a one-shot listing over the real agent-dir workflows store', () => {
	// loadRunEntries() targets `~/.pi/agent/workflows` via the ambient
	// `PI_CODING_AGENT_DIR`-backed `getAgentDir()`; point that at a temp dir
	// instead of touching the real home directory.
	const envVar = 'PI_CODING_AGENT_DIR';
	const previous = process.env[envVar];

	const agentDir = mkdtempSync(
		join(
			tmpdir(),
			'pi-workflow-dashboard-agentdir-',
		),
	);

	process.env[envVar] = agentDir;
	try {
		const runDir = join(agentDir, 'workflows', 'wf_fixture');

		mkdirSync(
			runDir,
			{ recursive: true },
		);
		persistWorkflowJson(
			runDir,
			fixtureDetails(),
		);

		const entries = loadRunEntries(new Map(), SESSION_ID, new Set());

		assert.equal(entries.length, 1);

		const entry: RunEntry | undefined = entries[0];

		assert.equal(entry?.runId, 'wf_fixture');
		assert.equal(entry?.live, false);
		// List rendering must not have eagerly loaded the result artifact.
		assert.equal(entry?.details.result, '[stored in result.json]');
	} finally {
		if (previous === undefined) {
			delete process.env[envVar];
		} else {
			process.env[envVar] = previous;
		}

		rmSync(
			agentDir,
			{ recursive: true, force: true },
		);
	}
});
