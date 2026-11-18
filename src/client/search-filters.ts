// Search conditions (pure functions that do not depend on the screen). The period is specified in the user's local dates, and what is sent to the server is
// the start of that day (local midnight) in ISO format (the server compares only by ISO time ranges).

/** Turns "YYYY-MM-DD" (a local date) into the ISO time of 0:00 (local) of that day. undefined if invalid. */
export function dayStartIso(date: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return undefined;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const start = new Date(y, m - 1, d);
  // A date that does not exist, such as February 30, is treated as invalid
  if (start.getFullYear() !== y || start.getMonth() !== m - 1 || start.getDate() !== d) return undefined;
  return start.toISOString();
}

/**
 * The ISO time of 0:00 (local) of the day after the given day. Used for the end of the period (includes that day, excludes 0:00 of the next day).
 */
export function nextDayStartIso(date: string): string | undefined {
  const start = dayStartIso(date);
  if (start === undefined) return undefined;
  const next = new Date(start);
  next.setDate(next.getDate() + 1);
  return next.toISOString();
}

/** The missions to search. `current` is the mission open now (it follows when the open mission changes). */
export type MissionScope = { kind: "current" } | { kind: "custom"; ids: string[] };

/** Decides the IDs of the target missions. custom is narrowed to missions that exist. */
export function resolveMissionIds(scope: MissionScope, activeMissionId: string, existingIds: readonly string[]): string[] {
  if (scope.kind === "current") return [activeMissionId];
  return scope.ids.filter((id) => existingIds.includes(id));
}

/**
 * Toggles one mission checkbox. The result is always custom (the moment a checkbox is touched, it is no longer "current only").
 */
export function toggleMission(scope: MissionScope, activeMissionId: string, id: string): MissionScope {
  const current = scope.kind === "current" ? [activeMissionId] : scope.ids;
  return { kind: "custom", ids: current.includes(id) ? current.filter((x) => x !== id) : [...current, id] };
}
