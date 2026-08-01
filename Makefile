SHELL := /bin/bash

.DEFAULT_GOAL := help

.PHONY: help install check typecheck test format format-all verify

help:
	@printf "pi-harness targets:\n"
	@printf "  install                 install dependencies with pnpm\n"
	@printf "  check                   typecheck TypeScript files (tsc --noEmit)\n"
	@printf "  test                    run extension test suites\n"
	@printf "  format                  format changed TypeScript/Vue files with fmtkit\n"
	@printf "  format-all              format all TypeScript/Vue files with fmtkit\n"
	@printf "  verify                  run format-check, typecheck, and unit tests\n"

install:
	pnpm install

check: typecheck

typecheck:
	pnpm run check

test:
	pnpm test

format:
	pnpm run format

format-all:
	pnpm run format:all

verify:
	pnpm run format:check
	pnpm run check
	pnpm test
