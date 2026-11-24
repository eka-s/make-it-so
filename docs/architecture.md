[日本語](architecture.ja.md)

# Architecture (for developers)

This document is for people who read or change the make-it-so code. For user-facing explanations, see [Core Concepts](concepts.md) and the [guides](guides/).

## Contents

- [Development environment and commands](#development-environment-and-commands)
- [Process structure](#process-structure)
- [Code structure](#code-structure)
- [Passing dependencies](#passing-dependencies)
- [Client structure](#client-structure)
- [Tests](#tests)
- [Changing the schema](#changing-the-schema)
- [Adding an HTTP route](#adding-an-http-route)
- [Adding a provider](#adding-a-provider)
- [Conventions for comments and language](#conventions-for-comments-and-language)

## Development environment and commands

The Node.js version follows `.tool-versions`. SQLite uses Node's built-in `node:sqlite`.

| Command | What it does |
|---|---|
| `npm run init -- [...]` | Creates a minimal configuration ([guide](guides/create-fleet-and-ship.md)) |
| `npm run dev -- --ship <ship ID>` | Starts the server (tsx watch) and the client (Vite) together. With `--settings`, starts the settings server (the UI is at `http://localhost:13938`) |
| `npm run dev:server` / `npm run dev:client` (both with `-- --ship <ship ID>`) | Only one of the two |
| `npm run build` | Empties `dist/` (`npm run clean`), then builds the server with `tsc` (`tsconfig.build.json`) into `dist/server` and `dist/electron`, and the client with Vite into `dist/client` |
| `npm start -- --ship <ship ID>` / `npm start -- --settings` | Starts the built output (`node dist/server/cli.js`). The API and the UI are served on the same port |
| `npm run start:electron` (`-- --ship <ship ID>` or `-- --settings`) | Starts the desktop app from the built output ([guide](guides/desktop-app.md)). The UI is served without a port |
| `npm run pack` / `npm run dist` | Makes the desktop app (`release/mac-arm64/Make-It-So.app`, and a dmg) |
| `npm run typecheck` | Type-checks the server and the client |
| `npm run lint` | eslint |
| `npm test` | vitest (no ship needs to be specified) |

- The build does not depend on a ship (`vite.config.ts` reads the configuration only for the dev server). Even with multiple ships, you can build without `--ship`.
- Serving the UI (`npm start`): only when `clientDir` is passed to `createApp`, it adds static file serving and a handler that routes GETs other than `/api` to `index.html`. `builtClientDir()` in `index.ts` returns the neighboring `dist/client` only when running as `dist/server/index.js` (during development, Vite serves the UI even if an old build is left over).
- CI (`.github/workflows/ci.yml`) runs lint, type-check, tests and build on pushes to `main` and on pull requests.

## Process structure

```
index.ts (wiring layer)
  ├─ createApp: Express (JSON, SSE, each router, error handling)
  ├─ bridge        manages turns (conversations between the captain and the crew) and automatic recovery
  ├─ CrewManager   manages conversation sessions and injects the briefing
  ├─ CrewRunner    runs tasks issued by dispatch_task
  ├─ connectCrewEvents  reflects CrewRunner/CrewManager events into the DB, timeline, SSE and permissions
  ├─ mcp-listener  Loopback-only listener (OS-picked port) that serves /mcp
  ├─ mcp-board     MCP board (/mcp)
  └─ database      SQLite
```

- The desktop app (`src/electron/`) runs a ship the same way (`buildShip()`), but serves its page at `app://` through an in-memory HTTP connection into the ship's Express app, so no port is opened for the UI; the `/mcp` listener is still there for the agents. The ship list and the settings each run in a process of their own, and a ship lives as long as its window.
- 1 process = 1 ship. A crew member is a provider's agent, started as a child process by `BaseAgentClient` (JSON-RPC over stdin/stdout, i.e. ACP). Crew members on remote hosts are started the same way over SSH and reach the MCP board through a reverse tunnel.
- Tool calls of each turn and task (what was run and what it output) are appended, one line each, to `activity/<id>.jsonl` (`src/server/activity-log.ts`). They are not written to the DB. Only the latest 50 files are kept (older files are deleted at startup and on creation of a new one), and the output of one operation is limited to its first 2000 characters. They arrive as the `activity` of a timeline item, in the same shape in both the snapshot and the upsert. While running, whenever it changes (batched to at most once every 0.4 seconds), `timeline:activity` replaces only the `activity` of that item. The client just renders `activity` as is, so the display is the same after a reload or in another browser. Each turn or task records at most 100 operations, and titles are limited to 300 characters.
- The body of a running turn or task is not accumulated in memory. It is written to a file (`turns/`, `agents/`) and read when a snapshot is taken. Once finalized, it is written to the DB and the file is deleted. If the server stops midway (Ctrl-C, crash), at the next startup, turns and tasks with no recorded result are recorded as "interrupted" errors (the contents of the remaining files are kept as the partial body). However, a turn that stopped before its file was created (while the session was starting) leaves no record, so it cannot be found. Each turn and task holds one write stream, and waiting for `end` to complete prevents losing the tail.
- The timeline SSE (`upsert`, `append`, `remove`) is built from the server's in-memory "live" (running) items and the history in the DB.

## Code structure

### Server (`src/server/`)

| File | Role |
|---|---|
| `cli.ts` | Entry point. Based on the arguments (`cli-args.ts`), loads and runs exactly one of: the settings server, a ship (`index.ts`), or all ships (`--all`) |
| `settings/` | Settings server (`--settings`). The API for reading and writing `~/.make-it-so`, and serving the UI (`settings.html`). It does not load any ship's configuration |
| `index.ts` | Wiring layer. **The only module allowed to import `config.ts` directly.** Creates the parts and connects them (`buildShip()` returns the `app` without serving it), and listens on the ship's port (`runShip()`) |
| `app.ts` | `createApp(deps)`: assembles the Express app |
| `routes/` | One router per feature (`createXxxRouter(deps)`). `mission-id.ts` shares mission ID resolution |
| `config.ts` | Calls `load-config.ts` with the `--ship` argument and the home directory, and builds `config` |
| `load-config.ts`, `fleet-config.ts` | Reading and validating `config.yml`, the roster and the ship's configuration. Functions that take arguments; problems are exceptions |
| `bridge.ts` | `createBridge(deps)`: turn management, automatic recovery, stopping |
| `crew-manager.ts` | `CrewManager`: session management, briefing, applying the model and permission mode |
| `crew-runner.ts` | `CrewRunner`: running tasks |
| `crew-events.ts` | `connectCrewEvents`: reflecting events |
| `crew-briefing.ts`, `skills.ts`, `crew-paths.ts` | Building the briefing, reading skills, paths |
| `crew-model.ts` | Model resolution (`resolveCrewModel`). A pure function |
| `mcp-board.ts` | The MCP board's MCP server |
| `mcp-listener.ts` | The listener that serves `/mcp` alone: loopback only, on a port the OS picks, 503 until the board is wired in |
| `ship-lock.ts`, `ship-id.ts` | The `desktop.pid` mark of a ship open in the desktop app (process ID and start time), read by the browser version and the settings; the one pattern a ship ID must match before it builds a path or a command line |
| `a2ui-action.ts`, `a2ui-validate.ts` | A2UI: the answer's action message, and the strict validation of a crew member's messages |
| `database.ts`, `migrations.ts` | SQLite, and schema versioning |
| `timeline.ts` | Running items, and composing the snapshot |
| `*-agent-client.ts`, `base-acp-client.ts`, `agent-client.interface.ts`, `agent-client-factory.ts` | ACP clients |
| `ssh.ts`, `host-tunnel.ts`, `crew-hosts.ts` | Remote hosts (building SSH commands, keeping reverse tunnels alive) |
| `usage-fetcher.ts`, `account-usage.ts`, `account-identity.ts` | Fetching usage, and aggregating per account |
| `quick-actions.ts` | The custom menu (`quick-actions.yml`): reading, validating and saving the items, and editing them as one ship sees them. Shared by the ship server (`routes/quick-actions.ts`) and the settings server |
| `messages.ts`, `language.ts` | Fixed messages the server writes (English text and keys), and language resolution |
| `logger.ts` | Configured with `configureLogger(...)` |
| `testing/` | Test helpers |

### Desktop app (`src/electron/`) and its client side

| File | Role |
|---|---|
| `main.ts` | The app's entry point: how to start (`start-mode.ts`), one instance per ship, the window, quitting after the ship has stopped. It loads `index.ts` only after deciding, so the ship's configuration is read for the ship being run |
| `start-mode.ts`, `argv.ts` | One ship / the ship list / the settings; the arguments of a packaged app |
| `in-memory-fetch.ts` | Serves a request through an in-memory HTTP connection into the Express app (no port); strips the browser-origin headers the local-request guard would refuse |
| `shell-requests.ts`, `window-fit.ts` | What the page tells the window over the path `/__shell/window` (its header's height and the room it keeps at both ends; the app answers with the page's zoom), and the position of the window buttons and the narrowest window worked out from it |
| `launcher-page.ts`, `launcher-handler.ts`, `launcher-text.ja.ts` | The ship list (a page with no script) and what it answers |
| `desktop-runtime.ts`, `running-in-browser.ts` | The settings' view of ships open in the desktop app and running in the browser version |
| `application-menu.ts` | The menu (with the way to the settings) |
| `src/client/shell.ts`, `desktop-shell.css`, `use-shell-window.ts` | The page's side: marking the desktop app on macOS, the header as the title bar (room for the window buttons, which a page zoom does not scale), reporting its size to the app |

### Direction of dependencies

- Routes and parts receive what they need as arguments and do not import `config.ts` or other parts directly.
- `database.ts` receives role resolution (`agentToRole`) as an argument of `initDatabase`.

## Passing dependencies

- **Only `index.ts` may import `config.ts` directly.** Other modules receive the values they need (part of the configuration, external commands, the current time, other parts) as arguments of a factory `createXxx(deps)` or of a constructor. `deps` is narrowed to only what the module uses, with `Pick<…>` and the like.
- Do not create modules that run side effects (loading configuration, creating files, networking) merely by being imported. Module-level state (Maps, caches) is confined to the factory's instance.
- Avoid variables that may be null before startup and are filled in later by a setter. Create things once their dependencies are ready. (One accepted exception: `mcp-listener.ts` binds its port first, because the sessions' MCP URL and the reverse tunnels need the port before the board's dependencies exist, and answers 503 until `serve()` gives it the handler.)
- State that is inherently single, such as `logger` and `timeline`, is configured exactly once at startup with `configureLogger(...)` and `configureTimeline(...)`.

## Client structure

`src/client/` (React + Vite). **Logic is pushed to the server, and the client only renders from a single data source** ([Core Concepts](concepts.md#design-principles)).

| File | Role |
|---|---|
| `server-api.ts` | **The only place that calls the API.** Do not hard-code `fetch` or `"/api/..."` in other files. The target is a same-origin relative path (the server rejects calls from other origins, so it cannot be pointed elsewhere) |
| `chat-state.ts` | `chatReducer`: state updates of the conversation (a pure function). **Do not put state-update logic in components** |
| `permission-state.ts` | State updates for pending permissions (pure functions). Communication with the server is in `usePermissions.ts` |
| `chat-grouping.ts`, `mission-filter.ts`, `search-group.ts`, etc. | Pure functions for sorting, filtering and the like |
| `preferences.ts` | Personal settings kept in `localStorage` |
| `i18n/` | Multiple languages. `en.ts` is the source of truth for the dictionary, plus `ja.ts` and `translate.ts` (the pure function behind `t()`) |

- **Do not start client source file names with `api`.** Vite's dev server proxies paths starting with `/api/` to the backend, so a name like `/api.ts` cannot be loaded and the screen goes blank.
- If the client needs logic that infers, converts or reconstructs from the server's values (for example mapping an agent name to a role, removing duplicates by matching timestamps, or combining the results of multiple endpoints), that is a sign of a design flaw on the server side. Solve it on the server.
- For a new feature, first consider whether the existing single data source (`TimelineItem` / `GET /api/timeline`) can be extended, and do not casually add endpoints or SSE kinds.

## Tests

- `npm test` (`vitest run`). `vitest.config.ts` does not load any ship's configuration.
- **Parts that start child processes accept a replacement for the start function as an argument** (the spawn in `BaseAcpClient`, the ssh in `createHostTunnels`). With a fake process (`testing/fake-acp-process.ts`), JSON-RPC over stdin/stdout and connection state transitions are verified without a real process.
- The DB is in memory with `initDatabase({ path: ":memory:", ... })`. Agents are `FakeAgentClient`, passed to `CrewManager`'s `createClient`. Routers and the whole app are stood up on a free port with `startTestServer` / `serveApp` and called with `fetch`.
- The client tests state updates, sorting, settings and request building as pure functions without a DOM (there are almost no tests of the components themselves).
- **Detecting drift between docs and code:** `testing/docs-drift.test.ts` checks that every HTTP route and every configuration key is listed in the reference (it also pins down that the server does not read environment variables). When you add a route or a setting, update the reference too.
- **Detecting stray Japanese:** `testing/no-hardcoded-japanese.test.ts` checks that no Japanese (comments included) exists outside the files where it is allowed.
- Policy: **tests are a means for refactoring, not an asset to be preserved.** Do not avoid changing product code just because tests exist. When a test fails, decide whether it is a bug or an intended change, and if it is an intended change, fix the test. Tests tied to implementation details (mocks, module paths, internal string formats) are of little value to keep. What to protect is externally visible behavior (the contract with the client, and regressions of bugs that actually happened).
- When you extract a function, pin its current behavior down as a test on the spot.

## Changing the schema

1. Add a migration **at the end** of `MIGRATIONS` in `src/server/migrations.ts`, with the next version number.
2. **Do not rewrite published migrations.** Do not add `CREATE TABLE` or `ALTER TABLE` directly to `database.ts`.
3. To add a column, use `addColumnIfMissing`. Fix the meaning of old rows (such as how to treat an empty column) once in a migration, not with special handling on the read side.
4. The default mission's ID and name used within version 1 (`baseline`) are written as literal strings, not constants (so that the published content does not change when a constant in the app changes).
5. Update the tables and the version list in the [data model](reference/data-model.md).
6. Start up and confirm that an existing DB (`data/bridge.db`) is migrated, leaving a `.bak-v<old version>`.

For the mechanism and rules, see the [data model](reference/data-model.md#migrations).

## Adding an HTTP route

1. Add it to `src/server/routes/` as `createXxxRouter(deps)`. Create it in `index.ts` and pass it to `createApp` (**do not hard-code routes in `index.ts`**).
2. Add the call from the client to `src/client/server-api.ts`.
3. Add a row to the [HTTP API reference](reference/http-api.md) (without it, `docs-drift.test.ts` fails).

## Adding a provider

Confine differences to each provider's client. Do not write branches like `if (provider === "...")` in higher-level code (`crew-manager.ts`, `config.ts`, etc.).

1. Create a subclass of `BaseAcpClient` (or `BaseAgentClient`). Implement the spawn arguments (`buildSpawnArgs`), session creation and resumption, provider-specific notifications (`handleProviderNotification`), and so on.
2. Register it in `agent-client-factory.ts`.
3. Add a branch to `usage-fetcher.ts` for the command that fetches usage.
4. Check the registration of the MCP board (MCP). Inject it dynamically with `session/new` and attach a per-session identification header and the ship's `/mcp` secret. Without this, `dispatch_task` and the like cannot be used.
5. Check provider-specific mechanisms such as the permission allowlist. Unless `Write`, `Read`, `Edit` and the MCP board's tools are allowed, ordinary work will be full of pending permissions.
6. Check for provider-specific pitfalls such as workspace trust (Claude Code shows no trust prompt when headless, and permission rules are ignored in untrusted directories).
7. `targets` / `access` (the area of responsibility) are an agreement in the prompt and do not depend on the provider, so they need not be added.

## Conventions for comments and language

- Comments in code (JSDoc, `//`, `/* */`, and all JSX comments) are written in **English**. Test names (`describe`/`it`) are also in English.
- Comments contain **only the current specification and its reason (Why)**. History such as "it used to be X but was changed to Y" goes in the commit message.
- Do not write character names from specific works (use neutral names in samples and explanations).
- UI text goes through the dictionary (`i18n/`). Fixed messages the server writes to the timeline go through the keys in `messages.ts`.
