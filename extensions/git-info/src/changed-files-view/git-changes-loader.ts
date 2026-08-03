import { basename } from 'node:path';
import { Effect } from 'effect';
import { runCommand } from '../process.ts';
import { TerminalText } from './terminal-text.ts';
import type { ChangedFile, ChangedFilesResult, ChangedPath, DiffLoadResult } from './types.ts';

const COMMAND_TIMEOUT_MS = 10_000;
const STATS_CONCURRENCY = 8;

/** Exported so callers can assert the documented truncation bound. */
export const MAX_DIFF_LINES = 20_000;

/** Git parsing and lazy changed-file loading concern. */
export class GitChangesLoader {
	/** Load changed paths and cheap per-file statistics. */
	static loadChangedFiles(cwd: string) {
		return Effect.gen(function* () {
			const rootResult = yield* GitChangesLoader.run(cwd, ['rev-parse', '--show-toplevel']);

			if (rootResult.code !== 0) {
				return null;
			}

			const repoRoot = rootResult.stdout.trim();

			const [statusResult, headResult] = yield* Effect.all(
				[GitChangesLoader.run(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']), GitChangesLoader.run(repoRoot, ['rev-parse', '--verify', 'HEAD'])],
				{ concurrency: 'unbounded' },
			);

			if (statusResult.code !== 0) {
				return null;
			}

			const changedPaths = GitChangesLoader.parseChangedPaths(statusResult.stdout);
			const hasHead = headResult.code === 0;

			const files = yield* Effect.all(
				changedPaths.map((changedPath) => GitChangesLoader.loadFileStats(repoRoot, changedPath, hasHead)),
				{ concurrency: STATS_CONCURRENCY },
			);

			return { files, hasHead, repoRoot } satisfies ChangedFilesResult;
		});
	}

	/** Load one changed file's textual diff, retaining at most MAX_DIFF_LINES lines. */
	static loadFileDiff(repoRoot: string, file: Pick<ChangedFile, 'rawPath' | 'status'>, hasHead: boolean) {
		return Effect.gen(function* () {
			const diffResult = yield* GitChangesLoader.run(repoRoot, GitChangesLoader.diffArguments(file.rawPath, file.status, hasHead));

			if (diffResult.code !== 0) {
				const reason = TerminalText.sanitize(diffResult.stderr).trim() || `git exited with code ${diffResult.code}`;

				return { _tag: 'unavailable', message: `Diff unavailable: ${reason}` } satisfies DiffLoadResult;
			}

			const allDiffLines = diffResult.stdout.trimEnd()
				.split('\n')
				.map(TerminalText.sanitize);

			const diff = allDiffLines.length > MAX_DIFF_LINES ? [...allDiffLines.slice(0, MAX_DIFF_LINES), `… diff truncated after ${MAX_DIFF_LINES.toLocaleString()} lines …`] : allDiffLines;

			return { _tag: 'loaded', lines: diff.length === 1 && diff[0] === '' ? ['No textual diff available.'] : diff } satisfies DiffLoadResult;
		});
	}

	private static loadFileStats(repoRoot: string, changedPath: ChangedPath, hasHead: boolean) {
		return Effect.gen(function* () {
			const statResult = yield* GitChangesLoader.run(repoRoot, GitChangesLoader.statArguments(changedPath.path, changedPath.status, hasHead));
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
		});
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

	private static run(cwd: string, args: string[]) {
		return runCommand('git', args, cwd, COMMAND_TIMEOUT_MS);
	}
}
