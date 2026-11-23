import express from "express";
import type { Bridge } from "../bridge.js";
import type { UiOfTurn } from "../database.js";
import { logger } from "../logger.js";
import { a2uiAnswerText, parseA2uiAction } from "../a2ui-action.js";

// The routes for the captain's dealings with an A2UI form a crew member showed in a reply (render_ui): answering it (pressing its
// button), or closing it without answering. The form is part of the reply's item, so `itemId` is the id of that reply (a turn id).

/** What this router needs. index.ts wires it in production; tests pass fakes. */
export type A2uiRouterDeps = {
  bridge: Pick<Bridge, "isMissionBusy" | "sendMessage" | "republishTurn">;
  /** The form in the reply `turnId`: where it is, who drew it, what became of it (undefined if there is none). */
  getUi: (turnId: string) => UiOfTurn | undefined;
  /** Records that the captain closed the form of the reply `turnId` without answering. */
  dismissUi: (turnId: string, missionId: string) => void;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createA2uiRouter(deps: A2uiRouterDeps): express.Router {
  const router = express.Router();

  /** The open form of the reply, or a response telling why there is none (404 unknown or not shown, 409 not open anymore). */
  function openUi(itemId: string, res: express.Response): UiOfTurn | undefined {
    const ui = deps.getUi(itemId);
    // A form of a reply that has not completed (or never will) is not shown, so it does not exist for the captain.
    if (!ui || ui.state === "pending") {
      res.status(404).json({ error: "Unknown form" });
      return undefined;
    }
    if (ui.state !== "open") {
      res.status(409).json({ error: "form_closed", message: "This form was already answered or closed." });
      return undefined;
    }
    return ui;
  }

  router.post("/api/a2ui/:itemId/answer", (req, res) => {
    try {
      const { dataModel, comment } = req.body as { dataModel?: unknown; comment?: unknown };
      const action = parseA2uiAction((req.body as { action?: unknown }).action);
      if (!action) {
        res.status(400).json({ error: "action must be an A2UI v1.0 action (name, surfaceId, sourceComponentId, timestamp, context)" });
        return;
      }
      const ui = openUi(req.params.itemId, res);
      if (!ui) return;
      // The values are kept for the one surface the form made: an id of any other surface would only break the form when it is shown again.
      if (action.surfaceId !== ui.surfaceId) {
        res.status(400).json({ error: "Unknown surface of this form" });
        return;
      }
      if (deps.bridge.isMissionBusy(ui.missionId)) {
        res.status(429).json({ error: "This mission is busy processing a previous message" });
        return;
      }
      // The values of the form at the moment of the answer, kept so the form can be shown as it was.
      const values = isPlainObject(dataModel) ? dataModel : {};
      // What the captain wrote in the comment field of the form, whatever the form asks: it goes along with the answer.
      const note = typeof comment === "string" ? comment.trim() : "";
      // sendMessage records the answer synchronously, before it returns, so a second press finds the form answered.
      const messageId = deps.bridge.sendMessage(a2uiAnswerText(action, note), ui.role, ui.missionId, { answerOf: { turnId: req.params.itemId, action, dataModel: values, comment: note } });
      deps.bridge.republishTurn(req.params.itemId);
      res.status(202).json({ messageId, status: "accepted" });
    } catch (error) {
      logger.error("[A2UI] Error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  router.post("/api/a2ui/:itemId/dismiss", (req, res) => {
    try {
      const ui = openUi(req.params.itemId, res);
      if (!ui) return;
      deps.dismissUi(req.params.itemId, ui.missionId);
      deps.bridge.republishTurn(req.params.itemId);
      res.status(200).json({ status: "dismissed" });
    } catch (error) {
      logger.error("[A2UI] Error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  return router;
}
