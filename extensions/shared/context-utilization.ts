/** Compact, defensive context-window utilization formatting for child agents. */

export interface ContextUtilization {
	/** Current conversation context occupancy; null while it is unknown after compaction. */
	tokens?: number | null;
	/** Capacity of the model currently serving the conversation. */
	contextWindow?: number | null;
}

/** Pure formatting operations for context-window usage. */
export class ContextUtilizationFormatter {
	/** Return a clamped occupancy percentage when both values are usable. */
	static percent(usage: ContextUtilization) {
		const tokens = this.usableTokens(usage.tokens);
		const capacity = this.usableCapacity(usage.contextWindow);

		if (tokens === undefined || capacity === undefined) {
			return undefined;
		}

		return Math.round(Math.min(100, Math.max(0, (tokens / capacity) * 100)));
	}

	/** Render a compact token count such as `1.2k` or `3.4M`. */
	static compactTokens(count: number) {
		if (count < 1000) {
			return Math.round(count).toString();
		}

		if (count < 10000) {
			return `${(count / 1000).toFixed(1)}k`;
		}

		if (count < 1000000) {
			return `${Math.round(count / 1000)}k`;
		}

		return `${(count / 1000000).toFixed(1)}M`;
	}

	/** Render `%/capacity`, or an empty string when capacity is unavailable. */
	static format(usage: ContextUtilization) {
		const capacity = this.usableCapacity(usage.contextWindow);

		if (capacity === undefined) {
			return '';
		}

		const percent = this.percent(usage);

		return `${percent === undefined ? '?' : percent}%/${this.compactTokens(capacity)}`;
	}

	private static usableTokens(value: number | null | undefined) {
		return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
	}

	private static usableCapacity(value: number | null | undefined) {
		return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
	}
}

/** Backward-compatible context percentage helper. */
export function contextPercent(usage: ContextUtilization) {
	return ContextUtilizationFormatter.percent(usage);
}

/** Backward-compatible compact token helper. */
export function formatCompactTokens(count: number) {
	return ContextUtilizationFormatter.compactTokens(count);
}

/** Backward-compatible utilization formatter. */
export function formatContextUtilization(usage: ContextUtilization) {
	return ContextUtilizationFormatter.format(usage);
}
