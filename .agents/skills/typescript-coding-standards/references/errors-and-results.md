# Errors, Results, and Defect Helpers

The rules (expected failures are values, defects may throw, precise unions at
boundaries) live in [../SKILL.md](../SKILL.md) — this file carries the
reference implementations and worked examples.

## The local `Result` type

When the codebase has no established result library (Effect, `better-result`),
use this small tagged union. It is a documented functional exception: `Result`
and its helpers are value-type functions by design — do not class-ify them.

```ts
// prelude.ts

/** The outcome of an operation whose expected failures are values. */
export type Result<T, E extends Error> = { readonly _tag: 'ok'; readonly value: T } | { readonly _tag: 'err'; readonly error: E };

/** Wrap a success value. */
export function ok<T>(value: T): Result<T, never> {
	return { _tag: 'ok', value };
}

/** Wrap an expected failure. */
export function err<E extends Error>(error: E): Result<never, E> {
	return { _tag: 'err', error };
}

/** True when the result is a success. Narrows the type. */
export function isOk<T, E extends Error>(result: Result<T, E>): result is { readonly _tag: 'ok'; readonly value: T } {
	return result._tag === 'ok';
}

/** True when the result is a failure. Narrows the type. */
export function isErr<T, E extends Error>(result: Result<T, E>): result is { readonly _tag: 'err'; readonly error: E } {
	return result._tag === 'err';
}

/** Map the success value, passing failures through unchanged. */
export function map<T, U, E extends Error>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
	return isOk(result) ? ok(
		fn(result.value),
	) : result;
}

/** Chain a result-returning function, flattening the failure channel. */
export function andThen<T, U, E extends Error, F extends Error>(result: Result<T, E>, fn: (value: T) => Result<U, F>): Result<U, E | F> {
	return isOk(result) ? fn(result.value) : result;
}

/** Unwrap a success or throw the failure — boundary/defect use only. */
export function unwrap<T, E extends Error>(result: Result<T, E>): T {
	if (isErr(result)) {
		throw result.error;
	}

	return result.value;
}
```

Async operations return `Promise<Result<T, E>>`. A rejected promise is a
throw: reserve it for defects and unclassified third-party errors at a
boundary, never for ordinary lookup/storage failures.

## Custom tagged errors

Expected failures use custom errors extending `Error` with a stable `_tag`,
structured telemetry-safe fields, and an optional `cause`.

**Good** — the caller can branch, log, and retry with data:

```ts
/** The user store could not serve a request. */
export class UserStoreUnavailable extends Error {
	readonly _tag = 'UserStoreUnavailable';

	constructor(
		readonly operation: 'findActiveByEmail' | 'record',
		readonly provider: 'postgres',
		readonly cause: unknown,
	) {
		super(`User store unavailable during ${operation}`);
	}
}

/** No active user matches the given address. */
export class UserNotFound extends Error {
	readonly _tag = 'UserNotFound';

	constructor(readonly email: EmailAddress) {
		super('No active user for the given email address');
	}
}
```

**Bad** — stringly-typed, unbranchable, leaks data into the message:

```ts
throw new Error(`lookup failed for ${email}: ${e}`); // no tag, no fields,
// email address (PII) baked into the message, cause flattened to a string
```

Keep unions precise at module boundaries:

```ts
findActiveByEmail(email: EmailAddress): Promise<Result<ActiveUser, UserNotFound | UserStoreUnavailable>>;
```

A broad `AppError` is acceptable only near entrypoints, orchestration,
logging, and rendering — the places that genuinely treat all failures alike.

## Boundary translation

At the edge between typed-result code and exception-style code (frameworks,
legacy modules, third-party SDKs), translate explicitly — in both directions:

```ts
// exception world -> result world (inside an adapter)
try {
	const rows = await this.db.query(sql);
	return ok(rows);
} catch (cause) {
	return err(new UserStoreUnavailable('findActiveByEmail', 'postgres', cause));
}

// result world -> exception world (framework handler that must throw/return 500)
const user = await users.findActiveByEmail(email);
if (isErr(user)) {
	throw framework.httpError(user.error._tag === 'UserNotFound' ? 404 : 503, user.error.message);
}
```

Do not rewrite an existing exception-style system wholesale; new code uses
results internally and translates at its edges.

## Defect helpers

Throwing is for defects only. Keep these in `prelude.ts` and use them instead
of ad-hoc `throw new Error("unreachable")`:

```ts
/** Exhaustiveness check — compile error if a union case is unhandled. */
export function casesHandled(unexpectedCase: never): never {
	throw new Error(`Unhandled case: ${JSON.stringify(unexpectedCase)}`);
}

/** A supposedly-impossible branch was reached: internal invariant violated. */
export function shouldNeverHappen(msg?: string): never {
	throw new Error(msg ?? 'Invariant violated: this should never happen');
}

/** Temporary marker for unimplemented paths. */
export function notYetImplemented(msg?: string): never {
	throw new Error(msg ?? 'Not yet implemented');
}
```

```ts
switch (invoice._tag) {
	case 'Draft':
		return renderDraft(invoice);
	case 'Sent':
		return renderSent(invoice);
	case 'Paid':
		return renderPaid(invoice);
	default:
		return casesHandled(invoice); // adding a variant breaks compilation here
}
```

## `Redacted<T>`

Sensitive values (tokens, API keys, passwords, credentials) are wrapped at the
boundary and unwrapped only where the raw value is used — usually inside an
adapter making an external call. The wrapper defeats logging, string
interpolation, and JSON encoding:

```ts
// prelude.ts

/** A sensitive value that cannot leak through logs, templates, or JSON. */
export type Redacted<T> = {
	readonly _tag: 'Redacted';
	/** Unwrap the raw value — call only at the point of external use. */
	readonly reveal: () => T;
	readonly toString: () => '[REDACTED]';
	readonly toJSON: () => '[REDACTED]';
};

/** Wrap a sensitive value. */
export function redacted<T>(value: T): Redacted<T> {
	return {
		_tag: 'Redacted',
		reveal: () => value,
		toString: () => '[REDACTED]',
		toJSON: () => '[REDACTED]',
	};
}
```

Never put secrets — or raw PII — in error messages, traces, logs, or
snapshots. Error fields carry domain IDs, operation names, provider names,
state tags, and retry counts; they do not carry payloads.

## Quick Reference

| Situation                                   | Tool                                           |
| ------------------------------------------- | ---------------------------------------------- |
| Expected failure (domain, parse, I/O, auth) | `Result<T, E>` / `Promise<Result<T, E>>`       |
| Caller needs to branch on failure kind      | custom tagged error class, precise union       |
| Unhandled union case                        | `casesHandled(x)` in the `default` branch      |
| Impossible branch / violated invariant      | `shouldNeverHappen()` (throws — defect)        |
| Startup misconfiguration                    | throw at the composition root                  |
| Third-party throw inside an adapter         | catch → classify into a tagged error           |
| Sensitive value                             | `Redacted<T>`; `reveal()` only at point of use |
| Broad catch-all error type                  | entrypoint/logging layers only                 |
