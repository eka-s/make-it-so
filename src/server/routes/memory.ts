import express from "express";
import { memoryPathProblem, resolveBundleLink } from "../memory-path.js";
import { MemoryError, type MemoryStore } from "../memory-store.js";
import type { MemoryStatus } from "../memory-document.js";

// The viewer's side of the ship's Memory: read-only. The crew writes through the MCP tools; the captain only looks.

/** What this router needs. index.ts wires it in production; tests pass fakes. */
export type MemoryRouterDeps = {
  memory: Pick<MemoryStore, "browse" | "read" | "search" | "history">;
};

function first(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The statuses to show: stable always, the other two unless the viewer switched them off (`draft=0`, `deprecated=0`). */
function statusesOf(query: express.Request["query"]): MemoryStatus[] {
  const statuses: MemoryStatus[] = ["stable"];
  if (first(query.draft) !== "0") statuses.push("draft");
  if (first(query.deprecated) !== "0") statuses.push("deprecated");
  return statuses;
}

function number(value: unknown): number | undefined {
  const parsed = Number(first(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function createMemoryRouter(deps: MemoryRouterDeps): express.Router {
  const router = express.Router();

  function fail(res: express.Response, err: unknown): void {
    if (err instanceof MemoryError) {
      res.status(err.code === "not_found" ? 404 : 400).json({ error: err.message });
      return;
    }
    throw err;
  }

  router.get("/api/memory/tree", (req, res) => {
    try {
      res.json(deps.memory.browse(first(req.query.dir) ?? "", statusesOf(req.query)));
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/api/memory/doc", (req, res) => {
    const path = first(req.query.path) ?? "";
    try {
      const doc = deps.memory.read(path.replace(/^\//, ""));
      if (!doc) {
        res.status(404).json({ error: "Unknown memo" });
        return;
      }
      // What replaces a deprecated memo is a string the crew wrote: only a path inside the Memory is passed on.
      const { supersededBy, ...rest } = doc;
      const resolved = supersededBy ? resolveBundleLink(doc.path, supersededBy) : null;
      const successor = resolved !== null && memoryPathProblem(resolved.slice(1)) === null ? resolved : null;
      res.json({ ...rest, ...(successor ? { supersededBy: successor } : {}) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/api/memory/history", async (req, res) => {
    try {
      const path = first(req.query.path);
      res.json(await deps.memory.history({
        ...(path !== undefined && path !== "" ? { path: path.replace(/^\//, "") } : {}),
        limit: number(req.query.limit),
        diff: first(req.query.diff) === "1",
      }));
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/api/memory/search", (req, res) => {
    res.json(deps.memory.search({
      query: first(req.query.q),
      statuses: statusesOf(req.query),
      limit: number(req.query.limit),
      offset: number(req.query.offset),
    }));
  });

  return router;
}
