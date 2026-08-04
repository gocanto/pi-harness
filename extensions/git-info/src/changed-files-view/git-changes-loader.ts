import { basename } from 'node:path';
import { liveCommandRunner, type CommandRunner } from '@git-info/src/process.ts';
import { TerminalText } from '@git-info/src/changed-files-view/terminal-text.ts';
import type { ChangedFile, ChangedFilesResult, ChangedPath, DiffLoadResult } from '@git-info/src/changed-files-view/types.ts';

const COMMAND_TIMEOUT_MS = 10_000;
const STATS_CONCURRENCY = 8;

/** Exported so callers can assert the documented truncation bound. */
export const MAX_DIFF_LINES = 20_000;

async function mapWithConcurrency<T, U>(items: readonly T[], concurrency: number, operation: (item: T) => Promise<U>) {
	const results: U[] = [];

	let nextIndex = 0;

	async function worker() {
		while (nextIndex < items.length) {
			const index = nextIndex;

			nextIndex += 1;

			results[index] = await operation(items[index]);
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));

	return results;
}

/** Git parsing and lazy changed-file loading concern. */
export class GitChangesLoader {
	constructor(private readonly runner: CommandRunner = liveCommandRunner) {}

	/** Load changed paths and cheap per-file statistics. */
	async loadChangedFiles(cwd: string, signal?: AbortSignal) {
		const rootResult = await this.run(cwd, ['rev-parse', '--show-toplevel'], signal);

		if (rootResult.code !== 0) {
			return null;
		}

		const repoRoot = rootResult.stdout.trim();

		const [statusResult, headResult] = await Promise.all([
			this.run(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal),
			this.run(repoRoot, ['rev-parse', '--verify', 'HEAD'], signal),
		]);

		if (statusResult.code !== 0) {
			return null;
		}

		const changedPaths = GitChangesLoader.parseChangedPaths(statusResult.stdout);
		const hasHead = headResult.code === 0;

		const files = await mapWithConcurrency(changedPaths, STATS_CONCURRENCY, (changedPath) => this.loadFileStats(repoRoot, changedPath, hasHead, signal));

		return { files, hasHead, repoRoot } satisfies ChangedFilesResult;
	}

	/** Load one changed file's textual diff, retaining at most MAX_DIFF_LINES lines. */
	async loadFileDiff(repoRoot: string, file: Pick<ChangedFile, 'rawPath' | 'status'>, hasHead: boolean, signal?: AbortSignal) {
		const diffResult = await this.run(repoRoot, GitChangesLoader.diffArguments(file.rawPath, file.status, hasHead), signal);

		if (diffResult.code !== 0) {
			const reason = TerminalText.sanitize(diffResult.stderr).trim() || `git exited with code ${diffResult.code}`;

			return { _tag: 'unavailable', message: `Diff unavailable: ${reason}` } satisfies DiffLoadResult;
		}

		const allDiffLines = diffResult.stdout.trimEnd()
			.split('\n')
			.map(TerminalText.sanitize);

		const diff = allDiffLines.length > MAX_DIFF_LINES ? [...allDiffLines.slice(0, MAX_DIFF_LINES), `… diff truncated after ${MAX_DIFF_LINES.toLocaleString()} lines …`] : allDiffLines;

		return { _tag: 'loaded', lines: diff.length === 1 && diff[0] === '' ? ['No textual diff available.'] : diff } satisfies DiffLoadResult;
	}

	private async loadFileStats(repoRoot: string, changedPath: ChangedPath, hasHead: boolean, signal?: AbortSignal) {
		const statResult = await this.run(repoRoot, GitChangesLoader.statArguments(changedPath.path, changedPath.status, hasHead), signal);

		const line = statResult.stdout.split('\n').find(Boolean);
		const [added, deleted] = line?.split('\t') ?? [];

		const stats = !line
			? { additions: 0, deletions: 0 }
			: {
					additions: added === '-' ? null : Number.parseInt(added ?? '0', 10),
					deletions: deleted === '-' ? null : Number.parseInt(deleted ?? '0', 10),
				};

		return {
			...stats,
			name: TerminalText.cleanDisplayPath(basename(changedPath.path)),
			path: TerminalText.cleanDisplayPath(changedPath.path),
			rawPath: changedPath.path,
			status: changedPath.status,
		} satisfies ChangedFile;
	}

	private run(cwd: string, args: readonly string[], signal?: AbortSignal) {
		return this.runner.run('git', args, cwd, COMMAND_TIMEOUT_MS, signal);
	}

	private static parseChangedPaths(output: string) {
		const records = output.split('\0');
		const paths: ChangedPath[] = [];

		for (let index = 0; index < records.length; index += 1) {
			const record = records[index];

			if (!record || record.length < 4) {
				continue;
			}

			const status = record.slice(0, 2);

			paths.push({ path: record.slice(3), status });
			if (status.includes('R') || status.includes('C')) {
				index += 1;
			}
		}

		return [...new Map(paths.map((entry) => [entry.path, entry])).values()];
	}

	private static usesNoIndexDiff(status: string, hasHead: boolean) {
		return status === '??' || !hasHead;
	}

	private static statArguments(path: string, status: string, hasHead: boolean) {
		return GitChangesLoader.usesNoIndexDiff(status, hasHead) ? ['diff', '--no-index', '--numstat', '--', '/dev/null', path] : ['diff', '--numstat', 'HEAD', '--', path];
	}

	private static diffArguments(path: string, status: string, hasHead: boolean) {
		return GitChangesLoader.usesNoIndexDiff(status, hasHead)
			? ['diff', '--no-index', '--no-ext-diff', '--no-color', '--unified=3', '--', '/dev/null', path]
			: ['diff', '--no-ext-diff', '--no-color', '--unified=3', 'HEAD', '--', path];
	}
}

const defaultLoader = new GitChangesLoader();

/** Load changed files and their cheap per-file statistics. */
export function loadChangedFiles(cwd: string, signal?: AbortSignal) {
	return defaultLoader.loadChangedFiles(cwd, signal);
}

/** Load a selected file's textual diff lazily. */
export function loadFileDiff(repoRoot: string, file: Pick<ChangedFile, 'rawPath' | 'status'>, hasHead: boolean, signal?: AbortSignal) {
	return defaultLoader.loadFileDiff(repoRoot, file, hasHead, signal);
}
