---
name: go-coding-standards
description: Use this skill when designing, implementing, refactoring, or testing Go code, including new packages, services, adapters, CLIs, error handling, parsing/validation, concurrency, performance, observability, dependency boundaries, and repository convention decisions.
---

# Go Coding Standards

Source: Go port of the local `typescript-coding-standards` skill (itself ported from https://gist.github.com/dmmulroy/9c80f1f499b031aa0b6525b5d9ae25f0), with the former `golang-pro` skill folded in.

These standards describe how to design and write Go code. They are especially intended for agents: before adding patterns, libraries, adapters, or abstractions, read the existing code and prefer the local convention unless it conflicts with the safety/correctness principles below.

**Repository standard: packages by concern, structs with constructor injection.** Go has no classes — the package is the encapsulation boundary and the struct is the dependency carrier. The rule is: anything with dependencies or state is a struct built by a `NewX(...)` constructor holding unexported fields; anything pure is a plain function in the package that owns the concept. Free functions are normal in Go — the discipline is not "prefer structs over functions" but "never let dependencies, I/O, or mutable state hide outside a constructor-injected struct". The functional-core / imperative-shell discipline applies throughout: pure logic in plain functions and methods, I/O sequenced at the edges.

## Workflow

For any substantial piece of work:

1. Understand constraints: runtime, throughput, error budget, deployment target.
2. Design contracts first: interfaces, request/response models, error model.
3. Implement idiomatic Go: explicit errors, context propagation, small packages.
4. Validate with tests and profiling before proposing optimisation work.
5. Deliver with operational basics: logging, metrics, health checks, graceful shutdown.

Non-negotiable on every change: run `gofmt` and `go test ./...`; use `context.Context` for I/O and blocking work; wrap errors with `%w`; document exported identifiers; never start a goroutine without lifecycle control; never `panic` for expected runtime failures.

Deep dives live in `references/`:

- [references/concurrency.md](references/concurrency.md) — goroutines, channels, `errgroup`, cancellation, race patterns
- [references/generics.md](references/generics.md) — type parameters, constraints, when generics earn their keep
- [references/interfaces.md](references/interfaces.md) — interface design, satisfaction, embedding
- [references/project-structure.md](references/project-structure.md) — modules, `go.mod`, layout, build tags
- [references/testing.md](references/testing.md) — table tests, fakes, benchmarks, fuzzing, golden files

## Decision priority

When rules pull in different directions, use this order:

1. Preserve correctness, safety, and debuggability.
2. Follow established project architecture and conventions (the concern-package standard below).
3. Improve the local design toward these standards.
4. Document meaningful trade-offs with comments or ADRs.

New packages, services, and adapters must follow the concern-package standard. Existing code that predates it is migrated incrementally, one concern per PR; match the target pattern when you touch a file rather than adding new unstructured surface area.

## Core principles

- **Model capabilities as concern packages.** One capability per package; service structs with constructor injection for stateful behaviour; plain functions for pure logic.
- **Encapsulate.** Keep struct fields unexported; expose behaviour through methods, not data. Inject dependencies through the constructor.
- Prefer **composition to embedding** — never use struct or interface embedding to simulate inheritance of domain behaviour.
- **Errors are values.** `(T, error)` returns everywhere; `panic` only for defects.
- Parse early. Do not merely validate and throw away the information learned.
- Make illegal states unrepresentable where practical — unexported fields plus smart constructors.
- Prefer correct-by-construction APIs over convention-based invariants.
- Use defined types liberally for meaningful primitives.
- Keep the functional core pure; keep the imperative shell (I/O, time, randomness) at the composition root and adapters.
- Design deep, cohesive packages with low caller burden.
- Test behaviour through real seams: hand-written fakes and real databases, not generated mocks.
- Keep code discoverable for humans and agents: godoc, predictable names, no grab-bag packages.

## Concern packages (repository standard)

Code is organized into **concern packages**: self-contained packages that own one domain problem end to end (its types, services, parsing, and persistence mapping).

Rules for concern packages:

- **One concern per package.** A package owns a cohesive capability (`billing`, `webhooks`, `identity`, `gitimport`), not a technical layer (`handlers`, `models`, `utils`).
- **Name for the capability.** Short, lowercase, singular, no underscores. Use an `x` suffix only when wrapping or extending a same-named standard-library package (`httpx`, `fsx`, `logx`, `timex`) — never as decoration.
- **Concerns do not import each other sideways.** They may import shared leaf packages (domain types, tiny infrastructure wrappers). The compiler rejects cycles; treat the _desire_ for a cycle as a design error — fix it by moving the shared type down or defining the interface on the consumer side, never with an `interfaces` dumping-ground package.
- **Exactly one composition root.** The `app` package (or `cmd/*` main) constructs concrete adapters once, reads configuration, opens connections, and injects everything down through constructors. Only the composition root touches ambient singletons: `os.Getenv`, wall-clock `time.Now` as a service, global `rand`, `os.Stdout`.
- **No barrel analogue.** A Go package's export set _is_ its public surface. Export deliberately; keep everything else unexported; use `internal/` to make whole packages unreachable from outside the module.

### The four shapes

Every non-glue piece of code should fit one of these shapes. Reach for the simplest that fits.

1. **Immutable value type** — a validated, immutable data carrier. Unexported fields, constructed only through `ParseX(input) (X, error)` (untrusted input) or `NewX(parts ...T) (X, error)` (typed parts), read through getter methods, updated through `WithY(v) X` copy methods. No I/O, no dependencies. Because fields are unexported, invalid instances cannot be constructed outside the package; make the zero value either valid or unusable, and document which.
2. **Service struct** — owns a capability. Dependencies injected through `NewX(...)` and held in unexported fields, public action methods taking `context.Context` first, composition over embedding. The constructor validates its inputs and may return an error.
3. **Adapter struct** — talks to the outside world (database, HTTP, filesystem). Satisfies a consumer-defined interface, keeps wire/SQL details private, and converts external failures into the package's typed errors.
4. **Package of pure functions** — Go's replacement for a static utility class is a small, precisely named package of functions. Never create a struct with no state just to namespace functions, and never create a `util` package.

### Framework glue is exempt (thin shell only)

Framework entrypoints keep the signatures the framework requires, but they must stay **thin**: decode input, call a service method, encode the result. No domain rules, queries, or multi-step logic in the glue.

- **`http.HandlerFunc` / router registrations** — decode the request into a wire DTO, call the injected service, write the response. Route files only wire paths to handlers.
- **cobra `RunE` functions and CLI entrypoints** — parse flags, call the same service the HTTP handler uses, print output.
- **Queue consumers, cron jobs, scheduled handlers** — same rule; they reuse the same service structs.

### Import paths

There is no alias machinery to maintain. Imports are always full module paths; making a package public to other modules means placing it outside `internal/` — nothing else to keep in sync.

## Adapting to existing codebases

Before adding a new pattern or library, inspect the repo for existing choices around:

- error handling
- input validation and parsing
- dependency injection
- testing
- observability
- adapters/services
- package layout

Prefer consistency inside the codebase. If existing code returns bare wrapped errors, do not rewrite the whole system around custom error types. New code may still use typed errors internally, but it must integrate with existing handlers, logging, tracing, metrics, and error reporting.

At boundaries, translate between local typed errors and whatever the framework or existing code expects.

## Errors and failures

### Expected failures are values

Go's native result type is the `(T, error)` return. Use it for domain, parsing, authorisation, integration, I/O, persistence, and workflow failures. Do not build or import a generic `Result[T, E]` type; do not use `panic`/`recover` as control flow; do not return `(T, bool)` where the caller needs to know _why_ it failed.

Reach for error tools in this order:

1. **Wrap with context** when the caller only needs the chain:

```go
cfg, err := loadConfig(path)
if err != nil {
	return fmt.Errorf("load config %q: %w", path, err)
}
```

2. **Sentinel errors** when callers branch on identity:

```go
var ErrSkillNotFound = errors.New("skill not found")

// Caller:
if errors.Is(err, skills.ErrSkillNotFound) { ... }
```

3. **Struct error types** when callers need data. The type name is the stable tag; fields carry structured, telemetry-safe context; `Unwrap` preserves the cause:

```go
// UserStoreUnavailable reports that the user store could not serve a request.
type UserStoreUnavailable struct {
	Operation string
	Provider  string
	Cause     error
}

func (e *UserStoreUnavailable) Error() string {
	return fmt.Sprintf("user store unavailable during %s", e.Operation)
}

func (e *UserStoreUnavailable) Unwrap() error { return e.Cause }

// Caller:
var unavailable *UserStoreUnavailable
if errors.As(err, &unavailable) { ... }
```

Keep errors precise at package boundaries: document in the doc comment which sentinel errors and error types a function can return ("returns an error satisfying `errors.Is(err, ErrNotFound)` when no user matches"). Avoid broad `AppError`-style types except near entrypoint, orchestration, logging, and rendering layers.

Never discard an error with a bare `_` without a comment saying why it is safe.

### Unrecoverable defects may panic

Panicking is acceptable only for defects:

- violated internal invariants
- impossible branches
- temporary `panic("not implemented")` paths

Startup misconfiguration is not a panic: return the error up through a `run() error` function and let `main` exit nonzero. Prefer one `run() error` over scattered `log.Fatal` calls, so cleanup runs and the failure is testable:

```go
func main() {
	if err := run(os.Args, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
```

### Exhaustive switches

Every `switch` over a domain enum handles all values. Go has no `never` type, so back the discipline two ways: enable the `exhaustive` linter, and give the `default` branch defect semantics — return an "unhandled X" error at boundaries, or panic in core code where the value was already parsed:

```go
switch state {
case StateDraft:
	...
case StateSent:
	...
case StatePaid:
	...
default:
	panic(fmt.Sprintf("unhandled invoice state: %v", state))
}
```

## Sensitive data, telemetry, and debugging

Prefer end-to-end structured logging and tracing across requests, jobs, application packages, adapters, and external calls. Use `log/slog` (or the repo's established logger) with safe fields:

- domain IDs
- operation names
- dependency/provider names
- state tags
- retry counts
- error type names
- safe summaries

Do not put secrets in errors, traces, logs, or panics.

Use a `Secret` type for sensitive values such as tokens, API keys, passwords, and raw credentials. The unexported field plus `String`/`GoString`/`LogValue`/`MarshalJSON` defeats `%v`, `%s`, `%#v`, slog, and JSON encoding:

```go
// Secret wraps a sensitive string so it cannot leak through formatting,
// logging, or JSON encoding. Call Reveal only where the raw value is used.
type Secret struct {
	value string
}

func NewSecret(v string) Secret { return Secret{value: v} }

func (s Secret) Reveal() string   { return s.value }
func (s Secret) String() string   { return "[REDACTED]" }
func (s Secret) GoString() string { return "Secret([REDACTED])" }

func (s Secret) LogValue() slog.Value { return slog.StringValue("[REDACTED]") }

func (s Secret) MarshalJSON() ([]byte, error) { return []byte(`"[REDACTED]"`), nil }
```

Wrap sensitive values at the boundary (config parsing) and call `Reveal` only where the raw value is needed, usually inside an adapter making an external call.

## Parse, don't validate

Boundary code should turn raw or less-structured input into domain types as early as practical.

Prefer:

```txt
[]byte -> wire DTO struct -> ParseX -> domain types (EmailAddress, UserID, ...)
```

not a `map[string]any` or a tag-validated struct passed throughout the app.

Wire DTOs live next to the transport (a `dto` subpackage beside the handlers); domain types never carry `json` tags for external wire formats. Use `json.Decoder` with `DisallowUnknownFields` where strictness matters, then an explicit parse step that checks invariants and constructs domain types.

Use names that preserve meaning:

- `ParseX(input) (X, error)` for untrusted or less-structured input
- `NewX(parts ...T) (X, error)` for smart constructors from already-typed pieces
- `IsX(v) bool` for true predicates
- `MustX(...)` only in tests, package-level initialisation of known-good constants, and composition-root code where failure is a startup defect

Avoid `ValidateX` when the function returns a refined value. It parsed something.

Struct-tag validator libraries (for example `go-playground/validator`) are validation, not parsing. Use one only if the repo already does, and still follow it with construction of domain types.

## Defined types and correct construction

Two tools, one rule each:

- **Defined types** for meaningful primitives where any underlying value is structurally acceptable and the win is _not mixing them up_:

```go
type UserID string

type OrgID string

type Milliseconds int64

type Cents int64
```

Zero runtime cost and compile-time distinctness — Go requires an explicit conversion to mix them. A defined type does not prevent `UserID("garbage")`; construction discipline comes from parsers, and conversions from raw values belong at boundaries only.

- **Unexported-field structs with smart constructors** when there is a real invariant to protect (`EmailAddress`, `NonEmptyString`, parsed URLs). Outside the defining package, the only way to obtain one is the constructor. This is Go's genuine correct-by-construction.

Decision rule: invariant to enforce → struct with unexported fields; only identity or units to distinguish → defined type.

Push optionality outward. A function that requires a value takes the value type, not a pointer; branch or parse before calling. Pointer fields mean "optional / leave unchanged" in update-input structs only — never use pointers to scalars as general-purpose optionality in domain types. Do not reuse one all-pointer struct for every operation; define explicit per-operation input types.

## State machines and boolean blindness

When an entity has meaningful lifecycle states, model them with a typed enum plus parser:

```go
type InvoiceState int

const (
	StateDraft InvoiceState = iota
	StateSent
	StatePaid
)

func (s InvoiceState) String() string { ... }

func ParseInvoiceState(input string) (InvoiceState, error) { ... }
```

Use string-typed constants instead of `iota` when the value is serialized or logged. Never raw strings or ints for states.

When variants carry different data, emulate a sum type with a **sealed interface**: an unexported marker method, one struct per variant, exhaustive type switch with a defect default:

```go
type Invoice interface{ invoice() }

type Draft struct {
	ID    InvoiceID
	Lines []LineItem
}

type Sent struct {
	ID     InvoiceID
	SentAt time.Time
}

type Paid struct {
	ID     InvoiceID
	PaidAt time.Time
}

func (Draft) invoice() {}
func (Sent) invoice()  {}
func (Paid) invoice()  {}
```

Go cannot statically force exhaustiveness over type switches, so keep variant sets small and colocated in one package, and give the `default` branch defect semantics.

Avoid boolean parameters that control behaviour:

```go
CreateUser(input, true) // what does true mean?
```

Prefer a two-value enum or an options struct:

```go
CreateUser(input, SkipEmailVerification)
```

Booleans are fine as clear predicate return values: `IsExpired() bool`, `HasPermission(user, perm) bool`.

## Packages and abstractions

### Deep packages

A deep package hides substantial behaviour and invariants behind a cohesive, low-burden interface. Low-burden does not necessarily mean few exports: a domain package may expose many cohesive functions around one concept and still be deep.

Avoid shallow abstractions that merely forward calls, mirror tables, or expose implementation steps.

Use the deletion test:

- if deleting the package makes complexity disappear, it was probably pass-through waste
- if deleting it spreads complexity across callers, it was probably earning its keep

### Domain packages

Center a domain package on one primary type or a tightly related family, exporting the type plus its parser, smart constructors, predicates, and formatting:

```go
// Package emailaddr models parsed, normalized email addresses.
package emailaddr

// EmailAddress is a parsed, normalized email address.
// The zero value is invalid; obtain one through Parse.
type EmailAddress struct {
	value string
}

// Parse parses an email address from untrusted input.
func Parse(input string) (EmailAddress, error) { ... }

// String renders the address for display and serialization.
func (e EmailAddress) String() string { return e.value }
```

A single-field comparable struct gets `==` equality for free — no `Equals` method needed.

Domain value types must not hide dependencies or I/O, and must not use embedding for behaviour.

### Application/service packages

Application packages own real capabilities or operations (`passwordreset`, `billing`, `invitations`). They coordinate domain types, persistence, external calls, authorisation, and telemetry.

Use a service struct with constructor injection when the capability has dependencies, configuration, or multiple cohesive operations. An aggregate deps struct passed to `NewX` and held in unexported fields is the intended pattern, not a smell:

```go
type Deployer struct {
	store Store
	clock Clock
	log   *slog.Logger
}

func NewDeployer(store Store, clock Clock, log *slog.Logger) *Deployer {
	return &Deployer{store: store, clock: clock, log: log}
}
```

No arbitrary method limit. Split when methods are unrelated, change for different reasons, or require unrelated dependencies.

Avoid vague names like `Manager`, `Processor`, `Helper` — and avoid stutter: the package qualifies the name, so `skills.Service`, not `skills.SkillService`.

## Dependency interfaces and adapters

**Interfaces belong to the consumer, sized to what the consumer uses.** Go's implicit satisfaction makes this free:

```go
// In package passwordreset — the consumer defines the shape it needs.
type UserFinder interface {
	FindActiveByEmail(ctx context.Context, email emailaddr.EmailAddress) (ActiveUser, error)
}

type PasswordReset struct {
	users UserFinder
}
```

A wider adapter satisfies it without declaration:

```go
// In package postgres — wider than any one consumer needs.
type Users struct{ db *sql.DB }

func (u *Users) FindActiveByEmail(ctx context.Context, email emailaddr.EmailAddress) (ActiveUser, error) { ... }
func (u *Users) FindByID(ctx context.Context, id UserID) (User, error)                                   { ... }
func (u *Users) UpdateProfile(ctx context.Context, in ProfileInput) error                                { ... }
```

This avoids both mega-repositories and one-method adapter sprawl. Corollaries: never a central `interfaces` package; never define an interface next to its only implementation "for mocking"; accept interfaces, return concrete types. See [references/interfaces.md](references/interfaces.md) for depth.

### Adapter reuse audit

Before creating a new adapter or service, audit existing adapters/services.

Prefer, in order:

1. Reuse an existing adapter as-is through a narrow consumer-defined interface.
2. Extend an existing adapter if the new method fits its existing cohesive capability and changes for the same reason.
3. Create a new adapter only when reuse/extension would create bad coupling or an accidental interface.

When a meaningful new adapter/service is still created after the audit, create an ADR explaining:

- what existing adapters/services were checked
- why reuse did not fit
- why extension did not fit
- why the new adapter is a separate cohesive capability

Do not require an ADR for tiny local test fakes, obvious in-memory adapters, or trivial framework glue.

ADR format and location: follow `.agents/skills/domain-modeling/ADR-FORMAT.md` (`docs/adr/`, sequential `0001-slug.md`, create the directory lazily on first need).

### Repositories and persistence

Avoid repository-per-table by default.

Repository-like adapters are acceptable when they represent a cohesive domain persistence capability. They should expose meaningful domain operations and return parsed domain types and typed errors — not `*sql.Rows`, scan structs, or driver errors.

Treat raw rows and scan targets as infrastructure DTOs. Parse them before application/core logic. Keep SQL and driver details inside the adapter package.

## Functional core, imperative shell, and entrypoints

Keep domain/application behaviour reusable across HTTP, CLI, queues, and other entrypoints.

The functional core contains domain logic, parsers, state transitions, and decision functions. It avoids:

- I/O
- `context.Context` (a pure function needing ctx is a smell)
- `time.Now()`, `rand`, `os.Getenv`
- goroutines
- framework-specific concerns

The imperative shell parses untrusted input, sequences effects, calls the core with refined values, classifies external failures into typed errors, and owns I/O, persistence, HTTP, queues, telemetry, time, and randomness.

`context.Context` discipline: first parameter of every function that does I/O or blocks, named `ctx`, never stored in struct fields, never `nil` — `context.Background()` at roots only.

Inject time and randomness. Services take a clock interface; pure functions take `now time.Time` as a parameter:

```go
type Clock interface {
	Now() time.Time
}
```

Entrypoint adapters are thin protocol translators sharing the same services. Authorization belongs in shared application/domain policy, not duplicated in handlers: entrypoints may authenticate and parse sessions, but shared code receives a parsed principal type (`AdminUser`, `Session`, `Principal`), not raw headers.

## Workflows, transactions, and idempotency

Use ordinary function calls or database transactions for simple single-boundary operations.

Use a saga/durable workflow when the process needs retries, compensation, idempotency, resumability, timers, human approval, or multiple transaction boundaries.

Do not hold database transactions open across network calls or long-running operations.

Any command, job, or workflow step that may be retried needs an explicit idempotency strategy:

- idempotency key
- natural unique constraint
- deduplication record
- state-machine transition guard
- transactional outbox/inbox

Retrying should not rely on "probably safe" side effects.

Background work uses goroutines with explicit lifecycle control — context cancellation and `errgroup`/`sync.WaitGroup`, never fire-and-forget. See [references/concurrency.md](references/concurrency.md).

## Testing

Prefer confidence-oriented tests:

1. e2e for critical user flows
2. integration tests through real seams
3. focused/property tests for pure domain packages
4. unit tests when they test meaningful behaviour, not implementation details

**Table-driven tests with named cases and `t.Run` subtests are the default idiom**; add `t.Parallel()` where safe. See [references/testing.md](references/testing.md) for mechanics (helpers, benchmarks, fuzzing, golden files).

Do not reach for `gomock`/`mockery` by default — generated mocks push tests toward interaction assertions. Use real seams:

- hand-written fakes implementing the consumer-defined interface
- in-memory adapters when behaviour is simple
- real databases via the repo's test harness or testcontainers; cgo-free SQLite (`modernc.org/sqlite`) only when SQL dialect differences don't matter

Prefer tests that assert observable input/output behaviour:

- returned value/error
- persisted state
- emitted event/message
- rendered response
- recorded sends in a fake adapter

Avoid asserting call counts and argument lists unless the interaction itself is the only observable behaviour.

Conventions:

- name tests `TestType_Method_scenario`
- use external test packages (`package skills_test`) by default, so tests exercise the public API
- tests must not bypass parsers, smart constructors, or invariants — no constructing invalid values via same-package access unless testing the parser itself

### Property tests

Use `pgregory.net/rapid` where properties are clearer than examples (`testing/quick` is frozen; do not use it), especially for:

- parsers and smart constructors
- defined/refined types
- state machines
- serialization round-trips
- normalization idempotence

Keep generators next to the domain package they support (`invoice_rapid_test.go`), or export them from an `xxxtest` helper package when shared. The standard library's fuzzing (`f.Fuzz`) complements rapid for byte-level parsers.

## Toolchain and static safety

Non-negotiable:

- `gofmt` (or the repo's format target) on every change
- `go vet ./...`
- `go test -race ./...` in CI

Recommended `golangci-lint` enable set: `errcheck`, `govet`, `staticcheck`, `unused`, `errorlint`, `exhaustive`, `revive`, `gocritic`, `unparam`, `sloglint`, `noctx`.

### `any`, type assertions, and unsafe

Avoid `any`/`interface{}` in exported signatures — use generics or concrete types instead (see [references/generics.md](references/generics.md) for when generics earn their keep). Use the comma-ok form for type assertions; the panicking form requires a justification comment.

`unsafe`, panicking assertions, and every `//nolint` directive require a Rust-like safety comment:

```go
//nolint:errcheck // SAFETY: Close on a read-only file cannot fail in a way we can act on; the data was already flushed and verified above.
```

### Immutability

Go has no `readonly`. Compensate structurally:

- unexported fields with getters
- copy-on-write `WithX` methods for updates
- defensive copies of slices and maps in getters and constructors — never expose internal mutable state

Mutation is acceptable inside localised shell code, performance-sensitive internals, and builders, when hidden behind a precise interface.

## Imports, exports, and files

- Put everything not deliberately public to other modules under `internal/`.
- Package names: short, lowercase, singular, no underscores. File names: lowercase snake case, named for content (`email_address.go`), never `utils.go`/`helpers.go`/`common.go`/`misc.go`.
- No `util`/`common`/`helpers` packages, ever. The acceptable extreme is a tiny single-purpose package (a pointer-helper or clock package); anything larger must be named for its concept.
- Import blocks grouped stdlib / external / module-local — let `goimports` handle it. No dot imports. Blank imports only for drivers, with a comment.
- Export only what callers should use. Keep helpers unexported unless intentionally shared. Do not export internals just for tests; prefer testing through the public API (an `export_test.go` is the rare escape hatch).
- Import cycles are compile errors, but treat the desire for one as the real signal: resolve with a consumer-defined interface or by moving the shared type down.

No arbitrary file-size limits. Prefer cohesion and discoverability over small files for their own sake. Split when a file has multiple unrelated reasons to change.

## Doc comments

Comments should explain invariants, trade-offs, non-obvious domain rules, and safety justifications. Avoid comments that narrate obvious code.

Every exported identifier gets a doc comment, starting with the identifier's name, in full sentences:

```go
// ParseEmailAddress parses an email address from untrusted input.
// It returns an error satisfying errors.Is(err, ErrInvalidEmail) when
// the input is not a valid address.
func ParseEmailAddress(input string) (EmailAddress, error) { ... }
```

- Give every package a package comment (`// Package gitimport ...`) in its primary file or `doc.go`.
- Describe parameters and returned errors in prose — Go has no `@param`/`@returns` tags. Name the sentinel errors and error types callers can branch on.
- Document panic behaviour explicitly ("panics if ...") — panics are for defects, so a documented panic is a documented contract.
- Mark deprecations with a `Deprecated:` paragraph.

For exported struct types whose fields are part of the API, document fields where helpful:

```go
// CreateUserInput carries the input required to create a user.
type CreateUserInput struct {
	// Actor is the authenticated principal creating the user.
	Actor AdminUser

	// Email is the parsed address for the new user.
	Email emailaddr.EmailAddress
}
```

## Configuration and resources

Parse environment/config **once at startup** into a typed `Config` struct in a `config` package, using `Secret` for credentials and defined types for ports and durations. Missing or invalid config is a startup failure with useful context, returned through `run() error`.

- No `os.Getenv` outside the config package/composition root.
- No `init()` side effects: no connection opening, handler registration, env reading, or I/O at import time. Prefer no `init` at all.
- Package-level `var` only for sentinel errors, compiled regexes, and constant-like lookup tables. No package-level mutable state; if a framework requires a singleton, isolate it at the boundary.
- Resource lifecycle is owned by the composition root: constructors return `(T, error)`, resources needing cleanup expose `Close() error` and the root defers them, shutdown is graceful via context cancellation.

## Quick agent checklist

Before coding:

- Pick the concern package the code belongs to; stateful behaviour goes in a struct with `NewX` constructor injection, pure logic in plain functions.
- Keep framework glue (HTTP handlers, cobra commands, queue consumers) thin — decode, call a service, encode.
- Ambient I/O (env, time, randomness, globals) only at the composition root; inject a clock elsewhere.
- Read existing conventions for errors, validation, tests, adapters, telemetry, and package layout.
- Look for existing domain types before creating new ones; look for existing adapters/services before creating a new one (ADR if a meaningful new one survives the audit).
- Parse inputs at the edge; use domain types internally. No raw DTOs, raw IDs, or all-pointer input bags in core logic.
- Use `(T, error)` with sentinel/struct errors and `%w` wrapping for new expected failures; panic only for defects.
- No boolean behaviour parameters — enums or option structs.
- Define dependency interfaces on the consumer, sized to actual use.
- Test through public interfaces and real seams: table-driven tests, hand-written fakes, real databases, `rapid` for properties.
- Add doc comments for every exported identifier.
- Finish clean: `gofmt`, `go vet`, `golangci-lint`, `go test -race ./...`.

## Local reference: `api/internal` (this repository)

This section is the only repo-specific part of the skill; delete it when mounting the skill elsewhere.

`api/` is the Go CLI + API service and the reference implementation of these standards. Read it before writing new Go code here. Binaries: `api/cmd/skills` (CLI) and `api/cmd/skills-api` (server), with the e2e suite under `api/cmd/tests`.

- Composition root and wiring: `app`, with service subpackages `authx`, `importsvc`, `importdeliverysvc`, `linksvc`, `operationsvc`, `skillsvc`, `workspacesvc`, and `shared`. CLI commands: `commands`.
- Concern packages: `gitimport`, `harness`, `embeddedagents`, `storage`, `security`, `database`, `linkfs`, `skillmount`.
- Domain types: `domain/imports`, `domain/skills`, `domain/link`, `domain/operations`, `domain/workspace`, `domain/importdelivery` (plain structs, doc comments on every exported type).
- Transport: `httpx`, with the `authx` middleware subpackage, wire DTOs in `skillsdto`, `importdto`, and `workspacedto`, and JSON decoding helpers in `requestjson` — DTOs live next to the transport, per the parse-don't-validate pipeline.
- Infrastructure wrappers using the `x` convention: `fsx`, `logx`, `ptrx`, `timex`.
- Config and validation: `config` (env parsed at startup), `validation`; build metadata: `version` (ldflags-stamped, see [references/project-structure.md](references/project-structure.md)).

Local conventions to match:

- `NewX` constructors returning `(*X, error)` with injected writers/dependencies — `logx.New` is the exemplar.
- Pointer fields mean "optional / leave unchanged" in input structs (see `domain/skills.Input`).
- Commands: `make build`, `make test USE_DOCKER=false` (or `make test-unit` / `make test-functional` / `make test-e2e`), `make lint` for formatting.
- Toolchain status: `make lint` runs the formatter only — no `golangci-lint` config exists in this repository yet. A trial run of the enable set recommended above measured ~211 findings (dominated by missing doc comments on exported identifiers and `unused` in-flight code), so treat that set as the target and its adoption as a staged follow-up, not the current gate.
- `api/go.mod` depends on the private Alloy Foundation module; do not disturb its version.
