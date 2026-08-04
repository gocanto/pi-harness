import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

const aliases = {
	'@tests': resolve(root, 'tests'),
	'@shared': resolve(root, 'extensions/shared'),
	'@ask-user': resolve(root, 'extensions/ask-user'),
	'@background-terminals': resolve(root, 'extensions/background-terminals'),
	'@copy-all': resolve(root, 'extensions/copy-all'),
	'@file-search': resolve(root, 'extensions/file-search'),
	'@git-info': resolve(root, 'extensions/git-info'),
	'@model-info': resolve(root, 'extensions/model-info'),
	'@subagents': resolve(root, 'extensions/subagents'),
	'@summaries': resolve(root, 'extensions/summaries'),
	'@ui-customization': resolve(root, 'extensions/ui-customization'),
	'@workflows': resolve(root, 'extensions/workflows'),
};

/** Shared test discovery for all extension concern slices. */
export default defineConfig(
	{
		root,
		resolve: { alias: aliases },
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
