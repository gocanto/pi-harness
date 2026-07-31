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

- Commands: `pnpm run typecheck` (vue-tsc + electron tsc + infra tsc),
  `npx vp lint`, `pnpm test` (`vp run -r test`), `make format`.
- tsconfig: there is **no shared base file yet** and none of the four flags
  above are set (`infra/tsconfig.json`, `apps/app/tsconfig.json`,
  `apps/app/tsconfig.electron.json` are independent; `apps/ui` extends
  `apps/app`). Adopting all four was measured at ~30 mechanical errors
  (mostly `exactOptionalPropertyTypes` in `apps/ui` prop-forwarding
  wrappers) — a small, staged follow-up.
- oxlint: configured inline in the root `vite.config.ts` `lint` block; the
  only explicit rule today is `vite-plus/prefer-vite-plus-imports`.
  `no-explicit-any` is not yet enabled (measured at 0 violations — free to
  turn on); `no-non-null-assertion` has 10. The lint baseline currently
  exits non-zero (~87 findings) and there is no CI lint job — both must be
  fixed before lint can gate.
- Formatter: oxfmt via vite-plus, configured in the root `vite.config.ts`
  `fmt` block (`singleQuote`, `useTabs`, `printWidth: 190`; `.agents/**` is
  format-ignored).
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
