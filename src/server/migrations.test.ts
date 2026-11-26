import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDatabase, closeDatabase } from "./database.js";
import { MIGRATIONS, migrate, getSchemaVersion, latestSchemaVersion, type Migration } from "./migrations.js";

function tableNames(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return rows.map((r) => r.name);
}

function columnNames(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((r) => r.name);
}

describe("migrate", () => {
  it("brings a blank DB to the latest version and creates the needed tables and the default mission", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    expect(getSchemaVersion(db)).toBe(latestSchemaVersion());
    const tables = tableNames(db);
    for (const t of ["timeline_events", "missions", "pinned_messages", "app_settings", "task_id_counters"]) {
      expect(tables).toContain(t);
    }
    expect(db.prepare("SELECT id, name FROM missions").all()).toEqual([{ id: "bridge", name: "Bridge" }]);
  });

  it("adds a column to an old-shape DB from before versioning (no mission_id column) and backfills to the default mission", () => {
    const db = new DatabaseSync(":memory:");
    // Reproduce the shape from before missions were introduced
    db.exec(`
      CREATE TABLE timeline_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL);
      CREATE TABLE pinned_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
        text TEXT NOT NULL, timestamp TEXT NOT NULL, pinned_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
      INSERT INTO timeline_events (event_type, occurred_at) VALUES ('captain_message', '2026-01-01T00:00:00Z');
      INSERT INTO pinned_messages (message_id, role, text, timestamp) VALUES ('m1', 'captain', 'hi', '2026-01-01');
    `);
    expect(getSchemaVersion(db)).toBe(0);

    migrate(db);

    expect(columnNames(db, "timeline_events")).toContain("mission_id");
    expect(db.prepare("SELECT mission_id FROM timeline_events").all()).toEqual([{ mission_id: "bridge" }]);
    expect(db.prepare("SELECT mission_id FROM pinned_messages").all()).toEqual([{ mission_id: "bridge" }]);
  });

  it("running twice changes nothing (idempotent)", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    const before = tableNames(db).sort();
    migrate(db);
    expect(tableNames(db).sort()).toEqual(before);
    expect(getSchemaVersion(db)).toBe(latestSchemaVersion());
  });

  it("a DB of a newer version than this program is rejected with an error, without changing anything", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`PRAGMA user_version = ${latestSchemaVersion() + 1}`);
    expect(() => migrate(db)).toThrow(/newer than this program/);
    expect(tableNames(db)).toEqual([]);
  });

  it("a migration that fails partway is rolled back, and the version does not advance", () => {
    const db = new DatabaseSync(":memory:");
    const migrations: Migration[] = [
      { version: 1, name: "ok", up: (d) => d.exec("CREATE TABLE a (x INTEGER)") },
      {
        version: 2,
        name: "broken",
        up: (d) => {
          d.exec("CREATE TABLE b (x INTEGER)");
          throw new Error("boom");
        },
      },
    ];
    expect(() => migrate(db, { migrations })).toThrow(/Migration 2 \(broken\) failed: boom/);
    expect(getSchemaVersion(db)).toBe(1);
    expect(tableNames(db)).toContain("a");
    expect(tableNames(db)).not.toContain("b");
  });

  it("only the unapplied ones are run, in numeric order", () => {
    const db = new DatabaseSync(":memory:");
    const ran: number[] = [];
    // run in numeric order even if the array order is reversed
    const migrations: Migration[] = [
      { version: 2, name: "two", up: () => void ran.push(2) },
      { version: 1, name: "one", up: () => void ran.push(1) },
    ];
    migrate(db, { migrations });
    expect(ran).toEqual([1, 2]);
    migrate(db, { migrations });
    expect(ran).toEqual([1, 2]);
  });

  it("the current migration list has versions numbered consecutively from 1", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });
});

describe("backup in initDatabase", () => {
  let dir: string;
  afterEach(() => {
    closeDatabase();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const options = (file: string) => ({ path: file, agentToRole: () => "first_officer" as const });

  it("no backup is made for a new DB", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mis-mig-"));
    initDatabase(options(path.join(dir, "ship.db")));
    expect(fs.readdirSync(dir).filter((f) => f.includes(".bak"))).toEqual([]);
  });

  it("opening an existing DB from before versioning copies it to .bak-v0 before any change (the contents are as before the change)", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mis-mig-"));
    const file = path.join(dir, "ship.db");
    const old = new DatabaseSync(file);
    old.exec("PRAGMA journal_mode = WAL");
    old.exec("CREATE TABLE timeline_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL)");
    old.exec("INSERT INTO timeline_events (event_type, occurred_at) VALUES ('captain_message', 'x')");
    old.close();

    initDatabase(options(file));

    const backup = `${file}.bak-v0`;
    expect(fs.existsSync(backup)).toBe(true);
    const b = new DatabaseSync(backup);
    expect(columnNames(b, "timeline_events")).not.toContain("mission_id");
    expect(b.prepare("SELECT COUNT(*) AS n FROM timeline_events").get()).toEqual({ n: 1 });
    b.close();
  });

  it("reopening a DB of the latest version does not add backups", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mis-mig-"));
    const file = path.join(dir, "ship.db");
    initDatabase(options(file));
    initDatabase(options(file));
    expect(fs.readdirSync(dir).filter((f) => f.includes(".bak"))).toEqual([]);
  });
});

describe("migrations that fix the special-casing of role names once, on the data side (v2, v3)", () => {
  // Create a DB up to version 1, insert old-shape rows (agent column NULL, no issuer column), and then raise it to the latest
  function legacyDb(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    migrate(db, { migrations: MIGRATIONS.filter((m) => m.version === 1) });
    db.exec(`
      INSERT INTO timeline_events (event_type, occurred_at, mission_id) VALUES ('turn_completed', '2026-01-01T00:00:00Z', 'bridge');
      INSERT INTO turn_completed_events (event_id, turn_id, text, agent) VALUES (1, 't-old', 'old reply', NULL);
      INSERT INTO timeline_events (event_type, occurred_at, mission_id) VALUES ('turn_completed', '2026-01-01T00:00:01Z', 'bridge');
      INSERT INTO turn_completed_events (event_id, turn_id, text, agent) VALUES (2, 't-new', 'new reply', 'chief_engineer');
      INSERT INTO timeline_events (event_type, occurred_at, mission_id) VALUES ('task_started', '2026-01-01T00:00:02Z', 'bridge');
      INSERT INTO task_started_events (event_id, task_id, agent, task_name, instruction) VALUES (3, 'sam_0001', 'sam', 'old_task', 'i');
    `);
    return db;
  }

  it("v2: old rows whose agent column is NULL are filled in as belonging to first_officer, the only one at that time. Existing values are not changed", () => {
    const db = legacyDb();
    migrate(db);
    expect(db.prepare("SELECT turn_id, agent FROM turn_completed_events ORDER BY event_id").all()).toEqual([
      { turn_id: "t-old", agent: "first_officer" },
      { turn_id: "t-new", agent: "chief_engineer" },
    ]);
  });

  it("v3: adds the column for the task issuer, and fills the issuer of existing rows as first_officer", () => {
    const db = legacyDb();
    expect(columnNames(db, "task_started_events")).not.toContain("dispatched_by");
    migrate(db);
    expect(columnNames(db, "task_started_events")).toContain("dispatched_by");
    expect(db.prepare("SELECT task_id, dispatched_by FROM task_started_events").all()).toEqual([
      { task_id: "sam_0001", dispatched_by: "first_officer" },
    ]);
  });

  it("the latest version is 7. Even a blank DB ends up in the same latest shape", () => {
    expect(latestSchemaVersion()).toBe(7);
    const db = new DatabaseSync(":memory:");
    migrate(db);
    expect(columnNames(db, "task_started_events")).toContain("dispatched_by");
    expect(columnNames(db, "task_completed_events")).toContain("cancelled");
    expect(columnNames(db, "ui_shown_events")).toEqual(expect.arrayContaining(["turn_id", "agent", "messages_json"]));
    expect(columnNames(db, "ui_answered_events")).toEqual(expect.arrayContaining(["turn_id", "action_json", "data_model_json", "comment"]));
    expect(columnNames(db, "ui_dismissed_events")).toContain("turn_id");
  });
});
