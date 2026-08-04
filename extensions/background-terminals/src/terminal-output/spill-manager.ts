import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Effect } from 'effect';
import type { OutputBuffer } from '@background-terminals/src/terminal-output/output-buffer.ts';
import { MAX_SPILL_BYTES_PER_STREAM, OUTPUT_ERROR_TEXT_MAX_LENGTH } from '@background-terminals/src/terminal-output/limits.ts';

const FLUSH_TIMEOUT_MS = 1_500;

type StreamName = 'stdout' | 'stderr';

/** Minimal mutable entry surface required by the spill adapter. */
export interface SpillEntry {
	snapshot: { errorText?: string };
	stdoutBuf: OutputBuffer;
	stderrBuf: OutputBuffer;
	spillStreams: fs.WriteStream[];
}

interface SpillHandle {
	readonly spillPath: string;
	readonly file: fs.WriteStream;
	readonly write: (chunk: string) => boolean;
}

/** Owns full-log spill files and their bounded flush lifecycle. */
export class OutputSpillManager {
	private spillDir: string | undefined | null;

	/** Create a spill writer for one stream, or return undefined if unavailable. */
	create(entry: () => SpillEntry | undefined, id: string, stream: StreamName, resumeSource: () => void) {
		const directory = this.resolveDirectory();

		if (!directory) {
			return undefined;
		}

		const spillPath = path.join(directory, `${id}.${stream}.log`);

		try {
			const file = fs.createWriteStream(spillPath, { flags: 'a', mode: 0o600 });

			let broken = false;
			let capped = false;
			let writtenBytes = 0;

			file.on('error', (error) => {
				broken = true;
				resumeSource();

				const current = entry();

				if (current) {
					this.streamBuffer(current, stream).spillPath = undefined;
					current.snapshot.errorText ??= this.bounded(`Full-log spill to ${spillPath} failed: ${this.errorText(error)}`);
				}
			});

			return {
				spillPath,
				file,
				write: (chunk: string) => {
					if (broken || capped || file.writableEnded) {
						return true;
					}

					const chunkBytes = Buffer.byteLength(chunk, 'utf8');

					if (writtenBytes + chunkBytes > MAX_SPILL_BYTES_PER_STREAM) {
						capped = true;

						const current = entry();

						if (current) {
							this.streamBuffer(current, stream).spillPath = undefined;
							current.snapshot.errorText ??= this.bounded(`${stream} full-log spill reached the ${MAX_SPILL_BYTES_PER_STREAM}-byte safety limit`);
						}

						return true;
					}

					writtenBytes += chunkBytes;

					const accepted = file.write(chunk);

					if (!accepted) {
						file.once('drain', resumeSource);
					}

					return accepted;
				},
			} satisfies SpillHandle;
		} catch {
			return undefined;
		}
	}

	/** Flush all spill streams before a terminal settlement is published. */
	flush(entry: SpillEntry) {
		const streams = entry.spillStreams;

		entry.spillStreams = [];

		return Effect.forEach(
			streams,
			(stream) =>
				Effect.callback<void>((resume) => {
					const done = () => resume(Effect.void);

					try {
						stream.end(done);
					} catch {
						done();
					}
				}),
			{ concurrency: 'unbounded', discard: true },
		).pipe(
			Effect.timeoutOrElse({
				duration: FLUSH_TIMEOUT_MS,
				orElse: () =>
					Effect.sync(() => {
						entry.stdoutBuf.spillPath = undefined;
						entry.stderrBuf.spillPath = undefined;
						entry.snapshot.errorText ??= 'Full-log spill flush timed out; full output may be incomplete';
					}),
			}),
		);
	}

	/** Remove this session's private spill directory. */
	dispose() {
		return Effect.sync(() => {
			const directory = this.spillDir;

			this.spillDir = null;

			if (directory) {
				fs.rmSync(directory, { recursive: true, force: true });
			}
		});
	}

	private resolveDirectory() {
		if (this.spillDir !== undefined) {
			return this.spillDir ?? undefined;
		}

		try {
			const base = path.join(os.tmpdir(), 'pi-background-terminals');

			fs.mkdirSync(base, { recursive: true, mode: 0o700 });
			fs.chmodSync(base, 0o700);
			this.spillDir = fs.mkdtempSync(path.join(base, 'session-'));
			fs.chmodSync(this.spillDir, 0o700);
		} catch {
			this.spillDir = null;
		}

		return this.spillDir ?? undefined;
	}

	private streamBuffer(entry: SpillEntry, stream: StreamName) {
		return stream === 'stdout' ? entry.stdoutBuf : entry.stderrBuf;
	}

	private bounded(text: string) {
		return text.slice(0, OUTPUT_ERROR_TEXT_MAX_LENGTH);
	}

	private errorText(error: unknown) {
		return this.bounded(error instanceof Error ? error.message : String(error));
	}
}
