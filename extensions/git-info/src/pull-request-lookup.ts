import { Effect } from "effect";
import type { PullRequestInfo } from "../../shared/dashboard-state.ts";
import { runCommand, type CommandRunner } from "./process.ts";

function parsePullRequest(value: unknown) {
  if (typeof value !== "object" || value === null) return null;
  if (!("number" in value) || typeof value.number !== "number") return null;
  if (!("url" in value) || typeof value.url !== "string") return null;
  if (!("state" in value) || value.state !== "OPEN") return null;

  return {
    number: value.number,
    url: value.url,
    isDraft: "isDraft" in value && value.isDraft === true,
  } satisfies PullRequestInfo;
}

function parsePullRequestJson(value: string) {
  try {
    return parsePullRequest(JSON.parse(value));
  } catch {
    return null;
  }
}

/**
 * Outcome of a `gh pr view` lookup. `notFound` is a confirmed result (the
 * command succeeded but no open PR exists); `failed` means the command
 * itself did not complete (nonzero exit or timeout). Callers must not treat
 * `failed` the same as `notFound`: a `failed` lookup should not be recorded
 * as a successfully queried branch, so a later refresh retries it.
 */
export type PullRequestLookupResult =
  | { readonly _tag: "found"; readonly pullRequest: PullRequestInfo }
  | { readonly _tag: "notFound" }
  | { readonly _tag: "failed" };

/**
 * Look up the open pull request for `branch` via `gh pr view`.
 *
 * @param cwd - The working directory to run `gh` in.
 * @param branch - The branch to query.
 * @param timeout - The command timeout, in milliseconds.
 * @returns A tagged result distinguishing a found PR, a confirmed absence of
 *   an open PR, and a failed (nonzero exit or timed-out) command.
 */
export const lookupPullRequest = (
  cwd: string,
  branch: string,
  timeout: number,
): Effect.Effect<PullRequestLookupResult, never, CommandRunner> =>
  Effect.gen(function* () {
    const result = yield* runCommand(
      "gh",
      ["pr", "view", branch, "--json", "number,url,state,isDraft"],
      cwd,
      timeout,
    );
    if (result.code !== 0) return { _tag: "failed" };

    const pullRequest = parsePullRequestJson(result.stdout);
    return pullRequest ? { _tag: "found", pullRequest } : { _tag: "notFound" };
  });

/**
 * Tracks which branch has a confirmed pull-request lookup result.
 *
 * A branch counts as "queried" only after `recordSuccess` runs, which
 * happens only for a `found`/`notFound` lookup outcome. A `failed` lookup
 * (see {@link PullRequestLookupResult}) leaves the tracker unchanged, so
 * {@link hasChanged} keeps reporting a change for that branch until a lookup
 * succeeds, letting the next refresh retry automatically without exceeding
 * the caller's existing refresh cadence.
 */
export class PullRequestQueryTracker {
  private queriedBranch: string | null = null;

  /**
   * Whether `branch` differs from the last branch with a confirmed lookup
   * result. Also `true` before any lookup has succeeded, and after `reset`.
   *
   * @param branch - The current branch name.
   */
  hasChanged(branch: string): boolean {
    return branch !== this.queriedBranch;
  }

  /**
   * Record that `branch` was successfully queried (found or confirmed no
   * open PR), so {@link hasChanged} stops reporting a change for it.
   *
   * @param branch - The branch that was successfully queried.
   */
  recordSuccess(branch: string): void {
    this.queriedBranch = branch;
  }

  /**
   * Clear the tracked branch, e.g. on session restart, branch loss, or
   * leaving a repository. The next call to {@link hasChanged} reports a
   * change for any branch.
   */
  reset(): void {
    this.queriedBranch = null;
  }

  /**
   * Query `branch` when required — `force` is set, or the branch differs
   * from the last confirmed branch — otherwise skip the command entirely.
   *
   * This method does not itself call {@link recordSuccess}: the caller must
   * do that only after confirming its own attempt is still current (e.g.
   * after re-checking a session/refresh generation), so a lookup started
   * before a reset cannot resurrect stale tracking state once it resolves.
   *
   * @param cwd - The working directory to run `gh` in.
   * @param branch - The branch to query.
   * @param timeout - The command timeout, in milliseconds.
   * @param force - Query even when `branch` was already confirmed.
   * @returns The lookup result, or `null` when no query was necessary.
   */
  queryIfNeeded(
    cwd: string,
    branch: string,
    timeout: number,
    force: boolean,
  ): Effect.Effect<PullRequestLookupResult | null, never, CommandRunner> {
    if (!force && !this.hasChanged(branch)) return Effect.succeed(null);

    return lookupPullRequest(cwd, branch, timeout);
  }
}
