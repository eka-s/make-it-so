import express from "express";
import type { SearchQuery, SearchRow } from "../database.js";
import { makeSnippet, parseSearchTerms, type Snippet } from "../search.js";

// Route for searching conversations. The search itself (SQL) and building the excerpts are done on the server; the client only renders.

export type SearchRouterDeps = {
  search: (query: SearchQuery) => { total: number; rows: SearchRow[] };
  /** Looks up the role name from the agent name in the DB (directory name / acp_agent name / role name). */
  agentToRole: (agent: string) => string;
};

/**
 * Maximum number of hits returned at once (beyond that, the user is asked to narrow the conditions; `truncated` tells them).
 */
export const MAX_SEARCH_HITS = 500;

/** One search hit. `id` is the id of the item in the conversation view (the jump target). */
export type SearchHit = {
  id: string;
  missionId: string;
  missionName: string;
  /** "captain", or the crew member's role name. */
  role: string;
  kind: "captain" | "reply" | "task";
  timestamp: string;
  snippet: Snippet;
  /** For a task result, whether the match was in the report or the instruction (null otherwise). */
  matchedIn: "report" | "instruction" | null;
};

function flag(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "1" || value === "true";
}

function isoOrUndefined(value: unknown): string | undefined | "invalid" {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return "invalid";
  return new Date(value).toISOString();
}

export function createSearchRouter(deps: SearchRouterDeps): express.Router {
  const router = express.Router();

  // q: search terms (space-separated AND). missions: target mission IDs (comma-separated; omitted means all).
  // from / to: period (ISO format; includes from, excludes to). captain / replies / tasks: whether to include them (all included by default).
  router.get("/api/search", (req, res) => {
    const terms = parseSearchTerms(typeof req.query.q === "string" ? req.query.q : "");
    if (terms.length === 0) {
      res.status(400).json({ error: "q is required" });
      return;
    }
    const from = isoOrUndefined(req.query.from);
    const to = isoOrUndefined(req.query.to);
    if (from === "invalid" || to === "invalid") {
      res.status(400).json({ error: "from and to must be ISO date-times" });
      return;
    }
    const missionIds = typeof req.query.missions === "string" && req.query.missions !== ""
      ? req.query.missions.split(",").filter((id) => id !== "")
      : null;
    const rawLimit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : NaN;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_SEARCH_HITS) : MAX_SEARCH_HITS;

    const { total, rows } = deps.search({
      terms,
      missionIds,
      from,
      to,
      includeCaptain: flag(req.query.captain, true),
      includeReplies: flag(req.query.replies, true),
      includeTasks: flag(req.query.tasks, true),
      limit,
    });

    const lowered = terms.map((t) => t.toLowerCase());
    const hits: SearchHit[] = rows.map((row) => {
      // For a task, the excerpt is built from the report if it contains a matched term, otherwise from the instruction
      const inReport = lowered.some((t) => row.text.toLowerCase().includes(t));
      const useInstruction = row.kind === "task" && !inReport && row.instruction !== null;
      return {
        id: row.item_id,
        missionId: row.mission_id,
        missionName: row.mission_name ?? row.mission_id,
        role: row.kind === "captain" ? "captain" : deps.agentToRole(row.agent ?? ""),
        kind: row.kind,
        timestamp: row.occurred_at,
        snippet: makeSnippet(useInstruction ? row.instruction! : row.text, terms),
        matchedIn: row.kind === "task" ? (useInstruction ? "instruction" : "report") : null,
      };
    });
    res.json({ total, truncated: total > hits.length, hits });
  });

  return router;
}
