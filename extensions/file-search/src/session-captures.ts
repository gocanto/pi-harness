/**
 * Tracks fd/rg full-output capture directories returned to the model during
 * a session so they can be removed once the session ends. The full-output
 * pointer is preserved (never mutated or logged) until `cleanup()` runs; the
 * registry only ever deletes directories it was explicitly told to track,
 * and `cleanup()` is safe to call more than once.
 */

import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Removes a directory recursively; injected so tests can observe/fake it. */
export type CaptureRemover = (directory: string) => Promise<void>;

const defaultRemove: CaptureRemover = (directory) => rm(
	directory,
	{ recursive: true, force: true },
);

export interface SessionCaptureRegistry {
	/** Record a full-output file's directory for removal at session shutdown. */
	track(fullOutputPath: string): void;
	/**
	 * Remove every tracked capture directory and clear the registry. Safe to
	 * call repeatedly: a second call has nothing left to remove.
	 */
	cleanup(): Promise<void>;
	/** Number of directories currently tracked (for tests/diagnostics). */
	readonly size: number;
}

/**
 * Create a registry of session-scoped capture directories.
 *
 * @param remove - Directory remover; defaults to a recursive, idempotent `fs.rm`.
 */
export function createSessionCaptureRegistry(remove: CaptureRemover = defaultRemove): SessionCaptureRegistry {
	const tracked = new Set<string>();

	return {
		track(fullOutputPath) {
			tracked.add(dirname(fullOutputPath));
		},
		async cleanup() {
			const directories = [...tracked];

			tracked.clear();

			await Promise.all(directories.map((directory) => remove(directory)));
		},
		get size() {
			return tracked.size;
		},
	};
}
