import { DEFAULT_MISSION_ID, missionExists } from "../database.js";

/**
 * Extracts missionId from the request body and checks that it exists. When omitted, the default mission is used,
 * so callers that are unaware of missions (manual curl, older clients) keep working.
 * Returns undefined only when a nonexistent ID is given (the caller turns that into a 404).
 */
export function resolveMissionId(body: unknown): string | undefined {
  const raw = (body as { missionId?: unknown } | null | undefined)?.missionId;
  if (typeof raw !== "string" || !raw) return DEFAULT_MISSION_ID;
  return missionExists(raw) ? raw : undefined;
}
