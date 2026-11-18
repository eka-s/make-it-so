import os from "node:os";
import type { CrewRole } from "./types.js";
import { agentToRole as resolveAgentRole, type CrewMemberConfig } from "./fleet-config.js";
import { loadConfig } from "./load-config.js";
import { parseShipArg } from "./ship-arg.js";

// Re-exported so that existing import sites (those that take CrewMemberConfig from `./config.js`) do not need to change.
export type { CrewMemberConfig };

// Reads the config from the real process (the --ship argument, the home directory). The loading logic lives in load-config.ts (a testable function).
// Only index.ts, the wiring layer, may import this file.
export const config = loadConfig({ shipId: parseShipArg(process.argv.slice(2)), homeDir: os.homedir(), log: console.log });

// Maps a crew directory name (agent_dir, derived from the task file path that the Relay detects) to the role name defined by the ship (ship.yml),
// via the crew config. It lives here rather than in index.ts so that database.ts can also use it when building the role
// of a crew task's TimelineItem (see getTimelineEventsHistory in database.ts) without a circular import between index.ts and database.ts.
export function agentToRole(agentDir: string): CrewRole {
  return resolveAgentRole(config.crew, agentDir);
}

/**
 * Looks up the human-readable display name from an agent's directory name. Falls back to the directory name itself. Used by bridge.ts when building the Report prompt and by the unreported-tasks API in index.ts.
 */
export function crewDisplayName(agentDir: string): string {
  const role = agentToRole(agentDir);
  return config.crew[role]?.name ?? agentDir;
}
