/** Bounded teardown operations for a Claude SDK session. */
export class ClaudeTeardown {
	private constructor() {}

	/** Wait for an operation without allowing teardown to hang forever. */
	static waitBounded(operation: Promise<unknown>, timeoutMs: number) {
		let timer: ReturnType<typeof setTimeout> | undefined;

		const timeout = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, timeoutMs);
		});

		return Promise.race([
			operation.then(
				() => undefined,
				() => undefined,
			),
			timeout,
		]).finally(() => {
			if (timer) {
				clearTimeout(timer);
			}
		});
	}
}
