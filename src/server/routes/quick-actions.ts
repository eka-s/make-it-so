import express from "express";
import { YamlUnreadableError } from "../settings/yaml-edit.js";
import { quickActionsOfShip, saveQuickActionsOfShip } from "../quick-actions.js";

// The custom menu of the message box, as one ship sees it: the items enabled on this ship.

export type QuickActionsRouterDeps = {
  /** The fleet directory (~/.make-it-so) that holds quick-actions.yml. */
  dir: string;
  /** This ship's ID. */
  shipId: string;
};

export function createQuickActionsRouter(deps: QuickActionsRouterDeps): express.Router {
  const router = express.Router();

  const run = (res: express.Response, work: () => void): void => {
    try {
      work();
    } catch (err) {
      if (err instanceof YamlUnreadableError) res.status(409).json({ error: "unreadable", message: err.message });
      else res.status(500).json({ error: "failed", message: err instanceof Error ? err.message : String(err) });
    }
  };

  router.get("/api/quick-actions", (_req, res) => {
    run(res, () => res.json({ actions: quickActionsOfShip(deps.dir, deps.shipId) }));
  });

  // Replaces this ship's list: { actions: [{ id?, name, kind, command, send }], seen?: string[] } (see saveQuickActionsOfShip).
  router.put("/api/quick-actions", (req, res) => {
    const actions = (req.body as { actions?: unknown } | undefined)?.actions;
    if (!Array.isArray(actions)) {
      res.status(400).json({ error: "invalid_body", message: "actions must be a list" });
      return;
    }
    const seenRaw = (req.body as { seen?: unknown }).seen;
    const seen = Array.isArray(seenRaw) ? seenRaw.filter((x): x is string => typeof x === "string") : undefined;
    run(res, () => {
      const result = saveQuickActionsOfShip(deps.dir, deps.shipId, actions, seen);
      if (!result.ok) res.status(400).json({ error: "invalid", errors: result.errors });
      else res.json({ actions: quickActionsOfShip(deps.dir, deps.shipId) });
    });
  });

  return router;
}
