import * as fs from 'node:fs';
import * as path from 'node:path';

let cachedBinary: string | null | undefined;

/** Resolve the Codex executable once and reuse the result for this process. */
export class CodexBinaryResolver {
	/** Return an executable Codex path, or undefined when unavailable. */
	resolve() {
		if (cachedBinary !== undefined) {
			return cachedBinary ?? undefined;
		}

		const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'];

		for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
			if (!directory) {
				continue;
			}

			for (const name of names) {
				const candidate = path.join(directory, name);

				try {
					fs.accessSync(candidate, fs.constants.X_OK);
					cachedBinary = candidate;

					return candidate;
				} catch {
					// Continue searching PATH.
				}
			}
		}

		cachedBinary = null;

		return undefined;
	}
}
