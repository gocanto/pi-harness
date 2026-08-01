/** Background-terminal compatibility surface for the shared delivery queue. */

import { DeferredResultDelivery } from '../../shared/deferred-result-delivery.ts';

export { DeferredResultDelivery } from '../../shared/deferred-result-delivery.ts';

/** Create a delivery queue for legacy extension consumers. */
export function createDeferredResultDelivery<T extends { readonly id: string }>() {
	return new DeferredResultDelivery<T>();
}
