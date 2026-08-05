import * as fs from 'node:fs';
import * as path from 'node:path';

/** Resolves the user's Claude Code executable once per process. */
export class ClaudeBinaryResolver {
	private cached: string | null | undefined;

	/** Return an executable Claude Code path when one is available. */
	resolve() {
		if (this.cached !== undefined) {
			return this.cached ?? undefined;
		}

		const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];

		for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
			if (!directory) {
				continue;
			}
			for (const name of names) {
				const candidate = path.join(directory, name);

				try {
					fs.accessSync(candidate, fs.constants.X_OK);
					this.cached = candidate;

					return candidate;
				} catch {
					// Try the next PATH entry.
				}
			}
		}

		this.cached = null;

		return undefined;
	}
}
