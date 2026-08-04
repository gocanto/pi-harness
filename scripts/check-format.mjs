/**
 * Formatting gate.
 *
 * fmtkit has no TS check mode -- `fmtkit check` is Go-only, and `fmtkit format`
 * rewrites files in place and always exits 0. So the only honest way to gate on
 * formatting is to run the formatter and see whether it changed anything.
 *
 * On CI the tree is clean, so any file the formatter touches is drift. Locally
 * the tree usually is not clean, so files that were already modified before we
 * ran are reported separately rather than failing the check.
 */

import { execFileSync } from 'node:child_process';

const git = (args) => execFileSync('git', args, { encoding: 'utf8' });

/** Tracked files with uncommitted modifications, as a set of repo-relative paths. */
const modifiedFiles = () => new Set(git(['diff', '--name-only']).split('\n').filter(Boolean));

const before = modifiedFiles();

execFileSync('fmtkit', ['format-all', '--ts', '--quiet'], { stdio: 'inherit' });

const after = modifiedFiles();
const drifted = [...after].filter((file) => !before.has(file));

if (drifted.length === 0) {
	const alreadyDirty = [...after].filter((file) => before.has(file));
	if (alreadyDirty.length > 0) {
		console.warn(`Formatting check skipped ${alreadyDirty.length} file(s) that were already modified before the run.`);
	}

	process.exit(0);
}

console.error('Formatting drift. These files are not formatted:');
for (const file of drifted) {
	console.error(`- ${file}`);
}

console.error('\nThe formatter has already rewritten them in your working tree. Review the diff and commit it, or run `pnpm run format`.');
process.exitCode = 1;
