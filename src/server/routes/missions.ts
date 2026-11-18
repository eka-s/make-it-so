import express from "express";
import { createMission, listMissions, missionExists, setMissionArchived } from "../database.js";

const MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** Routes to list, create, and archive/restore missions (boxes for conversations). */
export function createMissionsRouter(): express.Router {
  const router = express.Router();

  // --- Missions ---
  // The boundary of a conversation. There is no notion of a crew member belonging to a mission (every crew member exists in every mission
  // at all times and can be called any time with an @mention); a mission is purely a named box for a conversation.
  router.get("/api/missions", (_req, res) => {
    res.json(listMissions());
  });

  router.post("/api/missions", (req, res) => {
    try {
      const { id, name } = req.body as { id?: unknown; name?: unknown };
      if (typeof name !== "string" || !name.trim()) {
        res.status(400).json({ error: "name is required" });
        return;
      }
      // The id is optional (generated mechanically from the name when omitted). It can also be given explicitly, because some
      // workflows want to use an issue ID as is (one mission per issue).
      const rawId = typeof id === "string" && id.trim() ? id.trim() : `m${Date.now()}`;
      // The ID travels in URLs and is a key in the database; it also must not look like a task-running scope (`__tasks__:`).
      if (!MISSION_ID.test(rawId)) {
        res.status(400).json({ error: "id must be 1-64 characters: letters, digits, '.', '_', '-' or ':', starting with a letter or digit" });
        return;
      }
      if (missionExists(rawId)) {
        res.status(409).json({ error: `Mission "${rawId}" already exists` });
        return;
      }
      res.status(201).json(createMission(rawId, name.trim()));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
    }
  });

  // PATCH /api/missions/:id — archive/restore (only toggles whether it is shown in the list; nothing is deleted).
  // It extends the existing mission API rather than adding a new endpoint.
  router.patch("/api/missions/:id", (req, res) => {
    try {
      const { archived } = req.body as { archived?: unknown };
      if (typeof archived !== "boolean") {
        res.status(400).json({ error: "archived must be a boolean" });
        return;
      }
      const updated = setMissionArchived(req.params.id, archived);
      if (!updated) {
        res.status(404).json({ error: `Mission "${req.params.id}" not found` });
        return;
      }
      res.json(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
    }
  });

  return router;
}
