import { spawn, type ChildProcess } from 'node:child_process';
import { Effect } from 'effect';

const FORCE_KILL_AFTER_MS = 2_000;

/**
 * Platform adapter for launching shell commands and terminating their process
 * trees. Keeping OS-specific signalling here lets the terminal manager focus
 * on registry and lifecycle policy.
 */
export class ProcessTreeController {
	/** Return the platform shell invocation for a user command. */
	shellInvocation(command: string) {
		if (process.platform === 'win32') {
			const shell = process.env.ComSpec ?? 'cmd.exe';

			return { shell, args: ['/d', '/s', '/c', command] };
		}

		return { shell: '/bin/sh', args: ['-c', command] };
	}

	/**
	 * Terminate a process tree with SIGTERM then SIGKILL if stdio remains open.
	 * The returned effect is bounded and safe to run from detached cleanup work.
	 */
	terminate(child: ChildProcess, closed: () => boolean, onSignal: () => void) {
		return Effect.suspend(() => {
			if (closed()) {
				return Effect.void;
			}

			return Effect.sync(() => {
				onSignal();
				this.killTree(child, 'SIGTERM');
			}).pipe(
				Effect.andThen(this.awaitClose(child, closed).pipe(Effect.timeout(FORCE_KILL_AFTER_MS), Effect.ignore)),
				Effect.andThen(
					Effect.suspend(() => {
						if (closed()) {
							return Effect.void;
						}

						this.killTree(child, 'SIGKILL');

						return this.awaitClose(child, closed).pipe(Effect.timeout(500), Effect.ignore);
					}),
				),
			);
		});
	}

	private killTree(child: ChildProcess, signal: NodeJS.Signals) {
		if (process.platform === 'win32' && child.pid) {
			try {
				const killer = spawn(
					'taskkill',
					['/pid', String(child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])],
					{ stdio: 'ignore', windowsHide: true },
				);

				killer.once('error', () => this.signalDirectly(child, signal));
				killer.once('exit', (code) => {
					if (code !== 0) {
						this.signalDirectly(child, signal);
					}
				});
				killer.unref();

				return;
			} catch {
				// Fall through to the direct signal when taskkill cannot be launched.
			}
		}

		if (process.platform !== 'win32' && child.pid) {
			try {
				process.kill(-child.pid, signal);

				return;
			} catch {
				// Group may already be gone; fall through to the direct signal.
			}
		}

		this.signalDirectly(child, signal);
	}

	private signalDirectly(child: ChildProcess, signal: NodeJS.Signals) {
		try {
			child.kill(signal);
		} catch {
			// Process may already be gone.
		}
	}

	private awaitClose(child: ChildProcess, closed: () => boolean) {
		return Effect.callback<void>((resume) => {
			if (closed()) {
				resume(Effect.void);

				return;
			}

			const onClose = () => resume(Effect.void);

			child.once('close', onClose);

			return Effect.sync(() => child.off('close', onClose));
		});
	}
}
