import type { DatabaseSync } from "node:sqlite";

/**
 * Schema changes (migrations). The schema version is kept in SQLite's `PRAGMA user_version`.
 *
 * Rules:
 * - A published migration is never rewritten. A change is added at the end of MIGRATIONS with the next version number.
 * - Each migration runs inside a transaction (all succeed, or all are rolled back).
 * - A DB of a newer version than this code knows is not opened (see migrate()).
 */
export type Migration = {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
};

/** Whether the table already has that column. */
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

/** Adds a column if it is missing. `definition` is the column name and type (e.g. "mission_id TEXT"). */
function addColumnIfMissing(db: DatabaseSync, table: string, definition: string): void {
  const column = definition.split(/\s+/)[0];
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

/**
 * Version 1: the schema from before versioning was introduced. Every statement is safe to run repeatedly (idempotent), so both a blank
 * DB and an existing pre-versioning DB (user_version = 0, nearly in this shape) end up with the same result.
 * The default mission's ID and name are deliberately written here as plain strings, because a published
 * migration must not change when a constant on the app side changes.
 */
function baseline(db: DatabaseSync): void {
  // Removes the tables of the retired Ops Todo feature from existing DBs (if it is ever revived, something new will be built)
  db.exec("DROP TABLE IF EXISTS todo_messages");
  db.exec("DROP TABLE IF EXISTS todos");

  // Creates the tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS pinned_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      pinned_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);

  // Migration: missions. A pin is now a sub-concept of a mission, so one column
  // is added in the same pattern as timeline_events and then backfilled (keeping the invariant
  // that "no row has a NULL mission_id"). It simply stores the value the client passes when a pin is created,
  // and this module does not rebuild it from other values
  // (treated as part of the snapshot, like role/text/timestamp).
  addColumnIfMissing(db, "pinned_messages", "mission_id TEXT");
  db.prepare("UPDATE pinned_messages SET mission_id = ? WHERE mission_id IS NULL").run("bridge");

  // --- Missions ---
  // The boundary of a conversation. There is no "membership" of crew members — crew members exist in every mission
  // at all times and can be called any time with an @mention (the design decision is not to have the notion of membership
  // at all). So this table is purely a list of "named boxes for conversations".
  db.exec(`
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);

  // The default mission. All history from before missions existed is treated as belonging to it
  // (see the mission_id backfill below) — so the migration has no worry about "which mission
  // the past data should go into".
  db.prepare("INSERT OR IGNORE INTO missions (id, name) VALUES (?, ?)").run("bridge", "Bridge");

  // Migration: archive (hidden). It only toggles "shown in the list / not shown" and does not delete, so the conversation
  // itself (timeline_events, etc.) is left as it is and expressed by adding one column to missions.
  // NULL = shown; non-NULL holds the archive time — a timestamp rather than a boolean
  // so that it matches the naming and format of the other *_at columns (created_at/pinned_at, etc.).
  addColumnIfMissing(db, "missions", "archived_at TEXT DEFAULT NULL");

  // --- Timeline events ---
  // The only source of the chat timeline. It is built as an append-only event log:
  // the spine (timeline_events) only records "when and which event_type happened", and the actual payload of each event_type lives in its own
  // detail table (Class Table Inheritance. Single Table
  // Inheritance was not used, to avoid a table full of wide nullable columns and to keep the NOT NULL constraint of each type meaningful).
  // The `event_id` of a detail table is both the PRIMARY KEY and an FK to the spine — there is exactly one detail row
  // per spine row, never more.
  //
  // All 11 detail tables and all write APIs are implemented.
  db.exec(`
    CREATE TABLE IF NOT EXISTS timeline_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    )
  `);

  // Migration: missions. It is an attribute needed by every event_type, so instead of adding it to each of the 11 detail tables
  // it is held in **just one column on the spine** — filtering history is also a single WHERE clause
  // (taking full advantage of the CTI design).
  // Right after the column is added, existing rows are backfilled to the default mission, keeping the invariant that
  // "no row has a NULL mission_id".
  addColumnIfMissing(db, "timeline_events", "mission_id TEXT");
  db.prepare("UPDATE timeline_events SET mission_id = ? WHERE mission_id IS NULL").run("bridge");

  db.exec(`
    CREATE TABLE IF NOT EXISTS captain_message_events (
      event_id INTEGER PRIMARY KEY REFERENCES timeline_events(id),
      text TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_completed_events (
      event_id INTEGER PRIMARY KEY REFERENCES timeline_events(id),
      turn_id TEXT NOT NULL,
      text TEXT NOT NULL,
      credits_json TEXT
    )
  `);

  // turn_started and turn_recovery_started never produce a chat item for display by themselves
  // (see getTimelineEventsHistory below) — they exist purely as a permanent record that keeps the event log complete,
  // and turn_started in particular lets a reader tell that "this turn is still in progress" without touching the live map.
  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_started_events (
      event_id INTEGER PRIMARY KEY REFERENCES timeline_events(id),
      turn_id TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_cancelled_events (
      event_id INTEGER PRIMARY KEY REFERENCES timeline_events(id),
      turn_id TEXT NOT NULL,
      text TEXT NOT NULL,
      credits_json TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_error_events (
      event_id INTEGER PRIMARY KEY REFERENCES timeline_events(id),
      turn_id TEXT NOT NULL,
      partial_output TEXT,
      error_message TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_recovery_started_events (
      event_id INTEGER PRIMARY KEY REFERENCES timeline_events(id),
      turn_id TEXT NOT NULL,
      text TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS system_notice_events (
      event_id INTEGER PRIMARY KEY REFERENCES timeline_events(id),
      text TEXT NOT NULL
    )
  `);

  // Migration: lifts the assumption that only the commander (first_officer) can have "turns", so that
  // the same turn_* tables can also be used for direct chat with a crew member.
  // Existing rows have no value in this column (NULL) — the read side treats NULL as "first_officer"
  // (backward compatible; see agentToRole()).
  for (const table of [
    "turn_started_events",
    "turn_completed_events",
    "turn_cancelled_events",
    "turn_error_events",
    "turn_recovery_started_events",
    "system_notice_events",
  ]) {
    addColumnIfMissing(db, table, "agent TEXT");
  }

  // The permanent record of an issued crew task (turnId/taskName/instruction). A task's issue used to be
  // lost once the task was resolved and had to be rebuilt by guessing; task_started_events is now that permanent record itself
  // (an append-only log entry that is never deleted), so no separate issue-state tracking table or guessing fallback is needed.
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_started_events (
      event_id INTEGER PRIMARY KEY REFERENCES timeline_events(id),
      task_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      task_name TEXT NOT NULL,
      instruction TEXT NOT NULL,
      turn_id TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_completed_events (
      event_id INTEGER PRIMARY KEY REFERENCES timeline_events(id),
      task_id TEXT NOT NULL,
      report TEXT NOT NULL
    )
  `);

  // Migration: retrofits the credits tracking of crew tasks (a column turn_completed_events had from the start) (safe for existing data).
  addColumnIfMissing(db, "task_completed_events", "credits_json TEXT");

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_error_events (
      event_id INTEGER PRIMARY KEY REFERENCES timeline_events(id),
      task_id TEXT NOT NULL,
      partial_output TEXT,
      error_message TEXT NOT NULL
    )
  `);

  // The fact itself that "this task was reported at this time" is recorded as an append-only event —
  // rather than rewriting the task_completed/task_error row later (setting a reported flag), it is stacked as a separate independent fact.
  // This keeps the invariant that these tables are never UPDATEd, while "unreported tasks" can be found with just a
  // NOT EXISTS query: "tasks with no task_reported row". It is the single replacement for the denormalized JSON array
  // (`turn_completed_events.report_meta_json`), which has been removed.
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_reported_events (
      event_id INTEGER PRIMARY KEY REFERENCES timeline_events(id),
      task_id TEXT NOT NULL,
      turn_id TEXT NOT NULL
    )
  `);

  // Counter for assigning taskIds. Assigning a number by "reading the latest task_started_events row and adding 1"
  // is not atomic — the actual write (recordTaskStarted) happens asynchronously after the numbering,
  // when the task run queue advances, so two issues to the same crew member at almost the same time could collide on a taskId
  // (and since issues from different missions now run in parallel, the chance of a race is higher). The numbering is therefore an atomic UPSERT
  // on a one-row counter table (see nextTaskId below), leaving no gap of "read, then compute and write" at the JS level.
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_id_counters (
      agent TEXT PRIMARY KEY,
      next_seq INTEGER NOT NULL
    )
  `);
  // Migration of existing data: for each crew member that already has task_started_events,
  // the numbering is carried over from there (so it does not restart from 1 and collide with an existing taskId).
  // Crew members that already have a counter (= already migrated) are excluded by the WHERE clause,
  // so it is safe to run at every startup (nothing is inserted from the second time on).
  db.exec(`
    INSERT INTO task_id_counters (agent, next_seq)
    SELECT agent, MAX(CAST(SUBSTR(task_id, LENGTH(agent) + 2) AS INTEGER))
    FROM task_started_events
    WHERE agent NOT IN (SELECT agent FROM task_id_counters)
    GROUP BY agent
  `);

  // --- Per-mission model overrides for crew members ---
  // The model changed from the screen is saved per (mission, role). The default is the `model` of
  // ship.yml/roster.yml, and a row here takes priority over it.
  // Deleting the row goes back to the default. It is keyed by role name, so even when the person
  // assigned to a role changes with the ship's composition, the setting follows the role.
  db.exec(`
    CREATE TABLE IF NOT EXISTS mission_crew_model (
      mission_id TEXT NOT NULL,
      role TEXT NOT NULL,
      model TEXT NOT NULL,
      PRIMARY KEY (mission_id, role)
    )
  `);

  // Key-value settings saved from the UI (e.g. the language). The defaults live in
  // config.yml; a row here overrides the default at runtime.
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Messages the server writes itself (see messages.ts) are stored with their key, so
  // the client can show them in the current language. NULL for older rows and for
  // text that is not a fixed message (e.g. an error message from the provider).
  for (const table of ["turn_error_events", "system_notice_events"]) {
    addColumnIfMissing(db, table, "message_key TEXT");
  }

  // A cache of the "selectable model list" per provider. The list is only known from the response when a session is created, so
  // the last known content is kept so that it can be chosen on screen even right after the server restarts (no session yet).
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_model_options (
      provider TEXT PRIMARY KEY,
      options_json TEXT NOT NULL
    )
  `);
}

/**
 * v2: fills in old rows whose `agent` column is NULL. Before this column was added (when there was no direct chat with crew members),
 * only `first_officer` could speak, so the speaker of a NULL row is `first_officer`.
 * The special handling "NULL means `first_officer`" is not left on the read side; the data is fixed once, on the data side.
 */
function backfillLegacyAgents(db: DatabaseSync): void {
  for (const table of [
    "turn_started_events",
    "turn_completed_events",
    "turn_cancelled_events",
    "turn_error_events",
    "turn_recovery_started_events",
    "system_notice_events",
  ]) {
    db.exec(`UPDATE ${table} SET agent = 'first_officer' WHERE agent IS NULL`);
  }
}

/**
 * v3: records the issuer of a task (`dispatched_by`). It decides how unreported tasks appear (the commander sees all, others only
 * what they issued themselves). Before this column was added, only `first_officer` could issue tasks,
 * so the issuer of an existing row is `first_officer` (filled once on the data side, like v2).
 */
function addTaskDispatcher(db: DatabaseSync): void {
  addColumnIfMissing(db, "task_started_events", "dispatched_by TEXT");
  db.exec("UPDATE task_started_events SET dispatched_by = 'first_officer' WHERE dispatched_by IS NULL");
}

/**
 * v4: a cache of the "available slash commands" per provider. The list only arrives from the agent once a session has started,
 * so the last known content is kept so that the previous list can be offered as candidates in the input field even before startup.
 */
function addProviderCommands(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_commands (
      provider TEXT PRIMARY KEY,
      commands_json TEXT NOT NULL
    )
  `);
}

/**
 * v5: marks a crew task that the captain cancelled (`task_completed_events.cancelled`). A cancelled task still ends with
 * the output it had produced so far, so it stays a completed row (every query over finished tasks keeps working);
 * the flag only tells the display and the report that the output is partial. Existing rows were never cancelled.
 */
function addTaskCancelled(db: DatabaseSync): void {
  addColumnIfMissing(db, "task_completed_events", "cancelled INTEGER NOT NULL DEFAULT 0");
}

/**
 * Migration 6: the A2UI form a crew member shows the captain (render_ui) inside its reply, and what became of it. All three tables
 * are keyed by `turn_id`, the turn (the reply) the form appears in; a turn has at most one form, so it is UNIQUE in each.
 *  - `ui_shown_events`: the fact that a crew member showed a form. It is record-only: the form is part of the turn's item.
 *  - `ui_answered_events`: the fact that the captain answered it (record-only, like task_reported). It keeps the A2UI `action` the
 *    captain's press produced (`action_json`: name, surfaceId, sourceComponentId, timestamp, context) and the form's values at that
 *    moment (`data_model_json`), so the form can be shown as it was when it was answered, and the comment the captain wrote with the
 *    answer (`comment`, empty if none).
 *  - `ui_dismissed_events`: the fact that the captain closed the form without answering (record-only).
 * Whether a form is open, answered or dismissed is read from the existence of these rows; the form's own row is never updated.
 */
function addUiEvents(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ui_shown_events (
      event_id INTEGER PRIMARY KEY REFERENCES timeline_events(id),
      turn_id TEXT NOT NULL UNIQUE,
      agent TEXT NOT NULL,
      messages_json TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ui_answered_events (
      event_id INTEGER PRIMARY KEY REFERENCES timeline_events(id),
      turn_id TEXT NOT NULL UNIQUE,
      action_json TEXT NOT NULL,
      data_model_json TEXT NOT NULL,
      comment TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ui_dismissed_events (
      event_id INTEGER PRIMARY KEY REFERENCES timeline_events(id),
      turn_id TEXT NOT NULL UNIQUE
    )
  `);
}

/**
 * Migration 7: the search index of the Memory bundle (the Markdown files under the ship's `knowledge/`). The files are the truth; both
 * tables only hold what is read from them, so they can be thrown away and filled again from the files (the server does so at every start).
 *  - `memory_docs`: one row per concept file, with what the viewer and the tools list, and the body (for the words too short for the
 *    trigram index, which are looked up with LIKE). `version` is the git blob id of the file, which a write must quote to update it.
 *  - `memory_fts`: the trigram full-text index, which finds words of three characters or more, Japanese included. Its rowid is the
 *    rowid of `memory_docs`.
 */
function addMemoryIndex(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_docs (
      path TEXT PRIMARY KEY,
      dir TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      status TEXT NOT NULL,
      superseded_by TEXT,
      crew TEXT,
      updated_at TEXT,
      version TEXT NOT NULL,
      size INTEGER NOT NULL,
      body TEXT NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_memory_docs_dir ON memory_docs(dir)");
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(title, description, tags, body, tokenize = 'trigram')");
}

export const MIGRATIONS: Migration[] = [
  { version: 1, name: "baseline", up: baseline },
  { version: 2, name: "backfill-legacy-agents", up: backfillLegacyAgents },
  { version: 3, name: "task-dispatcher", up: addTaskDispatcher },
  { version: 4, name: "provider-commands", up: addProviderCommands },
  { version: 5, name: "task-cancelled", up: addTaskCancelled },
  { version: 6, name: "ui-events", up: addUiEvents },
  { version: 7, name: "memory-index", up: addMemoryIndex },
];

export function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

export function latestSchemaVersion(migrations: Migration[] = MIGRATIONS): number {
  return migrations.reduce((max, m) => Math.max(max, m.version), 0);
}

export type MigrateOptions = {
  migrations?: Migration[];
  /**
   * Called once right before running the first unapplied migration (passing the current version and the version that will be reached).
   */
  beforeMigrate?: (from: number, to: number) => void;
};

/**
 * Brings the DB to the latest schema version. A DB created with a version newer than this program is not changed at all
 * and an exception is thrown.
 */
export function migrate(db: DatabaseSync, options: MigrateOptions = {}): void {
  const migrations = [...(options.migrations ?? MIGRATIONS)].sort((a, b) => a.version - b.version);
  const current = getSchemaVersion(db);
  const latest = latestSchemaVersion(migrations);
  if (current > latest) {
    throw new Error(
      `Database schema version ${current} is newer than this program supports (${latest}). ` +
        `Update make-it-so, or restore a backup (*.bak-v*) of the database.`,
    );
  }
  const pending = migrations.filter((m) => m.version > current);
  if (pending.length === 0) return;
  options.beforeMigrate?.(current, latest);
  for (const m of pending) {
    db.exec("BEGIN");
    try {
      m.up(db);
      // PRAGMA does not accept bind variables. The version is a number we decide, so it is embedded as is.
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${m.version} (${m.name}) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
