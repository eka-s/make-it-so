import { KiroAgentClient } from "./kiro-agent-client.js";
import { ClaudeAgentClient } from "./claude-agent-client.js";
import type { AgentClientSettings, BaseAgentClient } from "./agent-client.interface.js";

export function createAgentClient(provider: string, settings: AgentClientSettings): BaseAgentClient {
  switch (provider) {
    case "claude":
      return new ClaudeAgentClient(settings);
    case "kiro":
    default:
      return new KiroAgentClient(settings);
  }
}
