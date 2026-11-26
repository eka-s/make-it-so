import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The secret each crew session presents to `/mcp`. It is derived from the ship's secret and the session's identity (agent and
 * mission), so a session cannot present another crew member's identification header with its own secret.
 */
export type McpTokens = {
  issue: (agent: string, missionId: string) => string;
  verify: (agent: string, missionId: string, presented: unknown) => boolean;
};

export function createMcpTokens(secret: string): McpTokens {
  // The length prefix keeps ("a", "bc") and ("ab", "c") apart.
  const issue = (agent: string, missionId: string): string =>
    createHmac("sha256", secret).update(`${agent.length}:${agent}${missionId}`).digest("hex");
  return {
    issue,
    verify(agent, missionId, presented) {
      if (typeof presented !== "string") return false;
      const a = Buffer.from(presented);
      const b = Buffer.from(issue(agent, missionId));
      return a.length === b.length && timingSafeEqual(a, b);
    },
  };
}
