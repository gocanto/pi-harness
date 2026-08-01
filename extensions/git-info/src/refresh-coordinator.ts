import { Effect, Semaphore } from 'effect';

/**
 * Coordinates repository refreshes.
 *
 * Explicit refreshes wait for the single permit. Background refreshes use
 * `runIfIdle` and are dropped when an explicit refresh is already active. The
 * policy belongs to this object rather than to each caller, keeping refresh
 * scheduling separate from git state and UI concerns.
 */
export class RefreshCoordinator {
	private readonly semaphore = Semaphore.makeUnsafe(1);

	/** Run an operation after all earlier refreshes have completed. */
	run<A, E, R>(effect: Effect.Effect<A, E, R>) {
		return this.semaphore.withPermit(effect);
	}

	/** Run an operation only when the coordinator is currently idle. */
	runIfIdle<A, E, R>(effect: Effect.Effect<A, E, R>) {
		return this.semaphore.withPermitsIfAvailable(1)(effect).pipe(Effect.asVoid);
	}
}

/** Create a refresh coordinator for existing extension integrations. */
export function makeRefreshCoordinator() {
	return new RefreshCoordinator();
}
