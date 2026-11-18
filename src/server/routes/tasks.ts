import express from "express";
import type { CrewRunner } from "../crew-runner.js";
import { getTaskDetail } from "../database.js";

// Routes to fetch the result of a crew task and to cancel a running task.

/** What this router needs. index.ts wires it in production; tests pass fakes. */
export type TasksRouterDeps = {
  crewRunner: Pick<CrewRunner, "cancel">;
};

export function createTasksRouter(deps: TasksRouterDeps): express.Router {
  const router = express.Router();

  // --- Results ---
  // Used by TaskReportPopup.tsx to show the full text of a crew task's result when the captain clicks
  // a task badge inside a Report turn's card.
  // It reads the same DB (task_completed_events / task_error_events) that already backs the chat card itself.
  // There is no agent in the URL: task IDs are globally unique, so /api/results/:taskId is enough.
  // Both the completion badge of a crew report group and the report badge of a report message use this one endpoint
  // and TaskReportPopup.tsx.
  router.get("/api/results/:taskId", (req, res) => {
    const { taskId } = req.params;
    const safePattern = /^[a-zA-Z0-9_-]+$/;
    if (!safePattern.test(taskId)) {
      res.status(400).json({ error: "Invalid taskId" });
      return;
    }
    const detail = getTaskDetail(taskId);
    if (detail === null) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(detail);
  });

  // --- Cancelling a crew member ---
  router.post("/api/crew/:taskId/cancel", (req, res) => {
    const { taskId } = req.params;
    // false: no such task is queued or running (it may have finished just now).
    if (!deps.crewRunner.cancel(taskId)) {
      res.status(404).json({ error: "not running" });
      return;
    }
    res.json({ status: "ok" });
  });

  return router;
}
