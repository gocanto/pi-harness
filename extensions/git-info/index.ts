import { PullRequestQueryTracker } from '@git-info/src/pull-request-lookup.ts';
import { liveCommandRunner } from '@git-info/src/process.ts';
import { makeRefreshCoordinator } from '@git-info/src/refresh-coordinator.ts';
import { runWithCancellation } from '@git-info/src/runtime.ts';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { emptyGitInfoState, GIT_INFO_CHANNEL, REFRESH_CHANNEL } from '@shared/dashboard-state.ts';

import { loadChangedFiles, loadFileDiff, showChangedFiles, type ChangedFile } from '@git-info/src/changed-files-view.ts';

const POLL_INTERVAL_MS = 3_000;
const GIT_TIMEOUT_MS = 3_000;
const GH_TIMEOUT_MS = 10_000;

function countChangedFiles(status: string) {
	if (!status.trim()) {
		return 0;
	}

	return status.split('\n').filter(Boolean).length;
}

function isAborted(error: unknown) {
	return error instanceof DOMException && error.name === 'AbortError';
}

function reportBackgroundError(error: unknown) {
	if (!isAborted(error)) {
		console.error('git-info background task failed', error);
	}
}

export default function gitInfo(pi: ExtensionAPI) {
	let state = emptyGitInfoState();
	let currentContext: ExtensionContext | undefined;
	let sessionAbortController: AbortController | undefined;
	let pollingTimer: ReturnType<typeof setInterval> | undefined;
	let generation = 0;

	const prQueryTracker = new PullRequestQueryTracker();
	const refreshCoordinator = makeRefreshCoordinator();
	const publish = () => pi.events.emit(GIT_INFO_CHANNEL, { ...state });
	const run = (command: string, args: readonly string[], ctx: ExtensionContext, timeout: number, signal?: AbortSignal) => liveCommandRunner.run(command, args, ctx.cwd, timeout, signal);

	const refreshAsync = async (ctx: ExtensionContext, forcePullRequest: boolean, refreshGeneration: number, signal?: AbortSignal) => {
		if (refreshGeneration !== generation) {
			return;
		}

		currentContext = ctx;

		const repo = await run(
			'git',
			['rev-parse', '--is-inside-work-tree'],
			ctx,
			GIT_TIMEOUT_MS,
			signal,
		);

		if (refreshGeneration !== generation) {
			return;
		}

		if (repo.code !== 0 || repo.stdout.trim() !== 'true') {
			prQueryTracker.reset();
			state = emptyGitInfoState();
			publish();

			return;
		}

		const [branchResult, headResult, statusResult] = await Promise.all([
			run('git', ['branch', '--show-current'], ctx, GIT_TIMEOUT_MS, signal),
			run('git', ['rev-parse', '--short', 'HEAD'], ctx, GIT_TIMEOUT_MS, signal),
			run('git', ['status', '--porcelain=v1', '--untracked-files=all'], ctx, GIT_TIMEOUT_MS, signal),
		]);

		if (refreshGeneration !== generation) {
			return;
		}

		const branchName = branchResult.stdout.trim();
		const shortHead = headResult.stdout.trim();

		const branch = branchName || (shortHead ? `detached@${shortHead}` : 'detached');

		const branchChanged = prQueryTracker.hasChanged(branchName);

		state = {
			...state,
			isRepository: true,
			branch,
			changedFiles: statusResult.code === 0 ? countChangedFiles(statusResult.stdout) : 0,
			pullRequest: branchChanged ? null : state.pullRequest,
		};
		publish();

		if (!branchName) {
			prQueryTracker.reset();

			return;
		}

		const lookup = await prQueryTracker.queryIfNeeded(ctx.cwd, branchName, GH_TIMEOUT_MS, forcePullRequest, signal);

		if (refreshGeneration !== generation) {
			return;
		}

		if (lookup === null || lookup._tag === 'failed') {
			return;
		}

		prQueryTracker.recordSuccess(branchName);
		state = {
			...state,
			pullRequest: lookup._tag === 'found' ? lookup.pullRequest : null,
		};
		publish();
	};

	const refresh = (ctx: ExtensionContext, forcePullRequest = false, signal?: AbortSignal) => refreshCoordinator.run(() => refreshAsync(ctx, forcePullRequest, generation, signal));
	const refreshIfIdle = (ctx: ExtensionContext) => refreshCoordinator.runIfIdle(() => refreshAsync(ctx, false, generation, sessionAbortController?.signal));

	const refreshInBackground = (ctx: ExtensionContext) => {
		void refreshIfIdle(ctx).catch(reportBackgroundError);
	};

	const stopPolling = () => {
		if (pollingTimer !== undefined) {
			clearInterval(pollingTimer);
		}

		pollingTimer = undefined;
	};

	const stopRefreshListener = pi.events.on(REFRESH_CHANNEL, () => {
		if (currentContext) {
			refreshInBackground(currentContext);
		}
	});

	pi.on('session_start', (_event, ctx) => {
		generation += 1;
		prQueryTracker.reset();
		stopPolling();
		sessionAbortController?.abort();
		sessionAbortController = new AbortController();
		currentContext = ctx;

		// Do not block Pi startup on GitHub/network I/O. The initial refresh publishes
		// state when it completes; polling continues to keep it current afterwards.
		refreshInBackground(ctx);
		pollingTimer = setInterval(() => refreshInBackground(ctx), POLL_INTERVAL_MS);
	});

	pi.on('input', (_event, ctx) => {
		refreshInBackground(ctx);

		return { action: 'continue' };
	});

	pi.on('tool_execution_end', (_event, ctx) => {
		refreshInBackground(ctx);
	});

	pi.on('session_shutdown', () => {
		stopRefreshListener();
		stopPolling();
		generation += 1;
		currentContext = undefined;
		sessionAbortController?.abort();
		sessionAbortController = undefined;
	});

	pi.registerCommand('lg', {
		description: 'Browse changed files and their diffs',
		handler: async (_args, ctx) => {
			if (ctx.mode !== 'tui') {
				ctx.ui.notify('The local changes viewer requires the interactive TUI', 'warning');

				return;
			}

			const result = await runWithCancellation(
				loadChangedFiles(ctx.cwd, ctx.signal),
				ctx.signal,
				'Loading changed files was cancelled.',
			);

			if (result === null) {
				ctx.ui.notify('Not a git repository', 'warning');

				return;
			}

			if (result.files.length === 0) {
				ctx.ui.notify('Working tree is clean', 'info');

				return;
			}

			const loadDiff = (file: ChangedFile, signal: AbortSignal) => runWithCancellation(
				loadFileDiff(result.repoRoot, file, result.hasHead, signal),
				signal,
				'Diff loading was cancelled.',
			);

			await showChangedFiles(ctx, result, loadDiff);
		},
	});

	pi.registerCommand('pr', {
		description: 'Refresh git and pull request information',
		handler: async (_args, ctx) => {
			await runWithCancellation(
				refresh(ctx, true, ctx.signal),
				ctx.signal,
				'Git and pull request refresh was cancelled.',
			);

			if (!state.isRepository) {
				ctx.ui.notify('Not a git repository', 'warning');
			} else if (state.pullRequest) {
				ctx.ui.notify(`PR #${state.pullRequest.number}: ${state.pullRequest.url}`, 'info');
			} else {
				ctx.ui.notify(`No open PR found for ${state.branch}`, 'info');
			}
		},
	});
}
