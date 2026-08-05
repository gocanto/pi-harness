import type { ChildProcess } from 'node:child_process';
import { Effect } from 'effect';
import { ChildCloseWaiter } from '@background-terminals/src/process-tree/child-close-waiter.ts';
import { ProcessTreeSignaler } from '@background-terminals/src/process-tree/process-tree-signaler.ts';
import { ShellInvocation } from '@background-terminals/src/process-tree/shell-invocation.ts';

const FORCE_KILL_AFTER_MS = 2_000;

/**
 * Coordinates platform process-tree operations.
 *
 * The controller is deliberately small: shell construction, signal delivery,
 * and close observation are separate adapters so each policy can be tested and
 * changed independently.
 */
export class ProcessTreeController {
	constructor(
		private readonly signaler = new ProcessTreeSignaler(),
		private readonly closeWaiter = new ChildCloseWaiter(),
	) {}

	/** Return the platform shell invocation for a user command. */
	shellInvocation(command: string) {
		return ShellInvocation.for(command);
	}

	/**
	 * Terminate a process tree with SIGTERM, then SIGKILL if it remains open.
	 * The effect is bounded and safe to run from detached cleanup work.
	 */
	terminate(child: ChildProcess, closed: () => boolean, onSignal: () => void) {
		return Effect.suspend(() => {
			if (closed()) {
				return Effect.void;
			}

			return Effect.sync(() => {
				onSignal();
				this.signaler.signal(child, 'SIGTERM');
			}).pipe(
				Effect.andThen(this.closeWaiter.wait(child, closed).pipe(Effect.timeout(FORCE_KILL_AFTER_MS), Effect.ignore)),
				Effect.andThen(
					Effect.suspend(() => {
						if (closed()) {
							return Effect.void;
						}

						this.signaler.signal(child, 'SIGKILL');

						return this.closeWaiter.wait(child, closed).pipe(Effect.timeout(500), Effect.ignore);
					}),
				),
			);
		});
	}
}
