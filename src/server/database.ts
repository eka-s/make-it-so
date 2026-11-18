import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { mkdirPrivate } from "./private-dirs.js";
import type { CrewRole, MeteringUsage, TimelineItem } from "./types.js";
import { parseStoredCommands, type SlashCommand } from "./slash-commands.js";
import { escapeLike } from "./search.js";
import { logger } from "./logger.js";
import { SERVER_MESSAGES, type ServerMessageKey } from "./messages.js";
import { migrate } from "./migrations.js";

// The DB is completely separated per ship —
// it is placed under the selected ship's directory, not under make-it-so's own directory. With a structural
// separation of one file per ship, rather than scoping by ship ID, there is no risk from the start of data leaking
// between ships through a forgotten WHERE clause.

/**
 * ID of the default mission. Ordinary conversations not tied to a particular issue belong here.
 * All history from before missions existed is also backfilled to this ID, so queries can be written on the assumption that
 * no row has a NULL `mission_id` (NULL never matches `= ?`, so leaving it nullable
 * would make filtering queries silently drop results).
 */
export const DEFAULT_MISSION_ID = "bridge";

let db: DatabaseSync | null = null;

// Function that converts a value of the DB's `agent` column into a role name (received in initDatabase). The role definitions are
// held by the ship config (config.ts), so this module does not depend on it and has the caller
// pass it in — depending on it would load the ship config just by importing, and make testing impossible.
let resolveRole: ((agent: string) => CrewRole) | null = null;

function agentToRole(agent: string): CrewRole {
  if (!resolveRole) throw new Error("Database not initialized. Call initDatabase() first.");
  return resolveRole(agent);
}

export type DatabaseOptions = {
  /** Path of the SQLite file. `":memory:"` means in-memory (for tests). */
  path: string;
  /**
   * Converts a value of the DB's `agent` column into a role name (it depends on the ship's composition, so the caller passes it in).
   */
  agentToRole: (agent: string) => CrewRole;
};

/**
 * Initializes the SQLite database. Creates the destination directory and tables if needed.
 * Call it only once at server startup. Calling it again switches to a new database
 * (so that tests can use a blank DB each time).
 */
export function initDatabase(options: DatabaseOptions): void {
  resolveRole = options.agentToRole;
  if (options.path !== ":memory:") {
    // Make sure the destination directory exists
    mkdirPrivate(path.dirname(options.path));
  }

  db?.close();
  db = new DatabaseSync(options.path);

  // Enable WAL mode to improve concurrent read performance
  db.exec("PRAGMA journal_mode = WAL");
  // Enable foreign key constraints
  db.exec("PRAGMA foreign_keys = ON");

  runMigrations(db, options.path);

  logger.info("[Database] Initialized at", options.path);
}

/**
 * Applies the unapplied schema changes (migrations). Before rewriting an existing DB file,
 * it is copied to `<path>.bak-v<old version>` (an earlier backup is not overwritten). If it fails, or if you want to go back
 * after raising the version, you can restore from here.
 */
function runMigrations(d: DatabaseSync, dbPath: string): void {
  migrate(d, {
    beforeMigrate: (from) => {
      if (dbPath === ":memory:") return;
      const hasData = d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
      if (!hasData) return; // A blank DB has nothing to back up
      // Write the WAL contents back to the main file, so that a copy of a single file is a complete backup
      d.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      let backupPath = `${dbPath}.bak-v${from}`;
      if (fs.existsSync(backupPath)) backupPath = `${backupPath}-${Date.now()}`;
      fs.copyFileSync(dbPath, backupPath);
      logger.info("[Database] Backed up before migration:", backupPath);
    },
  });
}

/**
 * Closes the database. The write-ahead log is folded into the main file first, so that the file alone holds everything: a copy of
 * `bridge.db` taken after the server stopped is then a complete backup. (A server that is killed without a chance to run this leaves
 * the log next to the file, and the log is part of the data.)
 */
export function closeDatabase(): void {
  try {
    db?.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // A checkpoint that cannot run (a reader still holds the log) leaves the log in place, which is still correct.
  }
  db?.close();
  db = null;
  resolveRole = null;
}

/** Gets the database instance. Throws if it is called before initialization. */
function getDb(): DatabaseSync {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return db;
}

// --- Pinned Messages ---

export type PinnedMessageRow = {
  id: number;
  message_id: string;
  role: string;
  text: string;
  timestamp: string;
  pinned_at: string;
  mission_id: string;
};

// When missionId is omitted, it looks across all missions (the same style as crew/status).
export function getPinnedMessages(options?: { missionId?: string }): PinnedMessageRow[] {
  const d = getDb();
  if (options?.missionId) {
    const stmt = d.prepare("SELECT * FROM pinned_messages WHERE mission_id = ? ORDER BY pinned_at ASC");
    return stmt.all(options.missionId) as PinnedMessageRow[];
  }
  const stmt = d.prepare("SELECT * FROM pinned_messages ORDER BY pinned_at ASC");
  return stmt.all() as PinnedMessageRow[];
}

export function createPinnedMessage(data: {
  message_id: string;
  role: string;
  text: string;
  timestamp: string;
  mission_id: string;
}): PinnedMessageRow {
  const d = getDb();
  const stmt = d.prepare(
    "INSERT INTO pinned_messages (message_id, role, text, timestamp, mission_id) VALUES (?, ?, ?, ?, ?)"
  );
  stmt.run(data.message_id, data.role, data.text, data.timestamp, data.mission_id);

  const selectStmt = d.prepare("SELECT * FROM pinned_messages WHERE message_id = ?");
  return selectStmt.get(data.message_id) as PinnedMessageRow;
}

export function deletePinnedMessage(messageId: string): boolean {
  const d = getDb();
  const checkStmt = d.prepare("SELECT id FROM pinned_messages WHERE message_id = ?");
  const exists = checkStmt.get(messageId);
  if (!exists) return false;

  const stmt = d.prepare("DELETE FROM pinned_messages WHERE message_id = ?");
  stmt.run(messageId);
  return true;
}

// --- Timeline events ---
//
// The write API is deliberately narrow: there is a dedicated record*() function per event_type,
// which writes the spine row + the detail row together in one transaction. This way, even if a crash happens
// between the two INSERTs, no orphaned spine row without a corresponding detail row is left.
// Callers (bridge.ts etc.) never INSERT directly into timeline_events or the detail tables.
//
// All 11 event_types (captain_message/turn_started/turn_completed/
// turn_cancelled/turn_error/turn_recovery_started/system_notice/
// task_started/task_completed/task_error/task_reported) are implemented.

function withTransaction<T>(fn: () => T): T {
  const d = getDb();
  d.exec("BEGIN");
  try {
    const result = fn();
    d.exec("COMMIT");
    return result;
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Appends one row to the spine (timeline_events) and returns its event_id. Every record*()
 * function goes through here — this way, when an attribute common to all event_types such as `mission_id` is added,
 * there is only one place to change. The caller must call this from inside a transaction
 * (withTransaction).
 */
function insertEvent(eventType: string, occurredAt: string, missionId: string): number {
  const result = getDb()
    .prepare("INSERT INTO timeline_events (event_type, occurred_at, mission_id) VALUES (?, ?, ?)")
    .run(eventType, occurredAt, missionId);
  return Number(result.lastInsertRowid);
}

// --- Missions ---

export type Mission = {
  id: string;
  name: string;
  createdAt: string;
  archivedAt: string | null;
};

type MissionRow = { id: string; name: string; created_at: string; archived_at: string | null };

function toMission(row: MissionRow): Mission {
  return { id: row.id, name: row.name, createdAt: row.created_at, archivedAt: row.archived_at };
}

// Returns all of them, including archived ones — "hide/do not hide from the list" is left to a display filter on the client
// side (it only looks at the archivedAt value the server sent as is, so it does not count as the
// "guessing/rebuilding" that CLAUDE.md forbids).
// It extends the existing single endpoint without adding new query parameters.
export function listMissions(): Mission[] {
  const rows = getDb()
    .prepare("SELECT id, name, created_at, archived_at FROM missions ORDER BY created_at ASC")
    .all() as MissionRow[];
  return rows.map(toMission);
}

export function createMission(id: string, name: string): Mission {
  const d = getDb();
  d.prepare("INSERT INTO missions (id, name) VALUES (?, ?)").run(id, name);
  const row = d.prepare("SELECT id, name, created_at, archived_at FROM missions WHERE id = ?").get(id) as MissionRow;
  return toMission(row);
}

export function missionExists(id: string): boolean {
  return getDb().prepare("SELECT 1 FROM missions WHERE id = ?").get(id) !== undefined;
}

/** Returns a setting saved from the UI, or undefined if none was saved. */
export function getSetting(key: string): string | undefined {
  const row = getDb().prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

/** Saves a setting from the UI (overwrites the previous value). */
export function setSetting(key: string, value: string): void {
  getDb()
    .prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

/** Returns the cache of the model list selectable for a provider (empty if none). */
export function getProviderModelOptions(provider: string): { value: string; name: string }[] {
  const row = getDb()
    .prepare("SELECT options_json FROM provider_model_options WHERE provider = ?")
    .get(provider) as { options_json: string } | undefined;
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.options_json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveProviderModelOptions(provider: string, options: { value: string; name: string }[]): void {
  getDb()
    .prepare(
      "INSERT INTO provider_model_options (provider, options_json) VALUES (?, ?) " +
      "ON CONFLICT(provider) DO UPDATE SET options_json = excluded.options_json",
    )
    .run(provider, JSON.stringify(options));
}

/** Returns the cache of the "available slash commands" of a provider (empty if none). */
export function getProviderCommands(provider: string): SlashCommand[] {
  const row = getDb()
    .prepare("SELECT commands_json FROM provider_commands WHERE provider = ?")
    .get(provider) as { commands_json: string } | undefined;
  if (!row) return [];
  try {
    return parseStoredCommands(JSON.parse(row.commands_json));
  } catch {
    return [];
  }
}

export function saveProviderCommands(provider: string, commands: SlashCommand[]): void {
  getDb()
    .prepare(
      "INSERT INTO provider_commands (provider, commands_json) VALUES (?, ?) " +
      "ON CONFLICT(provider) DO UPDATE SET commands_json = excluded.commands_json",
    )
    .run(provider, JSON.stringify(commands));
}

// --- Conversation search ---

/** Search conditions (`terms` are AND, partial match, case-insensitive). */
export type SearchQuery = {
  terms: string[];
  /** Target missions. If null, all missions. */
  missionIds: string[] | null;
  /** From this time on (inclusive). ISO format. */
  from?: string;
  /** Before this time (exclusive). ISO format. */
  to?: string;
  /** Whether to include the captain's messages. */
  includeCaptain: boolean;
  /** Whether to include the crew's replies (turns in the conversation with the captain). */
  includeReplies: boolean;
  /** Whether to include task instructions and reports. */
  includeTasks: boolean;
  /** Upper limit on the number of hits returned (newest first). */
  limit: number;
};

export type SearchRow = {
  seq: number;
  occurred_at: string;
  mission_id: string;
  mission_name: string | null;
  kind: "captain" | "reply" | "task";
  /**
   * The crew member who replied/handled the task (the value of the DB's agent column). null for the captain's messages.
   */
  agent: string | null;
  /** The body (the captain's message or a reply), or a task report. */
  text: string;
  /** The task instruction (tasks only). */
  instruction: string | null;
  /** The id of the item in the conversation view (the jump target). */
  item_id: string;
};

/**
 * Searches conversations. Returns the captain's messages, the crew's replies, and tasks (instructions and reports) that match the conditions, newest first.
 * Matching is partial (Japanese can be searched too). `total` is the total number of matches, ignoring the upper limit on the count.
 */
export function searchTimeline(query: SearchQuery): { total: number; rows: SearchRow[] } {
  if (query.terms.length === 0 || (query.missionIds !== null && query.missionIds.length === 0)) return { total: 0, rows: [] };
  const likeParams = query.terms.map((term) => `%${escapeLike(term)}%`);
  const like = (column: string) => query.terms.map(() => `${column} LIKE ? ESCAPE '\\'`).join(" AND ");
  const mission = `COALESCE(te.mission_id, '${DEFAULT_MISSION_ID}')`;

  const parts: string[] = [];
  const partParams: SQLInputValue[] = [];
  if (query.includeCaptain) {
    parts.push(`
      SELECT te.id AS seq, te.occurred_at AS occurred_at, ${mission} AS mission_id, 'captain' AS kind, NULL AS agent,
             cm.text AS text, NULL AS instruction, 'event-' || te.id AS item_id
      FROM timeline_events te JOIN captain_message_events cm ON cm.event_id = te.id
      WHERE te.event_type = 'captain_message' AND ${like("cm.text")}`);
    partParams.push(...likeParams);
  }
  if (query.includeReplies) {
    parts.push(`
      SELECT te.id AS seq, te.occurred_at AS occurred_at, ${mission} AS mission_id, 'reply' AS kind, tc.agent AS agent,
             tc.text AS text, NULL AS instruction, tc.turn_id AS item_id
      FROM timeline_events te JOIN turn_completed_events tc ON tc.event_id = te.id
      WHERE te.event_type = 'turn_completed' AND ${like("tc.text")}`);
    partParams.push(...likeParams);
  }
  if (query.includeTasks) {
    // For each term, it is enough that it is in either the report or the instruction (every term must be in one or the other)
    const taskLike = query.terms
      .map(() => "(tskc.report LIKE ? ESCAPE '\\' OR tsks.instruction LIKE ? ESCAPE '\\')")
      .join(" AND ");
    parts.push(`
      SELECT te.id AS seq, te.occurred_at AS occurred_at, ${mission} AS mission_id, 'task' AS kind, tsks.agent AS agent,
             tskc.report AS text, tsks.instruction AS instruction, tskc.task_id AS item_id
      FROM timeline_events te
      JOIN task_completed_events tskc ON tskc.event_id = te.id
      LEFT JOIN task_started_events tsks ON tsks.task_id = tskc.task_id
      WHERE te.event_type = 'task_completed' AND ${taskLike}`);
    for (const p of likeParams) partParams.push(p, p);
  }
  if (parts.length === 0) return { total: 0, rows: [] };

  const filters: string[] = [];
  const filterParams: SQLInputValue[] = [];
  if (query.missionIds !== null) {
    filters.push(`x.mission_id IN (${query.missionIds.map(() => "?").join(", ")})`);
    filterParams.push(...query.missionIds);
  }
  if (query.from) {
    filters.push("x.occurred_at >= ?");
    filterParams.push(query.from);
  }
  if (query.to) {
    filters.push("x.occurred_at < ?");
    filterParams.push(query.to);
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const union = parts.join("\n      UNION ALL");
  const d = getDb();

  const total = (d.prepare(`SELECT COUNT(*) AS n FROM (${union}) x ${where}`).get(...partParams, ...filterParams) as { n: number }).n;
  const rows = d.prepare(`
    SELECT x.seq AS seq, x.occurred_at AS occurred_at, x.mission_id AS mission_id, m.name AS mission_name,
           x.kind AS kind, x.agent AS agent, x.text AS text, x.instruction AS instruction, x.item_id AS item_id
    FROM (${union}) x
    LEFT JOIN missions m ON m.id = x.mission_id
    ${where}
    ORDER BY x.seq DESC
    LIMIT ?
  `).all(...partParams, ...filterParams, query.limit) as SearchRow[];
  return { total, rows };
}

/** Returns a crew member's model override in a mission (undefined if none). */
export function getCrewModelOverride(missionId: string, role: string): string | undefined {
  const row = getDb()
    .prepare("SELECT model FROM mission_crew_model WHERE mission_id = ? AND role = ?")
    .get(missionId, role) as { model: string } | undefined;
  return row?.model;
}

/** Saves a model override. If null, the override is removed and it goes back to the default. */
export function setCrewModelOverride(missionId: string, role: string, model: string | null): void {
  const d = getDb();
  if (model === null) {
    d.prepare("DELETE FROM mission_crew_model WHERE mission_id = ? AND role = ?").run(missionId, role);
    return;
  }
  d.prepare(
    "INSERT INTO mission_crew_model (mission_id, role, model) VALUES (?, ?, ?) " +
    "ON CONFLICT(mission_id, role) DO UPDATE SET model = excluded.model",
  ).run(missionId, role, model);
}

// Archive/restore (it only toggles whether it is shown in the list; nothing is deleted).
// Returns undefined for a nonexistent id (the caller turns that into a 404).
export function setMissionArchived(id: string, archived: boolean): Mission | undefined {
  const d = getDb();
  if (archived) {
    d.prepare("UPDATE missions SET archived_at = datetime('now', 'localtime') WHERE id = ? AND archived_at IS NULL").run(id);
  } else {
    d.prepare("UPDATE missions SET archived_at = NULL WHERE id = ?").run(id);
  }
  const row = d.prepare("SELECT id, name, created_at, archived_at FROM missions WHERE id = ?").get(id) as MissionRow | undefined;
  return row ? toMission(row) : undefined;
}

export function recordCaptainMessage(text: string, missionId: string): { id: string; timestamp: string } {
  return withTransaction(() => {
    const d = getDb();
    const timestamp = new Date().toISOString();
    const eventId = insertEvent("captain_message", timestamp, missionId);
    d.prepare("INSERT INTO captain_message_events (event_id, text) VALUES (?, ?)").run(eventId, text);
    // Unlike a turn or a task, captain_message has no natural entity id
    // — the only stable identifier available is the spine's own id, so that
    // is used as is. We do not fall back to the timestamp (two
    // messages landing in the same millisecond could collide).
    return { id: `event-${eventId}`, timestamp };
  });
}

/** How many rows of captain messages are looked at when collecting a history (so a mission full of repeats cannot make it slow). */
const CAPTAIN_HISTORY_SCAN = 500;

/**
 * The captain's earlier messages in a mission, newest first: what the captain typed, for choosing one to send again.
 * A text is listed once (its latest use), and a text in `excluded` (compared ignoring case and surrounding space) is left out: the
 * fixed messages the buttons and the custom menu send are not something to pick from a history.
 */
export function getCaptainHistory(missionId: string, limit: number, excluded: readonly string[] = []): Array<{ id: string; text: string; timestamp: string }> {
  const skip = new Set(excluded.map((t) => t.trim().toLowerCase()));
  const rows = getDb().prepare(`
    SELECT te.id as id, te.occurred_at as timestamp, cm.text as text
    FROM timeline_events te JOIN captain_message_events cm ON cm.event_id = te.id
    WHERE te.mission_id = ? AND te.event_type = 'captain_message'
    ORDER BY te.id DESC
    LIMIT ?
  `).all(missionId, CAPTAIN_HISTORY_SCAN) as Array<{ id: number; timestamp: string; text: string }>;
  const seen = new Set<string>();
  const result: Array<{ id: string; text: string; timestamp: string }> = [];
  for (const row of rows) {
    const key = row.text.trim().toLowerCase();
    if (key === "" || skip.has(key) || seen.has(key)) continue;
    seen.add(key);
    result.push({ id: `event-${row.id}`, text: row.text, timestamp: row.timestamp });
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * `reportedTaskIds` is only for the report flow (it is always omitted in the ordinary captain ⇄ commander turn).
 * It is the list of task IDs that the commander's response was confirmed to have actually reported. When given, a row of
 * `task_reported_events` is also appended for each task_id inside the same transaction as the `turn_completed` write —
 * "the turn completed" and "a particular task was reported in that turn" are facts that are effectively settled
 * at the same time, so this avoids the case where a crash writes only one of them and the other goes missing.
 */
export function recordTurnCompleted(
  turnId: string,
  missionId: string,
  text: string,
  credits: MeteringUsage | undefined,
  reportedTaskIds: string[] | undefined,
  agent: string
): { timestamp: string } {
  return withTransaction(() => {
    const d = getDb();
    const timestamp = new Date().toISOString();
    const eventId = insertEvent("turn_completed", timestamp, missionId);
    d.prepare(
      "INSERT INTO turn_completed_events (event_id, turn_id, text, credits_json, agent) VALUES (?, ?, ?, ?, ?)"
    ).run(eventId, turnId, text, credits ? JSON.stringify(credits) : null, agent);
    for (const taskId of reportedTaskIds ?? []) {
      const reportedEventId = insertEvent("task_reported", timestamp, missionId);
      d.prepare("INSERT INTO task_reported_events (event_id, task_id, turn_id) VALUES (?, ?, ?)").run(reportedEventId, taskId, turnId);
    }
    return { timestamp };
  });
}

/**
 * Recorded once per attempt (the first send, and again at every auto-recovery retry — it is an append-only log, so several rows with the same turn_id are expected and not a bug). It never produces a chat item for display by itself. See getTimelineEventsHistory.
 */
export function recordTurnStarted(turnId: string, missionId: string, agent: string): { timestamp: string } {
  return withTransaction(() => {
    const d = getDb();
    const timestamp = new Date().toISOString();
    const eventId = insertEvent("turn_started", timestamp, missionId);
    d.prepare("INSERT INTO turn_started_events (event_id, turn_id, agent) VALUES (?, ?, ?)").run(eventId, turnId, agent);
    return { timestamp };
  });
}

/**
 * Turns that were started and have no outcome (completed, cancelled or error) recorded: the server stopped while they ran, or
 * they ended without a reply that is shown (an empty response leaves no outcome by design — the caller tells those apart by the
 * stream file).
 */
export function getUnfinishedTurns(): Array<{ turnId: string; missionId: string; agent: string }> {
  return getDb().prepare(`
    SELECT s.turn_id AS turnId, te.mission_id AS missionId, s.agent AS agent
    FROM turn_started_events s JOIN timeline_events te ON te.id = s.event_id
    WHERE s.turn_id NOT IN (SELECT turn_id FROM turn_completed_events)
      AND s.turn_id NOT IN (SELECT turn_id FROM turn_cancelled_events)
      AND s.turn_id NOT IN (SELECT turn_id FROM turn_error_events)
    GROUP BY s.turn_id
    ORDER BY MIN(te.id)
  `).all() as Array<{ turnId: string; missionId: string; agent: string }>;
}

/** Crew tasks that were started and have no outcome (completed or error) recorded: the server stopped while they ran. */
export function getUnfinishedTasks(): Array<{ taskId: string; missionId: string; agent: string }> {
  return getDb().prepare(`
    SELECT s.task_id AS taskId, te.mission_id AS missionId, s.agent AS agent
    FROM task_started_events s JOIN timeline_events te ON te.id = s.event_id
    WHERE s.task_id NOT IN (SELECT task_id FROM task_completed_events)
      AND s.task_id NOT IN (SELECT task_id FROM task_error_events)
    ORDER BY te.id
  `).all() as Array<{ taskId: string; missionId: string; agent: string }>;
}

export function recordTurnCancelled(turnId: string, missionId: string, text: string, credits: MeteringUsage | undefined, agent: string): { timestamp: string } {
  return withTransaction(() => {
    const d = getDb();
    const timestamp = new Date().toISOString();
    const eventId = insertEvent("turn_cancelled", timestamp, missionId);
    d.prepare(
      "INSERT INTO turn_cancelled_events (event_id, turn_id, text, credits_json, agent) VALUES (?, ?, ?, ?, ?)"
    ).run(eventId, turnId, text, credits ? JSON.stringify(credits) : null, agent);
    return { timestamp };
  });
}

export function recordTurnError(turnId: string, missionId: string, partialOutput: string | null, errorMessage: string, agent: string, messageKey?: ServerMessageKey): { timestamp: string } {
  return withTransaction(() => {
    const d = getDb();
    const timestamp = new Date().toISOString();
    const eventId = insertEvent("turn_error", timestamp, missionId);
    d.prepare(
      "INSERT INTO turn_error_events (event_id, turn_id, partial_output, error_message, agent, message_key) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(eventId, turnId, partialOutput || null, errorMessage, agent, messageKey ?? null);
    return { timestamp };
  });
}

/**
 * The notice "A temporary error occurred. Auto-recovering...". It never produces a chat item for display by itself — it is transient, and is always overwritten (under the same turn_id) before a reload could see it. It is recorded only so as not to leave a gap in the event log.
 */
export function recordTurnRecoveryStarted(turnId: string, missionId: string, text: string, agent: string): { timestamp: string } {
  return withTransaction(() => {
    const d = getDb();
    const timestamp = new Date().toISOString();
    const eventId = insertEvent("turn_recovery_started", timestamp, missionId);
    d.prepare("INSERT INTO turn_recovery_started_events (event_id, turn_id, text, agent) VALUES (?, ?, ?, ?)").run(eventId, turnId, text, agent);
    return { timestamp };
  });
}

/**
 * An independent informational notice, e.g. "Re-run by auto-recovery" — it has no entity id of its own and is treated like captain_message.
 */
export function recordSystemNotice(text: string, missionId: string, agent: string, messageKey?: ServerMessageKey): { id: string; timestamp: string } {
  return withTransaction(() => {
    const d = getDb();
    const timestamp = new Date().toISOString();
    const eventId = insertEvent("system_notice", timestamp, missionId);
    d.prepare("INSERT INTO system_notice_events (event_id, text, agent, message_key) VALUES (?, ?, ?, ?)").run(eventId, text, agent, messageKey ?? null);
    return { id: `event-${eventId}`, timestamp };
  });
}

/**
 * Numbering of taskIds. The same numbering source is used by every trigger that issues tasks (the MCP bulletin board's
 * `dispatch_task`, etc.), so there is no room for two independent counters to collide on a taskId.
 *
 * **The number is assigned atomically with a single-statement UPSERT**. A multi-step approach
 * ("read the latest task_started_events row and add 1" — read (JS) → compute (JS) → write at a later time, in recordTaskStarted)
 * would be problematic: at the time `dispatch_task` is called it only assigns a number, and the actual DB write happens
 * asynchronously after the task run queue advances, so two issues to the same crew member at almost the same time
 * would both read the same "latest row" and could return the same taskId (and since issues from different missions
 * now run in parallel, the chance of a race is higher). `INSERT ... ON CONFLICT ... RETURNING`
 * executes the read and the write indivisibly within one SQL statement, so the gap of "read, then write" at the JS level
 * (a window in which another call could cut in) structurally does not exist.
 */
export function nextTaskId(agent: string): string {
  const d = getDb();
  const row = d.prepare(
    "INSERT INTO task_id_counters (agent, next_seq) VALUES (?, 1) ON CONFLICT(agent) DO UPDATE SET next_seq = next_seq + 1 RETURNING next_seq"
  ).get(agent) as { next_seq: number };
  return `${agent}_${String(row.next_seq).padStart(4, "0")}`;
}

/**
 * Recorded the moment a crew task is issued — this row is the permanent record of the task's turnId/taskName/instruction. It never produces a chat item for display by itself. The actual card is handled by task_completed/task_error below.
 */
export function recordTaskStarted(
  taskId: string,
  missionId: string,
  agent: string,
  taskName: string,
  instruction: string,
  turnId: string | undefined,
  /** The role of the crew member who issued this task (used for how unreported tasks appear). */
  dispatchedBy: string
): { timestamp: string } {
  return withTransaction(() => {
    const d = getDb();
    const timestamp = new Date().toISOString();
    const eventId = insertEvent("task_started", timestamp, missionId);
    d.prepare(
      "INSERT INTO task_started_events (event_id, task_id, agent, task_name, instruction, turn_id, dispatched_by) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(eventId, taskId, agent, taskName, instruction, turnId ?? null, dispatchedBy);
    return { timestamp };
  });
}

export function recordTaskCompleted(taskId: string, missionId: string, report: string, credits?: MeteringUsage, cancelled = false): { timestamp: string } {
  return withTransaction(() => {
    const d = getDb();
    const timestamp = new Date().toISOString();
    const eventId = insertEvent("task_completed", timestamp, missionId);
    d.prepare(
      "INSERT INTO task_completed_events (event_id, task_id, report, credits_json, cancelled) VALUES (?, ?, ?, ?, ?)"
    ).run(eventId, taskId, report, credits ? JSON.stringify(credits) : null, cancelled ? 1 : 0);
    return { timestamp };
  });
}

export function recordTaskError(taskId: string, missionId: string, partialOutput: string | null, errorMessage: string): { timestamp: string } {
  return withTransaction(() => {
    const d = getDb();
    const timestamp = new Date().toISOString();
    const eventId = insertEvent("task_error", timestamp, missionId);
    d.prepare(
      "INSERT INTO task_error_events (event_id, task_id, partial_output, error_message) VALUES (?, ?, ?, ?)"
    ).run(eventId, taskId, partialOutput || null, errorMessage);
    return { timestamp };
  });
}

/**
 * Builds the mission's conversation as plain text for injection and returns it.
 *
 * This is the core of the policy of **not trusting the crew session's own LLM memory**.
 * Every time someone is addressed, what has been said so far in that mission is built here from the DB
 * and passed as a preamble to the prompt — so we do not have to care whether the session is alive
 * or whether a restart wiped its memory.
 *
 * Only events after `afterSeq` are returned (a delta). If `afterSeq = 0` (right after the session
 * was not started / was recreated), the latest `limit` events are passed to establish the context.
 * In both cases `limit` caps the amount — to avoid sending a huge history all at once
 * for a mission left alone for a long time or right after a restart.
 *
 * Only the captain's messages and the other side's responses (`captain_message`/`turn_completed`) are included
 * — narrowed to the "conversation" itself. The result of a delegated task is the product of separate work done in an independent
 * context, so it is not passed as conversation context (the delegate can read it with `get_task` if needed).
 */
export function getMissionTranscript(
  missionId: string,
  afterSeq: number,
  limit: number
): { entries: Array<{ seq: number; role: string; text: string }>; maxSeq: number } {
  const d = getDb();
  // To get the latest `limit` rows, query with DESC once, then restore the chronological order the caller uses.
  const rows = d.prepare(`
    SELECT te.id as seq, te.event_type as event_type,
           cm.text as cm_text,
           tc.text as tc_text, tc.agent as tc_agent
    FROM timeline_events te
    LEFT JOIN captain_message_events cm ON cm.event_id = te.id AND te.event_type = 'captain_message'
    LEFT JOIN turn_completed_events tc ON tc.event_id = te.id AND te.event_type = 'turn_completed'
    WHERE te.mission_id = ?
      AND te.id > ?
      AND te.event_type IN ('captain_message', 'turn_completed')
    ORDER BY te.id DESC
    LIMIT ?
  `).all(missionId, afterSeq, limit) as Array<{
    seq: number;
    event_type: string;
    cm_text: string | null;
    tc_text: string | null;
    tc_agent: string | null;
  }>;

  rows.reverse();

  const entries = rows.map((row) => ({
    seq: row.seq,
    role: row.event_type === "captain_message" ? "captain" : agentToRole(row.tc_agent ?? ""),
    text: (row.event_type === "captain_message" ? row.cm_text : row.tc_text) ?? "",
  }));

  // maxSeq is "the latest event that exists in this mission now" — the reference point is advanced
  // including what was cut off by limit. If the older part that was cut off were sent again next time, we would
  // never catch up and would keep sending the same capped amount every time.
  const latest = d.prepare(
    "SELECT MAX(id) as max_seq FROM timeline_events WHERE mission_id = ? AND event_type IN ('captain_message', 'turn_completed')"
  ).get(missionId) as { max_seq: number | null } | undefined;

  return { entries, maxSeq: latest?.max_seq ?? afterSeq };
}

export type UnreportedTask = {
  taskId: string;
  agent: string;
  taskName: string;
};

/**
 * Returns the list of crew tasks that have not been reported yet. "Unreported" = among the tasks that reached a
 * terminal state by completing/erroring (`task_completed_events` ∪ `task_error_events`), those with no
 * corresponding `task_reported_events` row. It does not depend on any external file at all —
 * both completion/error and reported-ness can be derived from facts inside this DB alone.
 */
export function getUnreportedTasks(missionId?: string, dispatchedBy?: string): UnreportedTask[] {
  const d = getDb();
  const params: SQLInputValue[] = [];
  // Filter by issuer (when omitted, tasks from any issuer are included. For the commander's report)
  let dispatcherFilter = "";
  if (dispatchedBy !== undefined) {
    dispatcherFilter = " AND tsks.dispatched_by = ?";
    params.push(dispatchedBy);
  }
  // Filter by mission. When omitted, it is an aggregate across all missions —
  // for the "all missions overview" view. The mission a task belongs to is held by the spine row of its issue event (task_started).
  let missionFilter = "";
  if (missionId) {
    missionFilter = " AND EXISTS (SELECT 1 FROM timeline_events te WHERE te.id = tsks.event_id AND te.mission_id = ?)";
    params.push(missionId);
  }
  const rows = d.prepare(`
    SELECT tsks.task_id as task_id, tsks.agent as agent, tsks.task_name as task_name
    FROM task_started_events tsks
    WHERE tsks.task_id IN (
      SELECT task_id FROM task_completed_events
      UNION
      SELECT task_id FROM task_error_events
    )
    AND NOT EXISTS (
      SELECT 1 FROM task_reported_events tr WHERE tr.task_id = tsks.task_id
    )${dispatcherFilter}${missionFilter}
    ORDER BY tsks.event_id ASC
  `).all(...params) as Array<{ task_id: string; agent: string; task_name: string }>;
  return rows.map((row) => ({ taskId: row.task_id, agent: row.agent, taskName: row.task_name }));
}

export type TaskHistoryEntry = {
  taskId: string;
  taskName: string;
  status: "done" | "error";
  completedAt: string;
};

/**
 * Returns the history of tasks that reached a terminal state (completed/error) for the given crew member, newest first.
 * Used for lazy fetching when a row is expanded in the crew status panel in the left pane.
 * It only JOINs the existing task_started_events/task_completed_events/task_error_events,
 * and adds no new tables or new persistence. It fetches `limit+1` rows and compares with the number
 * actually returned to decide "there is more" (hasMore)
 * — the same approach as the pagination in timeline.ts.
 */
export function getTaskHistory(agent: string, limit: number, missionId?: string): { items: TaskHistoryEntry[]; hasMore: boolean } {
  const d = getDb();
  const params: SQLInputValue[] = [agent];
  // Filter by mission (the same idea as getUnreportedTasks — across all missions when omitted).
  // Judged by the mission the spine row of the issue event (task_started) belongs to.
  let missionFilter = "";
  if (missionId) {
    missionFilter = " AND EXISTS (SELECT 1 FROM timeline_events tes WHERE tes.id = tsks.event_id AND tes.mission_id = ?)";
    params.push(missionId);
  }
  params.push(limit + 1);

  const rows = d.prepare(`
    SELECT tsks.task_id as taskId, tsks.task_name as taskName,
           CASE WHEN tskc.event_id IS NOT NULL THEN 'done' ELSE 'error' END as status,
           te.occurred_at as completedAt
    FROM task_started_events tsks
    LEFT JOIN task_completed_events tskc ON tskc.task_id = tsks.task_id
    LEFT JOIN task_error_events tske ON tske.task_id = tsks.task_id
    JOIN timeline_events te ON te.id = COALESCE(tskc.event_id, tske.event_id)
    WHERE tsks.agent = ? AND (tskc.event_id IS NOT NULL OR tske.event_id IS NOT NULL)${missionFilter}
    ORDER BY te.id DESC
    LIMIT ?
  `).all(...params) as TaskHistoryEntry[];

  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

/**
 * Looks up the permanent issue information of a task (agent/taskName/instruction/turnId) from what was recorded at task_started time. This is the only source of information, not a fallback, so the task_done/task_error handlers do not need the last-resort "guess the current turn".
 */
export function getTaskStarted(taskId: string): { agent: string; taskName: string; instruction: string; turnId: string | null; missionId: string } | null {
  const d = getDb();
  // missionId is also returned — when recording the completion/error of a task, only this issue record (the spine row)
  // knows which mission the task belongs to.
  const row = d.prepare(`
    SELECT tsks.agent as agent, tsks.task_name as task_name, tsks.instruction as instruction,
           tsks.turn_id as turn_id, te.mission_id as mission_id
    FROM task_started_events tsks
    JOIN timeline_events te ON te.id = tsks.event_id
    WHERE tsks.task_id = ?
    ORDER BY tsks.event_id DESC LIMIT 1
  `).get(taskId) as { agent: string; task_name: string; instruction: string; turn_id: string | null; mission_id: string | null } | undefined;
  if (!row) return null;
  return {
    agent: row.agent,
    taskName: row.task_name,
    instruction: row.instruction,
    turnId: row.turn_id,
    missionId: row.mission_id ?? DEFAULT_MISSION_ID,
  };
}

/** Whether the captain cancelled the task (its recorded output is then partial). */
export function isTaskCancelled(taskId: string): boolean {
  const row = getDb().prepare("SELECT cancelled FROM task_completed_events WHERE task_id = ? ORDER BY event_id DESC LIMIT 1").get(taskId) as { cancelled: number } | undefined;
  return row?.cancelled === 1;
}

/**
 * The final result text of one crew task — exactly the content that the task's chat card already
 * shows (the report text, or a formatted error message).
 * Used by `/api/results/:taskId` (the "view full result" popup,
 * see TaskReportPopup.tsx). When the task has not yet reached a terminal state (or the taskId itself does not exist),
 * it returns null — the popup should not be opened for such a task in the first place.
 */
export function getTaskOutcome(taskId: string): string | null {
  const d = getDb();
  const completed = d.prepare("SELECT report FROM task_completed_events WHERE task_id = ? ORDER BY event_id DESC LIMIT 1").get(taskId) as { report: string } | undefined;
  if (completed) return completed.report;
  const errored = d.prepare("SELECT error_message FROM task_error_events WHERE task_id = ? ORDER BY event_id DESC LIMIT 1").get(taskId) as { error_message: string } | undefined;
  if (errored) return errored.error_message;
  return null;
}

export type TaskDetail = {
  text: string;
  status: "done" | "error";
  taskName?: string;
  instruction?: string;
  credits?: MeteringUsage;
  /** True when the captain cancelled the task (the text is then the output produced before the cancel). */
  cancelled?: boolean;
  /** The mission the task belongs to (used to move to that task's card in the conversation). */
  missionId: string;
  /**
   * The time it completed (or errored). The same as the time of the task's card in the conversation (used for the move).
   */
  timestamp: string;
};

/**
 * Complete display data for the "full detail" popup of one task (`GET /api/results/:taskId`,
 * TaskReportPopup.tsx), including the tabs, credits, and instruction content.
 * This function is the single source of information for every caller, so the same amount of content (tabs, credits)
 * is always shown. A report message's badge can refer to an old task outside the timeline's loaded window,
 * so it cannot rely on local state and must re-fetch from the server.
 */
export function getTaskDetail(taskId: string): TaskDetail | null {
  const d = getDb();
  const started = getTaskStarted(taskId);
  const completed = d.prepare(
    "SELECT tc.report AS report, tc.credits_json AS credits_json, tc.cancelled AS cancelled, te.occurred_at AS occurred_at " +
    "FROM task_completed_events tc JOIN timeline_events te ON te.id = tc.event_id " +
    "WHERE tc.task_id = ? ORDER BY tc.event_id DESC LIMIT 1"
  ).get(taskId) as { report: string; credits_json: string | null; cancelled: number; occurred_at: string } | undefined;
  const missionId = started?.missionId ?? DEFAULT_MISSION_ID;
  if (completed) {
    return {
      text: completed.report,
      status: "done",
      missionId,
      timestamp: completed.occurred_at,
      ...(started?.taskName ? { taskName: started.taskName } : {}),
      ...(started?.instruction ? { instruction: started.instruction } : {}),
      ...(completed.credits_json ? { credits: JSON.parse(completed.credits_json) as MeteringUsage } : {}),
      ...(completed.cancelled ? { cancelled: true } : {}),
    };
  }
  const errored = d.prepare(
    "SELECT te2.error_message AS error_message, te.occurred_at AS occurred_at " +
    "FROM task_error_events te2 JOIN timeline_events te ON te.id = te2.event_id " +
    "WHERE te2.task_id = ? ORDER BY te2.event_id DESC LIMIT 1"
  ).get(taskId) as { error_message: string; occurred_at: string } | undefined;
  if (errored) {
    return {
      text: errored.error_message,
      status: "error",
      missionId,
      timestamp: errored.occurred_at,
      ...(started?.taskName ? { taskName: started.taskName } : {}),
      ...(started?.instruction ? { instruction: started.instruction } : {}),
    };
  }
  return null;
}

type TimelineEventRow = {
  seq: number;
  event_type: string;
  occurred_at: string;
  mission_id: string | null;
  cm_text: string | null;
  tc_turn_id: string | null;
  tc_text: string | null;
  tc_credits_json: string | null;
  tc_agent: string | null;
  tx_turn_id: string | null;
  tx_text: string | null;
  tx_credits_json: string | null;
  tx_agent: string | null;
  te_turn_id: string | null;
  te_error_message: string | null;
  te_partial_output: string | null;
  te_agent: string | null;
  te_message_key: string | null;
  sn_text: string | null;
  sn_agent: string | null;
  sn_message_key: string | null;
  tskc_task_id: string | null;
  tskc_report: string | null;
  tskc_credits_json: string | null;
  tskc_cancelled: number | null;
  tske_task_id: string | null;
  tske_error_message: string | null;
  tske_partial_output: string | null;
  tsks_agent: string | null;
  tsks_task_name: string | null;
  tsks_instruction: string | null;
  tsks_turn_id: string | null;
};

/**
 * Persisted timeline history read from the event log tables.
 * The shape {items, hasMore} is kept identical to what getSnapshot/getOlder in timeline.ts
 * return as is.
 *
 * turn_started/turn_recovery_started/task_started are deliberately not selected here as standalone
 * rows — they never produce a chat item for display by themselves (see the doc comments of the record*() functions above).
 * They exist purely to keep the event log complete. However, task_started_events is JOINed to
 * the task_completed/task_error rows, supplying the taskName/instruction/agent that exist only in
 * the original issue record.
 */
const TIMELINE_ROWS_SQL = `
    SELECT te.id as seq, te.event_type, te.occurred_at, te.mission_id as mission_id,
           cm.text as cm_text,
           tc.turn_id as tc_turn_id, tc.text as tc_text, tc.credits_json as tc_credits_json, tc.agent as tc_agent,
           tx.turn_id as tx_turn_id, tx.text as tx_text, tx.credits_json as tx_credits_json, tx.agent as tx_agent,
           terr.turn_id as te_turn_id, terr.error_message as te_error_message, terr.partial_output as te_partial_output, terr.agent as te_agent, terr.message_key as te_message_key,
           sn.text as sn_text, sn.agent as sn_agent, sn.message_key as sn_message_key,
           tskc.task_id as tskc_task_id, tskc.report as tskc_report, tskc.credits_json as tskc_credits_json, tskc.cancelled as tskc_cancelled,
           tske.task_id as tske_task_id, tske.error_message as tske_error_message, tske.partial_output as tske_partial_output,
           tsks.agent as tsks_agent, tsks.task_name as tsks_task_name, tsks.instruction as tsks_instruction, tsks.turn_id as tsks_turn_id
    FROM timeline_events te
    LEFT JOIN captain_message_events cm ON cm.event_id = te.id AND te.event_type = 'captain_message'
    LEFT JOIN turn_completed_events tc ON tc.event_id = te.id AND te.event_type = 'turn_completed'
    LEFT JOIN turn_cancelled_events tx ON tx.event_id = te.id AND te.event_type = 'turn_cancelled'
    LEFT JOIN turn_error_events terr ON terr.event_id = te.id AND te.event_type = 'turn_error'
    LEFT JOIN system_notice_events sn ON sn.event_id = te.id AND te.event_type = 'system_notice'
    LEFT JOIN task_completed_events tskc ON tskc.event_id = te.id AND te.event_type = 'task_completed'
    LEFT JOIN task_error_events tske ON tske.event_id = te.id AND te.event_type = 'task_error'
    LEFT JOIN task_started_events tsks ON tsks.task_id = COALESCE(tskc.task_id, tske.task_id) AND te.event_type IN ('task_completed', 'task_error')
    WHERE te.event_type IN ('captain_message', 'turn_completed', 'turn_cancelled', 'turn_error', 'system_notice', 'task_completed', 'task_error')
`;

/** Turns rows of TIMELINE_ROWS_SQL (in chronological order) into timeline items. */
function rowsToItems(page: TimelineEventRow[]): TimelineItem[] {
  const d = getDb();
  // For the list of turn_id of the turn_completed rows included in this page,
  // it fetches task_reported_events (with agent filled in by JOINing task_started_events)
  // in a single query and groups them by turn_id (avoiding N+1. It rebuilds, from normalized tables, the information that
  // the removed report_meta_json column used to hold).
  const completedTurnIds = Array.from(new Set(
    page.filter((row) => row.event_type === "turn_completed" && row.tc_turn_id).map((row) => row.tc_turn_id!)
  ));
  const reportMetaByTurnId = new Map<string, NonNullable<TimelineItem["reportMeta"]>>();
  if (completedTurnIds.length > 0) {
    const placeholders = completedTurnIds.map(() => "?").join(", ");
    const reportedRows = d.prepare(`
      SELECT tr.turn_id as turn_id, tr.task_id as task_id, tsks.agent as agent
      FROM task_reported_events tr
      JOIN task_started_events tsks ON tsks.task_id = tr.task_id
      WHERE tr.turn_id IN (${placeholders})
      ORDER BY tr.event_id ASC
    `).all(...completedTurnIds) as Array<{ turn_id: string; task_id: string; agent: string }>;
    for (const row of reportedRows) {
      const existing = reportMetaByTurnId.get(row.turn_id);
      const entry = { agent: row.agent, taskId: row.task_id };
      if (existing) existing.tasks.push(entry);
      else reportMetaByTurnId.set(row.turn_id, { tasks: [entry] });
    }
  }

  const items: TimelineItem[] = page.map((row): TimelineItem => {
    // missionId is common to all event_types, so it is composed once here
    // instead of being written in each case (it comes from one column on the spine, so no branching is needed).
    const missionId = row.mission_id ?? DEFAULT_MISSION_ID;
    const item = ((): Omit<TimelineItem, "missionId"> => {
    switch (row.event_type) {
      case "captain_message":
        return { id: `event-${row.seq}`, role: "captain", text: row.cm_text!, timestamp: row.occurred_at };
      case "turn_completed":
        return {
          id: row.tc_turn_id!,
          role: agentToRole(row.tc_agent ?? ""),
          text: row.tc_text!,
          timestamp: row.occurred_at,
          ...(row.tc_credits_json ? { credits: JSON.parse(row.tc_credits_json) as MeteringUsage } : {}),
          ...(reportMetaByTurnId.has(row.tc_turn_id!) ? { reportMeta: reportMetaByTurnId.get(row.tc_turn_id!) } : {}),
        };
      case "turn_cancelled":
        return {
          id: row.tx_turn_id!,
          role: agentToRole(row.tx_agent ?? ""),
          text: row.tx_text!,
          timestamp: row.occurred_at,
          cancelled: true,
          ...(row.tx_credits_json ? { credits: JSON.parse(row.tx_credits_json) as MeteringUsage } : {}),
        };
      case "turn_error":
        // error_message is stored (like the text/report of the other detail tables) in an already formatted
        // state — it is exactly the same string that bridge.ts upserts live, so even after a reload the
        // rendering is byte-for-byte identical to what a client that stayed connected had already seen.
        // partial_output is not shown for an ordinary error, except for a turn that was interrupted by a stop of the server: its card says
        // that what was written so far is kept, so it is shown above the notice.
        return {
          id: row.te_turn_id!,
          role: agentToRole(row.te_agent ?? ""),
          text: row.te_error_message!,
          timestamp: row.occurred_at,
          ...(row.te_message_key ? { messageKey: row.te_message_key } : {}),
          ...(row.te_message_key === "interrupted" && row.te_partial_output ? { partialText: row.te_partial_output } : {}),
        };
      case "system_notice":
        return { id: `event-${row.seq}`, role: agentToRole(row.sn_agent ?? ""), text: row.sn_text!, timestamp: row.occurred_at, ...(row.sn_message_key ? { messageKey: row.sn_message_key } : {}) };
      case "task_completed":
        return {
          id: row.tskc_task_id!,
          role: agentToRole(row.tsks_agent ?? ""),
          text: row.tskc_report!,
          timestamp: row.occurred_at,
          ...(row.tsks_task_name ? { taskName: row.tsks_task_name } : {}),
          ...(row.tsks_instruction ? { instruction: row.tsks_instruction } : {}),
          ...(row.tsks_turn_id ? { turnId: row.tsks_turn_id } : {}),
          ...(row.tskc_credits_json ? { credits: JSON.parse(row.tskc_credits_json) as MeteringUsage } : {}),
          ...(row.tskc_cancelled ? { cancelled: true } : {}),
        };
      case "task_error":
        // The same convention of an already formatted string as for turn_error above.
        return {
          id: row.tske_task_id!,
          role: agentToRole(row.tsks_agent ?? ""),
          text: row.tske_error_message!,
          timestamp: row.occurred_at,
          ...(row.tske_error_message === SERVER_MESSAGES.interrupted && row.tske_partial_output ? { partialText: row.tske_partial_output } : {}),
          ...(row.tsks_task_name ? { taskName: row.tsks_task_name } : {}),
          ...(row.tsks_instruction ? { instruction: row.tsks_instruction } : {}),
          ...(row.tsks_turn_id ? { turnId: row.tsks_turn_id } : {}),
        };
      default:
        // Unreachable given the WHERE clause above — a branch only to satisfy TypeScript's exhaustiveness check.
        throw new Error(`Unexpected event_type in timeline history: ${row.event_type}`);
    }
    })();
    return { ...item, missionId };
  });

  return items;
}

export function getTimelineEventsHistory(options?: { limit?: number; before?: TimelineKey; missionId?: string }): { items: TimelineItem[]; hasMore: boolean } {
  const d = getDb();
  // A limit that is not a positive whole number (a malformed query) falls back to the default instead of reaching SQLite.
  const requested = options?.limit;
  const limit = typeof requested === "number" && Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_HISTORY_PAGE) : DEFAULT_HISTORY_PAGE;
  const params: SQLInputValue[] = [];

  let sql = TIMELINE_ROWS_SQL;
  // Filter by mission. When omitted, it looks across all missions
  // — the same query can be reused as is for the "see the overall picture" use (no new function is added).
  if (options?.missionId) {
    sql += " AND te.mission_id = ?";
    params.push(options.missionId);
  }
  if (options?.before) {
    // The position is (occurred_at, id), not the time alone: several events can share one millisecond, and a page that ends
    // between them must not lose the ones that are older by id.
    sql += " AND (te.occurred_at < ? OR (te.occurred_at = ? AND te.id < ?))";
    params.push(options.before.occurredAt, options.before.occurredAt, options.before.seq);
  }
  sql += " ORDER BY te.occurred_at DESC, te.id DESC LIMIT ?";
  params.push(limit + 1);

  const rows = d.prepare(sql).all(...params) as TimelineEventRow[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  page.reverse(); // The fetched rows are newest first, so reverse them into the chronological order the caller wants

  return { items: rowsToItems(page), hasMore };
}

const DEFAULT_HISTORY_PAGE = 20;
const MAX_HISTORY_PAGE = 200;

const TIMELINE_VISIBLE_TYPES = "'captain_message', 'turn_completed', 'turn_cancelled', 'turn_error', 'system_notice', 'task_completed', 'task_error'";

/** The position of an item in the history: items are ordered by (occurred_at, spine id). */
export type TimelineKey = { occurredAt: string; seq: number };

/**
 * Finds where a timeline item sits in the history, from the id the client knows
 * (`event-<n>` for the captain's messages and notices, a turn id or a task id otherwise).
 * Returns null if the item is not in the (persisted) history of that mission.
 */
export function findTimelineKey(itemId: string, missionId: string): TimelineKey | null {
  const d = getDb();
  const eventMatch = /^event-(\d+)$/.exec(itemId);
  const row = (eventMatch
    ? d.prepare(`SELECT id AS seq, occurred_at FROM timeline_events WHERE id = ? AND mission_id = ? AND event_type IN (${TIMELINE_VISIBLE_TYPES})`)
        .get(Number(eventMatch[1]), missionId)
    : d.prepare(`
        SELECT te.id AS seq, te.occurred_at FROM timeline_events te
        WHERE te.mission_id = ? AND te.event_type IN (${TIMELINE_VISIBLE_TYPES}) AND te.id IN (
          SELECT event_id FROM turn_completed_events WHERE turn_id = ?
          UNION ALL SELECT event_id FROM turn_cancelled_events WHERE turn_id = ?
          UNION ALL SELECT event_id FROM turn_error_events WHERE turn_id = ?
          UNION ALL SELECT event_id FROM task_completed_events WHERE task_id = ?
          UNION ALL SELECT event_id FROM task_error_events WHERE task_id = ?
        )
        ORDER BY te.id DESC LIMIT 1
      `).get(missionId, itemId, itemId, itemId, itemId, itemId)) as { seq: number; occurred_at: string } | undefined;
  return row ? { occurredAt: row.occurred_at, seq: row.seq } : null;
}

/**
 * The items of a mission between two positions of the history. `dir` says which end of the
 * range to take `limit` items from: "asc" the oldest (right after `after`), "desc" the newest
 * (right before `before`). The items are returned in chronological order. `complete` is true
 * when the whole range was returned, i.e. nothing is left between the returned items and the
 * other end of the range.
 */
export function getTimelineRange(options: {
  missionId: string;
  after?: TimelineKey;
  afterInclusive?: boolean;
  before?: TimelineKey;
  dir: "asc" | "desc";
  limit: number;
}): { items: TimelineItem[]; complete: boolean } {
  const params: SQLInputValue[] = [options.missionId];
  let sql = `${TIMELINE_ROWS_SQL} AND te.mission_id = ?`;
  if (options.after) {
    sql += ` AND (te.occurred_at, te.id) ${options.afterInclusive ? ">=" : ">"} (?, ?)`;
    params.push(options.after.occurredAt, options.after.seq);
  }
  if (options.before) {
    sql += " AND (te.occurred_at, te.id) < (?, ?)";
    params.push(options.before.occurredAt, options.before.seq);
  }
  const order = options.dir === "asc" ? "ASC" : "DESC";
  sql += ` ORDER BY te.occurred_at ${order}, te.id ${order} LIMIT ?`;
  params.push(options.limit + 1);

  const rows = getDb().prepare(sql).all(...params) as TimelineEventRow[];
  const complete = rows.length <= options.limit;
  const page = complete ? rows : rows.slice(0, options.limit);
  if (options.dir === "desc") page.reverse();
  return { items: rowsToItems(page), complete };
}
