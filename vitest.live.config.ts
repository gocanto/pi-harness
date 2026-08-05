import { defineConfig } from 'vitest/config';

// Relative because Vite loads this file before `resolve.alias` is in effect.
import { aliasMap, repoRoot } from './scripts/aliases.ts';

/** Configuration for provider smoke tests that require local CLIs. */
export default defineConfig(
	{
		root: repoRoot,
		resolve: { alias: aliasMap() },
		test: {
			include: ['extensions/subagents/claude.test.ts', 'extensions/subagents/codex.test.ts'],
			environment: 'node',
			testTimeout: 15_000,
			hookTimeout: 15_000,
			fileParallelism: false,
		},
	},
);
