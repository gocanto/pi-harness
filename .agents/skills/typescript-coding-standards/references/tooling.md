# Tooling: tsconfig, Lint, Format, JSDoc

The rules (strict settings, cast/`any` discipline, JSDoc on exports) live in
[../SKILL.md](../SKILL.md) — this file pins the exact baselines and the
enforcement mechanics.

## tsconfig baseline

The strictness baseline every package extends. Keep it in one shared file
(`tsconfig.base.json` at the workspace root) so "the baseline" has exactly one
definition; module/resolution settings stay per-package where they genuinely
differ (NodeNext for Node packages, Bundler for app code).

```jsonc
{
	"compilerOptions": {
		"strict": true,
		"noUncheckedIndexedAccess": true,
		"exactOptionalPropertyTypes": true,
		"noImplicitOverride": true,
		"noFallthroughCasesInSwitch": true,
	},
}
```

What each flag buys:

- `noUncheckedIndexedAccess` — indexing returns `T | undefined`; the compiler
  forces the branch the runtime always had.
- `exactOptionalPropertyTypes` — `prop?: T` no longer accepts an explicit
  `undefined`; optionality and undefined-as-value stop being conflated.
  (Most fallout from adopting this flag is prop-forwarding code; fix with
  conditional spreads or an explicit `| undefined` where "explicitly unset"
  is a real state.)
- `noImplicitOverride` — overriding a base member requires the `override`
  keyword; renaming the base member then breaks loudly.
- `noFallthroughCasesInSwitch` — no silent case fallthrough.

Worth measuring as extensions: `noUnusedLocals`/`noUnusedParameters` (or the
lint-side equivalents) and `verbatimModuleSyntax` (enforces `import type`).

## Lint (oxlint)

Target rule set beyond the linter's default correctness checks:

- `typescript/no-explicit-any` — `any` is banned by the standard; the escape
  hatch is a targeted disable with justification (below).
- `typescript/no-non-null-assertion` — `!` is banned outright: branch, parse,
  or refine instead.
- Keep the default `correctness` category at error.
- Candidates for a second wave: `no-unsafe-type-assertion` (mechanizes the
  SAFETY-comment cast rule) and the `suspicious` category.

The escape-hatch ritual — every exception is visible, justified, and greppable:

```ts
// oxlint-disable-next-line no-explicit-any -- SAFETY: This helper preserves
// arbitrary function parameters; TypeScript cannot express this variadic
// constraint without any.
type Fn = (...args: any[]) => unknown;
```

Any non-`as const` cast requires the same style of `SAFETY:` comment even
when no lint rule fires (see [parsing-and-schemas.md](parsing-and-schemas.md)
for the branding example).

Lint must run in CI at error level; a rule that only warns locally is
documentation, not enforcement.

## Formatting

The repo formatter's output is the standard — never hand-format against it,
never commit unformatted code, and never relitigate its choices in review.
Configure it once at the workspace root; run it through the repo's format
target before finishing any change.

## JSDoc

Every exported function, class, method, constant, and (usually) type gets
JSDoc — syntax and examples in [../SKILL.md](../SKILL.md). Enforcement is by
review until a lint plugin lands (oxlint's jsdoc rules are the natural
mechanism once adopted): reviewers treat a missing doc on a new export the
same as a failing test. `@throws` documents defects only — expected failures
are in the return type, which is self-documenting.

## Commands

Every change finishes with the repo's own gate — typecheck, lint, tests,
format — run through the repo's canonical targets (not ad-hoc tool
invocations, which drift from CI). The concrete commands are repo-specific;
see the Local reference section in [../SKILL.md](../SKILL.md).

## Local status (this repository — delete when mounting elsewhere)

- Commands: `pnpm run verify` is the whole gate (lint → format:check →
  typecheck → tests). Individually: `pnpm run lint`, `pnpm run format`,
  `pnpm run check`, `pnpm test`. `make verify` delegates to the same script
  so the two cannot drift. There is no `vp`/vite-plus and no `vite.config.ts`
  in this repo.
- tsconfig: a single root `tsconfig.json` covering `extensions/**/*.ts`, with
  `strict: true`. None of the four extra flags above are set yet. Per-extension
  tsconfigs exist but nothing runs them — the root config is the only
  typecheck. Note TypeScript 7 removed `baseUrl` and rejects non-relative
  `paths`; both are already fixed here, so keep alias paths `./`-prefixed.
- Lint: `pnpm run lint` is `fmtkit lint` (oxlint, embedded in the same
  binary), configured by `.oxlintrc.json` at the repo root. It lints the whole
  repo, not just changed files, and exits non-zero on errors only. Note it is
  silent and exits 0 when no `.oxlintrc.json` is present, so an absent config
  looks exactly like a clean run. `correctness` is error. `no-explicit-any` is error and the
  baseline is 0. `no-non-null-assertion` is a warning with 16 occurrences —
  warnings do not gate. `unicorn/no-useless-spread` is off: every report was
  a `[...collection]` snapshot taken because the loop body mutates that same
  collection, so "fixing" them would introduce mutation-during-iteration bugs.
- Formatter: fmtkit (`brew install oullin/fmtkit/fmtkit`), which wraps oxfmt
  plus its own blank-lines/fluent-chains passes. Its output differs from bare
  oxfmt, so do not substitute one for the other. fmtkit has no TS check mode,
  so `scripts/check-format.mjs` gates by hashing files before and after a
  format run. CI installs the pinned release by checksum; bump
  `FMTKIT_VERSION` and `FMTKIT_SHA256` in `.github/workflows/ci.yml` together.
- JSDoc: review-enforced only; no jsdoc lint plugin is configured.

## Quick Reference

| Concern                | Baseline                                                     |
| ---------------------- | ------------------------------------------------------------ |
| tsconfig               | `strict` + the four flags, in one shared base file           |
| `any`                  | banned; `oxlint-disable-next-line` + `SAFETY:` to except     |
| `!` non-null assertion | banned, no exceptions — branch or parse                      |
| Casts (`as`)           | `as const` free; anything else needs a `SAFETY:` comment     |
| Lint level             | error, enforced in CI — warnings don't gate                  |
| Formatting             | repo formatter wins; run the format target before finishing  |
| JSDoc                  | required on exports; review-enforced until a lint rule lands |
| Finishing a change     | repo's canonical typecheck + lint + test + format targets    |
