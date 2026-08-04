SHELL := /bin/bash

.DEFAULT_GOAL := help

.PHONY: help install check typecheck lint test test-coverage format format-all verify

help:
	@printf "pi-harness targets:\n"
	@printf "  install                 install dependencies with pnpm\n"
	@printf "  check                   typecheck TypeScript files (tsc --noEmit)\n"
	@printf "  lint                    lint TypeScript files with oxlint (via fmtkit)\n"
	@printf "  test                    run extension test suites\n"
	@printf "  test-coverage           run extension test suites with coverage\n"
	@printf "  format                  format changed TypeScript/Vue files with fmtkit\n"
	@printf "  format-all              format all TypeScript/Vue files with fmtkit\n"
	@printf "  verify                  run format-check, typecheck, and unit tests\n"

install:
	pnpm install

check: typecheck

typecheck:
	pnpm run check

lint:
	pnpm run lint

test:
	pnpm test

test-coverage:
	pnpm run test:coverage

format:
	pnpm run format

format-all:
	pnpm run format:all

verify:
	pnpm run verify
