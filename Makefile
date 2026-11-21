# Datum: developer commands.
# Run `make` or `make help` to see the targets.

SHELL := /bin/bash
# A failed recipe must not leave a half-written target that counts as up to date (dist/index.html).
.DELETE_ON_ERROR:
.DEFAULT_GOAL := help

# rustup installs cargo in ~/.cargo/bin. A shell started before the install
# does not have it in PATH yet, so add it here (no effect if it is already there).
ifneq ($(wildcard $(HOME)/.cargo/bin/cargo),)
export PATH := $(HOME)/.cargo/bin:$(PATH)
endif

CARGO ?= cargo
NPM   ?= npm
NPX   ?= npx

# Windows appends .exe to the binary name.
ifeq ($(OS),Windows_NT)
EXE := .exe
else
EXE :=
endif

# Test databases (Docker). The integration tests load their own seed data
# (crates/dbcore/tests/fixtures), so the containers only need to run.
PG_CONTAINER    ?= datum-pg
PG_IMAGE        ?= postgres:16
PG_PORT         ?= 54329
PG_PASSWORD     ?= datum
MYSQL_CONTAINER ?= datum-mysql
MYSQL_IMAGE     ?= mysql:8
MYSQL_PORT      ?= 33069
MYSQL_PASSWORD  ?= datum
ORACLE_CONTAINER ?= datum-oracle
ORACLE_IMAGE     ?= gvenzl/oracle-free:23-slim-faststart
ORACLE_PORT      ?= 15219
ORACLE_PASSWORD  ?= datum
# Optional old server (Oracle Database 10g XE 10.2.0.1) for the old-server tests (tests/oracle_legacy.rs):
#   make db-up-oracle-legacy
#   DATUM_ORACLE_10G_URL=oracle://demo:datum@127.0.0.1:15210/XE cargo test -p dbcore --test oracle_legacy -- --test-threads=1
ORACLE_LEGACY_CONTAINER ?= datum-oracle10g
ORACLE_LEGACY_IMAGE     ?= chameleon82/oracle-xe-10g:universal
ORACLE_LEGACY_PORT      ?= 15210
# Containers of 0.5.x (Prometeo DataGrip) publish the same ports as the datum-* ones: db-down / db-reset also clean
# them up (errors ignored when they do not exist), and db-up warns while one of them is still running.
OLD_CONTAINERS        := prometeo-pg prometeo-mysql prometeo-oracle
OLD_ORACLE_LEGACY     := prometeo-oracle10g

DB_ENV := DATUM_PG_URL=postgres://postgres:$(PG_PASSWORD)@127.0.0.1:$(PG_PORT)/postgres \
          DATUM_MYSQL_URL=mysql://root:$(MYSQL_PASSWORD)@127.0.0.1:$(MYSQL_PORT)/demo \
          DATUM_ORACLE_URL=oracle://demo:$(ORACLE_PASSWORD)@127.0.0.1:$(ORACLE_PORT)/FREEPDB1 \
          DATUM_NO_KEYRING=1

.PHONY: help install dev build bundle run \
        test test-ui test-rust test-rust-db test-all \
        lint typecheck clippy fmt fmt-check check ci \
        db-up db-down db-reset db-status db-up-oracle-legacy db-down-oracle-legacy clean

help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "; printf "Targets:\n"} /^[a-zA-Z_-]+:.*## / {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

## ---- Setup and run ----

install: ## Install the frontend dependencies (npm ci when a lockfile is present)
	@if [ -f package-lock.json ]; then $(NPM) ci; else $(NPM) install; fi

dev: ## Run the app in development mode (Vite + Tauri)
	$(NPM) run tauri dev

# The frontend bundle is rebuilt only when its sources are newer than dist/index.html.
# `tauri build` would otherwise run `npm run build` every time; that rewrites dist/ with new
# timestamps and makes cargo recompile (and fully LTO-relink) the app even when nothing changed.
# `find src` also lists directories: their mtime changes when a file is added, renamed or deleted.
# node_modules/.package-lock.json is rewritten by every `npm install`.
FRONTEND_SRC := $(shell find src) index.html package.json package-lock.json \
                tsconfig.json vite.config.ts $(wildcard node_modules/.package-lock.json)
NO_BEFORE_BUILD := --config '{"build":{"beforeBuildCommand":null}}'

dist/index.html: $(FRONTEND_SRC)
	$(NPM) run build

build: dist/index.html ## Build the optimized release binary (no installer bundles)
	$(NPX) tauri build --no-bundle $(NO_BEFORE_BUILD)
	@echo "Binary: target/release/datum$(EXE)"

bundle: dist/index.html ## Build the release binary and the installer bundles for the host OS
	$(NPX) tauri build $(NO_BEFORE_BUILD)

# `run` uses the fast-release profile (thin LTO, parallel codegen, incremental): close to release
# speed, but a code change rebuilds in seconds instead of minutes. `build`/`bundle` stay fully optimized.
run: dist/index.html ## Build a fast-release binary (only if something changed) and start the app
	$(CARGO) build --profile fast-release --bins --features tauri/custom-protocol -p datum
	./target/fast-release/datum$(EXE)

## ---- Tests ----

test: test-ui test-rust ## Run the unit tests (frontend + Rust, no databases needed)

test-ui: ## Run the frontend tests (vitest)
	$(NPM) test

test-rust: ## Run the Rust tests; database tests skip without the DB env
	DATUM_NO_KEYRING=1 $(CARGO) test --workspace

test-rust-db: db-up ## Run the Rust tests against the PostgreSQL, MySQL and Oracle containers
	$(DB_ENV) $(CARGO) test --workspace --no-fail-fast

test-all: test-ui test-rust-db ## Run every test, including the database integration tests

## ---- Quality ----

typecheck: ## Type-check the frontend (strict TypeScript)
	$(NPX) tsc --noEmit

clippy: ## Lint the Rust code (warnings are errors)
	$(CARGO) clippy --workspace --all-targets -- -D warnings

lint: typecheck clippy fmt-check ## Type-check, lint and check the Rust formatting

fmt: ## Format the Rust code
	$(CARGO) fmt --all

fmt-check: ## Check the Rust formatting
	$(CARGO) fmt --all -- --check

check: lint test ## Lint plus unit tests (quick check before a commit)

ci: lint test-all ## Everything a CI run does: lint, all tests with databases, frontend build
	$(NPM) run build

## ---- Test databases (Docker) ----

db-up: ## Start the PostgreSQL, MySQL and Oracle test containers (and wait until ready)
	@set -euo pipefail; \
	for old in $(OLD_CONTAINERS); do \
	  if docker ps --format '{{.Names}}' | grep -qx "$$old"; then echo "[db] warning: the 0.5.x container $$old is still running and may hold the same port: run 'make db-down' or 'make db-reset'"; fi; \
	done; \
	start() { \
	  name=$$1; shift; \
	  if docker ps --format '{{.Names}}' | grep -qx "$$name"; then echo "[db] $$name is running"; \
	  elif docker ps -a --format '{{.Names}}' | grep -qx "$$name"; then echo "[db] starting $$name"; docker start "$$name" >/dev/null; \
	  else echo "[db] creating $$name"; docker run -d --name "$$name" "$$@" >/dev/null; fi; \
	}; \
	start $(PG_CONTAINER) -e POSTGRES_PASSWORD=$(PG_PASSWORD) -p $(PG_PORT):5432 $(PG_IMAGE); \
	start $(MYSQL_CONTAINER) -e MYSQL_ROOT_PASSWORD=$(MYSQL_PASSWORD) -e MYSQL_DATABASE=demo -p $(MYSQL_PORT):3306 $(MYSQL_IMAGE); \
	start $(ORACLE_CONTAINER) -e ORACLE_PASSWORD=$(ORACLE_PASSWORD) -e APP_USER=demo -e APP_USER_PASSWORD=$(ORACLE_PASSWORD) -p $(ORACLE_PORT):1521 $(ORACLE_IMAGE); \
	echo "[db] waiting for PostgreSQL"; \
	for i in $$(seq 1 60); do docker exec $(PG_CONTAINER) pg_isready -U postgres -q && break; sleep 1; done; \
	docker exec $(PG_CONTAINER) pg_isready -U postgres -q || { echo "[db] PostgreSQL is not ready"; exit 1; }; \
	echo "[db] waiting for MySQL"; \
	for i in $$(seq 1 90); do docker exec $(MYSQL_CONTAINER) mysqladmin ping -uroot -p$(MYSQL_PASSWORD) --silent >/dev/null 2>&1 && break; sleep 1; done; \
	docker exec $(MYSQL_CONTAINER) mysqladmin ping -uroot -p$(MYSQL_PASSWORD) --silent >/dev/null 2>&1 || { echo "[db] MySQL is not ready"; exit 1; }; \
	echo "[db] waiting for Oracle (the first start takes a few minutes)"; \
	for i in $$(seq 1 300); do docker logs $(ORACLE_CONTAINER) 2>&1 | grep -q "DATABASE IS READY TO USE!" && break; sleep 2; done; \
	docker logs $(ORACLE_CONTAINER) 2>&1 | grep -q "DATABASE IS READY TO USE!" || { echo "[db] Oracle is not ready"; exit 1; }; \
	echo "[db] ready: PostgreSQL 127.0.0.1:$(PG_PORT), MySQL 127.0.0.1:$(MYSQL_PORT), Oracle 127.0.0.1:$(ORACLE_PORT)/FREEPDB1"

db-down: ## Stop the test containers, and any 0.5.x prometeo-* ones (data is kept)
	-docker stop $(PG_CONTAINER) $(MYSQL_CONTAINER) $(ORACLE_CONTAINER)
	-docker stop $(OLD_CONTAINERS) 2>/dev/null

db-reset: ## Remove the test containers (and any 0.5.x prometeo-* ones) and their data, then start new ones
	-docker rm -f $(PG_CONTAINER) $(MYSQL_CONTAINER) $(ORACLE_CONTAINER)
	-docker rm -f $(OLD_CONTAINERS) 2>/dev/null
	$(MAKE) db-up

db-status: ## Show the state of the test containers
	@docker ps -a --filter name=$(PG_CONTAINER) --filter name=$(MYSQL_CONTAINER) --filter name=$(ORACLE_CONTAINER) --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

# The image has SYS / SYSTEM password `oracle` and 40 processes, too few for the pooled test connections: the
# target sets 150 (one restart) and creates the account `demo` (password $(ORACLE_PASSWORD)). The listener is
# published on 127.0.0.1 only; the SSH server of the image is not published.
db-up-oracle-legacy: ## Start the optional Oracle 10g XE test container (old-server tests)
	@set -euo pipefail; \
	name=$(ORACLE_LEGACY_CONTAINER); \
	sys() { docker exec -i "$$name" sqlplus -s -L "sys/oracle as sysdba"; }; \
	if docker ps --format '{{.Names}}' | grep -qx "$$name"; then echo "[db] $$name is running"; \
	elif docker ps -a --format '{{.Names}}' | grep -qx "$$name"; then echo "[db] starting $$name"; docker start "$$name" >/dev/null; \
	else echo "[db] creating $$name"; docker run -d --name "$$name" --shm-size=1g -p 127.0.0.1:$(ORACLE_LEGACY_PORT):1521 $(ORACLE_LEGACY_IMAGE) >/dev/null; fi; \
	echo "[db] waiting for Oracle 10g"; \
	ready() { printf "select 'DB' || 'READY' from dual;\n" | sys 2>/dev/null | grep -q DBREADY; }; \
	for i in $$(seq 1 90); do ready && break; sleep 2; done; \
	ready || { echo "[db] Oracle 10g is not ready"; exit 1; }; \
	procs=$$(printf 'set heading off feedback off pagesize 0\nselect value from v$$parameter where name = '"'"'processes'"'"';\n' | sys | tr -d '[:space:]'); \
	if [ "$$procs" -lt 150 ]; then \
	  echo "[db] processes $$procs -> 150 (restart)"; \
	  printf 'alter system set processes=150 scope=spfile;\nshutdown immediate\nstartup\n' | sys >/dev/null; \
	fi; \
	echo "[db] account demo"; \
	printf '%s\n' \
	  "whenever sqlerror exit failure" \
	  "begin execute immediate 'create user demo identified by $(ORACLE_PASSWORD) default tablespace users quota unlimited on users'; exception when others then if sqlcode <> -1920 then raise; end if; end;" \
	  "/" \
	  "grant connect, resource, create view, create synonym, create materialized view, create type, create sequence, create trigger, create procedure, select_catalog_role to demo;" \
	  | sys >/dev/null; \
	echo "[db] ready: Oracle 10g 127.0.0.1:$(ORACLE_LEGACY_PORT)/XE (DATUM_ORACLE_10G_URL=oracle://demo:$(ORACLE_PASSWORD)@127.0.0.1:$(ORACLE_LEGACY_PORT)/XE)"

db-down-oracle-legacy: ## Stop and remove the Oracle 10g XE test container
	-docker rm -f $(ORACLE_LEGACY_CONTAINER)
	-docker rm -f $(OLD_ORACLE_LEGACY) 2>/dev/null

## ---- Cleanup ----

clean: ## Remove build output (target/ and dist/); keeps node_modules
	$(CARGO) clean
	rm -rf -- dist
