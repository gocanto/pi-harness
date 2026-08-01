import type { Effect } from 'effect';
import type { KillResult, TerminalReadModel } from '../manager.ts';
import type { TerminalSnapshot } from '../domain.ts';
import type { TerminalEntry } from './entry.ts';

const SETTLED_HISTORY_LIMIT = 128;

type Cleanup = (effect: Effect.Effect<void>) => unknown;

/** Synchronous registry and notification hub for background terminals. */
export class TerminalRegistry {
	private readonly entries = new Map<string, TerminalEntry>();
	private readonly settledHistory = new Map<string, Pick<KillResult, 'title' | 'status' | 'exit'>>();
	private readonly killInterest = new Map<string, number>();
	private readonly listeners = new Set<() => void>();
	private readonly idListeners = new Map<string, Set<() => void>>();
	private requestKillHandler: ((entry: TerminalEntry) => void) | undefined;
	private settledHandler: ((snapshot: TerminalSnapshot, consumed: boolean) => void) | undefined;

	constructor(private readonly closeEntry: (entry: TerminalEntry) => Effect.Effect<void>) {}

	/** Add a live entry and notify readers. */
	add(entry: TerminalEntry) {
		this.entries.set(entry.snapshot.id, entry);
		this.notify(entry.snapshot.id);
	}

	/** Look up an entry by its stable terminal id. */
	get(id: string) {
		return this.entries.get(id);
	}

	/** Return all tracked entries in insertion order. */
	all() {
		return [...this.entries.values()];
	}

	/** Return the number of tracked entries. */
	get size() {
		return this.entries.size;
	}

	/** Return tracked entries for lifecycle operations. */
	values() {
		return this.entries.values();
	}

	/** Return tracked ids for diagnostic messages. */
	keys() {
		return this.entries.keys();
	}

	/** Replace an entry without triggering a second notification. */
	set(id: string, entry: TerminalEntry) {
		this.entries.set(id, entry);
	}

	/** Remove an entry without triggering a second notification. */
	delete(id: string) {
		return this.entries.delete(id);
	}

	/** Count active processes. */
	runningCount() {
		return this.all().filter((entry) => entry.snapshot.status === 'running').length;
	}

	/** Mark ids whose settlement is being collected by a tool call. */
	addInterest(ids: ReadonlyArray<string>) {
		for (const id of ids) {
			this.killInterest.set(id, (this.killInterest.get(id) ?? 0) + 1);
		}
	}

	/** Release settlement interest after a tool call completes. */
	releaseInterest(ids: ReadonlyArray<string>) {
		for (const id of ids) {
			const count = (this.killInterest.get(id) ?? 1) - 1;

			if (count <= 0) {
				this.killInterest.delete(id);
			} else {
				this.killInterest.set(id, count);
			}
		}
	}

	/** Whether a terminal has an active result collector. */
	hasInterest(id: string) {
		return this.killInterest.has(id);
	}

	/** Save a bounded tombstone before a settled entry is pruned. */
	recordSettled(snapshot: TerminalSnapshot, exit: string) {
		this.settledHistory.set(snapshot.id, {
			title: snapshot.title,
			status: snapshot.status,
			exit,
		});

		while (this.settledHistory.size > SETTLED_HISTORY_LIMIT) {
			const oldest = this.settledHistory.keys().next().value;

			if (oldest === undefined) {
				break;
			}

			this.settledHistory.delete(oldest);
		}
	}

	/** Retrieve a settled tombstone for a terminal that was pruned. */
	history(id: string) {
		return this.settledHistory.get(id);
	}

	/** Remove old settled entries while retaining active or observed entries. */
	prune(maxTracked: number, runCleanup: Cleanup) {
		if (this.entries.size <= maxTracked) {
			return;
		}

		const candidates = this.all()
			.filter((entry) => entry.snapshot.status !== 'running' && !this.hasInterest(entry.snapshot.id))
			.sort((a, b) => (a.snapshot.settledAt ?? a.snapshot.createdAt) - (b.snapshot.settledAt ?? b.snapshot.createdAt));

		for (const entry of candidates) {
			if (this.entries.size <= maxTracked) {
				break;
			}

			this.entries.delete(entry.snapshot.id);
			runCleanup(
				this.closeEntry(entry),
			);
		}
	}

	/** Remove every entry before runtime shutdown. */
	clear() {
		const entries = this.all();

		this.entries.clear();

		return entries;
	}

	/** Build the synchronous read model consumed by TUI code. */
	readModel(): TerminalReadModel {
		return {
			list: () => this.all().map((entry) => entry.snapshot),
			get: (id) => this.get(id)?.snapshot,
			size: () => this.size,
			subscribe: (listener) => {
				this.listeners.add(listener);

				return () => this.listeners.delete(listener);
			},
			subscribeTo: (id, listener) => {
				let listeners = this.idListeners.get(id);

				if (!listeners) {
					listeners = new Set();
					this.idListeners.set(id, listeners);
				}

				listeners.add(listener);

				return () => {
					listeners?.delete(listener);

					if (listeners?.size === 0) {
						this.idListeners.delete(id);
					}
				};
			},
			requestKill: (id) => {
				const entry = this.get(id);

				if (entry) {
					this.requestKillHandler?.(entry);
				}
			},
			setOnSettled: (hook) => {
				this.settledHandler = hook;
			},
		};
	}

	/** Configure the fire-and-forget UI kill operation. */
	setRequestKillHandler(handler: (entry: TerminalEntry) => void) {
		this.requestKillHandler = handler;
	}

	/** Configure settlement delivery for the host extension. */
	setOnSettled(handler: ((snapshot: TerminalSnapshot, consumed: boolean) => void) | undefined) {
		this.settledHandler = handler;
	}

	/** Deliver a settled snapshot to the configured host hook. */
	deliverSettled(snapshot: TerminalSnapshot, consumed: boolean) {
		this.settledHandler?.(snapshot, consumed);
	}

	/** Notify global and per-terminal subscribers safely. */
	notify(id?: string) {
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// Rendering failures must not affect process lifecycle state.
			}
		}

		if (id) {
			for (const listener of this.idListeners.get(id) ?? []) {
				try {
					listener();
				} catch {
					// Rendering failures must not affect process lifecycle state.
				}
			}
		}
	}
}
