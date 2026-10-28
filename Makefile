SHELL := /bin/sh

PNPM ?= pnpm
NODE ?= node

.DEFAULT_GOAL := help

# Unit tests that need root (chown, cgroup writes, a real sandbox root, setuid) or a host the
# launch chain can run on. `make unit` runs them; `make unit-unprivileged` leaves them out so a
# hosted CI runner, which is not root, can run the rest.
PRIVILEGED_UNIT := \
	packages/cli/test/unit/local.test.js \
	packages/cli/test/unit/main.test.js \
	packages/cli/test/unit/serve.test.js \
	packages/core/test/unit/host/cgroup.test.js \
	packages/core/test/unit/host/doctor.test.js \
	packages/core/test/unit/host/launch.test.js \
	packages/core/test/unit/host/rootfs.test.js \
	packages/core/test/unit/sandbox/exec.test.js \
	packages/mcp/test/unit/main.test.js \
	packages/mcp/test/unit/server.test.js \
	packages/mcp/test/unit/tools.test.js \
	packages/runner/test/unit/checks.test.js \
	packages/runner/test/unit/sessions.test.js \
	packages/server/test/unit/server.test.js \
	packages/wb/test/unit/commands.test.js

ALL_UNIT := $(sort $(shell find packages -path '*/test/unit/*' -name '*.test.js' -not -path '*/node_modules/*'))
UNPRIVILEGED_UNIT := $(filter-out $(PRIVILEGED_UNIT),$(ALL_UNIT))

.PHONY: help install lint fmt fmt-check check-tests docs-check wb-docs check \
	unit unit-unprivileged test coverage deploy-check ci changelog

help: ## List the targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-z][a-z-]*:.*## / {printf "  %-18s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install dependencies from the lockfile
	$(PNPM) install --frozen-lockfile

lint: ## eslint over the repository
	$(PNPM) lint

fmt: ## Format sources with prettier
	$(PNPM) fmt

fmt-check: ## Check formatting without writing
	$(PNPM) fmt:check

check-tests: ## 1:1 src to unit test mapping, integration and e2e presence
	$(PNPM) check:tests

docs-check: ## docs/wb.md is current and every doc link resolves
	$(NODE) docs/check.mjs

wb-docs: ## Regenerate docs/wb.md from the wb command table
	$(NODE) docs/gen-wb.mjs

check: lint fmt-check check-tests docs-check ## Static gates; no privileges needed

unit: ## Every unit test; the privileged ones need root
	$(NODE) --test $(ALL_UNIT)

unit-unprivileged: ## Unit tests that run as an ordinary user
	$(NODE) --test $(UNPRIVILEGED_UNIT)

test: ## Unit, integration and e2e; needs root, bubblewrap and cgroup v2
	$(PNPM) test

coverage: ## Test run with the coverage floors; needs a prepared host
	$(PNPM) test:coverage

deploy-check: ## Validate the deployment assets and run the host doctor
	bash deploy/check.sh

ci: check unit-unprivileged ## What the hosted CI workflow runs

changelog: ## Regenerate CHANGELOG.md from git history (needs git-cliff)
	git cliff -o CHANGELOG.md
