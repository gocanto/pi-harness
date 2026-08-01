import type { OutputView } from '../domain.ts';

/**
 * Bounded in-memory capture for one process stream.
 *
 * Newest output is retained. An optional spill callback receives every chunk
 * before eviction so callers can keep a complete on-disk capture.
 */
export class OutputBuffer {
	private chunks: string[] = [];
	private retainedBytes = 0;
	private cachedText: string | undefined = '';

	/** Bumped on every push so views can cache derived line layouts. */
	version = 0;
	totalBytes = 0;
	truncatedBytes = 0;
	spillPath?: string;

	constructor(
		private readonly maxRetainedBytes: number,
		private readonly spill?: (chunk: string) => unknown,
	) {}

	/** Add one decoded stream chunk and report whether the source may continue. */
	push(chunk: string) {
		if (chunk.length === 0) {
			return true;
		}

		let bytes = Buffer.byteLength(chunk, 'utf8');

		this.totalBytes += bytes;

		const spillAccepted = this.spill?.(chunk) !== false;

		if (bytes > this.maxRetainedBytes) {
			this.truncatedBytes += this.retainedBytes;
			this.chunks = [];
			this.retainedBytes = 0;

			const raw = Buffer.from(chunk, 'utf8');

			let start = raw.length - this.maxRetainedBytes;

			while (start < raw.length && (raw[start] & 0xc0) === 0x80) {
				start++;
			}

			this.truncatedBytes += start;
			chunk = raw.subarray(start).toString('utf8');
			bytes = raw.length - start;
		}

		this.chunks.push(chunk);
		this.retainedBytes += bytes;

		while (this.retainedBytes > this.maxRetainedBytes && this.chunks.length > 1) {
			const evicted = this.chunks.shift();

			if (evicted === undefined) {
				break;
			}

			const evictedBytes = Buffer.byteLength(evicted, 'utf8');

			this.retainedBytes -= evictedBytes;
			this.truncatedBytes += evictedBytes;
		}

		this.cachedText = undefined;
		this.version++;

		return spillAccepted;
	}

	/** Read the current bounded stream view. */
	view(): OutputView {
		this.cachedText ??= this.chunks.join('');

		return {
			text: this.cachedText,
			totalBytes: this.totalBytes,
			truncatedBytes: this.truncatedBytes,
			spillPath: this.spillPath,
		};
	}
}
