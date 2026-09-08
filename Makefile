# mlx-spy - Makefile
#
# Thin wrapper over the package.json scripts: each task runs the script of the
# same name, so `make <task>` and `bun run <task>` are interchangeable. The
# actual commands live in package.json, edit them there. (`install-bin` is
# named to match its script: a script plainly named `install` would fire on
# `bun install`.)

# Exported so `make install-bin PREFIX=/usr/local` reaches the install-bin script.
export PREFIX

.DEFAULT_GOAL := help

.PHONY: help start dev test build lint clean install-bin uninstall-bin deploy-studio

help: ## Show available tasks
	@grep -hE '^[a-z][a-z-]*:.*## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-13s\033[0m %s\n", $$1, $$2}'

start: ## Run once against an engine (make start ARGS="--engine http://host:11234 --once")
	@bun run start $(ARGS)

dev: ## Run with live reload (make dev ARGS="...")
	@bun run dev $(ARGS)

test: ## Run tests
	@bun run test

lint: ## Format and lint with Biome, then type-check with tsc
	@bun run lint

build: ## Compile a standalone binary into bin/
	@bun run build

clean: ## Remove build artifacts
	@bun run clean

install-bin: ## Compile and install onto PATH (override PREFIX=...)
	@bun run install-bin

uninstall-bin: ## Remove the installed binary (override PREFIX=...)
	@bun run uninstall-bin

deploy-studio: ## Build, install on the Mac Studio and restart its agent (docs/internal/studio.md)
	@bun run deploy-studio
