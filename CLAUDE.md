# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

All commands use Bun (packageManager: bun@1.3.11). Default branch is `dev`, not `main`.

```bash
# Install dependencies
bun install

# Run TUI (dev mode)
bun dev                          # runs in packages/opencode dir
bun dev <directory>              # run against a specific directory
bun dev .                        # run against repo root
bun dev serve                    # headless API server (port 4096)
bun dev serve --port 8080        # custom port
bun dev web                      # server + web interface

# Web app (requires server running separately)
bun run --cwd packages/app dev

# Desktop app (requires Rust/Tauri)
bun run --cwd packages/desktop tauri dev

# Lint
bun run lint                     # runs oxlint

# Type check - uses tsgo, never tsc directly
bun typecheck                    # from within a package dir
bun turbo typecheck              # all packages from root

# Tests - MUST run from package dirs, NOT root
bun --cwd packages/opencode test              # all opencode tests
bun --cwd packages/opencode test <pattern>    # specific test file
bun --cwd packages/app test:unit              # app unit tests
bun --cwd packages/app test:e2e               # Playwright e2e tests

# Build standalone binary
./packages/opencode/script/build.ts --single

# Database migration (from packages/opencode)
bun run db generate --name <slug>

# Regenerate SDK (after API/server changes)
./script/generate.ts
./packages/sdk/js/script/build.ts    # JS SDK only
```

## Architecture

OpenCode is a monorepo (Bun workspaces + Turborepo) implementing a provider-agnostic AI coding agent with TUI, web, and desktop frontends.

### Client/Server Model

The core runs as a Hono HTTP + WebSocket server (default port 4096). All frontends are clients:
- **TUI**: SolidJS terminal UI via `@opentui/solid` (`packages/opencode/src/cli/cmd/tui/`)
- **Web**: SolidJS + Vite (`packages/app`)
- **Desktop**: Tauri wrapping the web UI (`packages/desktop`)

### Core Package (`packages/opencode/src/`)

- `agent/` — Agent definitions and prompt templates
- `session/` — Session management, LLM interaction, compaction
- `provider/` — LLM provider integrations via Vercel AI SDK (`ai` package)
- `tool/` — Built-in tools (each `.ts` has a companion `.txt` prompt file)
- `server/` — Hono HTTP/WebSocket API routes
- `config/` — Configuration system (self-export pattern: `export * as ConfigAgent from "./agent"`)
- `storage/` — SQLite via Drizzle ORM (schema in `**/*.sql.ts`)
- `lsp/` — Language Server Protocol client
- `mcp/` — Model Context Protocol support
- `effect/` — Effect-TS runtime utilities (`makeRuntime`, `InstanceState`)

### Other Packages

- `packages/sdk/js` — Auto-generated JS SDK from OpenAPI spec
- `packages/plugin` — Plugin API (`@opencode-ai/plugin`)
- `packages/ui` — Shared UI primitives
- `packages/console/` — Web dashboard (SolidStart)
- `packages/web` — Documentation site (Astro)

### Platform-Specific Imports

`packages/opencode/package.json` uses conditional `imports` (`#db`, `#pty`, `#hono`) to swap implementations between Bun and Node runtimes.

## Style Guide

### Code Style

- No semicolons (Prettier config)
- No `else` — use early returns
- No `try`/`catch` where possible — prefer `.catch()`
- No `any` type — use precise types, rely on type inference
- `const` over `let` — use ternaries instead of reassignment
- Bun APIs preferred (`Bun.file()`, etc.)
- Functional array methods (`flatMap`, `filter`, `map`) over for loops
- Use type guards on `filter` to maintain type inference

### Destructuring

Avoid unnecessary destructuring; use dot notation:
```ts
// Good: obj.a, obj.b
// Bad: const { a, b } = obj
```

### Variables

Inline single-use values to reduce variable count:
```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()
// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Drizzle Schema

snake_case field names so column names don't need string redefinition:
```ts
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})
```

Naming: join columns are `<entity>_id`; indexes are `<table>_<column>_idx`.

## Module Organization

Do NOT use `export namespace`. Use flat top-level exports with self-reexport:

```ts
// src/foo/foo.ts
export interface Interface { ... }
export class Service extends Context.Service<Service, Interface>()("@opencode/Foo") {}
export const layer = Layer.effect(Service, ...)
export * as Foo from "./foo"
```

For `index.ts`: `export * as Foo from "."` (not `"./index"`).

Multi-sibling directories: no barrel `index.ts` — import specific siblings directly.

## Effect-TS Conventions

- `Effect.gen(function* () { ... })` for composition
- `Effect.fn("Domain.method")` for named/traced effects; `Effect.fnUntraced` for internal helpers
- `Effect.fn`/`Effect.fnUntraced` accept pipeable operators as extra args — avoid unnecessary `.pipe()` wrappers
- Prefer `yield* new MyError(...)` over `yield* Effect.fail(new MyError(...))` in gen blocks
- `Schema.TaggedErrorClass` for typed errors; `Schema.Defect` for defect causes
- `makeRuntime` (from `src/effect/run-service.ts`) for all services
- `InstanceState` (from `src/effect/instance-state.ts`) for per-directory state needing per-instance cleanup
- **Effect v4 beta**: `Effect.fork`/`Effect.forkDaemon` don't exist — use `Effect.forkIn(scope)`
- Prefer Effect services (`FileSystem`, `HttpClient`, `Path`, `Clock`, `ChildProcessSpawner`) over raw platform APIs
- `Instance.bind(fn)` for native addon callbacks needing AsyncLocalStorage context

## Testing

- Run from package dirs only (root is guarded with `do-not-run-tests-from-root`)
- Avoid mocks — test actual implementations
- Do not duplicate logic into tests

## Web App Development

- `bun dev web` proxies `app.opencode.ai` — local UI changes won't show there
- For local UI changes, run backend and app separately:
  - Backend: `bun run --cwd packages/opencode --conditions=browser ./src/index.ts serve --port 4096`
  - App: `bun run --cwd packages/app dev -- --port 4444`
- SolidJS: prefer `createStore` over multiple `createSignal` calls

## Desktop Package

Never call `invoke` manually — use generated bindings in `packages/desktop/src/bindings.ts`.

## PR Conventions

Titles follow conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:` with optional scope like `feat(app):`.
