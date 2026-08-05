import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const FORCE_KILL_AFTER_MS = 2_000;

/** Terminates a Codex app-server and the tools it spawned. */
export class CodexProcessTree {
	/** Signal the complete process group, with a direct fallback. */
	signal(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
		if (process.platform === 'win32' && child.pid) {
			try {
				const killer = spawn(
					'taskkill',
					['/pid', String(child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])],
					{
						stdio: 'ignore',
						windowsHide: true,
					},
				);

				const killDirect = () => this.signalDirectly(child, signal);

				killer.once('error', killDirect);
				killer.once('exit', (code) => {
					if (code !== 0) {
						killDirect();
					}
				});
				killer.unref();

				return;
			} catch {
				// Fall through to direct signalling.
			}
		}

		if (process.platform !== 'win32' && child.pid) {
			try {
				process.kill(-child.pid, signal);

				return;
			} catch {
				// The group may already be gone.
			}
		}

		this.signalDirectly(child, signal);
	}

	/** Terminate the server and force-kill it after the bounded grace period. */
	terminate(child: ChildProcessWithoutNullStreams, exited: () => boolean) {
		if (exited()) {
			return Promise.resolve();
		}

		return new Promise<void>((resolve) => {
			let done = false;
			let forceTimer: ReturnType<typeof setTimeout> | undefined;
			let lastTimer: ReturnType<typeof setTimeout> | undefined;

			const finish = () => {
				if (done) {
					return;
				}

				done = true;
				if (forceTimer) {
					clearTimeout(forceTimer);
				}

				if (lastTimer) {
					clearTimeout(lastTimer);
				}

				resolve();
			};

			child.once('exit', finish);
			this.signal(child, 'SIGTERM');
			forceTimer = setTimeout(() => {
				if (!exited()) {
					this.signal(child, 'SIGKILL');
				}
			}, FORCE_KILL_AFTER_MS);
			lastTimer = setTimeout(finish, FORCE_KILL_AFTER_MS + 500);
		});
	}

	private signalDirectly(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
		try {
			child.kill(signal);
		} catch {
			// The process may already be gone.
		}
	}
}
