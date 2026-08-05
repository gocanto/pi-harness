import type { PullRequestInfo } from '@shared/dashboard-state.ts';
import { liveCommandRunner, type CommandRunner } from '@git-info/src/process.ts';

function parsePullRequest(value: unknown) {
	if (typeof value !== 'object' || value === null) {
		return null;
	}

	if (!('number' in value) || typeof value.number !== 'number') {
		return null;
	}

	if (!('url' in value) || typeof value.url !== 'string') {
		return null;
	}

	if (!('state' in value) || value.state !== 'OPEN') {
		return null;
	}

	return {
		number: value.number,
		url: value.url,
		isDraft: 'isDraft' in value && value.isDraft === true,
	} satisfies PullRequestInfo;
}

function parsePullRequestJson(value: string) {
	try {
		return parsePullRequest(
			JSON.parse(value),
		);
	} catch {
		return null;
	}
}

/** Outcome of a `gh pr view` lookup. */
export type PullRequestLookupResult = { readonly _tag: 'found'; readonly pullRequest: PullRequestInfo } | { readonly _tag: 'notFound' } | { readonly _tag: 'failed' };

/** Look up the open pull request for a branch via `gh pr view`. */
export async function lookupPullRequest(cwd: string, branch: string, timeout: number, signal?: AbortSignal, runner: CommandRunner = liveCommandRunner) {
	const result = await runner.run('gh', ['pr', 'view', branch, '--json', 'number,url,state,isDraft'], cwd, timeout, signal);

	if (result.code !== 0) {
		return { _tag: 'failed' } satisfies PullRequestLookupResult;
	}

	const pullRequest = parsePullRequestJson(result.stdout);

	if (pullRequest) {
		return { _tag: 'found', pullRequest } satisfies PullRequestLookupResult;
	}

	return { _tag: 'notFound' } satisfies PullRequestLookupResult;
}

/** Tracks which branch has a confirmed pull-request lookup result. */
export class PullRequestQueryTracker {
	private queriedBranch: string | null = null;

	constructor(private readonly runner: CommandRunner = liveCommandRunner) {}

	/** Whether `branch` differs from the last branch with a confirmed lookup. */
	hasChanged(branch: string) {
		return branch !== this.queriedBranch;
	}

	/** Record that `branch` was successfully queried. */
	recordSuccess(branch: string) {
		this.queriedBranch = branch;
	}

	/** Clear the tracked branch so the next lookup is attempted. */
	reset() {
		this.queriedBranch = null;
	}

	/** Query `branch` when required, or skip it when its result is confirmed. */
	queryIfNeeded(cwd: string, branch: string, timeout: number, force: boolean, signal?: AbortSignal) {
		if (!force && !this.hasChanged(branch)) {
			return Promise.resolve(null);
		}

		return lookupPullRequest(cwd, branch, timeout, signal, this.runner);
	}
}
