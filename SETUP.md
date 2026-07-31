# Setup

Clone or copy this repository to `~/.pi/agent`, then install its dependencies:

```sh
cd ~/.pi/agent
npm install
```

## fd and rg tools

The `file-search` extension registers `fd` and `rg` as model tools. No setup is normally needed: at startup it silently uses a system-installed `fd` (or `fdfind` on Debian/Ubuntu) and `rg` when available, or an existing fallback binary in `~/.pi/agent/bin/`. Only when neither exists does it download an official release binary (macOS/Linux, arm64/x64, over HTTPS) into `~/.pi/agent/bin/` and show a one-time notification. If your platform is unsupported, install `fd` and `rg` with your package manager and restart pi.

## Testing

Run the deterministic test suite before every change:

```sh
pnpm test
```

This runs every extension's deterministic tests plus the `file-search` Vitest suite. It never starts a real Claude or Codex session, so it needs no provider credentials or installed CLIs.

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
