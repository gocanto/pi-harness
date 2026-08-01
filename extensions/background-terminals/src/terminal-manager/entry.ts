import type { ChildProcess } from 'node:child_process';
import type * as fs from 'node:fs';
import type { Deferred } from 'effect';
import { type Scope } from 'effect';
import type { TerminalSnapshot, TerminalStatus } from '../domain.ts';
import type { OutputBuffer } from '../terminal-output/index.ts';

/** Mutable snapshot maintained while a terminal process is alive. */
export interface MutableTerminalSnapshot extends TerminalSnapshot {
	status: TerminalStatus;
	pid?: number;
	settledAt?: number;
	exitCode?: number;
	signal?: string;
	errorText?: string;
}

/** Runtime state for one terminal, including its process and cleanup scope. */
export class TerminalEntry {
	killSignaled = false;
	processErrored = false;
	exited = false;
	stdioClosed = false;
	settling = false;
	exitCleanupStarted = false;
	spillStreams: fs.WriteStream[];

	constructor(
		readonly snapshot: MutableTerminalSnapshot,
		readonly child: ChildProcess,
		readonly scope: Scope.Closeable,
		readonly stdoutBuf: OutputBuffer,
		readonly stderrBuf: OutputBuffer,
		spillStreams: fs.WriteStream[],
		readonly settled: Deferred.Deferred<void>,
	) {
		this.spillStreams = spillStreams;
	}
}
