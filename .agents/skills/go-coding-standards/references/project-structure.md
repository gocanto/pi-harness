# Project Structure and Module Management

Package design rules (packages by concern, not by layer; composition root;
`internal/` discipline) live in [../SKILL.md](../SKILL.md) — this file covers
module mechanics and repository scaffolding that supports those rules.

## Modules and workspaces

One `go.mod` per module. Most repositories need exactly one module; do not
split into multiple modules for "organisation" — packages already do that.
Split only when parts genuinely version and release independently.

```go
// go.mod
module github.com/user/myproject

go 1.26
```

A `go.work` file at the repository root lets tooling run from the root when
the module lives in a subdirectory (or when several modules coexist):

```go
// go.work
go 1.26

use ./api
```

A single-entry `go.work` is normal and useful — it is not a smell. With
multiple modules, keep their `go` directives aligned and run `go work sync`
after dependency changes.

`replace` directives are for local development only; never commit one that
points outside the repository. Use `retract` in `go.mod` to mark published
bad versions.

## Repository layout for concern packages

The layout is the SKILL.md standard made concrete. There is no `pkg/`
directory: code is either a `cmd/` entrypoint, importable-by-design (outside
`internal/`), or private (`internal/`). Default to private.

```
myproject/
├── go.work                    # if the module lives in a subdirectory
├── cmd/                       # one directory per binary, thin main only
│   ├── server/
│   │   └── main.go            # parse args, call run(), exit nonzero on error
│   └── cli/
│       └── main.go
├── internal/
│   ├── app/                   # composition root: config, wiring, run()
│   │   ├── importsvc/         #   service subpackages when app grows
│   │   └── linksvc/
│   ├── billing/               # concern packages — one capability each,
│   ├── invitations/           #   named for the capability, never
│   ├── gitimport/             #   handlers/, models/, utils/
│   ├── domain/                # domain types, one package per concept
│   │   ├── invoice/
│   │   └── user/
│   ├── httpx/                 # transport: handlers + middleware
│   │   ├── authx/             #   auth middleware subpackage
│   │   └── billingdto/        #   wire DTOs live beside the transport
│   ├── config/                # env parsed once at startup
│   ├── version/               # ldflags-stamped build info
│   └── fsx/, logx/, timex/    # tiny stdlib wrappers (x-suffix convention)
├── go.mod
└── go.sum
```

Notes:

- `main.go` stays thin: `func main()` calls `run(...) error` and exits
  nonzero on error. All wiring lives in the composition root package.
- Wire DTO subpackages (`billingdto`) sit next to the transport that owns
  them, per the parse-don't-validate pipeline in SKILL.md.
- Domain packages under `domain/` hold types + parsers only — no I/O.
- Test binaries, fixtures, and harnesses live beside the code they exercise
  or under a `tests/` tree — not in `pkg/`.

## `internal/` visibility

Code under `internal/` is importable only by packages rooted at `internal/`'s
parent. This is the mechanism behind "export deliberately":

```
myproject/
├── internal/
│   └── auth/          # importable only within myproject
└── api/
    └── internal/      # importable only within api/
```

Everything not deliberately public to other modules goes under `internal/`.
Moving a package out of `internal/` **is** the API-publishing act — there is
no alias or barrel machinery to update.

## Build tags

Use `//go:build` (the old `// +build` form is dead — `gofmt` maintains the
new one). Reserve tags for genuine platform splits and opt-in test suites:

```go
//go:build integration

package billing_test
```

```bash
go test -tags=integration ./...
```

Combine with `&&`, `||`, `!`: `//go:build linux || darwin`. Do not use build
tags to swap implementations that constructor injection can swap instead.

## Version stamping

A tiny `version` package with package-level `var`s set via `-ldflags` is the
standard pattern (one of the few legitimate package-level `var` uses — the
values are write-once at link time):

```go
// Package version exposes build metadata stamped at link time.
package version

// Set via -ldflags; treat as constants at runtime.
var (
	Version   = "dev"
	GitCommit = "none"
	BuildTime = "unknown"
)
```

```bash
go build -ldflags "-X myproject/internal/version.Version=1.2.3 \
  -X myproject/internal/version.GitCommit=$(git rev-parse --short HEAD)" ./cmd/server
```

## Dependency hygiene

```bash
go mod tidy                      # after any import change; keeps go.sum exact
go mod verify                    # checksums match the module cache
go mod why github.com/x/y        # justify a dependency before keeping it
go get github.com/x/y@v1.2.3     # pin explicitly; avoid blanket go get -u ./...
go work sync                     # multi-module only, after dependency changes
```

Upgrade dependencies deliberately and one at a time; a blanket `go get -u`
turns a review into an audit. Vendor (`go mod vendor`) only when the build
environment requires it.

## Quick Reference

| Decision             | Rule                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| New binary           | `cmd/<name>/main.go`, thin `main` → `run() error`                                                             |
| New capability       | `internal/<concern>/` package, named for the capability                                                       |
| New domain concept   | `internal/domain/<concept>/`, types + parsers, no I/O                                                         |
| Wire DTOs            | `<transport>/<concern>dto/` subpackage beside the transport                                                   |
| Public vs private    | private (`internal/`) by default; moving out publishes it                                                     |
| `pkg/` directory     | never — `internal/` + deliberate exports replace it                                                           |
| Second module        | only for independent versioning; otherwise packages                                                           |
| Swap implementations | constructor injection, not build tags                                                                         |
| Code generation      | fine for wire formats (protobuf, stringer); never for mocks — hand-write fakes (see [testing.md](testing.md)) |
