# Testing

The rules (confidence-oriented test ordering, no module mocks, real seams,
behaviour over interactions) live in [../SKILL.md](../SKILL.md) — this file
carries the seam catalog, worked examples, and runner conventions.

## The real-seam catalog

Never use `vi.mock`/`jest.mock` to replace modules. Every test double enters
through a seam the production code already exposes:

1. **Constructor injection** — the default. The test builds the class with
   fakes for its port interfaces.

```ts
class FakeReleaseStore {
	readonly recorded: Release[] = [];

	async latest(): Promise<Result<Release, ReleaseLookupError>> {
		return err(new ReleaseLookupError('empty'));
	}

	async record(release: Release): Promise<Result<void, ReleaseStoreError>> {
		this.recorded.push(release);

		return ok(undefined);
	}
}

it('records the release it deploys', async () => {
	const store = new FakeReleaseStore();
	const deployer = new Deployer(store, new FakeUploader(), fixedClock('2026-01-01'));

	const result = await deployer.deploy(config, build);

	expect(
		isOk(result),
	).toBe(true);
	expect(store.recorded).toHaveLength(1); // observable outcome, not a spy
});
```

2. **Injected service objects for framework code** — where constructor
   injection doesn't fit (composables, hooks, module-level state), accept an
   optional services parameter or resolve services through the framework's own
   injection (Vue `provide`/`inject` with an `InjectionKey`, defaulting to the
   real implementation). Components under test receive fakes via
   `mount(..., { global: { provide } })` — no module mocking involved.

3. **Data-seeding seams** — when production code reads a generated artifact
   (a route manifest, a fixture catalog), expose a test-only seeding function
   that loads the _real_ artifact into the real code path, instead of mocking
   the module that reads it.

4. **In-memory adapters** for simple behaviour; **local databases** (SQLite)
   when SQL/schema/transaction behaviour matters.

5. **Global transport stubbing** — `vi.stubGlobal("fetch", fake)` is a
   _global-seam_ stub, not a module mock, and is allowed for transport-level
   tests. Restore it in `afterEach`. (Injecting an `HttpClient` port remains
   the better design where the code already has one.)

## Worked example: removing a `vi.mock`

**Before** — the test re-implements the route table by mocking the module,
so it drifts silently when routes change:

```ts
vi.mock('@/api/routes', () => ({
	apiRouteUrl: (name: string, params: Record<string, string>) => (name === 'operations.show' ? `/api/operations/${params.operation}` : '/api/unknown'),
}));
```

**After** — the real module runs against the real generated manifest, seeded
through a test-only seam; assertions are unchanged:

```ts
import { seedTestApiRouteManifest, clearTestApiRouteManifest } from '#tests/api-route-manifest';

beforeEach(() => seedTestApiRouteManifest());
afterEach(() => clearTestApiRouteManifest());
```

If the mocked behaviour and the real behaviour differ, the mock was hiding a
bug — that difference is the finding, not a reason to keep the mock.

## What to assert

Observable input/output behaviour: the returned value or error, persisted
state, an emitted event, a rendered response, a recorded send in a fake.
Avoid `expect(spy).toHaveBeenCalledWith(...)` unless the interaction itself
is the only observable behaviour (e.g. a fire-and-forget notification).

Tests must not bypass parsers, smart constructors, or invariants: build test
data through the same factories production uses (or through arbitraries, see
below) — never by casting object literals into branded/refined types.

## Property tests with fast-check

Use `fast-check` where properties are clearer than examples: parsers and
smart constructors, branded types, state machines, serialization round-trips,
normalization idempotence.

```ts
import fc from 'fast-check';

it('parse accepts every render round-trip', () => {
	fc.assert(
		fc.property(emailAddressArbitrary(), (email) => {
			const reparsed = parseEmailAddress(
				toString(email),
			);

			expect(isOk(reparsed) && equals(reparsed.value, email)).toBe(true);
		}),
	);
});
```

Export arbitraries next to the domain module they support:

```txt
src/billing/
  invoice-number.ts
  invoice-number.arbitrary.ts
tests/
  invoice-number.test.ts
```

## Runner conventions

- Tests live in the package's `tests/` directory as `*.test.ts`, named for
  the module under test (`theme.test.ts` for `src/theme.ts`).
- Import test APIs explicitly from the runner's entrypoint rather than
  relying on globals, so the file states its dependencies.
- Coverage thresholds are configured centrally (the vite/vitest config), not
  per-file; a change that drops coverage below threshold fails the gate.
- Reset seams deterministically: seed in `beforeEach`, restore in
  `afterEach`; a test file must pass in isolation and in any order.

## Local status (this repository — delete when mounting elsewhere)

- Runner: vitest via `vp test run` (`pnpm test` at the root); environment
  `happy-dom`; coverage thresholds live in `apps/app/vite.config.ts` and
  `infra/vite.config.ts`. Test imports come from `'vite-plus/test'`.
- In-repo exemplars of the seams above: `apps/app/src/theme.ts` exposes a
  `ThemeServices` parameter (see `tests/theme.test.ts` — a fully compliant
  suite); the route-manifest seeding seam is `#tests/api-route-manifest`
  (`seedTestApiRouteManifest`/`clearTestApiRouteManifest`, backed by
  `tests/api-route-manifest.generated.json`); `SkillsWorkspace.vue` resolves
  services via `InjectionKey` provide/inject.
- Known divergences (target-state, migration pending): `vi.mock` is still
  used in `apps/app/tests/repository-links.test.ts`,
  `skill-import-settings-client.test.ts`, and `SkillsWorkspace.test.ts` —
  all three have existing seams to migrate to (the manifest seam for the
  first two, `InjectionKey` fakes for the third). `fast-check` is not yet
  installed; add it via the pnpm catalog when the first property test lands.

## Quick Reference

| Situation                         | Seam                                                      |
| --------------------------------- | --------------------------------------------------------- |
| Class with injected ports         | constructor injection + hand-written fake                 |
| Composable / hook / module state  | injected services object (framework DI)                   |
| Code reading a generated artifact | test-only seeding of the real artifact                    |
| Persistence behaviour             | in-memory adapter; SQLite when SQL matters                |
| Network calls                     | injected `HttpClient` port; else `vi.stubGlobal("fetch")` |
| Module mocking (`vi.mock`)        | never — find or build the seam                            |
| Parser/serializer/state machine   | fast-check property + colocated arbitrary                 |
| Assertions                        | outcomes (values, state, records) — not call spies        |
