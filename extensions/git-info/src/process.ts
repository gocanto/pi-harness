import { Context, Effect, Layer, Stream } from 'effect';
import { ChildProcess } from 'effect/unstable/process';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

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

interface CommandRunnerShape {
	run(command: string, args: string[], cwd: string, timeout: number): Effect.Effect<CommandResult>;
}

export class CommandRunner extends Context.Service<CommandRunner, CommandRunnerShape>()('git-info/CommandRunner') {}

function appendCommandFailure(stderr: string, command: string, error: Error) {
	const failure = `Failed to run ${command}: ${error.message}`;

	return stderr ? `${stderr.trimEnd()}\n${failure}` : failure;
}

/** Effect-backed command adapter. It owns process execution and output limits. */
export class EffectCommandRunner {
	constructor(private readonly spawner: ChildProcessSpawner['Service']) {}

	/** Execute one command with bounded stdout/stderr and a timeout. */
	run(command: string, args: string[], cwd: string, timeout: number) {
		return Effect.suspend(() => {
			const spawner = this.spawner;
			const stderr = new CommandOutputBuffer();
			const stdout = new CommandOutputBuffer();

			const child = ChildProcess.make(command, args, {
				cwd,
				detached: false,
				forceKillAfter: '5 seconds',
				stdin: 'ignore',
				stderr: 'pipe',
				stdout: 'pipe',
			});

			return Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* spawner.spawn(child);

					const [, , code] = yield* Effect.all(
						[
							Stream.runForEach(Stream.decodeText(handle.stdout), (chunk) => Effect.sync(() => stdout.append(chunk))),
							Stream.runForEach(Stream.decodeText(handle.stderr), (chunk) => Effect.sync(() => stderr.append(chunk))),
							handle.exitCode,
						],
						{ concurrency: 'unbounded' },
					);

					return { code: Number(code), stderr: stderr.text(), stdout: stdout.text() };
				}),
			).pipe(
				Effect.timeoutOrElse({
					duration: timeout,
					orElse: () =>
						Effect.succeed({
							code: -1,
							stderr: stderr.text(),
							stdout: stdout.text(),
						}),
				}),
				Effect.catch((error) =>
					Effect.succeed({
						code: 1,
						stderr: appendCommandFailure(stderr.text(), command, error),
						stdout: stdout.text(),
					}),
				),
			);
		});
	}
}

export const CommandRunnerLive = Layer.effect(
	CommandRunner,
	Effect.gen(function* () {
		return CommandRunner.of(new EffectCommandRunner(yield* ChildProcessSpawner));
	}),
);

export const runCommand = (command: string, args: string[], cwd: string, timeout: number) =>
	Effect.gen(function* () {
		const commands = yield* CommandRunner;

		return yield* commands.run(command, args, cwd, timeout);
	});
