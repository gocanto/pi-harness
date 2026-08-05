/** Pure protocol formatting helpers for native pi events and failures. */
export class PiProtocol {
	/** Bound an arbitrary failure to a safe event-sized message. */
	static boundedError(error: unknown) {
		return (error instanceof Error ? error.message : String(error)).slice(0, 4096);
	}

	/** Serialize a tool argument value, omitting empty objects and truncating it. */
	static safeJson(value: unknown) {
		try {
			const text = JSON.stringify(value);

			return text === undefined || text === '{}' ? undefined : text.slice(0, 4_096);
		} catch {
			return undefined;
		}
	}

	/** Return the first non-empty line of a tool result-like value. */
	static toolPreview(value: unknown) {
		if (typeof value === 'string') {
			return value
				.split('\n')
				.find((line) => line.trim())
				?.trim();
		}

		if (!this.isRecord(value) || !Array.isArray(value.content)) {
			return undefined;
		}

		for (const part of value.content) {
			if (!this.isRecord(part) || part.type !== 'text') {
				continue;
			}

			if (typeof part.text !== 'string') {
				continue;
			}

			const firstLine = part.text.split('\n').find((line) => line.trim());

			if (firstLine) {
				return firstLine.trim();
			}
		}

		return undefined;
	}

	private static isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null;
	}
}
