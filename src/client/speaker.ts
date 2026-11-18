import type { CrewMemberConfig } from "./types";

/**
 * The name shown for the speaker of a message or a pin: the captain's label, or the crew
 * member's display name (the role itself when the crew has no entry for it).
 */
export function speakerName(
  role: string,
  crewConfig: Record<string, CrewMemberConfig> | undefined,
  captainLabel: string,
): string {
  return role === "captain" ? captainLabel : (crewConfig?.[role]?.name ?? role);
}
