/**
 * Exactly-once delivery queue for results produced asynchronously.
 *
 * The queue is intentionally stateful: a result can be deferred, consumed by
 * a synchronous tool response, or flushed later when the host is idle. Keeping
 * those transitions in one object prevents each extension from reimplementing
 * subtly different delivery and retry semantics.
 */
export class DeferredResultDelivery<T extends { readonly id: string }> {
	private readonly pending = new Map<string, T>();

	/** Add or replace a pending result. */
	defer(result: T) {
		this.pending.set(result.id, result);
	}

	/** Remove results that were already returned by another operation. */
	consume(ids: Iterable<string>) {
		for (const id of ids) {
			this.pending.delete(id);
		}
	}

	/**
	 * Attempt delivery in insertion order.
	 *
	 * Failed sends remain queued so a later flush can retry them. Results added
	 * during a flush are intentionally deferred until the next flush.
	 */
	flush(send: (result: T) => void) {
		for (const [id, result] of [...this.pending]) {
			if (!this.pending.has(id)) {
				continue;
			}

			try {
				send(result);
			} catch {
				continue;
			}

			this.pending.delete(id);
		}
	}

	/** Remove and return all pending results. */
	drain() {
		const results = [...this.pending.values()];

		this.pending.clear();

		return results;
	}

	/** Discard all pending results. */
	clear() {
		this.pending.clear();
	}
}
