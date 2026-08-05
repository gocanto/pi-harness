import type { ChildProcess } from 'node:child_process';
import { Effect } from 'effect';

/** Waits for child stdio closure without leaking event listeners. */
export class ChildCloseWaiter {
	/** Await close unless the supplied state predicate is already true. */
	wait(child: ChildProcess, closed: () => boolean) {
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
