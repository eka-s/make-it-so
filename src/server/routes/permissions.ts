import express from "express";
import type { CrewManager } from "../crew-manager.js";
import { reportActivity } from "../bridge-activity.js";
import { listPending, peekPermission, resolvePermission } from "../permission-registry.js";

// Routes for the list of pending permission requests and for responding to them.

/** What this router needs. index.ts wires it in production; tests pass fakes. */
export type PermissionsRouterDeps = {
  crewManager: Pick<CrewManager, "respondToPermission">;
};

export function createPermissionsRouter(deps: PermissionsRouterDeps): express.Router {
  const router = express.Router();

  // --- Pending permissions (independent of the chat/message history) ---
  router.get("/api/permissions", (_req, res) => {
    res.json({ permissions: listPending() });
  });

  router.post("/api/permissions/:key/respond", (req, res) => {
    const { key } = req.params;
    const { optionId } = req.body as { optionId?: string };
    if (!optionId) {
      res.status(400).json({ error: "optionId is required" });
      return;
    }
    const preview = peekPermission(key);
    if (!preview) {
      // Already resolved (e.g. a double click, or cleared by a restart) — an idempotent no-op.
      res.status(404).json({ status: "not_found" });
      return;
    }
    const permission = resolvePermission(key);
    if (!permission) {
      // Resolved by someone else between the peek and here — an idempotent no-op.
      res.status(404).json({ status: "not_found" });
      return;
    }
    // The response goes to the session the request came from (a (crew member, mission) pair), not to a role (such as first_officer) —
    // the same crew member can request permissions in several missions at once, so the agent name alone
    // does not decide the destination.
    // For the same reason missionId is passed (see bridge-activity.ts). Entries of a task-running
    // session have no matching entry on the bridge.ts side and are simply ignored, so there is no need to branch here.
    reportActivity(permission.missionId);
    const delivered = deps.crewManager.respondToPermission(permission.scope, permission.missionId, permission.requestId, optionId);
    // The entry is gone either way: a request nobody is waiting for any more cannot be answered later. The captain is told it was
    // not delivered, so "ok" is never shown for an answer that reached nothing.
    if (!delivered) {
      res.status(409).json({ status: "undeliverable" });
      return;
    }
    res.json({ status: "ok" });
  });

  return router;
}
