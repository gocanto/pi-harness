# Setup

This repository is a pnpm workspace and requires Node.js >=22.19.0 and pnpm >=11.17.0 (see `engines` and `packageManager` in `package.json`).

Clone or copy this repository to `~/.pi/agent`, then install its dependencies with pnpm:

```sh
cd ~/.pi/agent
corepack enable
corepack use pnpm@11.17.0
pnpm install
```

`corepack enable` and `corepack use` install the pinned pnpm version automatically. If you don't use Corepack, install pnpm 11.17.0 or newer yourself (see the [pnpm installation guide](https://pnpm.io/installation)) and run `pnpm install`.

## Build

Pi does not load the extension sources. It loads a bundled form of each one, built by `pnpm run build` (also `make build`) into `extensions/<name>/dist/index.js`.

The build exists because the two resolvers disagree. Extension sources import across the tree through aliases declared in `compilerOptions.paths` — `@shared/dashboard-state.ts`, `@git-info/src/process.ts` — which TypeScript and Vitest both resolve. Pi loads extensions through jiti, which applies node module resolution and never reads `paths`, so every aliased import fails at startup with `Cannot find module '@shared/dashboard-state.ts'`. The build resolves the aliases ahead of time: aliased modules are inlined into the bundle, and real dependencies (`effect`, `@earendil-works/*`, node builtins) are left as external imports that resolve normally from the extension directory.

Pi is pointed at the output by each extension's `package.json`:

```json
{
	"pi": {
		"extensions": ["./dist/index.js"]
	}
}
```

Its loader honours that manifest ahead of `index.ts`, so the sources stay in place for typechecking, tests, and editing.

`pnpm install` runs the build through the `prepare` lifecycle script, so a fresh clone is ready to run. **After editing an extension, run `pnpm run build` and restart Pi** — a running Pi keeps using the previous bundle, and an unbuilt change is simply not loaded. If the bundle is missing entirely, Pi falls back to `index.ts` and reports one `Failed to load extension` warning per extension at startup; that warning means "build first", not a broken extension.

Build output is gitignored. The build fails loudly if an extension is missing its manifest, emits nothing, or leaves an alias specifier in the bundle.

## fmtkit

The repository uses [fmtkit](https://github.com/oullin/fmtkit) for TypeScript/Vue formatting and linting. On macOS, install it with Homebrew:

```sh
brew tap oullin/fmtkit
brew install --cask fmtkit
fmtkit version
```

On other platforms, follow the installation instructions in the upstream repository. `make format` runs fmtkit for changed files; `make format-all` formats the complete TypeScript/Vue tree.

## fd and rg tools

The `file-search` extension registers `fd` and `rg` as model tools. No setup is normally needed: at startup it silently uses a system-installed `fd` (or `fdfind` on Debian/Ubuntu) and `rg` when available, or an existing fallback binary in `~/.pi/agent/bin/`. Only when neither exists does it download an official release binary (macOS/Linux, arm64/x64, over HTTPS) into `~/.pi/agent/bin/` and show a one-time notification. If your platform is unsupported, install `fd` and `rg` with your package manager and restart pi.

## Workflows

The `workflows` extension registers a `workflow` tool that lets the model fan work out across several isolated subagents in ordered phases (research fan-out, per-file review, verify-then-synthesize pipelines). Because each run can make up to 32 `agent()` calls with a global concurrency cap of 4, it is **explicit opt-in**: the tool is inactive by default, and there is no hidden trigger phrase — the model cannot call it until you turn it on.

Control it with:

```
/workflows enable   # the model can now call the workflow tool
/workflows disable  # the model can no longer call it
/workflows status   # show whether it's enabled and why (env override, saved preference, or default)
```

The choice made by `/workflows enable`/`disable` is saved under `~/.pi/agent/workflows/activation.json` and applies to every future session until changed again. Set the `PI_WORKFLOWS_ENABLED` environment variable (`1`/`true`/`on`/`yes` to force on, `0`/`false`/`off`/`no` to force off) to override the saved preference for a single process — for example, to keep workflows off for an unattended or untrusted run regardless of what has been saved. Activation is never influenced by workflow scripts, agent output, or project files, so an untrusted project cannot enable itself.

`/workflows` (with no arguments) still lists workflow runs, and `/workflows <runId>` still shows one run's detail, whether or not the tool is currently enabled.

## Testing

Run the formatter, the extension build, and the deterministic Vitest suite before every change:

```sh
make format
pnpm run build
pnpm test
```

This runs every extension's deterministic Vitest suite. It never starts a real Claude or Codex session, so it needs no provider credentials or installed CLIs.

The `subagents` extension also has live provider smoke tests that spawn real Claude Code and Codex sessions. They are excluded from `pnpm test` and must be run explicitly:

```sh
pnpm test:live
```

`pnpm test:live` requires the `claude` and `codex` CLIs to be installed and authenticated locally; each test skips on its own when the corresponding CLI is unavailable.

## Theme

Add the included theme to `~/.pi/agent/settings.json` while keeping your existing settings:

```json
{
	"theme": "github-dark-default"
}
```

Pi will load the extensions, skills, and theme from their directories the next time it starts.
