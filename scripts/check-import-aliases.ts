import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** True when a caught value is a Node system error carrying the given code. */
function hasErrorCode(error: unknown, code: string) {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

const sourceExtensions = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx', '.vue']);
const moduleSpecifierPattern = /(?:\bfrom\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/g;

const files = execFileSync(
	'git',
	['ls-files', '-z'],
	{ encoding: 'utf8' },
).split('\0');

const violations: string[] = [];

for (const file of files) {
	if (!sourceExtensions.has(file.slice(file.lastIndexOf('.')))) {
		continue;
	}

	// A tracked file can be absent from the working tree (deleted but not yet
	// staged, uninitialized submodule). That is not an alias violation, so skip
	// it rather than crashing the whole check with an ENOENT stack trace.
	let source: string;

	try {
		source = readFileSync(file, 'utf8');
	} catch (error) {
		if (hasErrorCode(error, 'ENOENT')) {
			continue;
		}

		throw error;
	}

	for (const match of source.matchAll(moduleSpecifierPattern)) {
		violations.push(`${file}: ${match[2]}`);
	}
}

if (violations.length > 0) {
	console.error('Relative module specifiers are not allowed. Use a configured Vite alias:');

	for (const violation of violations) {
		console.error(`- ${violation}`);
	}

	process.exitCode = 1;
}
