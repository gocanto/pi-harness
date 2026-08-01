/**
 * An in-memory exactly-once delivery queue for settled subagent results,
 * keyed by result id.
 */
export interface DeferredResultDelivery<T extends { id: string }> {
  /** Queue a settled result for later delivery, keyed by its id. */
  defer(result: T): void;
  /**
   * Remove the given ids from the queue without delivering them, e.g.
   * because a `subagent_wait` call already returned the result to the
   * caller.
   */
  consume(ids: Iterable<string>): void;
  /**
   * Attempt to deliver every currently pending result via `send`, in
   * settlement order. A result is removed from the queue only after `send`
   * returns without throwing, so a failing send leaves its result pending
   * for a later flush instead of discarding it. One throwing send does not
   * stop delivery of the remaining pending results, and a result consumed
   * (e.g. by a concurrent `subagent_wait`) while this flush is running is
   * skipped rather than resent.
   */
  flush(send: (result: T) => void): void;
  /** Remove and return every pending result without attempting delivery. */
  drain(): T[];
  /** Discard all pending results without attempting delivery. */
  clear(): void;
}

/**
 * Create a {@link DeferredResultDelivery} queue.
 *
 * @template T - The deferred result type, identified by a stable `id`.
 */
export function createDeferredResultDelivery<
  T extends { id: string },
>(): DeferredResultDelivery<T> {
  const pending = new Map<string, T>();

  return {
    defer(result) {
      pending.set(result.id, result);
    },
    consume(ids) {
      for (const id of ids) pending.delete(id);
    },
    flush(send) {
      // Snapshot the ids up front: `send` may synchronously defer a new
      // result (e.g. a restart) or trigger a consume; neither should be
      // picked up mid-iteration.
      for (const [id, result] of [...pending]) {
        // The result may have been consumed (e.g. by subagent_wait) after
        // the snapshot above was taken but before this entry was reached.
        if (!pending.has(id)) continue;
        try {
          send(result);
        } catch {
          // Keep it pending; a later agent_settled/idle flush retries.
          continue;
        }
        pending.delete(id);
      }
    },
    drain() {
      const results = [...pending.values()];
      pending.clear();
      return results;
    },
    clear() {
      pending.clear();
    },
  };
}
