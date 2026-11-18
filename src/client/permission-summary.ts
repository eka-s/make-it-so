import type { PendingPermission } from "./types";

// Pure functions that aggregate pending permissions (approvals) for display.
// "Which mission's" and "which crew member's" approval it is uses the values the server attached
// (`ownerMissionId`, `role`) as they are — the client does not parse scope strings or agent names again.

/** Returns only the approvals of the given mission (the part shown in the tray above the input box). */
export function permissionsOfMission(permissions: PendingPermission[], missionId: string): PendingPermission[] {
  return permissions.filter((p) => p.ownerMissionId === missionId);
}

/** Number of pending approvals per mission. */
export function countByMission(permissions: PendingPermission[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of permissions) counts[p.ownerMissionId] = (counts[p.ownerMissionId] ?? 0) + 1;
  return counts;
}

/** Number of pending approvals per crew member (role) in the given mission. */
export function countByRole(permissions: PendingPermission[], missionId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of permissionsOfMission(permissions, missionId)) counts[p.role] = (counts[p.role] ?? 0) + 1;
  return counts;
}

/**
 * Title of the browser tab. If there are pending approvals, 🔐 and the total count across all missions are put at the front.
 */
export function tabTitle(baseTitle: string, pendingTotal: number): string {
  return pendingTotal > 0 ? `🔐(${pendingTotal}) ${baseTitle}` : baseTitle;
}
