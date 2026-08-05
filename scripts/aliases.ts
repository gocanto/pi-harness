/**
 * The alias layer, derived from `compilerOptions.paths` in tsconfig.json.
 *
 * Three consumers need the same mapping: the compiler (to typecheck), Vitest
 * (to resolve imports in tests), and the extension build (to inline aliased
 * modules into a bundle pi can load). tsconfig.json is the one declaration;
 * everything else reads it here. Hand-maintained copies drift, and the failure
 * they produce is the worst kind -- a new extension typechecks and tests
 * clean, then fails to resolve at runtime.
 *
 * This module is imported with relative specifiers because its consumers run
 * outside the alias layer: Vite loads its own config before `resolve.alias`
 * exists, and `scripts/` runs under bare Node, which resolves nothing.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(
	dirname(
		fileURLToPath(import.meta.url),
	),
	'..',
);

interface TsConfig {
	compilerOptions?: {
		paths?: Record<string, string[]>;
	};
}

/**
 * Alias prefix -> absolute directory, e.g. `@shared` -> `<root>/extensions/shared`.
 *
 * Only wildcard entries (`"@shared/*": ["./extensions/shared/*"]`) are
 * supported, because that is the only shape the repository uses and a silent
 * mis-mapping is worse than a loud rejection.
 */
export function aliasMap() {
	const tsconfigPath = resolve(repoRoot, 'tsconfig.json');
	const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8')) as TsConfig;
	const paths = tsconfig.compilerOptions?.paths;

	if (!paths) {
		throw new Error(`No compilerOptions.paths in ${tsconfigPath}. The alias layer is declared there.`);
	}

	const aliases: Record<string, string> = {};

	for (const [pattern, targets] of Object.entries(paths)) {
		if (!pattern.endsWith('/*') || targets.length !== 1 || !targets[0].endsWith('/*')) {
			throw new Error(`Unsupported path mapping in ${tsconfigPath}: "${pattern}". Expected a single "<prefix>/*" -> "<dir>/*" entry.`);
		}

		aliases[pattern.slice(0, -2)] = resolve(
			repoRoot,
			targets[0].slice(0, -2),
		);
	}

	return aliases;
}

/** True when `specifier` is (or is inside) an aliased directory. */
export function isAliased(specifier: string, prefixes: string[]) {
	return prefixes.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`));
}
