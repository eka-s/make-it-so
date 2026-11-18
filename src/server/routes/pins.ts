import { Router } from "express";
import * as database from "../database.js";
import { logger } from "../logger.js";

// Routes for pinning messages.

/** What this router needs. index.ts wires it in production; tests pass fakes. */
export type PinsRouterDeps = {
  /** Role names of the ship's crew (used to decide who can be a pinned speaker). */
  crewRoles: string[];
};

export function createPinsRouter(deps: PinsRouterDeps): Router {
  const router = Router();
  // Anyone who can be the speaker of a chat message: the captain, or a crew member (ConversationRole).
  // The kinds of roles can be defined freely per ship (ship.yml), so this is built from the ship's crew at runtime (`crewRoles`),
  // not from a compile-time constant.
  const PINNABLE_ROLES = new Set<string>(["captain", ...deps.crewRoles]);

  // GET /api/pins?missionId= — lists pinned messages
  // (without missionId, across all missions, in the same style as /api/crew/status etc.)
  router.get("/", (req, res) => {
    try {
      const missionId = typeof req.query.missionId === "string" ? req.query.missionId : undefined;
      const rows = database.getPinnedMessages({ missionId });
      // Converts to the shape the client expects
      const pins = rows.map((row) => ({
        messageId: row.message_id,
        role: row.role,
        text: row.text,
        timestamp: row.timestamp,
        pinnedAt: row.pinned_at,
        missionId: row.mission_id,
        isFloating: true,
      }));
      res.json(pins);
    } catch (error) {
      logger.error("[Pins] List error:", error);
      res.status(500).json({ error: "Failed to retrieve pinned messages" });
    }
  });

  // POST /api/pins — pins a message
  router.post("/", (req, res) => {
    try {
      const { messageId, role, text, timestamp, missionId } = req.body as {
        messageId?: string;
        role?: string;
        text?: string;
        timestamp?: string;
        missionId?: string;
      };

      if (!messageId || typeof messageId !== "string") {
        res.status(400).json({ error: "messageId is required" });
        return;
      }
      if (!role || !PINNABLE_ROLES.has(role)) {
        res.status(400).json({ error: "role must be 'captain' or a valid crew role" });
        return;
      }
      if (!text || typeof text !== "string") {
        res.status(400).json({ error: "text is required" });
        return;
      }
      if (!timestamp || typeof timestamp !== "string") {
        res.status(400).json({ error: "timestamp is required" });
        return;
      }
      if (!missionId || typeof missionId !== "string") {
        res.status(400).json({ error: "missionId is required" });
        return;
      }

      if (!database.missionExists(missionId)) {
        res.status(404).json({ error: `Mission "${missionId}" not found` });
        return;
      }

      const row = database.createPinnedMessage({
        message_id: messageId,
        role,
        text,
        timestamp,
        mission_id: missionId,
      });

      res.status(201).json({
        messageId: row.message_id,
        role: row.role,
        text: row.text,
        timestamp: row.timestamp,
        pinnedAt: row.pinned_at,
        missionId: row.mission_id,
        isFloating: true,
      });
    } catch (error) {
      // Handles a UNIQUE constraint violation (already pinned)
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        res.status(409).json({ error: "Message is already pinned" });
        return;
      }
      logger.error("[Pins] Create error:", error);
      res.status(500).json({ error: "Failed to pin message" });
    }
  });

  // DELETE /api/pins/:messageId — unpins a message
  router.delete("/:messageId", (req, res) => {
    try {
      const { messageId } = req.params;
      if (!messageId) {
        res.status(400).json({ error: "messageId is required" });
        return;
      }

      const deleted = database.deletePinnedMessage(messageId);
      if (!deleted) {
        res.status(404).json({ error: "Pin not found" });
        return;
      }
      res.status(204).send();
    } catch (error) {
      logger.error("[Pins] Delete error:", error);
      res.status(500).json({ error: "Failed to unpin message" });
    }
  });

  return router;
}
