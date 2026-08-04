import { assert } from '@tests/test-assert.ts';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AgentOutcome } from '@workflows/runner.ts';

/**
 * The sandbox and the agent runner are replaced so the settle deadline can be
 * driven deterministically: the workflow body starts one agent that never
 * finishes on its own, and the test decides when (and whether) it resolves.
 */
const sandboxMock = vi.hoisted(() => ({ onAgent: undefined as ((prompt: unknown) => Promise<unknown>) | undefined }));
const runAgentMock = vi.hoisted(() => ({ resolve: undefined as ((outcome: AgentOutcome) => void) | undefined }));

vi.mock('@workflows/sandbox.ts', () => ({
	runWorkflowSandbox: async (options: { onAgent: (prompt: unknown) => Promise<unknown> }) => {
		sandboxMock.onAgent = options.onAgent;
		// Start an agent and return without awaiting it, exactly as a workflow
		// body that forgets to await does.
		void options.onAgent('do the thing');
		// Give the scheduled agent a turn so it is running when settle begins.
		await new Promise((r) => setTimeout(r, 0));

		return 'script done';
	},
}));

vi.mock('@workflows/runner.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@workflows/runner.ts')>();

	return {
		...actual,
		createWorkflowResources: async () => ({ loader: {}, settingsManager: {} }),
		runAgent: () =>
			new Promise<AgentOutcome>((resolve) => {
				runAgentMock.resolve = resolve;
			}),
	};
});

const { WorkflowToolRegistrar } = await import('@workflows/tool.ts');

const { WorkflowRunRegistry } = await import('@workflows/registry.ts');

let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	agentDir = mkdtempSync(
		join(
			tmpdir(),
			'pi-workflow-tool-',
		),
	);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	sandboxMock.onAgent = undefined;
	runAgentMock.resolve = undefined;
});

afterEach(() => {
	if (previousAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}

	rmSync(
		agentDir,
		{ recursive: true, force: true },
	);
	vi.useRealTimers();
});

/** Register the workflow tool against a fake host and hand back its execute(). */
function registerTool() {
	let tool: { execute: (...args: never[]) => Promise<unknown> } | undefined;

	const pi = {
		registerTool: (registered: typeof tool) => {
			tool = registered;
		},
		getThinkingLevel: () => 'medium',
	} as unknown as ExtensionAPI;

	new WorkflowToolRegistrar(pi, new WorkflowRunRegistry(join(agentDir, 'workflows'))).register();
	assert.ok(tool, 'tool was not registered');

	return tool;
}

function makeContext(): ExtensionContext {
	return {
		cwd: process.cwd(),
		hasUI: false,
		isProjectTrusted: () => true,
		model: { id: 'test-model', contextWindow: 1000 },
		modelRegistry: { find: () => undefined, getAll: () => [] },
		sessionManager: { getSessionId: () => 'session-1' },
	} as unknown as ExtensionContext;
}

// The sandbox is mocked, so this only has to parse; the mock supplies the body.
const SCRIPT = 'export const meta = { name: "t", description: "d", phases: [] };\n';

function readRunArtifact() {
	const runsDir = join(agentDir, 'workflows');
	const [runId] = readdirSync(runsDir);

	assert.ok(runId, 'no run directory was created');

	return JSON.parse(readFileSync(join(runsDir, runId, 'workflow.json'), 'utf8'));
}

test('an agent that outlives the shutdown deadline cannot resurrect a finished run', async () => {
	const tool = registerTool();

	const execution = tool.execute(...(['call-1', { script: SCRIPT }, new AbortController().signal, undefined, makeContext()] as never[]));

	await vi.waitFor(() => assert.ok(runAgentMock.resolve, 'agent never started'));

	// The workflow tool signals failure by throwing, so the rejection here is
	// the run reporting that its agent never settled. Waiting it out costs the
	// real 8s shutdown deadline.
	await assert.rejects(execution, /shutdown deadline exceeded/);

	const afterRun = readRunArtifact();

	assert.equal(afterRun.status, 'failed');
	assert.equal(afterRun.agents[0].state, 'error');

	// The orphaned agent now succeeds, well after the run reported failure.
	runAgentMock.resolve?.({
		ok: true,
		output: 'late success',
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		transcript: [],
	} as unknown as AgentOutcome);
	// Longer than WORKFLOW_CHECKPOINT_INTERVAL_MS (500ms), so an unguarded
	// checkpoint scheduled by the late callback would have rewritten the
	// artifact by now.
	await new Promise((r) => setTimeout(r, 900));

	const afterLateCallback = readRunArtifact();

	assert.equal(afterLateCallback.status, 'failed', 'run status was rewritten after it finished');
	assert.equal(afterLateCallback.agents[0].state, 'error', 'orphaned agent flipped its record back to done');
});
