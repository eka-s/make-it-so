import express from "express";
import type { Bridge } from "../bridge.js";
import type { CrewManager } from "../crew-manager.js";
import type { CrewRunner } from "../crew-runner.js";
import { logger } from "../logger.js";
import { resolveMissionId } from "./mission-id.js";
import type { AgentStatus } from "./status.js";

// Routes for listing and restarting the crew's agents, and a route for debugging.

/** What this router needs. index.ts wires it in production; tests pass fakes. */
export type AgentsRouterDeps = {
  /** The ship's crew (used to check that a role exists and as the source of the list). */
  crew: Record<string, unknown>;
  /** Running state of one crew member (derived by routes/status.ts). */
  agentStatus: (role: string, missionId?: string) => AgentStatus;
  bridge: Pick<Bridge, "isAgentBusy" | "armErrorSimulation">;
  crewRunner: Pick<CrewRunner, "isRunning" | "getCurrentTaskId">;
  crewManager: Pick<CrewManager, "restartSession" | "sessionPhase">;
  /** Whether to enable the debug routes (config.debug). */
  debug: boolean;
};

export function createAgentsRouter(deps: AgentsRouterDeps): express.Router {
  const router = express.Router();

  // --- Debug ---
  router.post("/api/debug/simulate-error", (_req, res) => {
    if (!deps.debug) {
      res.status(404).json({ error: "not found" });
      return;
    }
    deps.bridge.armErrorSimulation();
    res.json({ status: "ok", message: "Error simulation armed. Next prompt will trigger RPC -32603 and auto-recovery." });
  });

  // --- Agents ---
  // There is no separate agent table; it is derived from the ship's crew and the actual running state
  // (same idea as /api/crew/status).
  router.get("/api/agents", (_req, res) => {
    const agents = Object.keys(deps.crew).map((role) => ({
      name: role,
      status: deps.agentStatus(role),
      currentTaskId: deps.crewRunner.getCurrentTaskId(role) ?? null,
    }));
    res.json(agents);
  });

  // Rebuilds a crew member's session. This is the single path shared by all crew members, including the commander:
  // every crew member is a lazily started session, so rebuilding is just discarding and recreating it.
  //
  // Sessions are per mission, so **which mission's session to rebuild** is taken from missionId in the body (the default mission if omitted).
  router.post("/api/agents/:role/restart", (req, res, next) => {
    void (async () => {
      const { role } = req.params;
      if (!deps.crew[role]) {
        res.status(404).json({ error: "Unknown role" });
        return;
      }
      const missionId = resolveMissionId(req.body);
      if (!missionId) {
        res.status(404).json({ error: "Unknown mission" });
        return;
      }

      try {
        if (deps.crewRunner.isRunning(role) || deps.bridge.isAgentBusy(role, missionId) || deps.crewManager.sessionPhase(role, missionId)) {
          res.status(409).json({ error: "agent_busy", message: "This crew member is busy. Restart it after it has finished." });
          return;
        }

        // The "restarting" display and the update notification when it finishes are emitted by restartSession
        await deps.crewManager.restartSession(role, missionId);
        res.json({ status: "ok", message: `${role} restarted successfully` });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logger.error(`[Restart] Failed for ${role}:`, message);
        res.status(500).json({ error: message });
      }
    })().catch(next);
  });

  return router;
}
