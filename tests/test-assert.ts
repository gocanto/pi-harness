import { assert as vitestAssert } from 'vitest';

/**
 * Small compatibility layer for the former node:assert assertions.
 *
 * Tests run under Vitest, while this preserves the expressive async rejection
 * assertions used by the existing suites during the migration.
 */
type AsyncAssertionHelpers = {
	rejects(operation: Promise<unknown>, expected?: RegExp | ((error: unknown) => boolean)): Promise<void>;
	doesNotMatch(value: string, pattern: RegExp): void;
};

export const assert: typeof vitestAssert & AsyncAssertionHelpers = Object.assign(vitestAssert, {
	async rejects(operation: Promise<unknown>, expected?: RegExp | ((error: unknown) => boolean)) {
		try {
			await operation;
		} catch (error) {
			if (expected instanceof RegExp) {
				const message = error instanceof Error ? error.message : String(error);

				vitestAssert.match(message, expected);
			} else if (expected && !expected(error)) {
				throw new Error('Rejected with an unexpected error.');
			}

			return;
		}

		throw new Error('Expected the promise to reject.');
	},
	doesNotMatch(value: string, pattern: RegExp) {
		if (pattern.test(value)) {
			throw new Error(`Expected ${JSON.stringify(value)} not to match ${pattern}.`);
		}
	},
});
