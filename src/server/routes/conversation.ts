import express from "express";
import type { Bridge } from "../bridge.js";
import { logger } from "../logger.js";
import type {
  BridgeMessageRequest,
  BridgeMessageResponse,
  AccountsSnapshot,
  SSEEvent,
} from "../types.js";
import { resolveMissionId } from "./mission-id.js";

// Routes for the captain's conversation with the crew (sending messages, report, cancel) and for re-fetching the
// credit usage shown in the bottom bar.

/** What this router needs. index.ts wires it in production; tests pass fakes. */
export type ConversationRouterDeps = {
  /** The ship's crew (used to check that a role name exists). */
  crew: Record<string, unknown>;
  bridge: Pick<Bridge, "isMissionBusy" | "sendMessage" | "sendReport" | "cancelMessage">;
  /** The id of the reply with an A2UI form the captain has neither answered nor closed, in the mission (null if none): nothing can be sent until then. */
  openUiItemId: (missionId: string) => string | null;
  /** Forces a re-fetch of the credit usage. */
  fetchCredits: () => Promise<AccountsSnapshot>;
  /** Broadcasts to all clients over SSE. */
  broadcast: (event: SSEEvent) => void;
};

export function createConversationRouter(deps: ConversationRouterDeps): express.Router {
  const router = express.Router();

  /** While a form a crew member showed is waiting for the captain, nothing else can be sent: it is answered or closed first. */
  function formIsOpen(missionId: string, res: express.Response): boolean {
    if (deps.openUiItemId(missionId) === null) return false;
    res.status(409).json({ error: "form_open", message: "A form is waiting for your answer: answer it, or close it without answering, first." });
    return true;
  }

  // --- Conversation with the crew ---
  // The captain talks to any one crew member of the ship (every crew member has the same entry point; there are no special crew members).
  router.post("/api/crew/:role/message", (req, res) => {
    try {
      const { role } = req.params;
      if (!deps.crew[role]) {
        res.status(404).json({ error: "Unknown crew role" });
        return;
      }
      const { text } = req.body as BridgeMessageRequest;
      if (!text || typeof text !== "string") {
        res.status(400).json({ error: "text is required" });
        return;
      }
      const missionId = resolveMissionId(req.body);
      if (!missionId) {
        res.status(404).json({ error: "Unknown mission" });
        return;
      }
      // Busy checks are per mission (concurrency is per mission).
      // A turn running in another mission does not cause a rejection.
      if (deps.bridge.isMissionBusy(missionId)) {
        res.status(429).json({ error: "This mission is busy processing a previous message" });
        return;
      }
      if (formIsOpen(missionId, res)) return;
      const messageId = deps.bridge.sendMessage(text, role, missionId);
      const response: BridgeMessageResponse = { messageId, status: "accepted" };
      res.status(202).json(response);
    } catch (error) {
      logger.error("[Bridge:Crew] Error:", error);
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
    }
  });

  // Report button: sends "report" to that crew member (the crew member reports the unreported tasks it is allowed to see, using the `report` skill)
  router.post("/api/crew/:role/report", (req, res) => {
    try {
      const { role } = req.params;
      if (!deps.crew[role]) {
        res.status(404).json({ error: "Unknown crew role" });
        return;
      }
      const missionId = resolveMissionId(req.body);
      if (!missionId) {
        res.status(404).json({ error: "Unknown mission" });
        return;
      }
      if (deps.bridge.isMissionBusy(missionId)) {
        res.status(429).json({ error: "This mission is busy processing a previous message" });
        return;
      }

      if (formIsOpen(missionId, res)) return;

      const { messageId } = deps.bridge.sendReport(role, missionId);
      res.status(202).json({ messageId, status: "accepted" });
    } catch (error) {
      logger.error("[Bridge:Report] Error:", error);
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
    }
  });

  router.post("/api/bridge/cancel", (req, res) => {
    try {
      const missionId = resolveMissionId(req.body);
      if (!missionId) {
        res.status(404).json({ error: "Unknown mission" });
        return;
      }
      const cancelled = deps.bridge.cancelMessage(missionId);
      if (cancelled) {
        res.json({ status: "ok", message: "Cancel sent" });
      } else {
        res.status(409).json({ error: "No active message to cancel" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
    }
  });

  router.post("/api/bridge/refresh-credits", async (_req, res) => {
    try {
      const data = await deps.fetchCredits();
      deps.broadcast({ type: "credits:usage", data });
      res.json({ status: "ok", data });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
    }
  });

  return router;
}
