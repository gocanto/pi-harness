import { randomUUID } from 'node:crypto';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/** A single-consumer push queue adapted to Claude's streaming input API. */
export class ClaudeInput implements AsyncIterable<SDKUserMessage> {
	private pending: SDKUserMessage[] = [];
	private waiter: ((result: IteratorResult<SDKUserMessage>) => void) | undefined;
	private closed = false;

	/** Queue a user message and wake a waiting SDK consumer. */
	push(text: string) {
		if (this.closed) {
			return undefined;
		}

		const message: SDKUserMessage = {
			type: 'user',
			message: { role: 'user', content: text },
			parent_tool_use_id: null,
			uuid: randomUUID(),
		};

		const waiter = this.waiter;

		if (waiter) {
			this.waiter = undefined;
			waiter(
				{ value: message, done: false },
			);
		} else {
			this.pending.push(message);
		}

		return message;
	}

	/** Remove and return queued messages that have not reached the SDK. */
	clear() {
		return this.pending.splice(0);
	}

	/** Close the stream and wake a pending consumer. */
	end() {
		if (this.closed) {
			return;
		}

		this.closed = true;

		const waiter = this.waiter;

		this.waiter = undefined;
		waiter?.(
			{ value: undefined, done: true },
		);
	}

	/** Consume queued messages until the input stream is closed. */
	async *[Symbol.asyncIterator]() {
		while (true) {
			const message = this.pending.shift();

			if (message) {
				yield message;
				continue;
			}

			if (this.closed) {
				return;
			}

			const next = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
				this.waiter = resolve;
			});

			if (next.done) {
				return;
			}

			yield next.value;
		}
	}
}
