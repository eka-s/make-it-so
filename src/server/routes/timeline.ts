import express from "express";
import { DEFAULT_MISSION_ID, getCaptainHistory } from "../database.js";
import { logger } from "../logger.js";
import * as timeline from "../timeline.js";

export type TimelineRouterDeps = {
  /** Messages the buttons and the custom menu send (they are left out of the captain's message history). */
  fixedMessages?: () => string[];
  /** The id of the reply with an A2UI form the captain has neither answered nor closed, in the mission (null if none; the input box is locked while there is one). */
  openUiItemId?: (missionId: string) => string | null;
};

/** How many earlier captain messages the history offers. */
export const CAPTAIN_HISTORY_LIMIT = 20;

/** Routes to fetch the chat timeline (the snapshot and older pages). */
export function createTimelineRouter(deps: TimelineRouterDeps = {}): express.Router {
  const router = express.Router();

  // The captain's earlier messages in a mission, newest first (for the ↑ history of the input box): `{ items: [{ id, text, timestamp }] }`.
  router.get("/api/timeline/captain-history", (req, res) => {
    try {
      const missionId = typeof req.query.missionId === "string" ? req.query.missionId : DEFAULT_MISSION_ID;
      res.json({ items: getCaptainHistory(missionId, CAPTAIN_HISTORY_LIMIT, deps.fixedMessages?.() ?? []) });
    } catch (error) {
      logger.error("[Timeline] Captain history error:", error);
      res.status(500).json({ error: "Failed to retrieve the captain's message history" });
    }
  });

  // --- Timeline (the only source of information for the chat feed) ---
  // One fetch is enough to rebuild exactly what should be shown now: the latest window of persisted history plus what is in progress
  // (the commander's own streaming turn, crew tasks that are partway through reporting). A client that loads fresh or reconnects
  // therefore never has to stitch several endpoints together or reconcile SSE deltas against a guessed earlier state.
  router.get("/api/timeline", (req, res, next) => {
    void (async () => {
      try {
        const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
        // Conversations are per mission. The client always specifies "the mission that is open now".
        // When omitted, the default mission is used, so manual curl calls keep working.
        const missionId = typeof req.query.missionId === "string" ? req.query.missionId : DEFAULT_MISSION_ID;
        const result = await timeline.getSnapshot(limit, missionId);
        // Which reply holds the form the captain has to deal with is a fact of the mission, not something to look for in the loaded items
        // (it can be outside them).
        res.json({ ...result, openUiItemId: deps.openUiItemId?.(missionId) ?? null });
      } catch (error) {
        logger.error("[Timeline] Snapshot error:", error);
        res.status(500).json({ error: "Failed to retrieve timeline" });
      }
    })().catch(next);
  });

  // Pagination for scrolling further back — it always returns only fully persisted items and never in-progress ones
  // (everything that is live right now is by definition recent).
  router.get("/api/timeline/older", (req, res, next) => {
    void (async () => {
      try {
        const before = typeof req.query.before === "string" ? req.query.before : undefined;
        const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
        if (!before) {
          res.status(400).json({ error: "before is required" });
          return;
        }
        const missionId = typeof req.query.missionId === "string" ? req.query.missionId : DEFAULT_MISSION_ID;
        const result = await timeline.getOlder(before, limit, missionId);
        if ("notFound" in result) {
          res.status(404).json({ error: "not found", id: result.notFound });
          return;
        }
        res.json(result);
      } catch (error) {
        logger.error("[Timeline] Older-history error:", error);
        res.status(500).json({ error: "Failed to retrieve older timeline items" });
      }
    })().catch(next);
  });

  // The items between two items of the history (by id). The client uses it to jump to an old
  // item (a chunk that starts at it) and to fill a gap in the loaded history from either end.
  //   after / inclusive=1 : the range starts after (or at) this item
  //   before              : the range ends before this item
  //   dir=asc|desc        : take `limit` items from the old end / from the new end of the range
  // `complete` tells whether the whole range was returned (nothing is left in between).
  router.get("/api/timeline/range", (req, res) => {
    try {
      const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
      const dir = req.query.dir === "desc" ? "desc" : "asc";
      const rawLimit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : NaN;
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
      const missionId = str(req.query.missionId) ?? DEFAULT_MISSION_ID;
      const afterId = str(req.query.after);
      const beforeId = str(req.query.before);
      if (!afterId && !beforeId) {
        res.status(400).json({ error: "range_unbounded", message: "after or before is required" });
        return;
      }
      const result = timeline.getRange({ missionId, afterId, afterInclusive: req.query.inclusive === "1", beforeId, dir, limit });
      if ("notFound" in result) {
        res.status(404).json({ error: "item_not_found", message: `Item "${result.notFound}" is not in the history of this mission` });
        return;
      }
      res.json(result);
    } catch (error) {
      logger.error("[Timeline] Range error:", error);
      res.status(500).json({ error: "Failed to retrieve timeline items" });
    }
  });

  return router;
}
