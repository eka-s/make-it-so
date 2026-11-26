[日本語](configuration.ja.md)

# Configuration Reference

A list of make-it-so's configuration files, startup arguments, and directory layout. For the ideas behind the configuration, see [Concepts](../concepts.md); for procedures, see the [Guides](../guides/).

## Contents

- [Configuration structure](#configuration-structure)
- [Configuration file location](#configuration-file-location)
- [Startup arguments](#startup-arguments)
- [`config.yml`](#configyml)
- [`roster.yml`](#rosteryml)
- [`ship.yml`](#shipyml)
- [`hosts.yml`](#hostsyml)
- [`quick-actions.yml`](#quick-actionsyml)
- [Persona files and icons](#persona-files-and-icons)
- [Rule and skill files](#rule-and-skill-files)
- [Directory layout](#directory-layout)
- [Startup validation and errors](#startup-validation-and-errors)

## Configuration structure

| File | Location | Scope | Contents |
|---|---|---|---|
| `config.yml` | `~/.make-it-so/` (optional) | Common to all ships | Language, provider launch commands, logging |
| `roster.yml` | `~/.make-it-so/` | Fleet (common to all ships) | The crew roster (ID, display name, provider, etc.) |
| `hosts.yml` | `~/.make-it-so/` | Fleet | Destinations of remote hosts (optional) |
| `quick-actions.yml` | `~/.make-it-so/` | Fleet (each item names its ships) | The custom menu of the message box (optional) |
| `ship.yml` | `~/.make-it-so/ships/{ship ID}/` | Per ship | Port, ship name, role assignments, rules, working directory |

All of them are YAML. If a required setting is missing, startup stops with an error instead of silently falling back to a default ([Startup validation and errors](#startup-validation-and-errors)).

## Configuration file location

All configuration lives in `~/.make-it-so/` in the home directory (this is the fleet itself; see [Directory layout](#directory-layout)). The location is fixed; there is no setting or environment variable to change it.

- `config.yml` **is not required** (defaults are used).
- A ship (`~/.make-it-so/ships/{ship ID}/ship.yml`) and the roster (`roster.yml`) are required. If they are missing, startup stops with an error.
- To use a different location (development, testing), start with `HOME` replaced.

## Startup arguments

| Argument | Description |
|---|---|
| `--ship <ship ID>` | The ship to start (the name of a directory under `~/.make-it-so/ships/`). `--ship=<ship ID>` also works. Can be omitted when there is only one ship. If there are several and it is omitted, an error lists the candidates |
| `--settings` | Starts the **settings server** instead of a ship. It edits the contents of `~/.make-it-so/` in the browser. Cannot be combined with `--ship` |
| `--all` | Starts **every ship that is not running** among those in `~/.make-it-so/ships/`, each as an independent process, and then exits (ships that are already running are left alone). It prints the result per ship (`started` / `running` / `conflict` / `no_port`), and the exit code is 1 if there is, for example, a ship whose port is used by something else (`conflict`). Cannot be combined with `--ship` or `--settings` |
| `--port <number>` | The settings server's port when used with `--settings` (default `3938`). Cannot be specified without `--settings` (a ship's port is in `ship.yml`) |

- Examples: `npm start -- --ship alpha`, `npm run dev -- --ship alpha`, `npm start -- --settings`.
- The settings server has no authentication, so it listens on `127.0.0.1` only (there is no setting to change this).
- Configuration is determined only by files (`config.yml`, `ship.yml`, etc.) and these arguments. **The server reads no environment variables** (overriding a ship's port or root through environment variables could accidentally break the separation of per-ship data).
- The build-time environment variable `VITE_API_BASE` (the client's connection target) **cannot be used**, because the server rejects calls from other origins ([Security](../security.md)). The screen always connects to the server of the same origin.

## Settings screen (`--settings`)

`npm start -- --settings` starts the settings server (default `http://127.0.0.1:3938`), where you can edit the contents of `~/.make-it-so/` in the browser.

| Tab | What you can do |
|---|---|
| Overview | Whether the directory and each file exist, the number of personas, and the list of ships (read-only) |
| Config | Edit every item in the [table below](#configyml) with a form |
| Remote hosts | Add, change, and delete hosts in `hosts.yml` |
| Custom menu | Edit the items of `quick-actions.yml` and choose the ships each item is enabled on |
| Roster | Add, change, and delete members in `roster.yml`, edit personas (`personnel/{ID}.md`), upload icons |
| Ships | Add a ship (a minimal ship: one commander role) and edit `ship.yml` (port, name, working directory, rules, skills, targets, role assignments). **Start and stop** ships and show their status |
| From a project | Read an existing project, create a draft of the roster and a ship, and save after you confirm it ([below](#creating-a-ship-from-an-existing-project)) |

- The settings screen's language is switched with "EN | 日本語" in the header. The chosen language is saved **only in this browser**; it is written neither to the ship's DB nor to `config.yml`. When none has been chosen yet, it follows `language` in `config.yml` (English if unset).
- Saving rewrites **only the items you changed**. Comments, key order, and unknown keys are left as they are. The file before saving is kept as `.bak` (one generation).
- An item set to the same value as its default is **removed** from the file (to keep the file short).
- If the input contains errors, nothing is written and an error is returned for each item. If the file cannot be read as YAML, it is not overwritten and you are told so.
- A host that a ship uses can be neither deleted nor renamed.
- Saving a ship goes through **the same validation as at startup** (duplicate ports, nonexistent files or directories, two `commander`s, undefined hosts or members, `cwd` and `access` of remote crew members, etc.). Errors are shown per item and nothing is written. A ship's target paths must be existing directories.
- **Deleting a ship:** "Delete this ship" at the bottom of a ship's screen removes the whole ship directory (everything the ship had: configuration, DB, logs, etc.). **This cannot be undone.** A running ship cannot be deleted (stop it first), and you must type the ship's ID to confirm. Roster members remain. A ship whose `ship.yml` cannot be read cannot be deleted from the screen, because it is impossible to check whether it is running (fix the file, or delete the directory by hand).
- **Starting and stopping ships:** The settings server starts a ship as an independent process (run the same way as the settings server, with `--ship` added). **Ships keep running even if you close the settings server.** Whether a ship is running is checked with `GET /api/health` on the ship's port (it returns `shipId` and `pid`). That is why ships started by hand can also be found and stopped. Stopping sends `SIGTERM` to that `pid`. If something else is using the port, it neither starts nor stops. The output of a ship that was started is kept in `ships/{ship ID}/logs/stdout.log` (viewable on the screen).
- A member that a ship has assigned cannot be deleted. Even if you delete a member, the persona and icon files remain. An ID cannot be changed after creation (because it becomes a file name).
- As at startup, rule and skill files accept only existing files. Saving with an empty persona deletes the file (the original file remains as `.bak`).
- Changes take effect on a ship **the next time it starts** (a running ship needs a restart).

### Creating a ship from an existing project

When you specify the directory of a project that already has agent settings, the "From a project" tab creates a draft of the roster and a ship from it. It works even if `~/.make-it-so/` does not exist yet (it is created on save). If you already use make-it-so, this is for adding another project as a new ship.

What it reads:

| Provider | Agent definitions | Model and permission mode | Rule candidates | MCP (report only) |
|---|---|---|---|---|
| claude | `.claude/agents/*.md` (`name` in the frontmatter; the file name if absent) | `model` and `permissions.defaultMode` in `.claude/settings.json` and `settings.local.json` (the latter takes precedence) | `CLAUDE.md` | `.mcp.json` |
| kiro | `.kiro/agents/*.json` and `*.md` (`name`; the file name if absent) | `model` in the agent definition | `.kiro/steering/*.md` | `.kiro/settings/mcp.json` |

The kiro reader was built to the specification and has not yet been verified on a real machine.

Contents of the draft:

- **One roster member per agent definition.** If there are no definitions, a single generic member (`lead`) is created.
- **Agent definitions are not copied.** A role refers to them by name through `agent`, and the working directory (`cwd`) is the project. If you edit a definition, the change is reflected in the original project as it is.
- **Everyone is `chief`.** When a commander is needed, you pick one on the screen.
- **The ship's ID and name come from the project's folder name.** The port is a number that no other ship uses (from 3939). The project goes into `targets`, and everyone is in charge of it with `readwrite`.
- **If the roster already has a member with the same ID** (and the same provider), the default is to use the existing member. If the provider differs, a different ID is used.
- **MCP such as `.mcp.json` is not imported.** It would widen what the crew can do, so you are only told that it was found.
- **`bypassPermissions` (the permission mode that skips all confirmations) is not imported.** You are only told about it.
- **Rule candidates are not added to the ship by default.** They are files the provider reads itself, so this avoids passing them twice. If needed, you choose them on the screen.

Saving writes the new roster members and the ship together in one go. If any one of them fails validation, the roster is restored to its original contents (to not existing, if the file did not exist) and nothing is left behind.

## `config.yml`

Settings common to make-it-so itself. A template is in the repository at [`config.sample.yml`](../../config.sample.yml).

| Key | Type | Default | Description |
|---|---|---|---|
| `language` | `en` \| `ja` | `en` | The UI language. A value changed on the screen is saved in the ship's DB and takes precedence over this |
| `crew_language` | `en` \| `ja` | same as `language` | The language the crew speaks. A value changed on the screen is saved in the DB and takes precedence over this |
| `theme` | `classic` \| `light` \| `dark` | `classic` | The default look of the screen. A choice made in the "Settings" section of the left pane (or the View menu in the desktop app) is kept in that browser and takes precedence over this |
| `acp.provider` | `kiro` \| `claude` | `claude` | The default provider for crew members whose provider is not specified in `roster.yml` |
| `acp.kiro.command` | string | `kiro-cli` | The launch command for kiro |
| `acp.kiro.args` | array of strings | `["acp"]` | The launch arguments for kiro |
| `acp.claude.command` | string | `npx` | The launch command for claude |
| `acp.claude.args` | array of strings | `["--yes", "@agentclientprotocol/claude-agent-acp@0.106.0"]` | The launch arguments for claude (the adapter version is pinned) |
| `server.host` | string | `127.0.0.1` | The host to listen on. There is no authentication, so change it only after understanding the [security notes](../security.md). **Access it by IP address or `localhost`** (a `Host` with any other name gets `403`; using a name is not supported in v0.1) |
| `debug` | boolean | `false` | Enables the debug route (`POST /api/debug/simulate-error`) |
| `logging.level` | `debug` \| `info` \| `warn` \| `error` | `info` | Logs below this level are output neither to the console nor to the file |
| `logging.maxFileSizeMb` | number | `5` | The log file size limit. When exceeded, `app.log` is moved to `app.log.1` (only one generation is kept) |

- The `config.yml` that `init` creates contains `language` and `acp.provider`.
- An unsupported `language` / `crew_language` / `theme` value is an error.

## `roster.yml`

The fleet's crew roster. The key (the member ID) becomes the name of the persona file and icon.

```yaml
crew:
  alex:
    name: "Alex"
    provider: "claude"
  sam:
    name: "Sam"
    provider: "claude"
    model: "sonnet"          # model only takes effect for claude crew members (kiro cannot change models)
    rules: [personnel/sam-rules.md]
```

| Key (`crew.<ID>.`) | Type | Default | Description |
|---|---|---|---|
| `name` | string | **required** | The display name shown in the UI |
| `provider` | `kiro` \| `claude` | `acp.provider` | This member's provider. **This is the only place to specify the provider** (it cannot be overridden in `ship.yml`) |
| `model` | string | not specified | This member's default model (a value from ACP's model options, e.g. `opus`, `sonnet`). The value in `ship.yml` takes precedence |
| `permission_mode` | string | not specified | Permission mode. The value in `ship.yml` takes precedence |
| `rules` | array of strings | none | Rule files tied to this member (paths relative to `~/.make-it-so`). Effective no matter which ship the member is assigned to |
| `skills` | array of strings | none | Skill files tied to this member (relative to `~/.make-it-so`) |

- A member ID starts with `[A-Za-z0-9]` and consists only of alphanumerics, `_`, and `-` (because it becomes the name of the persona file and icon).

## `ship.yml`

Per-ship settings. One directory (`~/.make-it-so/ships/{ship ID}/`) is one ship, and only directories that have a `ship.yml` are treated as ships.

```yaml
port: 3939
name: "My Ship"
rules: [rules/working-agreement.md]
targets:
  app: /path/to/your/project
crew:
  first_officer:
    member: alex
    rank: commander
  chief_engineer:
    member: sam
    rank: chief
    access:
      app: readwrite
  ensign:
    member: jo
    permission_mode: default
```

### Ship settings

| Key | Type | Default | Description |
|---|---|---|---|
| `port` | integer | **required** | This ship's HTTP port. Use a **different value for each ship** (a duplicate is an error at startup) |
| `name` | string | the ship's ID | The ship's name shown in the UI |
| `cwd` | string | the ship's root | The ship-wide working directory (a relative path is relative to the ship's root; must be an existing directory) |
| `rules` | array of strings | none | Rule files whose full text is injected to all crew in the ship (relative to the ship's root) |
| `skills` | array of strings | none | Skill files announced to all crew in the ship (relative to the ship's root) |
| `targets` | map of `name: path` | none | A named set of directories the ship is in charge of. Referenced by the crew's `access` |
| `crew` | role name → assignment | **required (at least one)** | Role definitions. A role name consists of alphanumerics, `_`, and `-` (starting with an alphanumeric); otherwise it is free |

### Role assignment (`crew.<role name>.`)

| Key | Type | Default | Description |
|---|---|---|---|
| `member` | string | **required** | A member ID from `roster.yml`. If it is not in the roster, **startup stops with an error** (so that a typo does not silently make a role disappear) |
| `rank` | `commander` \| `chief` \| `crew` | `crew` | Rank. Determines permissions regarding tasks (table below). At most one `commander` per ship |
| `model` | string | the roster's value | The model used for this role (takes precedence over the roster) |
| `permission_mode` | string | the roster's value | Permission mode (takes precedence over the roster) |
| `cwd` | string | the ship's `cwd` | This crew member's working directory. Independent of where the persona comes from |
| `agent` | string | none | The name of an agent definition on the provider side. When specified, that definition becomes the persona, and `personnel/{ID}.md` is not injected |
| `access` | `target name: readonly \| readwrite` | none | Which of the `targets` this member is in charge of, and with what permission. A target that is not listed is outside the member's scope |
| `host` | string | none | A host name from `hosts.yml`. When specified, that crew member runs on the remote host. `cwd` is required |

Ranks:

| Rank | Issuing tasks (`dispatch_task`) | Tasks that can be handled in reporting (`list_unreported_tasks`) |
|---|---|---|
| `commander` | Allowed | **All** in the ship |
| `chief` | Allowed | Those **they issued themselves** |
| `crew` | Not allowed (the server rejects it) | Cannot see any |

- The default conversation target (the one the captain talks to first) is the `commander` crew member. If there is none, it is the crew member written first under `crew:`.
- The permission mode (`permission_mode`) is applied as a provider setting right after the session is created. The claude values are `default` (confirm every time), `acceptEdits`, `plan`, `auto`, and `bypassPermissions`. For a value that cannot be chosen, or for a provider that does not support it (kiro), a warning is output and it runs with the default.
- If the old name `profile` is written, startup stops with an error that urges renaming it to `agent`.
- `targets` with `access` is **an agreement made in the prompt** (not technical access control). For details, see the [security notes](../security.md).
- Remote host crew members (with `host`) cannot specify `access` (it is an error). `skills` are announced by name and description only, and the crew member reads the body with the `get_skill` tool.

## `hosts.yml`

A table of remote host destinations (optional).

```yaml
hosts:
  dev-server:
    destination: dev-server   # a Host name in ~/.ssh/config, or user@host
```

| Key | Type | Description |
|---|---|---|
| `hosts.<name>.destination` | string | A Host name in `~/.ssh/config`, or `user@host`. Empty strings, values containing whitespace, and values starting with `-` (ssh option injection) are rejected |

- `destination` is the only key you can write. Connection details such as key paths, ports, users, and host key handling go in each PC's `~/.ssh/config`. An unknown key produces an error that points to where it should be moved.
- If there is no `hosts.yml`, remote crew members cannot be used (it is an error if `ship.yml` refers to `host:`).

## `quick-actions.yml`

The custom menu of the message box: messages and slash commands you use often (optional). One file holds the items of every ship, and each item names the ships it is enabled on. Each ship can also edit its own items from the menu button ([Use the custom menu](../guides/use-custom-menu.md)).

```yaml
actions:
  - id: review
    name: Review the diff
    kind: message
    command: Please review the current diff and list any risks.
    send: fill
    ships: [my-ship]
  - id: compact
    name: Compact
    kind: slash
    command: /compact
    send: now
    ships: all
```

| Key | Type | Description |
|---|---|---|
| `actions[].id` | string | The item's ID (starts with a letter or digit; letters, digits, `.`, `_`, `-`; up to 64 characters). An item added on a screen gets `qa-` followed by eight hex digits |
| `actions[].name` | string | The label in the menu (1 to 40 characters) |
| `actions[].kind` | `message` / `slash` | `message` sends the text as a message. `slash` runs a slash command: one line starting with `/` (the `/` is added when it is left out) |
| `actions[].command` | string | The text to send (up to 4000 characters) |
| `actions[].send` | `now` / `fill` | `now` sends it when clicked (default). `fill` only puts it in the input box, so it can be edited before sending |
| `actions[].ships` | `all` or a list of ship IDs | The ships the item is enabled on. `all` includes ships made later |
| `actions[].except` | list of ship IDs | With `ships: all`: the ships the item is switched off on. Written when a ship removes an item that was enabled on all ships; ignored with a list |

- Up to 50 items. The menu shows them in the order of the file.
- If there is no `quick-actions.yml`, every ship offers `Resume` (`/resume`) and `Compact` (`/compact`). The file is created the first time something is saved.
- An item without a valid `id`, `name` or `command`, or with an unknown `kind`, is skipped; an item without `ships` is enabled on no ship. A `slash` item written without its leading `/` is read with it. A file that is not valid YAML is never overwritten; the menu and the settings screen report it instead.

## Persona files and icons

Personas and icons are placed in the fleet's `personnel/`, named by member ID.

| File | Description |
|---|---|
| `~/.make-it-so/personnel/{ID}.md` | The persona (a prompt for the crew member's tone, personality, etc.). Injected at startup. No persona if absent. Not injected for crew members that specify `agent` |
| `~/.make-it-so/personnel/{ID}.{png\|jpg\|webp\|gif}` | The icon. Placing it by hand and uploading it from the screen are equivalent. One per member, up to 1 MB. SVG is not accepted. The image format is determined from the first bytes of the content, not from the extension |

## Rule and skill files

- **Rules:** Markdown files whose full text is injected at startup. They can be written for each roster member (relative to `~/.make-it-so`) and in `ship.yml` (relative to the ship's root), and are concatenated in the order personal, then ship. A nonexistent file is an error at startup.
- **Skills:** Only the list (names and descriptions) is announced, and the model reads the body itself when needed (the file name must be lowercase `skill.md`; a `SKILL.md` copied as is from Claude Code is not picked up). A YAML frontmatter at the top with `name` and `description` is required, and files that lack it or are invalid are excluded with a warning. A ship's `skills/*/skill.md` are scanned automatically, and those named explicitly in the roster and in `skills:` of `ship.yml` are placed after them (for the same name, the one that appears first wins). A remote host crew member cannot read these files, so it is told the names and descriptions only and reads the body with the `get_skill` tool (which gives only the skills announced to that member).

## Directory layout

```
~/.make-it-so/
  roster.yml
  hosts.yml                  # optional
  quick-actions.yml          # optional
  personnel/
    {ID}.md                  # persona
    {ID}.png                 # icon (optional)
  ships/
    {ship ID}/
      ship.yml
      rules/ skills/         # optional. Files referenced from ship.yml, the ship's skills (skills/*/skill.md)
      report-format.md       # optional. The report format. If absent, the default format is used
      workspace/             # a free working area for the crew (announced to the crew)
      data/bridge.db         # the ship's DB (SQLite)
      knowledge/             # the ship's Memory (Markdown files and their git history; see the Memory guide)
      logs/app.log           # log
      turns/                 # working area for running turns (temporary files)
      agents/{agent}/results/ # working area for running crew tasks (temporary files)
```

- `data/`, `logs/`, `turns/`, `agents/` and `knowledge/` are created by make-it-so as needed (`knowledge/` when the crew first writes to the Memory).
- The contents of `turns/` and `agents/` are temporary files that hold the body text while streaming; once it is finalized, it is written to the DB and they are deleted.
- Before the DB is updated, a copy is left at `data/bridge.db.bak-v<old version>` (see [Data model](data-model.md)).

## Startup validation and errors

In the following cases, startup stops with a message instead of falling back to a default.

| Condition | Description |
|---|---|
| `~/.make-it-so/ships/` does not exist, or there is no ship at all | Create it with `npm run init`, or place a directory that has a `ship.yml` |
| There are several ships and no `--ship` | Lists the candidates |
| The ship given by `--ship` is not found | Lists the candidates |
| `port` is missing, not an integer, outside the range 1–65535, or duplicated among ships | A different `port` is required for each ship |
| `roster.yml` is missing, or has no `crew:` | The roster is required |
| `ship.yml` has no `crew:`, or not a single role can be loaded | At least one is required |
| `rank` is something other than `commander`, `chief`, or `crew` | — |
| A role name contains characters other than alphanumerics, `_`, and `-` (starting with an alphanumeric). A role's content is not a map that has `member` | Because it is used for task IDs and directory names |
| Two or more `commander`s | At most one per ship |
| `cwd` does not exist (or is not a directory) | For local crew. For remote crew, only checks that it is an absolute path |
| A crew member with `host` has no `cwd`, or it is not an absolute path | `cwd` is required for remote |
| `host` is not in `hosts.yml` | Lists the defined host names |
| A crew member with `host` has `access` | Not supported |
| A rule or skill file is missing | Existence is checked |
| `hosts.yml` has a key other than `destination`, or an invalid `destination` | — |
| The YAML is broken | Shows which file, with line and column |
| `language` / `crew_language` has an unsupported value | Only `en` and `ja` |
| A used member's `name` is missing or empty, or the member ID does not match the format (alphanumerics, `_`, `-`) | — |
| A role's `access` value is something other than `readonly` or `readwrite` | — |
| `acp.provider` or the roster's `provider` is something other than `kiro` or `claude` (typos, etc.) | — |
| A role in `ship.yml` points to a member who is not in the roster | Lists the roster's members |
| `debug` is not a boolean, `logging.level` is unsupported, or `logging.maxFileSizeMb` is not a positive number | — |
| `acp.*.command` is empty or not a string, `acp.*.args` is not an array of strings, or `server.host` is empty | — |
| `profile` is used | Rename it to `agent` |
