/** Coordinates serialized refreshes and best-effort background refreshes. */
export class RefreshCoordinator {
	private tail = Promise.resolve();
	private active = false;
	private queued = 0;

	/** Run an operation after all earlier refreshes have completed. */
	run<T>(operation: () => Promise<T>) {
		this.queued += 1;

		const result = this.tail.then(async () => {
			this.queued -= 1;
			this.active = true;

			try {
				return await operation();
			} finally {
				this.active = false;
			}
		});

		this.tail = result.then(
			() => undefined,
			() => undefined,
		);

		return result;
	}

	/** Run an operation only when the coordinator is currently idle. */
	runIfIdle(operation: () => Promise<void>) {
		if (this.active || this.queued > 0) {
			return Promise.resolve();
		}

		return this.run(operation).then(() => undefined);
	}
}

/** Create a refresh coordinator for existing extension integrations. */
export function makeRefreshCoordinator() {
	return new RefreshCoordinator();
}
