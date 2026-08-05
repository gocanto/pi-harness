import { configDefaults, defineConfig } from 'vitest/config';

// Relative because Vite loads this file before `resolve.alias` is in effect.
import { aliasMap, repoRoot } from './scripts/aliases.ts';

/** Shared test discovery for all extension concern slices. */
export default defineConfig({
	root: repoRoot,
	resolve: { alias: aliasMap() },
	test: {
		include: ['extensions/**/*.test.ts', 'extensions/**/*.spec.ts'],
		// `exclude` replaces the defaults rather than merging, so the defaults
		// (node_modules, dist, ...) have to be carried over explicitly -- the
		// include glob would otherwise reach into per-extension node_modules.
		// The two named files are live provider smoke tests; they run via
		// vitest.live.config.ts, which requires the real claude/codex CLIs.
		exclude: [...configDefaults.exclude, 'extensions/subagents/claude.test.ts', 'extensions/subagents/codex.test.ts'],
		environment: 'node',
		testTimeout: 15_000,
		hookTimeout: 15_000,
		// Suites share process-level state (env vars, the agent directory, real
		// child processes), so they cannot safely run in parallel files.
		fileParallelism: false,
		coverage: {
			provider: 'v8',
			reportsDirectory: 'coverage',
			reporter: ['text-summary', 'lcov'],
			include: ['extensions/**/*.ts'],
			exclude: ['extensions/**/*.test.ts', 'extensions/**/*.spec.ts'],
		},
	},
});
