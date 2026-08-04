import { assert } from '../../tests/test-assert.ts';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'vitest';

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { activationPreferencePath, parseActivationEnv, readActivationPreference, resolveWorkflowActivation, writeActivationPreference, WORKFLOW_ACTIVATION_ENV_VAR } from './activation.ts';

function withTempAgentDir(fn: (agentDir: string) => void) {
	const agentDir = mkdtempSync(
		join(
			tmpdir(),
			'pi-workflow-activation-',
		),
	);

	try {
		fn(agentDir);
	} finally {
		rmSync(
			agentDir,
			{ recursive: true, force: true },
		);
	}
}

test('parseActivationEnv recognizes common truthy/falsy spellings, case-insensitively', () => {
	assert.equal(parseActivationEnv('1'), true);
	assert.equal(parseActivationEnv('true'), true);
	assert.equal(parseActivationEnv('TRUE'), true);
	assert.equal(parseActivationEnv('on'), true);
	assert.equal(parseActivationEnv('yes'), true);
	assert.equal(parseActivationEnv('0'), false);
	assert.equal(parseActivationEnv('false'), false);
	assert.equal(parseActivationEnv('OFF'), false);
	assert.equal(parseActivationEnv('no'), false);
});

test('parseActivationEnv returns undefined for unset or unrecognized values', () => {
	assert.equal(parseActivationEnv(undefined), undefined);
	assert.equal(parseActivationEnv(''), undefined);
	assert.equal(parseActivationEnv('maybe'), undefined);
});

test('resolveWorkflowActivation defaults to disabled with no preference and no env override', () => {
	withTempAgentDir((agentDir) => {
		const resolved = resolveWorkflowActivation(
			{ agentDir, env: {} },
		);

		assert.deepEqual(resolved, { enabled: false, source: 'default' });
	});
});

test('resolveWorkflowActivation honors an explicit enable preference', () => {
	withTempAgentDir((agentDir) => {
		writeActivationPreference(agentDir, true);

		const resolved = resolveWorkflowActivation(
			{ agentDir, env: {} },
		);

		assert.deepEqual(resolved, { enabled: true, source: 'preference' });
	});
});

test('resolveWorkflowActivation honors an explicit disable preference', () => {
	withTempAgentDir((agentDir) => {
		writeActivationPreference(agentDir, true);
		writeActivationPreference(agentDir, false);

		const resolved = resolveWorkflowActivation(
			{ agentDir, env: {} },
		);

		assert.deepEqual(resolved, { enabled: false, source: 'preference' });
	});
});

test('resolveWorkflowActivation lets the environment override a persisted preference', () => {
	withTempAgentDir((agentDir) => {
		writeActivationPreference(agentDir, true);

		const resolved = resolveWorkflowActivation(
			{
				agentDir,
				env: { [WORKFLOW_ACTIVATION_ENV_VAR]: '0' },
			},
		);

		assert.deepEqual(resolved, { enabled: false, source: 'env' });
	});
});

test('resolveWorkflowActivation ignores an unrecognized environment value and falls back to preference', () => {
	withTempAgentDir((agentDir) => {
		writeActivationPreference(agentDir, true);

		const resolved = resolveWorkflowActivation(
			{
				agentDir,
				env: { [WORKFLOW_ACTIVATION_ENV_VAR]: 'maybe' },
			},
		);

		assert.deepEqual(resolved, { enabled: true, source: 'preference' });
	});
});

test('readActivationPreference tolerates a missing, corrupt, or shape-invalid file', () => {
	withTempAgentDir((agentDir) => {
		assert.equal(readActivationPreference(agentDir), undefined);

		const filePath = activationPreferencePath(agentDir);

		mkdirSync(
			dirname(filePath),
			{ recursive: true },
		);
		writeFileSync(filePath, 'not json');
		assert.equal(readActivationPreference(agentDir), undefined);

		writeFileSync(
			filePath,
			JSON.stringify({ enabled: 'yes' }),
		);
		assert.equal(readActivationPreference(agentDir), undefined);
	});
});

test('writeActivationPreference persists a private JSON file that readActivationPreference round-trips', () => {
	withTempAgentDir((agentDir) => {
		writeActivationPreference(agentDir, true);

		const raw = JSON.parse(readFileSync(activationPreferencePath(agentDir), 'utf8'));

		assert.deepEqual(raw, { enabled: true });
		assert.equal(readActivationPreference(agentDir), true);
	});
});
