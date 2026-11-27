[日本語](data-model.ja.md)

# Data Model

The structure of each ship's database (SQLite) and the rules for schema changes (migrations).

> **The source of truth for the schema is `src/server/migrations.ts`.** This document explains the meaning of the columns and the design conventions; for column types and constraints, refer to the source.

## Contents

- [Overview](#overview)
- [Table List](#table-list)
- [Timeline Events](#timeline-events)
- [Missions and PINs](#missions-and-pins)
- [Crew Tasks](#crew-tasks)
- [Memory Index](#memory-index)
- [Settings and Caches](#settings-and-caches)
- [Shared Conventions](#shared-conventions)
- [Migrations](#migrations)
- [Backup and Restore](#backup-and-restore)

## Overview

- Each ship (`--ship`) uses one file, `data/bridge.db` ([Configuration](configuration.md#directory-layout)).
- Conversation history is stored as an **append-only event log**. The `TimelineItem`s shown in the UI ([HTTP API](http-api.md#timeline)) are assembled from this log.
- Unapplied migrations are applied automatically at startup.

## Table List

| Group | Tables |
|---|---|
| Timeline | `timeline_events` (the trunk), plus a detail table for each event type (14 kinds) |
| Missions | `missions`, `pinned_messages`, `mission_crew_model` |
| Tasks | `task_started_events`, `task_completed_events`, `task_error_events`, `task_reported_events`, `task_id_counters` |
| A2UI forms | `ui_shown_events`, `ui_answered_events`, `ui_dismissed_events` |
| Memory index | `memory_docs`, `memory_fts` (rebuilt from the files; see below) |
| Settings and caches | `app_settings`, `provider_model_options`, `provider_commands` |

## Timeline Events

### Structure

History is kept in two levels, a "trunk" and "details" (Class Table Inheritance).

- The trunk `timeline_events` records only "when, in which mission, and what kind of event happened".
- The content of each kind goes in that kind's detail table. A detail table's `event_id` is both its primary key and a foreign key to the trunk's `id`. **Every trunk row has exactly one corresponding detail row.**
- The trunk and the detail are written in one transaction. Even if it stops partway, no trunk row without a detail is left behind.

### `timeline_events`

| Column | Meaning |
|---|---|
| `id` | The event's sequence number. Becomes the `seq` of a `TimelineItem` |
| `event_type` | The kind of event (table below) |
| `occurred_at` | Time of occurrence |
| `mission_id` | The mission it belongs to. Every row has a value |

### Event types and detail tables

| `event_type` | Detail table | Meaning | Main columns |
|---|---|---|---|
| `captain_message` | `captain_message_events` | The captain's message | `text` |
| `turn_started` | `turn_started_events` | A turn starts | `turn_id`, `agent` |
| `turn_completed` | `turn_completed_events` | A turn completes (the body of the reply) | `turn_id`, `text`, `credits_json`, `agent` |
| `turn_cancelled` | `turn_cancelled_events` | A turn is cancelled (the body up to that point) | `turn_id`, `text`, `credits_json`, `agent` |
| `turn_error` | `turn_error_events` | A turn fails | `turn_id`, `partial_output`, `error_message`, `message_key`, `agent` |
| `turn_recovery_started` | `turn_recovery_started_events` | A failed turn is resumed | `turn_id`, `text`, `agent` |
| `system_notice` | `system_notice_events` | A notice from the server | `text`, `message_key`, `agent` |
| `task_started` | `task_started_events` | A task is issued | See [Crew Tasks](#crew-tasks) |
| `task_completed` | `task_completed_events` | A task completes | Same as above |
| `task_error` | `task_error_events` | A task fails | Same as above |
| `task_reported` | `task_reported_events` | A task's result was reported to the commander | Same as above |
| `ui_shown` | `ui_shown_events` | A crew member showed an A2UI form under its reply | See [A2UI Forms](#a2ui-forms) |
| `ui_answered` | `ui_answered_events` | The captain answered an A2UI form | Same as above |
| `ui_dismissed` | `ui_dismissed_events` | The captain closed an A2UI form without answering | Same as above |

The kinds that appear as items in the UI are `captain_message`, `turn_completed`, `turn_cancelled`, `turn_error`, `system_notice`, `task_completed`, and `task_error`. `turn_started`, `turn_recovery_started`, `task_started`, `task_reported`, `ui_shown`, `ui_answered`, and `ui_dismissed` are records kept so that the history is complete, and never become items on their own.

### Meaning of the columns

| Column | Meaning |
|---|---|
| `turn_id` | The turn's identifier. Ties together start, completion, cancellation, and failure |
| `agent` | The agent name of the speaker for that turn. Conversion to a role depends on the ship's composition, so it is done at read time. It was empty in old rows, but was backfilled in [v2](#version-list) |
| `credits_json` | The consumption for that turn. JSON of `{ credits, turnDurationMs, unit }`. `unit` is `usd` (estimated cost) or `kiro_credits`. Old records without `unit` are treated as `kiro_credits`. May be empty |
| `partial_output` | The body that had been output up to the failure. May be empty |
| `message_key` | Key of a fixed message written by the server itself. The client picks the wording to match the display language. Empty for anything that is not a fixed message, such as a provider's error text |

## Missions and PINs

### `missions`

| Column | Meaning |
|---|---|
| `id` | The mission's identifier. The default mission is `bridge` (named `Bridge`), and it is always created at initialization |
| `name` | Display name |
| `created_at` | Creation time |
| `archived_at` | If empty, the mission is shown. If it has a value, the time it was archived (hidden, not deleted) |

Missions have no "crew belonging to them". Crew members are always present in every mission and can be called with `@`. This table is merely "a list of conversation containers".

### `pinned_messages`

| Column | Meaning |
|---|---|
| `id` | Sequence number |
| `message_id` | The identifier of the pinned message. Unique |
| `role`, `text`, `timestamp` | A snapshot as of the time of pinning (not rebuilt from the original message) |
| `pinned_at` | The time it was pinned |
| `mission_id` | The mission it belongs to |

### `mission_crew_model`

The model specified per mission and per role.

| Column | Meaning |
|---|---|
| `mission_id`, `role` | Primary key. Even if the person in charge changes, the setting stays with the role |
| `model` | The specified model |

The default is the `model` in `ship.yml`/`roster.yml`. If a row exists, it takes precedence; deleting the row reverts to the default.

## Crew Tasks

| Table | Columns | Meaning |
|---|---|---|
| `task_started_events` | `task_id`, `agent`, `task_name`, `instruction`, `turn_id`, `dispatched_by` | The record of a task being issued (persistent). `dispatched_by` is the agent that issued it. It determines how unreported tasks are seen (the commander sees all; others see the ones they issued) |
| `task_completed_events` | `task_id`, `report`, `credits_json`, `cancelled` | Completion and the report body. Where `cancelled` is 1, the task was stopped by the captain and the body is the output up to the stop |
| `task_error_events` | `task_id`, `partial_output`, `error_message` | Failure |
| `task_reported_events` | `task_id`, `turn_id` | The fact that "this task was reported in this turn" |
| `task_id_counters` | `agent` (primary key), `next_seq` | The sequence number for task IDs |

- A task ID is `<role name>_<4-digit sequence number>` (for example, `chief_engineer_0001`; even if the assignee is specified by member ID, it is normalized to the role name). The sequence number is issued by UPSERTing one row of `task_id_counters`, so there are no duplicates even with concurrent issuance.
- "Reported" is expressed by adding a row to `task_reported_events`, without rewriting the completion or failure row. **An unreported task is a task with no row in `task_reported_events`.**

## A2UI Forms

A crew member can show an interactive form (A2UI) under its reply with `render_ui`. The form is **part of the item of that reply** (a turn), not an item of its own; what became of it is recorded as separate facts.

| Table | Columns | Meaning |
|---|---|---|
| `ui_shown_events` | `turn_id` (unique), `agent`, `messages_json` | A crew member showed a form. `turn_id` is the reply it appears in (a turn has at most one form), and it identifies the form in the other two tables too. `messages_json` holds the A2UI v1.0 messages (exactly one surface) |
| `ui_answered_events` | `turn_id` (unique), `action_json`, `data_model_json`, `comment` | The captain answered the form (pressed a button): which form (`turn_id`), the A2UI action the press produced (`action_json`: `name`, `surfaceId`, `sourceComponentId`, `timestamp`, `context`), the values the form's surface had at that moment, and the comment the captain wrote in the form's comment field (empty if none). The text the crew member received is not stored: it is made from `action_json` and `comment` when the conversation context is built |
| `ui_dismissed_events` | `turn_id` (unique) | The captain closed the form without answering it |

- Like "reported" for tasks, what became of a form is expressed by adding a row, without rewriting the form's row. **A form with a row in `ui_answered_events` is answered; with one in `ui_dismissed_events`, closed; with neither, open.**
- Only a reply that **completed** (`turn_completed`) carries its form. A form shown in a reply that was cancelled, failed, or broke without ending is never shown, and never locks the mission.
- The item of the reply carries the form as `a2ui: { state, messages, comment?, actionName?, locksInput? }`:
  - `state: "open"` — waiting for the captain. `messages` are the form as the crew member sent it. `locksInput: true` is set: the server decides that this form locks the mission's input, and the client takes it from the item as it is.
  - `state: "answered"` — `messages` end with an `updateDataModel` that sets the values stored in `data_model_json`, so the form is shown as it was when it was answered. `actionName` is the action pressed; `comment` is the comment written with the answer (absent if none).
  - `state: "dismissed"` — closed without answering; `messages` is empty (nothing to draw), and the reply keeps a mark saying so.
- While a mission has an open form, no message can be sent in it: the input box is locked, and the server refuses with `409`. `GET /api/timeline` says which reply holds it (`openUiItemId`), so the client does not have to look for it among the loaded items.
- The message the crew member receives for an answer is not stored: it is made from `action_json` and `comment` when it is read: a fenced block marked `a2ui-action` holding the A2UI v1.0 action message, then `Captain's comment:` and the comment if there is one (it is also what appears in the conversation context handed to the other crew members). Keeping the facts (not the text) means the one place that words the text can change without leaving old rows behind.

## Memory Index

The ship's Memory is a directory of Markdown files, `knowledge/` ([guide](../guides/memory.md)); **the files are the truth**, and these two tables only hold what is read from them, so listing and searching are fast. They are filled again from the files at every start (which also picks up files edited by hand), and can be thrown away at any time.

| Table | Columns | Meaning |
|---|---|---|
| `memory_docs` | `path` (primary key), `dir`, `title`, `description`, `status`, `superseded_by`, `crew`, `updated_at`, `version`, `size`, `body` | One row per memo. `version` is the git blob id of the file (what a write quotes as `base`). `body` is kept so that words too short for the trigram index are looked up with `LIKE` |
| `memory_fts` | `title`, `description`, `body` | The full-text index (FTS5, `trigram` tokenizer: words of three characters or more, Japanese included). Its rowid is the rowid of `memory_docs` |

## Settings and Caches

| Table | Columns | Meaning |
|---|---|---|
| `app_settings` | `key`, `value` | Settings saved from the UI. The default is `config.yml`, and a row takes precedence at runtime. The keys are `language` and `crew_language` |
| `provider_model_options` | `provider`, `options_json` | The last known "selectable models" for each provider. They are unknown until a session is created, so this is used for the choices right after a restart |
| `provider_commands` | `provider`, `commands_json` | The last known "available slash commands" for each provider. Used for input completion before startup |

## Shared Conventions

- **Event tables are never updated or deleted** (append-only). A change of state is also added as a row recording a new fact.
- Every event has a `mission_id`. Only the trunk holds the value; the detail tables do not.
- Foreign keys are enabled (`PRAGMA foreign_keys = ON`), and the journal is in WAL mode.
- Writes go only through a dedicated function for each kind. Callers never `INSERT` into a table directly.

## Migrations

The schema version is kept in SQLite's `PRAGMA user_version`.

### Version list

| Version | Name | Description |
|---|---|---|
| 1 | `baseline` | The schema from before versioning began. Running it any number of times gives the same result (an empty DB and a pre-versioning DB end up in the same shape) |
| 2 | `backfill-legacy-agents` | Fills old rows whose `agent` is empty with `first_officer` (the commander at the time) |
| 3 | `task-dispatcher` | Adds `task_started_events.dispatched_by`. Existing rows are filled with `first_officer` |
| 4 | `provider-commands` | Adds `provider_commands` |
| 5 | `task-cancelled` | Adds `task_completed_events.cancelled`. Existing rows are 0 (not cancelled) |
| 6 | `ui-events` | Adds `ui_shown_events`, `ui_answered_events` and `ui_dismissed_events` |
| 7 | `memory-index` | Adds `memory_docs` and `memory_fts` (the search index of the Memory) |

### Rules

- Published migrations are **never rewritten**. Changes are added at the end of `MIGRATIONS` with the next version number.
- Each migration runs in one transaction. If it fails, all of that version's changes are rolled back and startup stops.
- How old data is handled (such as the meaning of empty columns) is not made a special case on the read side; the data is fixed once, by a migration.
- A DB with a newer version than this program is not modified in any way, and is refused with an error.

For the procedure, see [Architecture](../architecture.md).

## Backup and Restore

- Before rewriting an existing DB, a copy is left at `data/bridge.db.bak-v<old version>`. If a backup of the same name exists, a timestamp is appended to the end (it is not overwritten).
- No backup is made for an empty DB (one just created).
- Before copying, the WAL contents are written back into the main file, so **that one file is a complete backup**.
- When a ship is stopped (`Ctrl+C`, `SIGTERM`), the WAL is also merged into the main file before closing. After a forced termination, unapplied data remains in `-wal`, so copy `bridge.db*` together.
- To restore, stop the server, move the old `bridge.db*` (including `-wal` and `-shm`) out of the way, and then place the backup at `bridge.db`. The procedure is covered in the [guide](../guides/backup-and-restore.md).
