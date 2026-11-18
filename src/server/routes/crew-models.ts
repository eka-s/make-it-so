import express from "express";
import type { CrewManager } from "../crew-manager.js";
import { resolveCrewModel, type ModelOption, type ModelSource } from "../crew-model.js";
import type { CrewMemberConfig } from "../fleet-config.js";
import { logger } from "../logger.js";

// Routes to list and change crew members' models per mission.
// The model actually used (override > ship > roster > default) is decided on the server and returned,
// and the client just renders the value it receives.

/** What this router needs. index.ts wires it in production; tests pass fakes. */
export type CrewModelsRouterDeps = {
  /** The ship's crew (role name → crew config). */
  crew: Record<string, CrewMemberConfig>;
  /** Default provider when the roster does not specify one. */
  defaultProvider: string;
  crewManager: Pick<CrewManager, "getModelOptions" | "getLiveModel" | "applyModel">;
  missionExists: (missionId: string) => boolean;
  getOverride: (missionId: string, role: string) => string | undefined;
  setOverride: (missionId: string, role: string, model: string | null) => void;
  /** Scope of a mission's session for running tasks (taskSessionScope in crew-runner.ts). */
  taskScope: (missionId: string) => string;
};

/** Data for displaying the model of one crew member (GET /api/missions/:id/crew-models). */
export type CrewModelEntry = {
  role: string;
  name: string;
  /**
   * Selectable models. Empty means switching is not supported, or the session has not been created yet so it is unknown.
   */
  options: ModelOption[];
  /** The model decided by configuration (override > ship > roster). null if none is specified. */
  effective: string | null;
  source: ModelSource;
  /** The model the running session is actually using. null if there is no session. */
  live: string | null;
};

export function createCrewModelsRouter(deps: CrewModelsRouterDeps): express.Router {
  const router = express.Router();

  function entryOf(role: string, missionId: string): CrewModelEntry {
    const member = deps.crew[role];
    const { model, source } = resolveCrewModel({
      override: deps.getOverride(missionId, role),
      configured: member.model,
    });
    return {
      role,
      name: member.name,
      options: deps.crewManager.getModelOptions(member.provider ?? deps.defaultProvider),
      effective: model ?? null,
      source,
      live: deps.crewManager.getLiveModel(role, missionId, deps.taskScope(missionId)) ?? null,
    };
  }

  router.get("/api/missions/:missionId/crew-models", (req, res) => {
    const { missionId } = req.params;
    if (!deps.missionExists(missionId)) {
      res.status(404).json({ error: `Mission "${missionId}" not found` });
      return;
    }
    res.json(Object.keys(deps.crew).map((role) => entryOf(role, missionId)));
  });

  // body: { model: string | null }. null removes the override and goes back to the default.
  router.put("/api/missions/:missionId/crew-models/:role", (req, res, next) => {
    void (async () => {
      const { missionId, role } = req.params;
      if (!deps.missionExists(missionId)) {
        res.status(404).json({ error: `Mission "${missionId}" not found` });
        return;
      }
      if (!deps.crew[role]) {
        res.status(404).json({ error: "Unknown role" });
        return;
      }
      const { model } = (req.body ?? {}) as { model?: unknown };
      if (model !== null && (typeof model !== "string" || !model)) {
        res.status(400).json({ error: "model must be a non-empty string or null" });
        return;
      }
      if (model !== null) {
        const options = deps.crewManager.getModelOptions(deps.crew[role].provider ?? deps.defaultProvider);
        if (options.length === 0) {
          res.status(409).json({ error: "model_unavailable", message: "The model cannot be chosen for this crew member (not supported, or no session has been started yet)." });
          return;
        }
        if (!options.some((o) => o.value === model)) {
          res.status(400).json({ error: `Unknown model "${model}"` });
          return;
        }
      }

      deps.setOverride(missionId, role, model);
      // Also applied to the running session. Even if that fails, the save is done
      // and will be applied the next time a session is created.
      try {
        const { model: target } = resolveCrewModel({ override: model, configured: deps.crew[role].model });
        await deps.crewManager.applyModel(role, missionId, deps.taskScope(missionId), target);
      } catch (err) {
        logger.warn(`[CrewModels] Failed to apply model to live session of ${role} in ${missionId}:`, err);
      }
      res.json(entryOf(role, missionId));
    })().catch(next);
  });

  return router;
}
