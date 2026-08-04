/**
 * The tracker retains only what a bounded transcript can show. These pin the
 * two properties that makes safe: the emitted transcript is byte-identical to
 * one built from the full history, and the retained state stops growing.
 */

import { assert } from '@tests/test-assert.ts';
import { test } from 'vitest';
import { IncrementalProgressTracker, transcriptFromMessages } from '@workflows/runner/progress.ts';

import type { AgentSession, ExtensionContext } from '@earendil-works/pi-coding-agent';

type AgentMessage = AgentSession['messages'][number];

const modelRegistry = { find: () => undefined, getAll: () => [] } as unknown as ExtensionContext['modelRegistry'];

/** A minimal assistant message carrying one text block. */
function message(index: number): AgentMessage {
	return {
		role: 'assistant',
		content: [{ type: 'text', text: `turn ${index}` }],
		timestamp: index,
	} as unknown as AgentMessage;
}

test('a long run emits the same transcript as a full rescan of every message', () => {
	const messages = Array.from({ length: 700 }, (_, index) => message(index));
	const tracker = new IncrementalProgressTracker();

	for (const item of messages) {
		tracker.observeMessage(item, undefined, modelRegistry, new Map());
	}

	assert.deepEqual(tracker.transcript(), transcriptFromMessages(messages));
});

test('retained entries stay bounded as turns accumulate', () => {
	const tracker = new IncrementalProgressTracker();
	const sizes: number[] = [];

	for (let index = 0; index < 2_000; index++) {
		tracker.observeMessage(message(index), undefined, modelRegistry, new Map());

		if (index % 500 === 499) {
			sizes.push(tracker.transcript().length);
		}
	}

	// The emitted transcript is capped, and the count it reports as the true
	// total keeps rising even though the retained list does not.
	for (const size of sizes) {
		assert.ok(size <= 210, `transcript grew to ${size} entries`);
	}

	const notice = tracker.transcript().at(-1);

	assert.equal(notice?.name, 'transcript');
	assert.match(notice?.text ?? '', /of 2000 entries/);
});
