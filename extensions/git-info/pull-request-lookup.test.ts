import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer } from "effect";
import { CommandRunner, type CommandResult } from "./src/process.ts";
import {
  lookupPullRequest,
  PullRequestQueryTracker,
  type PullRequestLookupResult,
} from "./src/pull-request-lookup.ts";

const OPEN_PR = {
  number: 42,
  url: "https://github.com/acme/repo/pull/42",
  state: "OPEN",
  isDraft: false,
};

function fixture(result: CommandResult) {
  return Layer.succeed(
    CommandRunner,
    CommandRunner.of({ run: () => Effect.succeed(result) }),
  );
}

function runWithFixture<A>(
  effect: Effect.Effect<A, never, CommandRunner>,
  result: CommandResult,
) {
  return Effect.runPromise(effect.pipe(Effect.provide(fixture(result))));
}

test("lookupPullRequest: reports the open PR when gh succeeds", async () => {
  const lookup = await runWithFixture(
    lookupPullRequest("/repo", "feature", 1_000),
    { code: 0, stdout: JSON.stringify(OPEN_PR), stderr: "" },
  );
  assert.deepEqual(lookup, {
    _tag: "found",
    pullRequest: { number: 42, url: OPEN_PR.url, isDraft: false },
  });
});

test("lookupPullRequest: a confirmed absence of an open PR is not a failure", async () => {
  const lookup = await runWithFixture(
    lookupPullRequest("/repo", "feature", 1_000),
    {
      code: 0,
      stdout: JSON.stringify({ ...OPEN_PR, state: "MERGED" }),
      stderr: "",
    },
  );
  assert.deepEqual(lookup, { _tag: "notFound" });
});

test("lookupPullRequest: a nonzero gh exit is a failure, not a confirmed absence", async () => {
  const lookup = await runWithFixture(
    lookupPullRequest("/repo", "feature", 1_000),
    { code: 1, stdout: "", stderr: "authentication required" },
  );
  assert.deepEqual(lookup, { _tag: "failed" });
});

test("lookupPullRequest: a timed-out command (code -1) is a failure", async () => {
  const lookup = await runWithFixture(
    lookupPullRequest("/repo", "feature", 1_000),
    { code: -1, stdout: "", stderr: "" },
  );
  assert.deepEqual(lookup, { _tag: "failed" });
});

test("PullRequestQueryTracker: reports changed before any confirmed lookup", () => {
  const tracker = new PullRequestQueryTracker();
  assert.equal(tracker.hasChanged("main"), true);
});

test("PullRequestQueryTracker: stops reporting changed after a confirmed lookup", () => {
  const tracker = new PullRequestQueryTracker();
  tracker.recordSuccess("main");
  assert.equal(tracker.hasChanged("main"), false);
});

test("PullRequestQueryTracker: reports changed again for a different branch", () => {
  const tracker = new PullRequestQueryTracker();
  tracker.recordSuccess("main");
  assert.equal(tracker.hasChanged("feature"), true);
});

test("PullRequestQueryTracker: reset makes every branch report changed", () => {
  const tracker = new PullRequestQueryTracker();
  tracker.recordSuccess("main");
  tracker.reset();
  assert.equal(tracker.hasChanged("main"), true);
});

/**
 * Mirrors the real caller contract in `index.ts`: run `queryIfNeeded`, then
 * only record success for the outcome, exactly as the caller would after
 * its own generation check. Tests pass `stale: true` to simulate a refresh
 * that was superseded before its lookup resolved, so `recordSuccess` is
 * skipped even though the command itself completed.
 */
function pollOnce(
  tracker: PullRequestQueryTracker,
  branch: string,
  force: boolean,
  layer: Layer.Layer<CommandRunner>,
  options: { stale?: boolean } = {},
) {
  return Effect.runPromise(
    tracker.queryIfNeeded("/repo", branch, 1_000, force).pipe(
      Effect.tap((lookup) =>
        Effect.sync(() => {
          if (!options.stale && lookup !== null && lookup._tag !== "failed") {
            tracker.recordSuccess(branch);
          }
        }),
      ),
      Effect.provide(layer),
    ),
  );
}

test("queryIfNeeded: a transient gh failure retries on a later call instead of sticking", async () => {
  const tracker = new PullRequestQueryTracker();
  const responses: CommandResult[] = [
    { code: 1, stdout: "", stderr: "timed out" },
    { code: 0, stdout: JSON.stringify(OPEN_PR), stderr: "" },
  ];
  let calls = 0;
  const layer = Layer.succeed(
    CommandRunner,
    CommandRunner.of({
      run: () => {
        const response = responses[calls];
        calls += 1;
        // SAFETY: `responses` is sized to the number of calls this test makes.
        return Effect.succeed(response as CommandResult);
      },
    }),
  );

  // First poll on a newly seen branch: attempted, but the command fails, so
  // the branch is not recorded as confirmed.
  const first = await pollOnce(tracker, "feature", false, layer);
  assert.deepEqual(first, { _tag: "failed" });
  assert.equal(tracker.hasChanged("feature"), true);

  // A later poll (still not forced) retries automatically because the
  // branch was never confirmed.
  const second = await pollOnce(tracker, "feature", false, layer);
  assert.deepEqual(second satisfies PullRequestLookupResult | null, {
    _tag: "found",
    pullRequest: { number: 42, url: OPEN_PR.url, isDraft: false },
  });
  assert.equal(tracker.hasChanged("feature"), false);
  assert.equal(calls, 2);
});

test("queryIfNeeded: a confirmed no-PR result does not retry on every later poll", async () => {
  const tracker = new PullRequestQueryTracker();
  let calls = 0;
  const layer = Layer.succeed(
    CommandRunner,
    CommandRunner.of({
      run: () => {
        calls += 1;
        return Effect.succeed({
          code: 0,
          stdout: JSON.stringify({ ...OPEN_PR, state: "CLOSED" }),
          stderr: "",
        });
      },
    }),
  );

  const first = await pollOnce(tracker, "feature", false, layer);
  assert.deepEqual(first, { _tag: "notFound" });

  // Repeated polling on the same, unchanged branch does not call `gh`
  // again: the branch was confirmed queried.
  const second = await pollOnce(tracker, "feature", false, layer);
  assert.equal(second, null);
  assert.equal(calls, 1);
});

test("queryIfNeeded: a branch change re-queries even after a confirmed result", async () => {
  const tracker = new PullRequestQueryTracker();
  let calls = 0;
  const layer = Layer.succeed(
    CommandRunner,
    CommandRunner.of({
      run: () => {
        calls += 1;
        return Effect.succeed({
          code: 0,
          stdout: JSON.stringify(OPEN_PR),
          stderr: "",
        });
      },
    }),
  );

  await pollOnce(tracker, "main", false, layer);
  assert.equal(calls, 1);

  await pollOnce(tracker, "feature", false, layer);
  assert.equal(calls, 2);
  assert.equal(tracker.hasChanged("feature"), false);
  assert.equal(tracker.hasChanged("main"), true);
});

test("queryIfNeeded: an explicit /pr force re-queries an already-confirmed branch", async () => {
  const tracker = new PullRequestQueryTracker();
  tracker.recordSuccess("main");
  let calls = 0;
  const layer = Layer.succeed(
    CommandRunner,
    CommandRunner.of({
      run: () => {
        calls += 1;
        return Effect.succeed({
          code: 0,
          stdout: JSON.stringify(OPEN_PR),
          stderr: "",
        });
      },
    }),
  );

  const forced = await pollOnce(tracker, "main", true, layer);

  assert.deepEqual(forced, {
    _tag: "found",
    pullRequest: { number: 42, url: OPEN_PR.url, isDraft: false },
  });
  assert.equal(calls, 1);
});

test("queryIfNeeded: a superseded (stale) refresh's completed lookup does not confirm the branch", async () => {
  const tracker = new PullRequestQueryTracker();
  const layer = Layer.succeed(
    CommandRunner,
    CommandRunner.of({
      run: () =>
        Effect.succeed({
          code: 0,
          stdout: JSON.stringify(OPEN_PR),
          stderr: "",
        }),
    }),
  );

  // A refresh starts, is superseded (e.g. by session_start) before its `gh`
  // call resolves. A real caller re-checks its generation after the yield
  // and skips `recordSuccess` for a superseded attempt (`stale: true`
  // simulates that skip) — otherwise a late-arriving stale result could
  // resurrect tracking state right after a `reset()`.
  const lookup = await pollOnce(tracker, "main", false, layer, {
    stale: true,
  });

  assert.deepEqual(lookup, {
    _tag: "found",
    pullRequest: { number: 42, url: OPEN_PR.url, isDraft: false },
  });
  // Despite the successful command, the branch was never confirmed because
  // the caller treated the attempt as stale.
  assert.equal(tracker.hasChanged("main"), true);
});
