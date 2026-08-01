import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Shared test discovery for all extension concern slices. */
export default defineConfig(
	{
		root: fileURLToPath(new URL('.', import.meta.url)),
		test: {
			include: ['extensions/**/*.test.ts', 'extensions/**/*.spec.ts'],
			exclude: ['extensions/subagents/claude.test.ts', 'extensions/subagents/codex.test.ts'],
			environment: 'node',
			testTimeout: 15_000,
			hookTimeout: 15_000,
			fileParallelism: false,
		},
	},
);
