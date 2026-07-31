---
name: typescript-coding-standards
description: Use this skill when designing or changing TypeScript code, including new modules, refactors, adapters, services, tests, parsing/schema work, error handling, telemetry, dependency boundaries, and repository convention decisions.
---

# TypeScript Coding Standards Skill

Source: Ported from https://gist.github.com/dmmulroy/9c80f1f499b031aa0b6525b5d9ae25f0.

# TypeScript Coding Standards

These standards describe how to design and write TypeScript code in this codebase. They are especially intended for agents: before adding patterns, libraries, adapters, or abstractions, read the existing code and prefer the local convention unless it conflicts with the safety/correctness principles below.

**Repository standard: class-based, organized by concern.** This codebase is deliberately object-oriented. Behaviour lives in classes grouped into concern slices, encapsulated behind narrow interfaces, wired by constructor dependency injection. Plain functions are the exception, allowed only where a framework requires a function signature (framework glue), for inherently-imperative private helpers, and for a small number of documented value types (see [Class-based concern slices](#class-based-concern-slices-repository-standard) and the `Result` exception). The functional-core / imperative-shell discipline still applies — but it applies _inside_ class methods (pure private methods, no ambient I/O), not as a reason to prefer free functions over classes.

## Workflow

For any substantial piece of work:

1. Understand constraints: runtime, throughput, error budget, deployment target.
2. Design contracts first: types, ports/interfaces, request/response DTOs, the error model.
3. Implement to the class/concern-slice standard: parse at boundaries, inject dependencies, typed errors as values.
4. Validate with tests through real seams before proposing optimisation work.
5. Finish clean with the repo's gate: typecheck, lint, tests, format.

Non-negotiable on every change: run the repo's typecheck/lint/test targets; JSDoc every exported symbol; no `vi.mock`/`jest.mock`; no non-null assertions; no undocumented casts.

Deep dives live in `references/`:

- [references/modules-and-di.md](references/modules-and-di.md) — concern slices, the four class shapes with full examples, thin glue, composition root, adapter reuse audit
- [references/errors-and-results.md](references/errors-and-results.md) — the `Result` implementation, tagged errors, defect helpers, `Redacted<T>`
- [references/parsing-and-schemas.md](references/parsing-and-schemas.md) — boundary parsing, Zod patterns, branded types, naming
- [references/testing.md](references/testing.md) — the real-seam catalog, removing module mocks, fast-check, runner conventions
- [references/tooling.md](references/tooling.md) — exact tsconfig baseline, lint rules and the SAFETY ritual, formatting, JSDoc enforcement

## Decision priority

When rules pull in different directions, use this order:

1. Preserve correctness, safety, and debuggability.
2. Follow established project architecture and conventions (the class/concern-slice standard below).
3. Improve the local design toward these standards.
4. Document meaningful trade-offs with comments or ADRs.

New code paths, modules, adapters, and services must follow the class/concern-slice standard. Existing functional code is being migrated toward it incrementally, one concern/package per PR; match the target pattern when you touch a file rather than adding new free-function surface area.

## Core principles

- **Model behaviour as classes grouped by concern.** Free functions are the exception (framework glue, private imperative helpers, documented value types), not the default.
- **Encapsulate.** Keep fields `private readonly`; expose behaviour through methods, not data. Inject dependencies through the constructor.
- Prefer **composition to inheritance** — do not build inheritance hierarchies for domain or application behaviour.
- Prefer **errors as values** over `throw` / rejected promises for expected failures.
- Parse early. Do not merely validate and throw away the information learned.
- Make illegal states unrepresentable where practical.
- Prefer correct-by-construction APIs over convention-based invariants.
- Use branded/refined/domain types liberally for meaningful primitives.
- Keep the functional core pure inside class methods; keep the imperative shell (I/O, time, randomness) at the composition root.
- Design deep, cohesive modules with low caller burden.
- Test behaviour through real seams; avoid module mocks and spy-driven tests.
- Keep code discoverable for humans and agents.

## Class-based concern slices (repository standard)

Code is organized into **concern slices**: self-contained folders that own one domain problem end to end (its types, classes, serialization, and barrel) — e.g. `env-config/`, `deploy/`, `secrets/`, `provision/`, each a vertical slice, all depending on a shared `kernel/`. A complete worked layout lives in [references/modules-and-di.md](references/modules-and-di.md).

Rules for concern slices:

- **One concern per folder.** A slice owns a cohesive capability (billing, webhooks, events, identity), not a technical layer (`handlers/`, `utils/`).
- **Concerns do not cross-import each other.** They depend only on the shared `kernel/` (ports/interfaces + constants + the composition root) and on their own files. Shared behaviour goes into `kernel/` or a lower slice, never sideways.
- **`kernel/` is the dependency-injection boundary.** It holds port interfaces (`FileSystem`, `HttpClient`, `Db`, `Clock`, …), constants, and exactly one composition root that constructs concrete adapters once and injects them down (template in [references/modules-and-di.md](references/modules-and-di.md)). The composition root is the only place allowed to reach runtime singletons / ambient I/O (`env()`, `database()`, `fetch`, `crypto`, clocks).
- **Barrels are required, not avoided (this overrides the general "avoid barrels" guidance below for slice public surfaces).** Each slice has an `index.ts` re-exporting its public classes; the package `src/index.ts` re-exports by concern; `package.json` `exports` maps `.` and per-concern subpaths. Consumers import from the package/concern barrel via repo aliases, never via relative paths.

### The four class shapes

Every non-glue class should fit one of these shapes. Reach for the simplest that fits. A complete code template for each lives in [references/modules-and-di.md](references/modules-and-di.md).

1. **Immutable DTO** — a validated, immutable data carrier. Private constructor, static `from()` (or `parse()`) factory, `readonly` fields exposed through typed getters, functional `withX()` updates that return a new instance. No I/O, no dependencies.
2. **Orchestrator / service** — owns a capability. Dependencies injected through the constructor, private (optionally memoized) state, public action methods, composition over inheritance.
3. **Transport / adapter** — talks to the outside world. Private I/O methods, public domain operations, all I/O behind an injected port interface so it is testable with a fake.
4. **Static-only utility** — pure serialization/parsing/formatting grouped under a class namespace, no instance state (e.g. `DotenvFormatter`, `Jsonc`). Prefer this over a loose `utils.ts` of free functions.

### Framework glue is exempt (thin shell only)

Framework entrypoints keep functional signatures because the framework requires them, but they must stay **thin**: resolve dependencies from context, call a service class, serialize the result. No domain rules, queries, or multi-step logic in the glue.

- **Hono handlers / route factories** — `(c) => { const deps = serverDeps(c); const dto = await new XService(deps).action(input); return c.json(XSerializer.toPayload(dto)); }`. Business logic lives in the service; `routes/*` only wires paths.
- **Vue `<script setup>` and `useX` composables** — components and composables stay functional and reactive, but non-render logic moves into injected service classes / Pinia stores backed by services.
- **graphql-yoga resolvers, queue/scheduled handlers, CLI entrypoints** — same rule; they reuse the same service classes as the REST handlers.

### Documented functional exceptions

- **`Result` and tiny `prelude.ts` helpers stay functional.** `Result` is a value type discriminating on a tag; its helpers (`ok`/`err`/`map`/`isErr`) are functions by design (see [Errors and failures](#errors-and-failures)). Do not class-ify them.
- **Inherently-imperative private helpers** (parsers, retry loops, char-by-char state machines) may be plain functions, but keep them **private inside the owning class** (e.g. a `private static` method) rather than exported free functions.

### Aliases for new public entrypoints

Adding a new public concern entrypoint (one imported from another package/app) requires a three-way update, kept in sync:

1. the workspace alias table (wherever the repo centralizes bundler/test resolution),
2. the matching `paths` entry in the relevant `tsconfig.json` (this is also the production resolver),
3. the `exports` map in the package's `package.json`.

Internal moves within a package that already has a wildcard alias need no alias change. Never use `./` or `../` specifiers (see `.agents/skills/no-relative-module-specifiers`). The concrete alias-table location for this repository is in the Local reference section below.

## Adapting to existing codebases

Before adding a new pattern or library, inspect the repo for existing choices around:

- error handling
- schema parsing
- dependency injection
- testing
- observability
- adapters/services
- module layout

Prefer consistency inside the codebase. If existing code uses exception-style errors, do not rewrite the whole system. New code may still use typed results internally, but it must integrate with existing framework handlers, logging, tracing, metrics, and error reporting.

At boundaries, translate between local typed errors and whatever the framework or existing code expects.

## Errors and failures

### Expected failures are values

Expected failures include domain, parsing, authorisation, integration, I/O, persistence, and workflow failures. They should appear in the return type.

Preferred order:

1. Effect, when the codebase already uses Effect.
2. `better-result`, when available and appropriate.
3. A small local tagged union:

```ts
type Result<T, E extends Error> = { readonly _tag: 'ok'; readonly value: T } | { readonly _tag: 'err'; readonly error: E };
```

Prefer:

```ts
Promise<Result<User, UserLookupError>>;
```

not:

```ts
Promise<User>; // rejects for ordinary lookup/storage failures
```

Promise rejection is equivalent to throwing. Treat it as acceptable only for unrecoverable defects or unclassified third-party errors at a boundary.

### Unrecoverable defects may throw

Throwing is acceptable for panic-style failures:

- violated internal invariants
- impossible branches
- startup misconfiguration
- temporary `notYetImplemented` paths
- catastrophic runtime conditions

Use shared helpers from `prelude.ts` where available:

```ts
export function casesHandled(unexpectedCase: never): never;

export function shouldNeverHappen(msg?: string): never;

export function notYetImplemented(msg?: string): never;
```

Use `casesHandled` for exhaustive union handling. Avoid names like `absurd` or one-off `assertNever` helpers when the project already has these helpers.

### Custom errors

Expected failures should use custom tagged errors, generally extending:

- `Error`
- `TaggedError` from `better-result`
- `Schema.TaggedErrorClass` in Effect codebases

Custom errors should include:

- stable tag
- useful message
- structured contextual fields
- safe telemetry fields
- optional `cause: unknown`

Example:

```ts
export class UserStoreUnavailable extends Error {
	readonly _tag = 'UserStoreUnavailable';

	constructor(
		readonly operation: 'findActiveByEmail',
		readonly provider: 'postgres',
		readonly cause: unknown,
	) {
		super(`User store unavailable during ${operation}`);
	}
}
```

Keep error unions precise at module boundaries:

```ts
Result<User, UserNotFound | UserStoreUnavailable>;
```

Avoid broad `AppError`-style types except near entrypoint, orchestration, logging, and rendering layers.

## Sensitive data, telemetry, and debugging

Prefer end-to-end structured tracing across requests, jobs, workflows, application modules, adapters, and external calls.

Tracing/logging should make failures diagnosable with safe fields:

- domain IDs
- operation names
- dependency/provider names
- state tags
- retry counts
- typed error tags
- safe summaries

Do not put secrets in errors, traces, logs, or snapshots.

Use a `Redacted<T>` wrapper for sensitive values such as tokens, API keys, passwords, raw credentials, and secrets. Prefer Effect's `Redacted.Redacted` in Effect codebases or a local `Redacted<T>` in `prelude.ts`.

Wrap sensitive values at the boundary and unwrap only where the raw value is needed, usually inside an adapter making an external call.

## Parse, don't validate

Boundary code should turn unknown or less-structured input into domain types as early as practical.

Prefer:

```ts
unknown -> HttpBodyDto -> CreateUserInput -> EmailAddress/UserId/etc.
```

not:

```ts
unknown -> z.infer<typeof CreateUserSchema>
```

passed throughout the app.

Use names that preserve meaning:

- `parseX(input): Result<X, ParseXError>` for untrusted or less-structured input
- `makeX(...)` / `createX(...)` for smart constructors from already-typed pieces
- `isX(value): boolean` for true predicates
- `assertX(...)` rarely, mostly at tests/framework boundaries

Avoid `validateX` when the function returns a refined value. It parsed something.

### Schemas

Use schema libraries as boundary parsers, not as ad-hoc validators sprinkled through core logic.

Preference:

- use the repo's established schema library if one exists
- use Effect Schema in Effect codebases
- prefer Standard Schema compatibility for generic helpers
- otherwise prefer Zod 4
- use handwritten smart constructors/parsers for small domain types when clearer

Schema parsing should produce refined/domain types and typed custom errors where practical.

## Branded types and correct construction

Use branded/refined types for meaningful primitives:

- IDs: `UserId`, `OrgId`, `WorkflowId`
- parsed strings: `EmailAddress`, `NonEmptyString`, `Url`
- constrained numbers: `PositiveInt`, `Cents`, `Percentage`
- units: `Milliseconds`, `Bytes`, `UsdCents`

Construct branded values through parsers or smart constructors. Avoid passing raw strings/numbers where a domain type exists.

Avoid optional/null/undefined values in functions that require a value. Push optionality outward. Branch or parse before calling.

Avoid `Partial<T>` as an application/domain input unless partiality is the real domain concept. Prefer explicit input types for each operation.

## State machines and boolean blindness

When an entity has meaningful lifecycle states, model them with tagged unions or equivalent value classes.

Prefer:

```ts
type Invoice =
	| { readonly _tag: 'Draft'; readonly id: InvoiceId; readonly lines: NonEmptyArray<LineItem> }
	| { readonly _tag: 'Sent'; readonly id: InvoiceId; readonly sentAt: Instant }
	| { readonly _tag: 'Paid'; readonly id: InvoiceId; readonly paidAt: Instant };
```

Avoid:

```ts
type Invoice = {
	readonly isSent: boolean;
	readonly isPaid: boolean;
	readonly sentAt?: Date;
	readonly paidAt?: Date;
};
```

Avoid boolean parameters that control behaviour:

```ts
createUser(input, true);
```

Prefer named options or domain types:

```ts
createUser(
	input,
	{ emailVerification: 'skip' },
);
```

Booleans are fine as clear predicate return values:

```ts
isExpired(token): boolean;
hasPermission(user, permission): boolean;
```

## Modules and abstractions

### Deep modules

A deep module hides substantial behaviour/invariants behind a cohesive, low-burden interface. Low-burden does not necessarily mean few functions. A domain module may expose many cohesive combinators around one concept and still be deep.

Avoid shallow abstractions that merely forward calls, mirror tables, or expose implementation steps.

Use the deletion test:

- if deleting the module makes complexity disappear, it was probably pass-through waste
- if deleting it spreads complexity across callers, it was probably earning its keep

### Domain modules

Prefer OCaml-style domain modules for core concepts. A domain module centers on one primary type or tightly related type family and exposes parsers, smart constructors, combinators, predicates, interpreters, arbitrariness, and formatting helpers for that concept.

Example:

```ts
// email-address.ts

/** A parsed, normalized email address. */
export type EmailAddress = Brand<string, 'EmailAddress'>;

/** Parse an email address from untrusted input. */
export function parse(input: string): Result<EmailAddress, InvalidEmailAddress>;

/** Render an email address as a string. */
export function toString(email: EmailAddress): string;

/** Compare two email addresses for equality. */
export function equals(left: EmailAddress, right: EmailAddress): boolean;
```

Model domain concepts as classes by default — an immutable DTO (shape 1) for values, or a static-only utility class (shape 4) for a namespace of pure helpers over a concept. Reserve plain functions for the documented exceptions (`Result`, prelude helpers, private imperative helpers).

If using classes for domain values:

- construct through `parse` / `make` / smart constructors
- make invalid instances unconstructable
- keep fields readonly/immutable from callers
- keep methods cohesive over that value
- do not hide dependencies or I/O inside domain value classes
- avoid inheritance for domain behaviour

### Application/service modules

Application modules own real capabilities or operations:

- `PasswordReset`
- `Billing`
- `Invitations`
- `SubscriptionLifecycle`

They coordinate domain modules, persistence, external calls, authorisation, workflows, and telemetry.

Prefer classes with constructor injection when the module has dependencies, stateful resources, configuration, or multiple cohesive operations.

Avoid threading a `deps` object into every free function. An aggregate ports object (e.g. `CloudflareDeps` / `ServerDeps`) injected once through a class constructor and built at the composition root is the intended pattern, not a code smell — the class holds it as a `private readonly` field.

No arbitrary method limit. Split when methods are unrelated, change for different reasons, require unrelated dependencies, or create an accidental grab bag.

Avoid vague names like `Manager`, `Processor`, `Helper`, or generic `UserService` unless established by the framework/project.

## Dependency interfaces and adapters

Depend on the smallest meaningful shape a module actually uses. Let concrete adapters be wider.

Because TypeScript is structurally typed, this works well:

```ts
type UsersForPasswordReset = {
	findActiveByEmail(email: EmailAddress): Promise<Result<ActiveUser, UserLookupError>>;
};

export class PasswordReset {
	constructor(private readonly users: UsersForPasswordReset) {}
}
```

A wider adapter can satisfy it:

```ts
export class PostgresUsers {
  findActiveByEmail(...) { ... }
  findById(...) { ... }
  updateProfile(...) { ... }
}
```

This avoids both mega-repositories and one-method adapter sprawl.

### Adapter reuse audit

Before creating a new adapter or service, agents must audit existing adapters/services.

Prefer, in order:

1. Reuse an existing adapter as-is through a narrow dependency type.
2. Extend an existing adapter if the new method fits its existing cohesive capability and changes for the same reason.
3. Create a new adapter only when reuse/extension would create bad coupling or an accidental interface.

When a meaningful new adapter/service is still created after the audit, create an ADR explaining:

- what existing adapters/services were checked
- why reuse did not fit
- why extension did not fit
- why the new adapter is a separate cohesive capability

Do not require an ADR for tiny local test adapters, obvious in-memory fakes, or trivial framework glue.

ADR format and location: follow `.agents/skills/domain-modeling/ADR-FORMAT.md` (`docs/adr/`, sequential `0001-slug.md`, create the directory lazily on first need). A worked reuse-audit example lives in [references/modules-and-di.md](references/modules-and-di.md).

### Repositories and persistence

Avoid repository-per-table by default.

Repository-like adapters are acceptable when they represent a cohesive domain persistence capability. They should expose meaningful domain operations and return parsed domain types / typed errors, not raw rows and ORM errors.

Treat raw database rows and ORM models as infrastructure DTOs. Parse them before application/core logic. Keep SQL/ORM details inside infrastructure adapters or persistence modules.

## Functional core, imperative shell, and entrypoint

Keep domain/application behaviour reusable across REST, CLI, GraphQL, workers, and other entrypoint.

The functional core contains:

- domain logic
- parsers
- state transitions
- combinators
- decision functions

It avoids:

- I/O
- hidden dependencies
- ambient time/randomness
- thrown expected failures
- framework-specific concerns

The imperative shell:

- parses untrusted input
- sequences effects
- calls the core with refined values
- classifies external failures into typed errors
- handles I/O, persistence, HTTP, queues, telemetry, time, randomness

Entrypoint adapters should be thin protocol translation layers. They parse protocol-specific input, invoke shared modules, and render protocol-specific output. Do not duplicate business rules in controllers/resolvers/CLI handlers.

Authorization belongs in shared application/domain policy, not duplicated in controllers. Entrypoint may authenticate and parse users/sessions/credentials, but shared modules should receive a domain-specific parsed authorisation input such as `AdminUser`, `Session`, `Principal`, `DeployCredential`, or `CommandActor`.

## Workflows, transactions, and idempotency

Use ordinary function calls or database transactions for simple single-boundary operations.

Use a saga/durable workflow when the process needs:

- retries
- compensation
- idempotency
- resumability
- timers
- human approval
- cross-service coordination
- multiple transaction boundaries

Do not hold database transactions open across network calls or long-running operations.

Any command, job, or workflow step that may be retried needs an explicit idempotency strategy:

- idempotency key
- natural unique constraint
- deduplication record
- state-machine transition guard
- transactional outbox/inbox

Retrying should not rely on “probably safe” side effects.

## Testing

Prefer confidence-oriented tests:

1. e2e for critical user flows
2. integration tests through real seams
3. focused/property tests for pure domain modules
4. unit tests when they test meaningful behaviour, not implementation details

Never use `vi.mock` or `jest.mock` for module mocking. Use real seams:

- constructor-injected interfaces/classes
- Effect services/layers
- local database substitutes such as SQLite
- in-memory adapters when behaviour is simple
- fake external adapters when needed

Prefer tests that assert observable input/output behaviour:

- returned value/error
- persisted state
- emitted event/message
- rendered response
- sent email record in a fake/local adapter

Avoid spy-driven tests like `expect(sendEmail).toHaveBeenCalledWith(...)` unless the interaction itself is the only observable behaviour.

For persistence behaviour, prefer SQLite/local DB-backed tests over hand-rolled in-memory fakes when SQL/schema/transaction behaviour matters.

### Property tests and arbitrariness

Use `fast-check` where properties are clearer than examples, especially for:

- parsers/smart constructors
- branded/refined types
- state machines
- serialization roundups
- normalization/idempotence
- lawful combinators

Use arbitrariness for mock/test data generation. Prefer exporting arbitrariness near the domain module they support:

```txt
src/billing/
  invoice-number.ts
  invoice-number.test.ts
  invoice-number.arbitrary.ts
```

Tests should not bypass parsers, smart constructors, or invariants.

## TypeScript style and safety

Use strict TypeScript settings where practical:

- `strict: true`
- `noUncheckedIndexedAccess: true`
- `exactOptionalPropertyTypes: true`
- `noImplicitOverride: true`
- `noFallthroughCasesInSwitch: true`

Prefer immutable values:

```ts
type CreateUserInput = {
	readonly email: EmailAddress;
	readonly roles: ReadonlyArray<Role>;
};
```

Mutation is acceptable inside localised imperative shell code, performance-sensitive internals, builders, or adapters when hidden behind a precise interface.

### Casts, `any`, and non-null assertions

Avoid:

- `any`
- non-null assertions (`!`)
- casts with `as Type`

`as const` is fine.

Rare exceptions are allowed for highly generic helpers, branding internals, interop boundaries, or combinators where TypeScript cannot express the invariant.

Any non-`as const` cast requires a Rust-like safety comment:

```ts
// SAFETY: TypeScript cannot express the brand. parseEmailAddress checked the normalized string before branding. Callers cannot construct EmailAddress except through this parser.
return normalized as EmailAddress;
```

Rare `any` also requires a targeted oxlint ignore and justification:

```ts
// oxlint-disable-next-line no-explicit-any -- SAFETY: This helper preserves arbitrary function parameters; TypeScript cannot express this variadic constraint without any.
type Fn = (...args: any[]) => unknown;
```

Do not use `!`. Branch, parse, or refine instead.

## Imports, exports, and files

Import through repo aliases only. Never use `./` or `../` module specifiers (see `.agents/skills/no-relative-module-specifiers`).

**Concern barrels are the standard, not something to avoid.** Each concern slice exposes its public classes through an `index.ts`; the package `src/index.ts` re-exports by concern; `package.json` `exports` maps `.` and per-concern subpaths. Import from the package or concern barrel (`@acme/cloud`, `@acme/cloud/secrets`) or from a package-internal wildcard alias (`@server/context/identity`). Do not deep-import a sibling concern's internal files to bypass its barrel.

Use named imports for classes, prelude helpers, and focused shared helpers:

```ts
import { casesHandled } from '@primitives/prelude';
import { SecretsClient } from '@acme/cloud/secrets';
```

Use `import type` / `export type` for type-only imports and exports.

Export only what callers should use. Keep internal helpers unexported unless intentionally shared. Do not export internals just for tests.

Avoid TypeScript `namespace` unless there is a compelling interop reason.

Avoid vague files:

```txt
utils.ts
helpers.ts
common.ts
misc.ts
```

Use precise names:

```txt
email-address.ts
billing-period.ts
string-case.ts
array.ts
prelude.ts
```

`prelude.ts` is allowed for tiny ubiquitous generic helpers/types such as:

- `casesHandled`
- `shouldNeverHappen`
- `notYetImplemented`
- `Redacted`
- common `Result` helpers
- broad type utilities

Do not put domain/application policy in `prelude.ts`.

No arbitrary file-size limits. Prefer cohesion and discoverability over small files for their own sake. Split when a file has multiple unrelated reasons to change or callers must understand unrelated concepts.

## Comments and JSDoc

Comments should explain invariants, trade-offs, non-obvious domain rules, and safety justifications. Avoid comments that narrate obvious code.

Every exported function, class, method, constant, and usually exported type should have JSDoc.

Use standard JSDoc syntax:

```ts
/**
 * Parse an email address from untrusted input.
 *
 * @param input - The untrusted string to parse.
 * @returns A parsed email address, or `InvalidEmailAddress` when the input is invalid.
 */
export function parse(input: string): Result<EmailAddress, InvalidEmailAddress>;
```

For generics:

```ts
/**
 * Map the success value of a result.
 *
 * @template T - The original success type.
 * @template U - The mapped success type.
 * @template E - The error type.
 * @param result - The result to map.
 * @param fn - The function applied to the success value.
 * @returns A result with the mapped success value, or the original error.
 */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E>;
```

Use `@throws` only for unrecoverable defects, framework-required behaviour, or temporary `notYetImplemented` paths. Do not document expected typed errors as throws.

For complex exported object types, document fields when helpful:

```ts
/** Input required to create a user. */
export type CreateUserInput = {
	/** The actor creating the user. */
	readonly actor: AdminUser;

	/** The parsed email address for the new user. */
	readonly email: EmailAddress;
};
```

## Configuration and resources

Parse environment/config at startup or the earliest boundary into typed config with branded/redacted values where appropriate.

Do not read `process.env` throughout the app. Missing/invalid config is a startup failure with useful context.

Avoid top-level side effects except in true entrypoint/bootstrap files. Modules should not start servers, open connections, read env, register handlers, or perform I/O at import time.

Resource creation and clean-up should be explicit and owned by bootstrap/imperative shell code or Effect layers when using Effect.

Avoid mutable singletons/global state. Constants and pure lookup tables are fine. If a singleton is required by a framework/runtime, isolate it at the boundary.

Inject `Clock` / `Random` services into dependency-bearing modules. Pure domain functions may accept explicit `now` / random values.

## Quick agent checklist

Before coding:

- Pick the concern slice the code belongs to; put behaviour in a class of one of the four shapes, not a free function.
- Keep framework glue (Hono handlers, Vue composables, resolvers) thin — resolve deps, call a service, serialize.
- Inject dependencies through the constructor; keep runtime singletons / ambient I/O at the composition root only.
- Export public classes through the concern/package barrel; import via repo aliases, never `./`/`../`.
- Read existing conventions for errors, schemas, tests, adapters, telemetry, and module layout.
- Look for existing domain modules/types before creating new ones.
- Look for existing adapters/services before creating a new one.
- Parse inputs at the edge and use domain types internally.
- Avoid raw DTOs, raw IDs, nullable bags, and `Partial<T>` in core/application logic.
- Prefer typed errors as values for new expected failures.
- Preserve existing observability/error mechanics.
- Test through public interfaces and real seams.
- Use `fast-check` arbitrariness for generated test data when practical.
- Add JSDoc for exported symbols.
- Add ADRs for meaningful new adapters/services created after an adapter reuse audit.

## Local reference (this repository)

This section is the only repo-specific part of the skill; delete it when mounting the skill elsewhere.

The TypeScript lives in three workspace packages:

- `apps/app` — the Electron + Vue 3 application, and the bulk of the TS. **It predates the concern-slice standard**: `src/` is flat files (`skills.ts`, `settings.ts`, `theme.ts`, …) with classes but no slice folders, barrels, or `exports` maps. Migration is incremental — match the target pattern when you touch a file; do not add new free-function surface area.
- `apps/ui` — shared Vue components (reka-ui/tailwind wrappers).
- `infra` — workspace tooling (`src/paths.ts`, `src/workspace/aliases.ts`).

Local mechanics to match:

- **Aliases three-way sync**: (1) `workspaceAliases()` in `infra/src/workspace/aliases.ts`, (2) `paths` in the relevant `tsconfig.json`, (3) `exports`/`imports` in the package's `package.json`. App-local aliases (`@/`, `#tests/*`, `#electron/*`) live in `apps/app`'s own configs.
- **Tooling locations**: oxlint and oxfmt are configured inline in the root `vite.config.ts` (`lint` and `fmt` blocks); there is **no shared base tsconfig yet** — `infra`, `apps/app`, and `apps/app/tsconfig.electron.json` are independent, and the four strict flags in [references/tooling.md](references/tooling.md) are not yet enabled (current divergences and measured adoption cost are noted there).
- **Tests**: vitest via `vp test run`, files in `tests/*.test.ts`, environment happy-dom, coverage thresholds in each package's `vite.config.ts`. Exemplar seams: `ThemeServices` injection (`src/theme.ts` + `tests/theme.test.ts`), the `#tests/api-route-manifest` seeding seam, and `InjectionKey` provide/inject in `SkillsWorkspace.vue`. Three test files still use `vi.mock` — known divergences listed in [references/testing.md](references/testing.md), slated for migration, not precedent.
- **Commands**: `pnpm run typecheck`, `npx vp lint`, `pnpm test`, `make format`.
