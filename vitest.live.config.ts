import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Configuration for provider smoke tests that require local CLIs. */
export default defineConfig(
	{
		root: fileURLToPath(new URL('.', import.meta.url)),
		test: {
			include: ['extensions/subagents/claude.test.ts', 'extensions/subagents/codex.test.ts'],
			environment: 'node',
			testTimeout: 15_000,
			hookTimeout: 15_000,
			fileParallelism: false,
		},
	},
);
