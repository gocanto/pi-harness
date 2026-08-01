# Pi Harness

A practical, opinionated extension pack for [Pi Coding Agent](https://github.com/badlogic/pi-mono).
Copy it into Pi's agent directory and get a useful coding workspace without changing Pi itself.

## What

Pi Harness adds local extensions, skills, and a theme for:

- model, context, cost, Git, and changed-file visibility;
- background terminals with bounded output and a TUI;
- trusted subagents and bounded multi-agent workflows;
- `fd`/`rg` search, interactive questions, summaries, and clipboard-friendly output.

## Why

Pi is deliberately small. This repository supplies the surrounding workflow needed for day-to-day coding: inspect the repository, delegate bounded work, run long-lived commands, and keep progress visible. Safety boundaries, output limits, cancellation, and deterministic tests are part of the setup—not optional polish.

## Who

This is for Pi users who want a maintained, local, opinionated setup and for contributors extending Pi through its extension API. It is not a replacement for Pi, a hosted service, or a general-purpose agent framework.

## Install

Requirements: Pi Coding Agent, Node.js, and pnpm.

```sh
git clone https://github.com/gocanto/pi-harness.git ~/.pi/agent
cd ~/.pi/agent
pnpm install
```

Start Pi from `~/.pi/agent`. See [`SETUP.md`](SETUP.md) for configuration, extension behavior, workflow activation, and verification commands.

```sh
pnpm run verify
```
