import { spawn, type ChildProcess } from 'node:child_process';

const MAX_STREAM_CHARS = 10 * 1_024 * 1_024;
const TRUNCATED_MARKER = '\n[command output truncated]\n';

class CommandOutputBuffer {
	private value = '';

	append(chunk: string) {
		if (this.value.endsWith(TRUNCATED_MARKER)) {
			return;
		}

		if (this.value.length + chunk.length <= MAX_STREAM_CHARS) {
			this.value += chunk;

			return;
		}

		const remaining = Math.max(0, MAX_STREAM_CHARS - this.value.length);

		this.value = `${this.value}${chunk.slice(0, remaining)}${TRUNCATED_MARKER}`;
	}

	text() {
		return this.value;
	}
}

export interface CommandResult {
	code: number;
	stderr: string;
	stdout: string;
}

/** Runs one external command and captures its bounded output. */
export interface CommandRunner {
	run(command: string, args: readonly string[], cwd: string, timeout: number, signal?: AbortSignal): Promise<CommandResult>;
}

function appendCommandFailure(stderr: string, command: string, error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	const failure = `Failed to run ${command}: ${message}`;

	return stderr ? `${stderr.trimEnd()}\n${failure}` : failure;
}

/** Node child-process adapter used by the git-info extension. */
export class ProcessCommandRunner implements CommandRunner {
	/** Execute one command with bounded stdout/stderr and a timeout. */
	run(command: string, args: readonly string[], cwd: string, timeout: number, signal?: AbortSignal) {
		if (signal?.aborted) {
			return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
		}

		return new Promise<CommandResult>((resolve, reject) => {
			const stderr = new CommandOutputBuffer();
			const stdout = new CommandOutputBuffer();

			let settled = false;
			let timedOut = false;
			let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
			let child: ChildProcess | undefined;

			const clear = () => {
				if (timeoutHandle !== undefined) {
					clearTimeout(timeoutHandle);
				}

				signal?.removeEventListener('abort', abort);
			};

			const finish = (result: CommandResult) => {
				if (settled) {
					return;
				}

				settled = true;
				clear();
				resolve(result);
			};

			const fail = (error: unknown) => {
				if (settled) {
					return;
				}

				settled = true;
				clear();
				reject(error);
			};

			const terminate = () => {
				try {
					child?.kill();
				} catch {
					// The process may have exited between the timeout and kill call.
				}
			};

			const abort = () => {
				terminate();
				fail(new DOMException('The operation was aborted.', 'AbortError'));
			};

			try {
				child = spawn(
					command,
					[...args],
					{
						cwd,
						stdio: ['ignore', 'pipe', 'pipe'],
					},
				);
			} catch (error) {
				finish(
					{
						code: 1,
						stderr: appendCommandFailure(stderr.text(), command, error),
						stdout: stdout.text(),
					},
				);

				return;
			}

			if (!child) {
				return;
			}

			const spawnedChild = child;

			spawnedChild.stdout?.setEncoding('utf8');
			spawnedChild.stderr?.setEncoding('utf8');
			spawnedChild.stdout?.on('data', (chunk: string) => stdout.append(chunk));
			spawnedChild.stderr?.on('data', (chunk: string) => stderr.append(chunk));
			spawnedChild.once('error', (error: Error) => {
				finish(
					{
						code: 1,
						stderr: appendCommandFailure(stderr.text(), command, error),
						stdout: stdout.text(),
					},
				);
			});
			spawnedChild.once('close', (code: number | null) => {
				finish(
					{
						code: timedOut ? -1 : (code ?? 1),
						stderr: stderr.text(),
						stdout: stdout.text(),
					},
				);
			});

			if (signal) {
				signal.addEventListener('abort', abort, { once: true });
				if (signal.aborted) {
					abort();
				}
			}

			if (settled) {
				return;
			}

			timeoutHandle = setTimeout(() => {
				timedOut = true;
				terminate();
				finish(
					{ code: -1, stderr: stderr.text(), stdout: stdout.text() },
				);
			}, timeout);
		});
	}
}

/** The live command runner used by git-info when no test runner is supplied. */
export const liveCommandRunner: CommandRunner = new ProcessCommandRunner();

/** Execute a command with the live command runner. */
export function runCommand(command: string, args: readonly string[], cwd: string, timeout: number, signal?: AbortSignal) {
	return liveCommandRunner.run(command, args, cwd, timeout, signal);
}
