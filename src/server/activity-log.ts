import fs from "node:fs";
import path from "node:path";
import { mkdirPrivate } from "./private-dirs.js";
import type { ActivityEntry } from "./types.js";

// What the crew did while working on a turn or a task (the tool calls: what was run, and the start of what it printed), kept in one small file
// per turn or task (`<id>.jsonl`, one line per event). The screen shows it as "3 operations", and it is still there after a reload, on
// another browser, and after the server stopped in the middle of the work. It is not part of the conversation (the database): only the
// most recent items are kept, and the output of each operation is cut short.

/** How many turns and tasks keep their operations (the oldest files are removed first). */
export const ACTIVITY_KEPT = 50;
/** How much of one operation's output is kept (characters). */
export const OUTPUT_KEPT_CHARS = 2000;
/** How many operations one turn or task keeps (the rest are not recorded), so one file and what is sent to the screen stay small. */
export const OPERATIONS_KEPT = 100;
/** How much of one operation's title is kept (a title can be a whole command). */
export const TITLE_KEPT_CHARS = 300;

type Line = { k: "call"; t: string; title: string } | { k: "out"; text: string } | { k: "cut" };

export type ActivityLog = ReturnType<typeof createActivityLog>;

/** An id that is safe as a file name (turn ids are UUIDs, task ids are `<role>_0001`); anything else is not recorded. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function createActivityLog(deps: { dir: string; keep?: number; now?: () => Date; onChange?: (id: string) => void }) {
  const keep = deps.keep ?? ACTIVITY_KEPT;
  const now = deps.now ?? (() => new Date());
  const fileOf = (id: string) => path.join(deps.dir, `${id}.jsonl`);
  // For the items being written: how much output the last operation has already been given (so it stops at the limit).
  const written = new Map<string, number>();
  // How many operations the items being written have so far.
  const operationCounts = new Map<string, number>();

  function append(id: string, line: Line): void {
    try {
      mkdirPrivate(deps.dir);
      const isNew = !fs.existsSync(fileOf(id));
      fs.appendFileSync(fileOf(id), `${JSON.stringify(line)}\n`, { mode: 0o600 });
      if (isNew) prune();
      deps.onChange?.(id);
    } catch {
      // A failed write only means the screen shows fewer operations; it must never disturb the work itself.
    }
  }

  /** Removes the oldest files beyond the limit. */
  function prune(): void {
    try {
      const files = fs.readdirSync(deps.dir)
        .filter((name) => name.endsWith(".jsonl"))
        .filter((name) => !written.has(name.slice(0, -".jsonl".length))) // an item still being written is never removed
        .map((name) => ({ name, mtime: fs.statSync(path.join(deps.dir, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const old of files.slice(keep)) fs.rmSync(path.join(deps.dir, old.name), { force: true });
    } catch {
      // nothing to prune
    }
  }

  return {
    /** A tool call started: a new operation. */
    recordCall(id: string, title: string): void {
      if (!SAFE_ID.test(id)) return;
      const count = operationCounts.get(id) ?? 0;
      if (count >= OPERATIONS_KEPT) {
        written.set(id, OUTPUT_KEPT_CHARS); // the output of operations that are not recorded is not recorded either
        return;
      }
      operationCounts.set(id, count + 1);
      written.set(id, 0);
      const text = String(title);
      append(id, { k: "call", t: now().toISOString(), title: text.length > TITLE_KEPT_CHARS ? `${cutAt(text, TITLE_KEPT_CHARS)}…` : text });
    },

    /** What the last operation printed (it arrives in pieces; only the start is kept). */
    recordOutput(id: string, text: string): void {
      if (!SAFE_ID.test(id) || text === "") return;
      const already = written.get(id) ?? 0;
      if (already >= OUTPUT_KEPT_CHARS) return;
      const room = OUTPUT_KEPT_CHARS - already;
      if (text.length <= room) {
        written.set(id, already + text.length);
        append(id, { k: "out", text });
        return;
      }
      const kept = cutAt(text, room);
      written.set(id, OUTPUT_KEPT_CHARS);
      if (kept) append(id, { k: "out", text: kept });
      append(id, { k: "cut" });
    },

    /** The operations recorded for a turn or task, or undefined when there are none (never recorded, or already removed). */
    read(id: string): ActivityEntry | undefined {
      if (!SAFE_ID.test(id)) return undefined;
      let raw: string;
      try {
        raw = fs.readFileSync(fileOf(id), "utf-8");
      } catch {
        return undefined;
      }
      const operations: ActivityEntry["operations"] = [];
      let timestamp = "";
      for (const text of raw.split("\n")) {
        if (!text) continue;
        let line: Line;
        try {
          line = JSON.parse(text) as Line;
        } catch {
          continue; // a half-written last line (the server stopped while writing) is skipped
        }
        if (line.k === "call" && typeof line.title === "string") {
          if (!timestamp) timestamp = line.t;
          operations.push({ title: line.title, output: "" });
        } else if (line.k === "out" && typeof line.text === "string" && operations.length > 0) {
          operations[operations.length - 1].output += line.text;
        } else if (line.k === "cut" && operations.length > 0) {
          operations[operations.length - 1].output += "…"; // the output was longer than what is kept
        }
      }
      if (operations.length === 0) return undefined;
      return { id, operations, isActive: false, timestamp };
    },

    /** The turn or task is over: its writing state is no longer needed. */
    finish(id: string): void {
      written.delete(id);
      operationCounts.delete(id);
    },

    prune,
  };
}

/** The first `max` characters of a text, without splitting a surrogate pair. */
function cutAt(text: string, max: number): string {
  if (max <= 0) return "";
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}
