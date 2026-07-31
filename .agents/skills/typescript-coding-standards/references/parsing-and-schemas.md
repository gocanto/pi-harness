# Parsing, Schemas, and Branded Types

The rules (parse don't validate, schemas as boundary parsers, branded types
for meaningful primitives) live in [../SKILL.md](../SKILL.md) — this file
carries the worked examples. Schema examples use Zod 4; substitute the repo's
established schema library where one exists.

## The boundary pipeline

Untrusted input crosses exactly one parse boundary and comes out as domain
types. Everything past the boundary trusts its inputs.

```txt
unknown  →  wire DTO (schema-shaped)  →  domain input  →  branded primitives
             CreateUserBodyDto            CreateUserInput    EmailAddress, UserId
```

**Bad** — the schema's inferred shape leaks through the whole app, and every
layer re-checks what the boundary already learned:

```ts
const CreateUserSchema = z.object({ email: z.string(), role: z.string() });

// z.infer<typeof CreateUserSchema> passed around everywhere; deep in the core:
function assignRole(user: { email: string; role: string }) {
	if (!user.email.includes("@")) throw new Error("bad email"); // re-validating
	if (user.role !== "admin" && user.role !== "member") throw new Error("bad role");
	...
}
```

**Good** — one parse at the edge produces refined types; the core never
re-checks:

```ts
const CreateUserBodySchema = z.object({
	email: z.string(),
	role: z.enum(["admin", "member"]),
});

/** Parse an untrusted request body into a domain input. */
export class CreateUserInput {
	private constructor(
		readonly email: EmailAddress,
		readonly role: Role,
	) {}

	static parse(input: unknown): Result<CreateUserInput, InvalidCreateUserBody | InvalidEmailAddress> {
		const body = CreateUserBodySchema.safeParse(input);
		if (!body.success) {
			return err(new InvalidCreateUserBody(body.error));
		}
		const email = EmailAddress.parse(body.data.email);
		return map(email, (address) => new CreateUserInput(address, Role.from(body.data.role)));
	}
}

// Deep in the core: inputs are already refined, no checks left to do.
function assignRole(email: EmailAddress, role: Role) { ... }
```

Schemas are boundary parsers, not ad-hoc validators sprinkled through core
logic. If you find a `safeParse` call in a service method, the boundary is in
the wrong place.

## Branded primitives

Use branded types for meaningful primitives so raw strings and numbers cannot
be passed where a domain type is required:

```ts
declare const brand: unique symbol;

/** Nominal typing helper: a T distinguishable from other Ts at compile time. */
export type Brand<T, Tag extends string> = T & { readonly [brand]: Tag };

export type UserId = Brand<string, 'UserId'>;

export type EmailAddress = Brand<string, 'EmailAddress'>;

export type Cents = Brand<number, 'Cents'>;

export type Milliseconds = Brand<number, 'Milliseconds'>;
```

Branded values are constructed only through parsers or smart constructors:

```ts
/** Parse an email address from untrusted input, normalizing case. */
export function parseEmailAddress(input: string): Result<EmailAddress, InvalidEmailAddress> {
	const normalized = input.trim().toLowerCase();

	if (!EMAIL_PATTERN.test(normalized)) {
		return err(new InvalidEmailAddress());
	}
	// SAFETY: TypeScript cannot express the brand. The pattern check above is
	// the invariant; callers cannot construct EmailAddress except through this parser.
	return ok(normalized as EmailAddress);
}
```

Zod 4 can carry the brand for you when the whole pipeline is schema-driven:

```ts
const EmailAddressSchema = z.string()
	.trim()
	.toLowerCase()
	.email()
	.brand<'EmailAddress'>();

export type EmailAddress = z.infer<typeof EmailAddressSchema>;
```

Either style is fine; pick one per codebase and stay consistent. The brand
cast inside a hand-written parser is one of the few sanctioned `as` uses and
always carries a `SAFETY:` comment.

## Naming

Names preserve what the function learned:

- `parseX(input): Result<X, ParseXError>` — from untrusted/less-structured input
- `makeX(...)` / `createX(...)` — smart constructor from already-typed pieces
- `isX(value): boolean` — a true predicate, no refinement returned
- `assertX(...)` — rare; tests and framework boundaries only

Avoid `validateX` when the function returns a refined value — it parsed
something; name it that.

## Optionality is pushed outward

Functions that require a value take the value type. Branch or parse before
calling — do not let `undefined` flow inward:

```ts
// Bad: every layer re-handles the absence
function renderInvoice(invoice: Invoice | undefined) { ... }

// Good: the caller resolves absence once, at the edge
const invoice = await store.find(id);
if (isErr(invoice)) {
	return respondNotFound();
}
renderInvoice(invoice.value);
```

Avoid `Partial<T>` as an application/domain input unless partiality is the
real domain concept; define explicit per-operation input types instead.

## Wire DTOs stay at the wire

Raw payload shapes (HTTP bodies, database rows, IPC messages, env vars) are
infrastructure DTOs. They live next to their transport, are parsed
immediately, and never travel into application/core logic. Domain types never
carry wire concerns (serialization tags, snake_case field mirrors); slices
own serializer classes (shape 4) for the outbound direction.

## Quick Reference

| Situation                               | Rule                                            |
| --------------------------------------- | ----------------------------------------------- |
| Untrusted input arrives                 | one schema parse at the boundary → domain types |
| Schema-inferred type in core logic      | wrong — refine into DTO/branded types first     |
| Meaningful primitive (id, email, money) | branded type + parser/smart constructor         |
| Brand cast in a parser                  | allowed, with a `SAFETY:` comment               |
| Function needs a value                  | take the value type; caller branches first      |
| `validateX` returning a refined value   | rename to `parseX`                              |
| `Partial<T>` as domain input            | explicit per-operation input type instead       |
| Outbound serialization                  | serializer class per slice, at the edge         |
