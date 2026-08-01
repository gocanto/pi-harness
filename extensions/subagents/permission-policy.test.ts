/**
 * Backend option fixtures for the trust boundary: a subagent whose task
 * carries `parent.projectTrusted: false` must never receive the options
 * that grant autonomous host-wide access (Claude's `bypassPermissions`,
 * Codex's `danger-full-access`), no matter which backend runs it. These are
 * pure option builders — no live SDK/process is involved — so this stays
 * deterministic and safe to run in CI.
 */

import { assert } from '../test-assert.ts';
import { test } from 'vitest';
import { claudePermissionOptions } from './src/backends/claude.ts';
import { codexSandboxOptions } from './src/backends/codex.ts';

test('Claude: a trusted cwd gets bypassPermissions', () => {
	assert.deepEqual(claudePermissionOptions(true), {
		permissionMode: 'bypassPermissions',
		allowDangerouslySkipPermissions: true,
	});
});

test('Claude: an untrusted cwd never receives bypassPermissions', () => {
	const options = claudePermissionOptions(false);

	assert.notEqual(options.permissionMode, 'bypassPermissions');
	assert.equal('allowDangerouslySkipPermissions' in options, false);
	assert.deepEqual(options, {
		permissionMode: 'dontAsk',
		settingSources: ['user'],
	});
});

test('Codex: a trusted cwd gets danger-full-access', () => {
	assert.deepEqual(codexSandboxOptions(true), {
		approvalPolicy: 'never',
		sandbox: 'danger-full-access',
	});
});

test('Codex: an untrusted cwd never receives danger-full-access', () => {
	const options = codexSandboxOptions(false);

	assert.notEqual(options.sandbox, 'danger-full-access');
	assert.deepEqual(options, {
		approvalPolicy: 'never',
		sandbox: 'workspace-write',
	});
});
