/**
 * Formatting gate.
 *
 * fmtkit has no TS check mode -- `fmtkit check` is Go-only, and `fmtkit format`
 * rewrites files in place and always exits 0. So the only honest way to gate on
 * formatting is to run the formatter and see whether it changed anything.
 *
 * Drift is measured by hashing each source file before and after the run rather
 * than by consulting `git diff`. Uncommitted work is normal locally, and a
 * git-based comparison would either miss drift in an already-modified file or
 * report unrelated edits as drift.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sourceExtensions = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx', '.vue']);

const sourceFiles = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
	.split('\0')
	.filter((file) => file && sourceExtensions.has(file.slice(file.lastIndexOf('.'))));

/** Content hash per file, skipping any file missing from the working tree. */
const hashFiles = () => {
	const hashes = new Map();
	for (const file of sourceFiles) {
		try {
			hashes.set(file, createHash('sha256').update(readFileSync(file)).digest('hex'));
		} catch (error) {
			if (error.code !== 'ENOENT') {
				throw error;
			}
		}
	}

	return hashes;
};

const before = hashFiles();

// `fmtkit format-all --ts` also runs oxlint, so it exits non-zero on a lint
// error as well as on a genuine formatter failure. Either way this is not
// formatting drift, and it should not surface as an unhandled stack trace.
try {
	execFileSync('fmtkit', ['format-all', '--ts', '--quiet'], { stdio: 'inherit' });
} catch (error) {
	if (error.code === 'ENOENT') {
		console.error('fmtkit is not installed. See https://github.com/oullin/fmtkit, or `brew install oullin/fmtkit/fmtkit`.');
	} else {
		console.error('The formatter exited non-zero (see its output above). That is a formatter or lint failure, not formatting drift.');
	}

	process.exit(1);
}

const after = hashFiles();
const drifted = sourceFiles.filter((file) => before.has(file) && after.has(file) && before.get(file) !== after.get(file));

if (drifted.length === 0) {
	process.exit(0);
}

console.error(`Formatting drift in ${drifted.length} file(s):`);
for (const file of drifted) {
	console.error(`- ${file}`);
}

console.error('\nThe formatter has already rewritten them in your working tree. Review the diff and commit it, or run `pnpm run format`.');
process.exitCode = 1;
