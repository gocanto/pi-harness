/**
 * Extension build.
 *
 * pi loads extensions through jiti, which resolves node module specifiers and
 * nothing else -- it never reads `compilerOptions.paths`. Sources here import
 * across the tree through aliases (`@shared/dashboard-state.ts`), so what
 * typechecks and tests clean cannot be loaded as-is: every aliased import
 * fails with "Cannot find module" at startup.
 *
 * This step bundles each extension into `extensions/<name>/dist/index.js` with
 * the aliased modules inlined and every real dependency left external, so the
 * output resolves under plain node semantics. Each extension's package.json
 * points pi at that bundle via `pi.extensions`, which its loader honours ahead
 * of `index.ts`.
 *
 * The build then asserts what it produced: a declared bundle, an emitted file,
 * and no alias specifier surviving in the output. A silent partial build would
 * hand back the startup failures this exists to prevent.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';

import { build } from 'vite';

import { aliasMap, isAliased, repoRoot } from './aliases.ts';

/** Path pi is pointed at, relative to the extension directory. */
const bundlePath = './dist/index.js';

const extensionsDir = resolve(repoRoot, 'extensions');
const aliases = aliasMap();
const aliasPrefixes = Object.keys(aliases);

/**
 * Directories pi would discover as extensions: one level below `extensions/`,
 * holding an `index.ts`. `shared/` has no entry point and is only ever reached
 * through an alias, so it is bundled into its consumers rather than built.
 */
function extensionDirs() {
	return readdirSync(
		extensionsDir,
		{ withFileTypes: true },
	)
		.filter((entry) => entry.isDirectory())
		.map((entry) => resolve(extensionsDir, entry.name))
		.filter((dir) => existsSync(
			resolve(dir, 'index.ts'),
		))
		.sort();
}

/**
 * Rollup consults `external` with the raw specifier before any plugin resolves
 * it, so aliased ids have to be claimed here. Left to the default, they would
 * be treated as bare packages and emitted untouched -- reproducing the exact
 * breakage this build exists to fix, but in a file that looks built.
 */
function isExternal(id: string) {
	if (id.startsWith('.') || isAbsolute(id)) {
		return false;
	}

	return !isAliased(id, aliasPrefixes);
}

async function bundleExtension(dir: string) {
	await build(
		{
			configFile: false,
			root: repoRoot,
			logLevel: 'warn',
			resolve: { alias: aliases },
			build: {
				outDir: resolve(dir, 'dist'),
				emptyOutDir: true,
				target: 'node22',
				minify: false,
				sourcemap: true,
				lib: {
					entry: resolve(dir, 'index.ts'),
					formats: ['es'],
					fileName: () => 'index.js',
				},
				rollupOptions: { external: isExternal },
			},
		},
	);
}

/** Reasons `dir` would still fail to load under pi, as human-readable lines. */
function verifyExtension(dir: string) {
	const name = basename(dir);
	const problems: string[] = [];
	const manifestPath = resolve(dir, 'package.json');

	if (existsSync(manifestPath)) {
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { pi?: { extensions?: string[] } };

		if (!manifest.pi?.extensions?.includes(bundlePath)) {
			problems.push(`${name}: package.json does not declare "pi": { "extensions": ["${bundlePath}"] }, so pi would load the unbuildable index.ts instead.`);
		}
	} else {
		problems.push(`${name}: no package.json, so pi cannot be pointed at the bundle.`);
	}

	const bundle = resolve(dir, bundlePath);

	if (!existsSync(bundle)) {
		problems.push(`${name}: ${bundlePath} was not emitted.`);

		return problems;
	}

	const leaked = [...new Set([...readFileSync(bundle, 'utf8').matchAll(/from\s*["']([^"']+)["']/g)].map((match) => match[1]).filter((specifier) => isAliased(specifier, aliasPrefixes)))];

	if (leaked.length > 0) {
		problems.push(`${name}: alias specifiers survived bundling and will fail to resolve at runtime: ${leaked.join(', ')}`);
	}

	return problems;
}

const dirs = extensionDirs();

if (dirs.length === 0) {
	console.error(`No extensions with an index.ts under ${relative(repoRoot, extensionsDir)}/.`);
	process.exit(1);
}

const problems: string[] = [];

for (const dir of dirs) {
	await bundleExtension(dir);

	problems.push(...verifyExtension(dir));

	const bundle = resolve(dir, bundlePath);
	const size = existsSync(bundle) ? `${(statSync(bundle).size / 1024).toFixed(1)} kB` : 'missing';

	console.log(`  ${basename(dir).padEnd(22)} ${size}`);
}

if (problems.length > 0) {
	console.error(`\n${problems.length} extension(s) would fail to load under pi:`);

	for (const problem of problems) {
		console.error(`- ${problem}`);
	}

	process.exit(1);
}

console.log(`\nBuilt ${dirs.length} extension(s). pi loads them from ${bundlePath} in each extension directory.`);
