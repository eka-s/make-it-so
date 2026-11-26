[日本語](http-api.ja.md)

# HTTP API Reference

Reference for the HTTP API, SSE (Server-Sent Events), and MCP board provided by the make-it-so server. The client (the UI) talks to the server through this API and nothing else.

## Contents

- [Common Conventions](#common-conventions)
- [Configuration and Status](#configuration-and-status)
- [Conversations with the Crew](#conversations-with-the-crew)
- [Missions](#missions)
- [Timeline](#timeline)
- [Crew Personnel Records and Icons](#crew-personnel-records-and-icons)
- [Tasks](#tasks)
- [Pending Permissions (permission)](#pending-permissions-permission)
- [PINs](#pins)
- [Search](#search)
- [Memory (viewer)](#memory-viewer)
- [Models](#models)
- [Agents and Debugging](#agents-and-debugging)
- [SSE (Server-Sent Events)](#sse-server-sent-events)
- [MCP Board](#mcp-board)
- [Settings Server API (`--settings`)](#settings-server-api---settings)
- [Error Codes](#error-codes)

## Common Conventions

- **Format:** Requests and responses are both JSON (the one exception is icon upload, which is raw image bytes). JSON bodies are limited to 1MB.
- **Listening:** Defaults to `127.0.0.1`. **There is no authentication** ([Security notes](../security.md)). No CORS headers are sent. The following are rejected on every route: requests whose `Host` is not an IP address or `localhost` (`403`, `{ error: "forbidden_host" }`); requests whose `Origin` differs from the server's own origin (`403`, `{ error: "forbidden_origin" }`); and requests whose `Sec-Fetch-Site` is anything other than `same-origin` or `none` (`403`, `{ error: "forbidden_site" }`; GETs that open a page by following a link, i.e. top-level navigations, are let through). `Host` is accepted only in the form `name[:port]`, and `Origin` only with `http:`. Requests without an `Origin` (such as `curl`) are let through.
- **Serving the UI:** With `npm start`, any GET outside `/api` returns the built UI (`index.html`). A nonexistent `/api/...` returns 404.
- **Error shape:** `{ "error": "<message or code>", "message"?: "<English description>" }`. When `error` is a code (such as `agent_busy`), the UI translates it with a dictionary ([Error Codes](#error-codes)).
- **Missions:** APIs that take a mission accept `missionId` in the body or the query.
  - Body (`POST`-style): if omitted, empty, or not a string, the default mission (`bridge`) is used. An ID that does not exist returns `404`.
  - Query (`GET` timeline-style): if omitted, the default mission (`bridge`) is used.
- **Specifying a crew member (`:role`):** A role name from `ship.yml`. A role that does not exist returns `404`.

## Configuration and Status

| Method and path | Description |
|---|---|
| `GET /api/health` | `{ status: "ok", shipId, pid, uptime, agents }`. `agents` maps role name to status. `shipId` and `pid` are used by the settings server to identify and stop the ship running on that port |
| `GET /api/config` | `{ defaultTarget, shipName, language, crewLanguage }`. `defaultTarget` is the role of the default conversation target (the commander, or the first crew member if there is none; `null` if there is no crew) |
| `PUT /api/config/language` | Changes the UI language. Body `{ language: "en" \| "ja" }`. Saved in the ship's DB. Response `{ language }`. An unsupported value returns `400` (`invalid_language`) |
| `PUT /api/config/crew-language` | Changes the language the crew speaks. Same shape. Takes effect from newly created sessions |
| `GET /api/quick-actions` | The custom menu items enabled on this ship. `{ actions: [{ id, name, kind, command, send, shared }] }`. `kind` is `message` or `slash`, `send` is `now` or `fill`, and `shared` says that other ships have the item too. A `quick-actions.yml` that cannot be read as YAML returns `409` |
| `PUT /api/quick-actions` | Replaces this ship's list. Body `{ actions: [{ id?, name, kind, command, send }], seen?: string[] }`. An item with a known `id` is updated (a shared item changes for every ship that has it), one without is new and enabled on this ship only, and one that is left out is taken off this ship (an item enabled on all ships is switched off for this ship only). `seen` lists the IDs the editor loaded: an item that appeared after that is left alone. Only this ship's own items are validated. Response: the same as `GET`. Invalid input returns `400` (`errors` by index in the list); a `quick-actions.yml` that cannot be read as YAML returns `409` |
| `GET /api/crew` | The crew lineup. Role name -> `{ name, provider, acp_agent, rank, icon?, host? }`. `icon` is an image URL; `host` is present only for remote crew members |
| `GET /api/crew/status?missionId=` | Crew activity status (an array of per-host groups). See below |
| `GET /api/crew/:role/tasks?limit=&missionId=` | A crew member's running task and history. `limit` defaults to 5. Response `{ current, history, hasMore }`. `current` is `{ taskId, taskName }` or `null` |
| `POST /api/bridge/refresh-credits` | Re-fetches per-account usage, broadcasts it over SSE (`credits:usage`), and also returns it in the response. Response `{ status: "ok", data }`. Failure is `500` |

### `GET /api/crew/status`

The response is an array of per-host groups (local first; remote hosts in the order they first appear in the crew list).

```json
[
  {
    "host": { "label": "workstation", "kind": "local" },
    "tunnel": null,
    "crew": [
      { "role": "first_officer", "status": "idle", "unreportedCount": 0,
        "contextPercent": null, "commands": [], "commandsLive": false }
    ]
  }
]
```

| Field | Description |
|---|---|
| `host` | `{ label, kind: "local" \| "remote", address? }`. For remote hosts, `address` is the destination resolved with `ssh -G` (absent if it is the same as the name or cannot be resolved) |
| `tunnel` | State of the reverse tunnel to a remote host: `connected` \| `connecting` \| `idle`. `null` for local |
| `status` | `idle` \| `working` \| `starting` \| `restarting` (priority: restarting > starting > working > idle) |
| `unreportedCount` | Number of unreported tasks |
| `contextPercent` | Context usage (%). When `missionId` is given, the value for that mission's conversation session. `null` if there is no session or no `missionId` |
| `commands` | Slash commands available in the conversation session, `{ name, description, hint? }[]`. Before startup, the previous list (a cached copy). Empty without `missionId` or without a cached copy |
| `commandsLive` | Whether `commands` is the latest list received from a running session |

When `missionId` is given, the status is determined for that mission only. When omitted, it spans all missions.

## Conversations with the Crew

| Method and path | Description |
|---|---|
| `POST /api/crew/:role/message` | The captain sends a message to a crew member (the same entry point for every role). Body `{ text, missionId? }` |
| `POST /api/crew/:role/report` | Sends `report` to a crew member (the crew member reports the unreported tasks it can see). Body `{ missionId? }` |
| `POST /api/a2ui/:itemId/answer` | The captain pressed a button of the A2UI form shown under a reply (see `render_ui`). `itemId` is the id of that reply. The server sends the A2UI action to the crew member who showed it (a fenced block marked `a2ui-action` holding the A2UI v1.0 action message, then the captain's comment if there is one) and records it as the answer to that form (`ui_answered`; not as a message of the captain's). Body `{ action, dataModel?, comment? }`: `action` is the action the A2UI renderer reports (`name`, `surfaceId`, `sourceComponentId`, `timestamp`, `context`; any other field is dropped; `surfaceId` must be the surface the form made), `dataModel` is the values of that surface at that moment (kept to show the form as it was), and `comment` is what the captain wrote in the form's comment field. Returns `202` with `{ messageId, status: "accepted" }`. `404` for a reply with no form, `400` for a malformed action or a surface the form did not make, `409` (`form_closed`) if the form was already answered or closed, `429` while the mission is busy |
| `POST /api/a2ui/:itemId/dismiss` | The captain closes the form without answering it (`ui_dismissed`). Nothing is sent to the crew member; the reply keeps a mark saying it was closed. No body. Returns `200` with `{ status: "dismissed" }`; `404`/`409` as above |
| `POST /api/bridge/cancel` | Stops the in-progress turn of that mission. Body `{ missionId? }` |

- While the mission has an open A2UI form (see `render_ui`), `message` and `report` are refused with `409` (`form_open`): the captain answers it, or closes it without answering, first.
- `message` and `report` return `202` (`{ messageId, status: "accepted" }`) once accepted, and the reply arrives over SSE.
- They fail in the following cases.

| Status | Condition |
|---|---|
| `400` | `text` is missing or not a string (`message` only) |
| `404` | The role or the mission does not exist |
| `429` | That mission is still processing a previous message (**concurrency is per mission**; other missions are accepted) |
| `500` | An exception while sending |

- `cancel` requests a stop (it sends a cancel if there is a session, aborts startup if the session is still starting, and force-kills if things have not finished after a 15-second grace period). Response `{ status: "ok", message: "Cancel sent" }`. Returns `409` if there is no turn in progress. A failure after the stop is recorded as "cancelled", not as an error.

## Missions

| Method and path | Description |
|---|---|
| `GET /api/missions` | List of missions (all of them, including archived ones). `{ id, name, createdAt, archivedAt }[]` |
| `POST /api/missions` | Create. Body `{ name, id? }` (if `id` is omitted, one is assigned automatically; leading and trailing whitespace is trimmed from the name). Returns the created mission with `201`. A missing or empty `name` returns `400`; a duplicate `id` returns `409`. `id` must be 1 to 64 characters, starting with an alphanumeric character, consisting only of alphanumerics and `.`, `_`, `-`, `:` (anything else returns `400`) |
| `PATCH /api/missions/:id` | Archive or restore. Body `{ archived: boolean }`. Returns the mission. `400` if `archived` is not a boolean, `404` if the mission does not exist |

- Archiving is not deletion; it only toggles whether the mission appears in the list (`archivedAt` being `null` means it is shown).
- Mission changes are not broadcast over SSE (the calling client updates its list from the response).

## Timeline

The **single source of truth** for chat content. Persisted history and in-progress items are returned in the same shape (`TimelineItem`).

| Method and path | Description |
|---|---|
| `GET /api/timeline?missionId=&limit=` | Returns the most recent history plus in-progress items. Response `{ items, hasMore, openUiItemId }` (`openUiItemId` is the id of the reply that holds an A2UI form the captain has neither answered nor closed, or `null`) |
| `GET /api/timeline/captain-history?missionId=` | The captain's earlier messages in the mission, newest first, for the ↑ history of the input box. `{ items: [{ id, text, timestamp }] }`. Up to 20; a text appears once (its latest use), and the fixed messages the buttons and the custom menu send (`report`, `engage`, `make it so`, and the items that send at once) are left out |
| `GET /api/timeline/older?before=&missionId=&limit=` | Returns persisted history older than `before` (an item ID; the oldest one the client has). The position is determined by the pair of timestamp and ID, so events in the same millisecond are not missed. Response `{ items, hasMore }`. `400` if `before` is missing; `404` if the ID is not in that mission's history. If `limit` is not a positive integer, the default count is used |
| `GET /api/timeline/range?missionId=&after=&inclusive=&before=&dir=&limit=` | Returns the items between two items |

- `limit` defaults to 20.
- `range`: at least one of `after` and `before` is required (otherwise `400`, `range_unbounded`). `dir` is `asc` (from the older side) or `desc` (from the newer side; default `asc`), and `inclusive=1` includes the `after` item itself. `limit` defaults to 20 and is at most 100. If a given ID is not in that mission's history, the response is `404` (`item_not_found`). The response has `items` and `complete`, which indicates whether the range was read to the end.
- An item ID is one of: `event-<n>` (the captain's message or a notice), a turn ID, or a task ID.

### `TimelineItem`

| Field | Type | Description |
|---|---|---|
| `id` | string | Item ID (above) |
| `missionId` | string | The mission it belongs to |
| `role` | string | `captain`, or a crew member's role name |
| `text` | string | Body (Markdown) |
| `timestamp` | string | Time of occurrence (ISO format) |
| `status` | `streaming` \| `done` \| `error` | For in-progress items, or the state of a task or error. Absent on ordinary persisted messages |
| `cancelled` | boolean | A cancelled turn |
| `credits` | `{ credits, turnDurationMs, unit }` | Usage. `unit` is `usd` or `kiro_credits` |
| `taskName`, `instruction` | string | The name and instruction of a crew task. **An item with `taskName` is a task** (otherwise it is a conversation turn) |
| `turnId` | string | The turn that issued the task (tasks from the same turn are grouped into one card) |
| `reportMeta` | `{ tasks: { agent, taskId }[] }` | The tasks reported in this turn |
| `partialText` | string | For a turn or task marked "interrupted" because the server stopped, the text written up to that point (shown on the card with `messageKey: "interrupted"`) |
| `a2ui` | `{ state, messages, comment?, actionName?, locksInput? }` | The A2UI form a crew member showed under this reply (`render_ui`); only a reply that completed carries one. `state` is `open`, `answered` or `dismissed`; see [A2UI Forms](data-model.md#a2ui-forms) |
| `messageKey` | string | Key of a fixed message written by the server. The UI translates it with a dictionary. If absent, `text` is shown as is |

## Crew Personnel Records and Icons

| Method and path | Description |
|---|---|
| `GET /api/crew/:role/profile` | The personnel record. The server assembles and returns a summary of the settings (name, ID, rank, provider, permission mode, `cwd`, host), the persona, and the briefing (the full text sent at session start) |
| `GET /api/crew/:role/icon` | The icon image (`Content-Type` is an image type, `X-Content-Type-Options: nosniff`, `Cache-Control: no-cache`). `404` if there is none |
| `PUT /api/crew/:role/icon` | Saves the icon. The body is raw image bytes. Response `{ status: "ok", icon }` |
| `DELETE /api/crew/:role/icon` | Removes the icon (reverts to the default avatar). Response `{ status: "ok" }` |

- **Persona (`persona`):** `source` is `personnel` (the contents of the persona file that make-it-so injects), `agent` (the provider's agent definition; `status` is `found` / `not_found` / `remote`), or `none` (there is no persona file). The final prompt the provider actually uses cannot be obtained.
- **Briefing:** Built with the same function used for sending, every time it is opened. When it cannot be built (for example, a rules file cannot be read), `briefing` is `null` and the reason is in `briefingError`.
- **Icon validation (`PUT`):** Only PNG, JPG, WebP, and GIF are accepted (SVG is not). The format is determined from the leading bytes of the content. Over 1MB returns `413`; any other rejection (format, empty, invalid member ID) returns `400` (see `reason` in the response). The `icon` in `GET /api/crew` is a URL with a modification timestamp, so replacing the icon changes the URL.

## Tasks

| Method and path | Description |
|---|---|
| `GET /api/results/:taskId` | Details of one task. `{ text, status, taskName?, instruction?, credits?, cancelled?, missionId, timestamp }` (`cancelled` is `true` only for tasks the captain stopped; `text` is the output up to the stop). `taskId` may contain only alphanumerics, `_`, and `-` (anything else returns `400`). A task that does not exist or is not yet finished returns `404` |
| `POST /api/crew/:taskId/cancel` | Requests cancellation of a crew task. Response `{ status: "ok" }`. If it is running, it ends keeping the output up to the stop, marked `cancelled`. A task that is waiting in the queue or starting ends as `cancelled` without being run. A task that is in neither the queue nor running (for example, already finished) returns `404` |

## Pending Permissions (permission)

Pending requests while a crew member is asking for permission to run a tool.

| Method and path | Description |
|---|---|
| `GET /api/permissions` | `{ permissions: PendingPermission[] }` |
| `POST /api/permissions/:key/respond` | Answers a request. Body `{ optionId }`. Success is `{ status: "ok" }`. `400` if `optionId` is missing. A `key` that does not exist or is already resolved returns `404` (`{ status: "not_found" }`; **idempotent**: sending twice does not deliver twice). If the answer could not reach the waiting session (the session has already ended, or the request was already cancelled by a turn cancellation), it returns `409` (`{ status: "undeliverable" }`; the request disappears from the list) |

`PendingPermission`: `{ key, scope, missionId, ownerMissionId, role, requestId, taskId?, toolName, toolInput, options, receivedAt }`.

- `ownerMissionId` is the **real mission ID**, while `missionId` is the session's scope (during a task run it takes the form `__tasks__:<mission ID>`). `role` is the role name of the crew member waiting for approval. The UI uses these as they are.
- The answer is delivered to the **session** (crew member and mission) the request came from.

## PINs

| Method and path | Description |
|---|---|
| `GET /api/pins?missionId=` | List of pins (all missions if `missionId` is omitted). `{ messageId, role, text, timestamp, pinnedAt, missionId, isFloating }[]` |
| `POST /api/pins` | Pin a message. Body `{ messageId, role, text, timestamp, missionId }` (all required). `201`. A mission that does not exist returns `404` |
| `DELETE /api/pins/:messageId` | Unpin. `204` |

- `role` is `captain` or the role name of one of the ship's crew (anything else returns `400`). `isFloating` is a field kept for compatibility and is always `true`.
- A message that is already pinned returns `409`. Unpinning a pin that does not exist returns `404`.

## Search

`GET /api/search?q=&missions=&from=&to=&captain=&replies=&tasks=&limit=`

| Parameter | Description |
|---|---|
| `q` | The search terms (**required**). AND across terms separated by whitespace (including full-width spaces). Substring match, case-insensitive |
| `missions` | Mission IDs to search (comma-separated). All missions if omitted |
| `from`, `to` | Period (ISO date-time). `from` is inclusive and `to` is exclusive. An invalid value returns `400` |
| `captain`, `replies`, `tasks` | Whether to include the captain's messages, crew replies, and tasks (instructions and reports). By default, all are included |
| `limit` | Upper bound on the number of results returned. Default and maximum are both 500 |

The response is in newest-first order.

```json
{ "total": 12, "truncated": false, "hits": [
  { "id": "event-3", "missionId": "bridge", "missionName": "Bridge", "role": "captain",
    "kind": "captain", "timestamp": "2026-11-15T00:00:00.000Z",
    "snippet": { "text": "…", "ranges": [[4, 9]], "cutStart": false, "cutEnd": true },
    "matchedIn": null } ] }
```

- `total` is the total number of matches ignoring the limit, and `truncated` indicates whether the results were cut off by the limit.
- `kind`: `captain` (the captain's message), `reply` (a reply), `task` (a task). For a task, `matchedIn` is `report` (the report) or `instruction` (the instruction).
- `snippet.ranges` are the matched ranges within the excerpt (`[start, end)`). `cutStart` and `cutEnd` indicate whether the beginning and the end were trimmed.
- The search covers the captain's messages, replies, and task instructions and reports. Errors, cancellations, and system notices are excluded.

## Memory (viewer)

The read-only side of the ship's Memory (see the [guide](../guides/memory.md)). The crew writes it through the MCP tools below; there is no route that changes it.

| Method and path | Description |
|---|---|
| `GET /api/memory/tree?dir=&draft=&deprecated=` | What is directly in one directory (`dir` is `""` for the root): `{ dir, dirs: { name, path, count }[], docs: MemorySummary[] }`. `count` is the number of memos under that directory (at any depth). Stable memos are always listed; `draft=0` and `deprecated=0` leave those out |
| `GET /api/memory/doc?path=` | One memo: the summary fields, `frontmatter` (the YAML as it is in the file), `body` (the Markdown as it is written; the viewer reads a relative link against the path of the memo it shows), and `version`. An unknown memo, or a path that is not valid, returns `404`; a path that goes through a link returns `400` |
| `GET /api/memory/history?path=&limit=&diff=` | The changes of the Memory, or of one memo when `path` is given, newest first: `{ commit, message, author, at, diff? }[]`. `message` is the crew member's sentence and `author` the crew member. `limit` is 20 by default and at most 100. `diff=1` adds the diff of each change (cut when it is large). `400` for a path that is not a path of the Memory. The viewer does not use it yet |
| `GET /api/memory/search?q=&draft=&deprecated=&limit=&offset=` | Searches titles, descriptions, tags and bodies (every word must match, up to the first 32 words, and the first four of one or two characters; Japanese works). `{ total, items: MemorySummary[] }`; `limit` is 20 by default and at most 100 |

- `MemorySummary` is `{ path, type, title, description, tags, status, supersededBy?, crew?, updatedAt? }`; `status` is `draft`, `stable` or `deprecated`.
- A `dir` that is not a safe directory name of the Memory returns `400`. `supersededBy` is a path from the root of the Memory, or absent when what the crew wrote is not one.
- A path is checked on the server at every entry (reading, writing, deleting, listing, history), whatever the viewer or crew member sends: it must be relative, end with `.md`, and have no `.` or `..` name, no name that starts with a dot or ends with a dot or space, none of `\ # ? % : * " < > |` or control characters, no Windows device name (`con`, `nul`, ...), and no symbolic link along it; `index.md` and `log.md` are reserved. It also may not differ from an existing path (or one of its directories) only by letter case. A path that fails is `404` for a memo and `400` for a directory.

## Models

| Method and path | Description |
|---|---|
| `GET /api/missions/:missionId/crew-models` | The model of each crew member. `{ role, name, options, effective, source, live }[]`. `404` if the mission does not exist |
| `PUT /api/missions/:missionId/crew-models/:role` | Changes the crew member's model for that mission. Body `{ model: string \| null }` (`null` clears the override). Returns the updated entry |

- `options`: the models that can be chosen, `{ value, name }[]` (if empty, switching is not supported or no session has been created yet). `effective`: the model determined by the configuration. `source`: `mission` (changed for this mission), `config`, or `default`. `live`: the model the running session is actually using.
- Order of precedence: mission override > `ship.yml` > `roster.yml` > the provider's default.
- Errors: `404` if the mission or role does not exist; `400` if `model` is invalid (an empty string, or neither a string nor `null`); `400` for a model that cannot be chosen; `409` (`model_unavailable`) for a crew member whose model cannot be chosen (unsupported, or no session created).
- It is also applied to a running session (from the next turn if a turn is in progress). Even if applying it fails, saving still succeeds.

## Agents and Debugging

| Method and path | Description |
|---|---|
| `GET /api/agents` | List of all crew members. `{ name, status, currentTaskId }[]` (`name` is the role name; `currentTaskId` is the ID of the running task, or `null` if none) |
| `POST /api/agents/:role/restart` | Recreates that crew member's session for the mission. Body `{ missionId? }`. Success is `{ status: "ok", message }` |
| `POST /api/debug/simulate-error` | Causes an error (RPC -32603) on the next prompt to trigger automatic recovery. Enabled **only when `debug: true`** (otherwise `404`) |

- Restart: `409` (`agent_busy`) if the crew member is in a conversation or running a task, and also `409` if it is starting or restarting. `404` if the role or mission does not exist. Failure is `500`.

## SSE (Server-Sent Events)

| Endpoint | Events received |
|---|---|
| `GET /api/events/bridge` | All events for the UI (chat) (table below) |
| `GET /api/events` | All events |

- Format: `id: <sequence number>`, `event: <type>`, `data: <JSON>`. A `: connected` comment is sent on connection. A heartbeat (a comment line) is sent every 15 seconds.
- On reconnection, the client does not try to replay missed events; it re-fetches the snapshot from `GET /api/timeline`.
- **Events for all missions flow on the same channel.** The client discards events whose `missionId` differs from the mission currently open (`crew:status_changed` is accepted regardless of mission).

| Type | Data | Description |
|---|---|---|
| `timeline:upsert` | `TimelineItem` | Create an item, or replace it entirely (including changes other than text) |
| `timeline:append` | `{ id, text }` | A body delta during streaming. Appended to the body of the item with that `id` |
| `timeline:remove` | `{ id }` | Remove an item (only when it turned out there was nothing to display after all) |
| `timeline:activity` | `{ id, activity }` | The "operations" (tool calls and the beginning of their output) of an in-progress item changed. Replaces the `activity` of the item with that `id` (the body is unchanged). Batched and sent at most about once every 0.4 seconds |
| `credits:usage` | `{ accounts, untracked }` | Per-account usage (see below) |
| `permission:requested` | `PendingPermission` | A pending permission appeared |
| `permission:resolved` | `{ key }` | A pending permission was resolved |
| `crew:status_changed` | `{ role, missionId }` | A signal that starting or restarting of a conversation session began or ended. On receiving it, re-fetch `GET /api/crew/status` |
| `memory:changed` | `{}` | A signal that the ship's Memory changed. On receiving it, a Memory pane that is open fetches again what it shows |

The type definitions also include `task:progress`, `task:complete`, `notification:*`, and `log`, but the client does not use them.

`accounts` in `credits:usage` is `{ key, provider, label, plan?, usage, crews }[]`. `usage` is `{ usedPercent, resetsAt, label?, secondary? }` or `null` (not yet obtained), and `crews` are the display names of the crew members running on that account. `untracked` holds the display names of crew members whose account could not be identified and so are not counted (crew members on remote hosts).

## MCP Board

`POST /mcp` (a body of up to 8 MB). It is served on its own listener, not on the ship's port: `127.0.0.1` only (whatever `server.host` is) and a port the OS picks at each start. The sessions are given its URL. A built-in MCP server that crew sessions use to delegate tasks and fetch reports (stateless mode; a server is created and discarded for each request).

| Tool | Description |
|---|---|
| `dispatch_task(agent, task_name, instruction)` | Delegates a task to a crew member. `agent` is a role name or a roster member ID. Only a short notice is actually sent; the full instruction is recorded in the DB and the assignee reads it with `get_task`. **Only crew members whose rank is `commander` or `chief`** can use it (for anyone else, the server rejects it) |
| `get_task(taskId)` | Fetches a task's instruction (and its result, if it is finished) |
| `get_skill(name)` | Fetches the body of a skill announced to the caller (the file without its frontmatter). Only the skills announced to that crew member are returned, so it cannot be used to read other files; an unknown name returns an error that lists the names available to the caller. Only the text of the skill is given, not the files it mentions beside it. It is how a remote host crew member, who cannot read the skill files, uses a skill |
| `search_memory(query?, type?, tags?, status?, path?, limit?, offset?)` | Lists and searches the ship's Memory. Every word of `query` must match (titles, descriptions, tags and bodies; Japanese works). Returns `{ total, items }` with the path, type, title, description, tags and status of each memo |
| `read_memory(path)` | Reads one memo: its fields, its body and its `version` (the git blob id of the file) |
| `write_memory(path, type, description, body, message, title?, tags?, status?, base?)` | Creates or updates a memo. `type` and `description` are required, and so is `message`, the change in a sentence (the commit message). Updating an existing memo needs `base`, the `version` that was read; a missing or stale `base` is refused with the memo as it is now. Leaving out `tags` or `status` on an update keeps them. It succeeds with a warning past 1 MB of body or 50,000 memos. Every crew member can use it (there is no rank check) |
| `deprecate_memory(path, message, superseded_by?)` | Marks a memo `deprecated` (it stays, and is shown as such); `superseded_by` is the path with a leading `/` of what replaces it |
| `delete_memory(path, message)` | Deletes a memo (the history keeps it) |
| `get_memory_history(path?, limit?, diff?)` | The change history, newest first (default 20, at most 100): the commit, message, author (the crew member) and time. With `path` it is that memo's, deleted ones included, and `diff: true` adds what each change did (cut at 20,000 characters) |
| `render_ui(messages)` | Shows an interactive form to the captain under the crew member's reply: `messages` are A2UI v1.0 messages (the basic catalog), self-contained and making exactly one surface, starting with `createSurface`. They are checked with the strict rules the A2UI library offers (an unknown component type, a missing root, a reference to a component that does not exist, an orphan, a wrong version or several operations in one message are refused); on a mistake nothing is shown and the error is returned. The description of the tool carries a complete example. It can be used only in a reply to the captain (not while working on a delegated task), once per reply. It returns at once, and the form appears when the reply ends. While the form is open, the captain can send nothing else in that mission; when they press a button, the crew member receives the A2UI action message (`{ "version": "1.0", "action": { name, surfaceId, sourceComponentId, timestamp, context } }`) in a fenced block marked `a2ui-action`, then the captain's comment from the form's comment field if they wrote one (once per form). A form is recorded (`ui_shown`) and stays after a restart |
| `list_unreported_tasks()` | Returns the unreported tasks as formatted text. The commander gets all of them; anyone else gets only the ones they issued. The IDs at the time of the call are recorded as "this report's targets", and they become reported once the turn completes normally |

- **Secret:** A call must carry the header `x-makeitso-token`, whose value is derived at each start for one agent and mission and put into that session's MCP configuration, next to the identification headers naming the same agent and mission. Without it (or with a wrong one, or one made for another agent or mission), `/mcp` returns `401` `{ "error": "unauthorized" }` before any tool runs.
- **Identifying the caller:** The caller's (crew member, mission) is determined from the HTTP headers `x-makeitso-agent` and `x-makeitso-mission`, which are put into that session's own MCP server configuration when the session is created. The model's self-report is not relied on. A call without the headers is refused with `401` before any tool runs.
- Task IDs are per-role sequence numbers (for example, `chief_engineer_0001`).

## The desktop app's own path

In the desktop app the page's requests are answered by the ship's Express app through an in-memory connection, with one exception: the paths under `/__shell/` are answered by the app around the page and never reach the ship (they are deliberately outside the router pattern: they are about the window, not the ship). Outside the desktop app nothing answers them and the page does not ask. For both, anything but a `POST` gets `405`, and a body that is not understood gets `400`.

- `/__shell/window`: the page sends a `POST` with `{ height, room }` (the header's height, and the room it keeps at both ends, in CSS pixels; two integers) and gets `{ zoom }` back (the page's zoom, which the app knows exactly). The app uses them to keep the window wide enough on every system and, on macOS, to put the window buttons in the middle of the header.
- `/__shell/appearance`: the page sends a `POST` with `{ theme, language }` and, from a page that has a crew, `crewLanguage` (`theme`: `classic` / `light` / `dark`; the languages: `en` / `ja`) and gets `204`. It tells the app what the page shows now, so that the View menu marks it. The other way, from the app to the page, is not a request: a choice in the View menu is sent to the page as a `makeitso:appearance` event, which the page applies as it applies its own switches.

## Settings Server API (`--settings`)

The API of the settings server (default `http://127.0.0.1:3938`). It is an **internal API** used by the UI (the settings screen), and compatibility is not promised. The `Host` and `Origin` checks from [Common Conventions](#common-conventions) apply in the same way. Saving endpoints write only the fields that changed; if there is any error, nothing is written and a per-field error (a message key) is returned with `400`. A file that cannot be read as YAML is not overwritten and returns `409`.

| Method and path | Description |
|---|---|
| `GET /api/settings/overview` | The directories, whether each file exists, the number of personas, and the list of ships |
| `GET /api/settings/config`, `PUT /api/settings/config` | Get and save the fields and values of `config.yml`. Body `{ values }` |
| `GET /api/settings/hosts`, `PUT /api/settings/hosts` | Get and save the hosts in `hosts.yml`. Body `{ hosts: [{ name, destination }] }` |
| `GET /api/settings/quick-actions`, `PUT /api/settings/quick-actions` | Get and save the items of `quick-actions.yml` and the ships to choose from (`{ actions, ships: [{ id, name }] }`). Body `{ actions: [{ id?, name, kind, command, send, ships }] }`, where `ships` is `"all"` or a list of ship IDs |
| `GET /api/settings/roster`, `POST /api/settings/roster` | Get the roster and add a member (body `{ id, name, provider?, model?, permission_mode?, rules?, skills? }`) |
| `PUT /api/settings/roster/:id`, `DELETE /api/settings/roster/:id` | Save and delete a member (invalid input is `400`; a member that does not exist is `404`; a member assigned to a ship is `409` (returns `usedBy`)) |
| `GET /api/settings/roster/:id/persona`, `PUT /api/settings/roster/:id/persona` | Get and save the persona (`personnel/{id}.md`). Body `{ text }` |
| `GET /api/settings/roster/:id/icon`, `PUT /api/settings/roster/:id/icon`, `DELETE /api/settings/roster/:id/icon` | The icon. The `PUT` body is raw image bytes (the format is determined from the leading bytes; up to 1MB; `413`) |
| `GET /api/settings/ships/:id` | The ship's settings (`fields`) and the form's choices (`options`). `404` if it does not exist |
| `POST /api/settings/ships` | Creates a minimal ship. Body `{ id, port, name?, member }` |
| `PUT /api/settings/ships/:id` | Saves the ship's settings. Body `{ fields }`. Goes through the same validation as at startup |
| `DELETE /api/settings/ships/:id` | Deletes the ship along with its directory. The body `{ confirm: "<ship ID>" }` is required (`400`). A running ship returns `409`, and so does a ship whose `ship.yml` cannot be read |
| `GET /api/settings/runtime` | `{ ships: [{ id, port, state, pid?, url, devCommand }], shipUi, desktop }`. `state` is `running`, `stopped`, or `conflict`. `desktop` is `true` in the desktop app's settings: a ship has no screen address there (`url` is `null`) and opens in a window; a ship open in a window, or running in the browser version, counts as `running` (the settings of the browser version count a ship open in the desktop app the same way) |
| `POST /api/settings/ships/:id/start`, `POST /api/settings/ships/:id/stop` | Start and stop a ship (as an independent process). Start returns `404` for a ship that does not exist, and `409` for a running ship, a simultaneous start, a port conflict, or a ship without a port |
| `GET /api/settings/ships/:id/log` | The tail of the ship's standard output (`{ text }`) |
| `POST /api/settings/import/scan` | Reads an existing project and returns drafts (writes nothing). Body `{ path }`. Response `{ dir, isDirectory, found, drafts }` |
| `POST /api/settings/import` | Saves the drafts (after edits). New roster members and the ship are saved together in one go, and rolled back if rejected. Failure is `400` (`errors: { ship, members }`) |
| `GET /api/config` | The UI language (`{ language, crewLanguage }`, from `config.yml`) |

## Error Codes

When `error` is one of the following codes, the UI translates it with the dictionary (`error.<code>`). If there is no code, or it is not in the dictionary, `message` is shown.

| Code | Status | Description |
|---|---|---|
| `agent_busy` | 409 | Cannot restart because the crew member is working (in a conversation or running a task) or is starting or restarting |
| `model_unavailable` | 409 | The model for this crew member cannot be chosen (unsupported, or the session has not been created yet) |
| `form_open` | 409 | A form a crew member showed is waiting for the captain, so a message or a report cannot be sent until it is answered or closed |
| `form_closed` | 409 | The form was already answered or closed |
| `invalid_language` | 400 | Unsupported language |
| `range_unbounded` | 400 | `timeline/range` has neither `after` nor `before` |
| `item_not_found` | 404 | The item given to `timeline/range` is not in that mission's history |

Any other error is `{ "error": "<English message>" }`, and the message is displayed as it is.
