import { spawn, type ChildProcess } from 'node:child_process';

/** Sends termination signals to a complete child process tree. */
export class ProcessTreeSignaler {
	/** Signal the process group on POSIX or the process tree on Windows. */
	signal(child: ChildProcess, signal: NodeJS.Signals) {
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
				// Fall through to direct signalling when taskkill cannot start.
			}
		}

		if (process.platform !== 'win32' && child.pid) {
			try {
				process.kill(-child.pid, signal);

				return;
			} catch {
				// The process group may already be gone.
			}
		}

		this.signalDirectly(child, signal);
	}

	private signalDirectly(child: ChildProcess, signal: NodeJS.Signals) {
		try {
			child.kill(signal);
		} catch {
			// The process may already be gone.
		}
	}
}
