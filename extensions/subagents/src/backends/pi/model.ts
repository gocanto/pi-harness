import type { Api, Model } from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { createAgentSession } from '@earendil-works/pi-coding-agent';

/** The thinking-level type accepted by the pi agent session factory. */
export type PiThinkingLevel = NonNullable<NonNullable<Parameters<typeof createAgentSession>[0]>['thinkingLevel']>;

/** Resolves shared subagent model hints using the parent pi model registry. */
export class PiModelResolver {
	/**
	 * Resolve a provider-qualified or bare model hint.
	 *
	 * Bare ids first prefer the inherited provider, then must be unique across
	 * providers. An omitted hint inherits the parent model when available.
	 */
	static resolve(registry: ModelRegistry, hint: string | undefined, inherited: { provider: string; id: string } | undefined): Model<Api> | undefined {
		if (!hint) {
			if (!inherited) {
				return undefined;
			}

			return registry.find(inherited.provider, inherited.id) ?? undefined;
		}

		const slash = hint.indexOf('/');

		if (slash > 0) {
			const provider = hint.slice(0, slash);
			const id = hint.slice(slash + 1);
			const found = registry.find(provider, id);

			if (found) {
				return found;
			}

			throw new Error(`Unknown model "${hint}".`);
		}

		if (inherited) {
			const found = registry.find(inherited.provider, hint);

			if (found) {
				return found;
			}
		}

		const matches = registry.getAll().filter((model) => model.id === hint);

		if (matches.length === 1) {
			return matches[0];
		}

		if (matches.length > 1) {
			throw new Error(`Model "${hint}" exists in multiple providers (${matches.map((model) => model.provider).join(', ')}). Use "provider/${hint}".`);
		}

		throw new Error(`Unknown model "${hint}".`);
	}
}
