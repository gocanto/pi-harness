import { assert } from '../test-assert.ts';
import { test } from 'vitest';
import { createDeferredResultDelivery } from './src/result-delivery.ts';

test('a result consumed by a later wait is not delivered', () => {
	const delivery = createDeferredResultDelivery<{
		id: string;
		output: string;
	}>();

	delivery.defer({ id: 'sa-1', output: 'done' });
	delivery.consume(['sa-1']);

	assert.deepEqual(delivery.drain(), []);
});

test('unconsumed results are delivered once in settlement order', () => {
	const delivery = createDeferredResultDelivery<{ id: string }>();
	const first = { id: 'sa-1' };
	const second = { id: 'sa-2' };

	delivery.defer(first);
	delivery.defer(second);

	assert.deepEqual(delivery.drain(), [first, second]);
	assert.deepEqual(delivery.drain(), []);
});

test('a result stays pending after a failed send and delivers once on retry', () => {
	const delivery = createDeferredResultDelivery<{ id: string }>();
	const result = { id: 'sa-1' };

	delivery.defer(result);

	const attempts: { id: string }[] = [];
	// flush must not throw: a failing send is bounded per-result, not
	// propagated to the caller (e.g. an agent_settled/idle event handler).
	delivery.flush((r) => {
		attempts.push(r);
		throw new Error('transient send failure');
	});
	assert.deepEqual(attempts, [result]);

	// The failed send must not have removed the result from the queue.
	const delivered: { id: string }[] = [];

	delivery.flush((r) => delivered.push(r));
	assert.deepEqual(delivered, [result]);

	// Delivered exactly once: a further flush has nothing left to send.
	const redelivered: { id: string }[] = [];

	delivery.flush((r) => redelivered.push(r));
	assert.deepEqual(redelivered, []);
});

test('flush delivers multiple results in settlement order and removes only sent ones', () => {
	const delivery = createDeferredResultDelivery<{ id: string }>();
	const first = { id: 'sa-1' };
	const second = { id: 'sa-2' };

	delivery.defer(first);
	delivery.defer(second);

	const delivered: { id: string }[] = [];

	delivery.flush((r) => delivered.push(r));
	assert.deepEqual(delivered, [first, second]);

	const redelivered: { id: string }[] = [];

	delivery.flush((r) => redelivered.push(r));
	assert.deepEqual(redelivered, []);
});

test('a sender failure for one result does not block delivery of the others', () => {
	const delivery = createDeferredResultDelivery<{ id: string }>();
	const first = { id: 'sa-1' };
	const second = { id: 'sa-2' };
	const third = { id: 'sa-3' };

	delivery.defer(first);
	delivery.defer(second);
	delivery.defer(third);

	const delivered: { id: string }[] = [];

	delivery.flush((r) => {
		if (r.id === 'sa-2') {
			throw new Error('sa-2 delivery failed');
		}

		delivered.push(r);
	});
	assert.deepEqual(delivered, [first, third]);

	// Only the failed result remains pending for the next flush.
	const retried: { id: string }[] = [];

	delivery.flush((r) => retried.push(r));
	assert.deepEqual(retried, [second]);
});

test('a result consumed mid-flush is not resent by that same flush', () => {
	const delivery = createDeferredResultDelivery<{ id: string }>();
	const first = { id: 'sa-1' };
	const second = { id: 'sa-2' };

	delivery.defer(first);
	delivery.defer(second);

	const delivered: { id: string }[] = [];

	delivery.flush((r) => {
		if (r.id === 'sa-1') {
			delivery.consume(['sa-2']);
		}

		delivered.push(r);
	});

	assert.deepEqual(delivered, [first]);
	assert.deepEqual(delivery.drain(), []);
});
