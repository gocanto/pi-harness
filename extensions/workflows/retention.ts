import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Retention policy: workflow run artifacts (transcripts, results, scripts)
 * are swept once they are older than this window. Sweeps run opportunistically
 * on session start, are idempotent, and never remove a run tracked as active
 * by the current process.
 */
export const WORKFLOW_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

interface PersistedWorkflowSummary {
  finishedAt?: unknown;
  startedAt?: unknown;
}

/** Age of a run, preferring its recorded finish/start time and falling back to directory mtime. */
function runAgeMs(runDir: string, now: number): number | undefined {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(runDir, "workflow.json"), "utf8"),
    ) as PersistedWorkflowSummary;
    const reference =
      typeof raw.finishedAt === "number"
        ? raw.finishedAt
        : typeof raw.startedAt === "number"
          ? raw.startedAt
          : undefined;
    if (reference !== undefined) return now - reference;
  } catch {
    // Missing or unreadable workflow.json; fall through to directory mtime.
  }
  try {
    return now - fs.statSync(runDir).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Remove workflow run directories once they exceed the retention window.
 *
 * Runs referenced by `activeRunIds` (tracked in-memory by the current
 * process) are always preserved regardless of age. Runs whose age cannot be
 * determined (unreadable artifacts and an unreadable directory) are left in
 * place rather than guessed at. Missing directories, concurrent deletion, and
 * repeated calls are all safe: this function only ever removes what it can
 * currently see and never throws on a single run's cleanup failure.
 *
 * @param baseDir - The `workflows` directory containing one subdirectory per run.
 * @param activeRunIds - Run ids the current process still considers live.
 * @param options - Overrides for the retention window and current time (for tests).
 * @returns The run ids that were removed.
 */
export function cleanupExpiredWorkflowRuns(
  baseDir: string,
  activeRunIds: ReadonlySet<string>,
  options: { retentionMs?: number; now?: number } = {},
): string[] {
  const retentionMs = Math.max(0, options.retentionMs ?? WORKFLOW_RETENTION_MS);
  const now = options.now ?? Date.now();

  let names: string[] = [];
  try {
    names = fs.readdirSync(baseDir).filter((name) => name.startsWith("wf_"));
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const runId of names) {
    if (activeRunIds.has(runId)) continue;
    const runDir = path.join(baseDir, runId);
    const age = runAgeMs(runDir, now);
    if (age === undefined || age < retentionMs) continue;
    try {
      fs.rmSync(runDir, { recursive: true, force: true });
      removed.push(runId);
    } catch {
      // Leave it for the next sweep rather than failing the whole batch.
    }
  }
  return removed;
}
