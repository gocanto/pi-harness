import { assert } from '@tests/test-assert.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { activationPreferencePath } from '@workflows/activation.ts';
import workflowsExtension from '@workflows/index.ts';

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';

/** Minimal in-memory stand-in for the subset of ExtensionAPI the extension calls. */
function makeFakeApi(initialActiveTools: string[] = ['read', 'bash']) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();

	const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => unknown }>();

	let registeredTool: { name: string } | undefined;
	let activeTools = [...initialActiveTools];

	const api = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, handler);
		},
		registerCommand: (
			name: string,
			options: {
				description?: string;
				handler: (args: string, ctx: unknown) => unknown;
			},
		) => {
			commands.set(name, options);
		},
		registerTool: (tool: { name: string }) => {
			registeredTool = tool;
		},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
		getThinkingLevel: () => 'medium',
	} as unknown as ExtensionAPI;

	return {
		api,
		handlers,
		commands,
		getRegisteredTool: () => registeredTool,
		getActiveTools: () => [...activeTools],
	};
}

function withTempAgentDir(fn: (agentDir: string) => void) {
	const envVar = 'PI_CODING_AGENT_DIR';
	const previous = process.env[envVar];

	const agentDir = mkdtempSync(
		join(
			tmpdir(),
			'pi-workflow-index-',
		),
	);

	process.env[envVar] = agentDir;
	try {
		fn(agentDir);
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
}

test('registers the workflow tool and the /workflows command', () => {
	const fake = makeFakeApi();

	workflowsExtension(fake.api);
	assert.equal(fake.getRegisteredTool()?.name, 'workflow');
	assert.ok(fake.commands.has('workflows'));
});

test('session_start deactivates the workflow tool by default, leaving other tools untouched', () => {
	withTempAgentDir(() => {
		const fake = makeFakeApi(
			['read', 'bash', 'workflow'],
		);

		workflowsExtension(fake.api);

		const sessionStart = fake.handlers.get('session_start');

		assert.ok(sessionStart);
		sessionStart?.(
			{},
			{ hasUI: false } as unknown as ExtensionContext,
		);
		assert.deepEqual(fake.getActiveTools(), ['read', 'bash']);
	});
});

test('session_start reactivates the workflow tool once a persisted enable preference exists', () => {
	withTempAgentDir((agentDir) => {
		const fake = makeFakeApi(
			['read', 'bash'],
		);

		workflowsExtension(fake.api);

		const enableHandler = fake.commands.get('workflows')?.handler;

		assert.ok(enableHandler);

		const notifications: string[] = [];

		const commandCtx = {
			ui: { notify: (text: string) => notifications.push(text) },
		} as unknown as ExtensionCommandContext;

		// Enabling writes the preference and flips the active set immediately.
		void enableHandler?.('enable', commandCtx);
		assert.deepEqual(fake.getActiveTools(), ['read', 'bash', 'workflow']);
		assert.equal(JSON.parse(readFileSync(activationPreferencePath(agentDir), 'utf8')).enabled, true);

		// A fresh session still honors the persisted preference.
		fake.api.setActiveTools(['read', 'bash']);

		const sessionStart = fake.handlers.get('session_start');

		sessionStart?.(
			{},
			{ hasUI: false } as unknown as ExtensionContext,
		);
		assert.deepEqual(fake.getActiveTools(), ['read', 'bash', 'workflow']);
	});
});

test('/workflows disable removes the tool and /workflows status reports the resolved source', () => {
	withTempAgentDir(() => {
		const fake = makeFakeApi(
			['read', 'bash', 'workflow'],
		);

		workflowsExtension(fake.api);

		const handler = fake.commands.get('workflows')?.handler;

		assert.ok(handler);

		const notifications: string[] = [];

		const commandCtx = {
			ui: { notify: (text: string) => notifications.push(text) },
		} as unknown as ExtensionCommandContext;

		void handler?.('disable', commandCtx);
		assert.deepEqual(fake.getActiveTools(), ['read', 'bash']);
		assert.ok(notifications.some((n) => n.includes('disabled')));

		void handler?.('status', commandCtx);
		assert.ok(notifications.some((n) => n.includes('disabled') && n.includes('source: preference')));
	});
});

test('activation commands cannot override the environment policy', () => {
	const envVar = 'PI_WORKFLOWS_ENABLED';
	const previous = process.env[envVar];

	try {
		withTempAgentDir(() => {
			process.env[envVar] = '0';

			const disabledByEnv = makeFakeApi(
				['read', 'bash'],
			);

			workflowsExtension(disabledByEnv.api);

			const disableHandler = disabledByEnv.commands.get('workflows')?.handler;

			assert.ok(disableHandler);
			void disableHandler?.(
				'enable',
				{
					ui: { notify: () => undefined },
				} as unknown as ExtensionCommandContext,
			);
			assert.deepEqual(disabledByEnv.getActiveTools(), ['read', 'bash']);

			process.env[envVar] = '1';

			const enabledByEnv = makeFakeApi(
				['read', 'bash', 'workflow'],
			);

			workflowsExtension(enabledByEnv.api);

			const enableHandler = enabledByEnv.commands.get('workflows')?.handler;

			assert.ok(enableHandler);
			void enableHandler?.(
				'disable',
				{
					ui: { notify: () => undefined },
				} as unknown as ExtensionCommandContext,
			);
			assert.deepEqual(enabledByEnv.getActiveTools(), ['read', 'bash', 'workflow']);
		});
	} finally {
		if (previous === undefined) {
			delete process.env[envVar];
		} else {
			process.env[envVar] = previous;
		}
	}
});
