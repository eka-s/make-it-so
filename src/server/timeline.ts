import { broadcast } from "./sse-emitter.js";
import { findTimelineKey, getTimelineEventsHistory, getTimelineRange, getTaskStarted, type TimelineKey } from "./database.js";
import type { ActivityEntry, TimelineItem } from "./types.js";
import { logger } from "./logger.js";

// The single data source of the chat feed shown in Bridge Console.
// Every item — captain, commander, or crew, whether streaming or long finished — has the same TimelineItem shape.
// Items in progress live here (in memory) until they are persisted. getSnapshot() merges them with the persisted history
// (the timeline_events SQLite table; see getPersistedHistory below), so a client can rebuild exactly what should be shown now
// with a single fetch, and upsert/append/remove broadcast the same shape, so a connected client never has to guess
// how to reassemble things from deltas.
const live = new Map<string, TimelineItem>();

/**
 * Creates an item or replaces it entirely (a new item, or a change other than the text: status, credits, reportMeta, etc.).
 */
export function upsert(item: TimelineItem): void {
  live.set(item.id, item);
  broadcast({ type: "timeline:upsert", data: withActivity(item) });
}

const ACTIVITY_NOTIFY_MS = 400;
const activityTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * The operations of an item still being worked on have changed: tells the screens, at most once per ACTIVITY_NOTIFY_MS per item
 * (the output arrives in many small pieces). Only `activity` is sent — the text of the item is untouched, so it cannot clash with the
 * text deltas that are flowing at the same time.
 */
export function notifyActivity(id: string): void {
  if (activityTimers.has(id)) return;
  const timer = setTimeout(() => {
    activityTimers.delete(id);
    // Only for an item still streaming: once it has ended, its final upsert already carries the final activity.
    if (live.get(id)?.status !== "streaming") return;
    const activity = liveReaders?.readActivity?.(id);
    if (activity) broadcast({ type: "timeline:activity", data: { id, activity: { ...activity, isActive: true } } });
  }, ACTIVITY_NOTIFY_MS);
  timer.unref();
  activityTimers.set(id, timer);
}

/**
 * The item with the operations the crew member did for it (from the activity log), so a client shows them from the
 * same item it shows everything else from. Captain messages have none.
 */
function withActivity(item: TimelineItem): TimelineItem {
  if (item.role === "captain" || !liveReaders?.readActivity) return item;
  const activity = liveReaders.readActivity(item.id);
  return activity ? { ...item, activity: { ...activity, isActive: item.status === "streaming" } } : item;
}

/**
 * Does the same SSE broadcast as append(), but does not accumulate into `.text` of the live map —
 * for entities whose accumulated text is persisted somewhere other than memory
 * (the commander's turns via turn-stream.ts). For such entities, getSnapshot() does not trust live.text and reads the
 * external source directly — live.text is deliberately left empty/stale.
 */
export function broadcastAppend(id: string, text: string): void {
  if (!live.has(id)) return;
  broadcast({ type: "timeline:append", data: { id, text } });
}

/**
 * Removes an item entirely — it disappears on the client too. Only for the case where "there turned out to be nothing to show" (e.g. an empty response). Normal completion uses an upsert with a final status.
 */
export function remove(id: string): void {
  if (!live.delete(id)) return;
  broadcast({ type: "timeline:remove", data: { id } });
}

/**
 * Drops an item from the live map without telling clients — for the ordinary transition "it is persisted now, so live no longer needs to manage it". The client keeps showing it (it was already upserted with its final status). Later snapshots find it in the persisted history.
 */
export function forget(id: string): void {
  live.delete(id);
}

export function get(id: string): TimelineItem | undefined {
  return live.get(id);
}

/** The persisted history. It is read only from the timeline_events SQLite table. */
function getPersistedHistory(options: { limit?: number; before?: TimelineKey; missionId?: string }): { items: TimelineItem[]; hasMore: boolean } {
  const history = getTimelineEventsHistory(options);
  return { ...history, items: history.items.map(withActivity) };
}

/**
 * A way to read "how far along" an in-progress (streaming) item is.
 * The way of reading is passed in by the caller (index.ts) at startup so that this module does not depend on
 * where the files live (the ship config).
 */
export type LiveTextReaders = {
  /** Reads the in-progress text of a crew task issued via dispatch_task. */
  readTaskText: (agent: string, taskId: string) => Promise<string>;
  /** Reads the in-progress text of a turn (the commander's own, or a direct chat with a crew member). */
  readTurnText: (turnId: string) => Promise<string>;
  /** Reads the operations (tool calls) recorded for a turn or task. Items carry no operations when omitted. */
  readActivity?: (id: string) => ActivityEntry | undefined;
};

let liveReaders: LiveTextReaders | null = null;

/** Configures how to read in-progress text. Call it once at startup, before getSnapshot is called. */
export function configureTimeline(readers: LiveTextReaders): void {
  liveReaders = readers;
}

/**
 * A best-effort wrapper for showing "how far along" a streaming item is —
 * one item failing to load must never fail the whole snapshot,
 * so errors other than ENOENT from readFileStream/readTurnStream are not propagated; they are caught here and logged.
 */
async function readForDisplay(read: () => Promise<string>): Promise<string> {
  try {
    return await read();
  } catch (err) {
    logger.error("[Timeline] Failed to read file for display:", err);
    return "";
  }
}

/**
 * Persisted history (the latest window) + everything in progress right now, in chronological order.
 * The one call a client that loads fresh or reconnects needs to rebuild exactly what should be shown now.
 *
 * When `missionId` is given, only that mission's conversation is returned —
 * the client always requests only "the mission that is open now". Live items are filtered by the same criterion:
 * a turn running in parallel in another mission must not appear on the screen of the mission being viewed.
 */
export async function getSnapshot(limit?: number, missionId?: string): Promise<{ items: TimelineItem[]; hasMore: boolean }> {
  if (!liveReaders) throw new Error("Timeline not configured. Call configureTimeline() first.");
  const readers = liveReaders;
  const history = await getPersistedHistory({ limit, missionId });
  const persistedIds = new Set(history.items.map((item) => item.id));
  const items = [...history.items];

  // Take a snapshot into an independent array before awaiting below — `live` is a shared mutable Map that
  // other event handling (task completion, cancellation, etc.) can rewrite at any time, and when file reads were awaited one by one
  // inside a `for...of live.values()` loop, an item could complete and be forgotten in the middle of the iteration,
  // leaving a gap where it vanished from this response entirely. If it is copied to a plain array first, later
  // changes to `live` do not affect this response. Running the reads through Promise.all also lets several
  // items streaming at the same time be resolved in parallel instead of one by one.
  const liveSnapshot = Array.from(live.values())
    .filter((item) => !persistedIds.has(item.id))
    .filter((item) => !missionId || item.missionId === missionId);
  const resolved = await Promise.all(liveSnapshot.map(async (liveItem): Promise<TimelineItem> => {
    // A streaming commander turn or crew task no longer accumulates text in this map
    // (see broadcastAppend above) — the corresponding result file is the authoritative
    // source of "how far along". If the file is empty/missing, fall back to the live item's own text
    // (for example the narrow gap where an auto-recovery notice has been upserted but the retry's stream file has not been (re)created yet,
    // or between a crew task's "started" and its first chunk).
    if (liveItem.role !== "captain" && liveItem.status === "streaming") {
      // If there is a record in task_started_events, it is a crew task via dispatch_task
      // — instead of trying to work back from `role`, look up the actual agent directory name from the permanent issue record
      // (it does not necessarily match `role`; the agentToRole mapping can lose information).
      // If there is no record it is a "turn" (the commander's own, or a direct chat with a crew member;
      // both use the id as the turnId, so they can be read from the same turn-stream.ts).
      const started = getTaskStarted(liveItem.id);
      if (started) {
        const fileText = await readForDisplay(() => readers.readTaskText(started.agent, liveItem.id));
        return fileText ? { ...liveItem, text: fileText } : liveItem;
      }
      const fileText = await readForDisplay(() => readers.readTurnText(liveItem.id));
      return fileText ? { ...liveItem, text: fileText } : liveItem;
    }
    return liveItem;
  }));
  items.push(...resolved.map(withActivity));

  return { items, hasMore: history.hasMore };
}

/**
 * Persisted history strictly before `before` — for "read further back" pagination. It never includes live items, because everything in progress is by definition recent.
 */
/**
 * The persisted history older than an item (given by its id: the oldest one the caller has). Returns `{ notFound }` when that item
 * is not in the mission's persisted history.
 */
export async function getOlder(beforeId: string, limit: number | undefined, missionId: string): Promise<{ items: TimelineItem[]; hasMore: boolean } | { notFound: string }> {
  const before = findTimelineKey(beforeId, missionId);
  if (!before) return { notFound: beforeId };
  return getPersistedHistory({ before, limit, missionId });
}

/**
 * Items of the persisted history between two items (given by id). Used to jump to an old
 * item (a chunk starting at it) and to fill a gap in the loaded history from either end.
 * Returns `{ notFound }` with the id that is not in the mission's history.
 */
export function getRange(options: {
  missionId: string;
  afterId?: string;
  afterInclusive?: boolean;
  beforeId?: string;
  dir: "asc" | "desc";
  limit: number;
}): { items: TimelineItem[]; complete: boolean } | { notFound: string } {
  const resolve = (id: string | undefined): TimelineKey | undefined | "missing" => {
    if (id === undefined) return undefined;
    return findTimelineKey(id, options.missionId) ?? "missing";
  };
  const after = resolve(options.afterId);
  if (after === "missing") return { notFound: options.afterId! };
  const before = resolve(options.beforeId);
  if (before === "missing") return { notFound: options.beforeId! };
  const range = getTimelineRange({ missionId: options.missionId, after, afterInclusive: options.afterInclusive, before, dir: options.dir, limit: options.limit });
  return { ...range, items: range.items.map(withActivity) };
}
