# Pi Harness Setup

This repository contains an opinionated setup and extension harness for **Pi Coding Agent**:

- Sets up GitHub Dark default as the theme (`themes/github-dark-default.json`)
- Updates the bottom bar to show active model, context window usage, cost, token speed, git branch, and changed file counts
- Adds background terminals + TUI to manage them (`background-terminals`)
- Adds subagents support (`subagents`)
- Adds task automation workflows (`workflows`), off by default until you run `/workflows enable` (see [`SETUP.md`](SETUP.md#workflows))
- Adds an `ask_user` tool for interactive multiple-choice questions
- Adds first-class `fd` (file discovery) and `rg` (content search) tools (`file-search`)

## Setup Instructions

See [`SETUP.md`](SETUP.md) for installation and usage instructions.

Development uses Vitest for all test suites, Vite 8 as the test runner foundation, and [fmtkit](https://github.com/oullin/fmtkit) for TypeScript/Vue formatting and linting. Run `make format` and `pnpm test` before submitting changes.
