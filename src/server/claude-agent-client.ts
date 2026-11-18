import { BaseAcpClient } from "./base-acp-client.js";

export class ClaudeAgentClient extends BaseAcpClient {
  buildSpawnArgs(_agentName?: string): { command: string; args: string[] } {
    return { command: this.settings.acp.claude.command, args: [...this.settings.acp.claude.args] };
  }

  // The persona injected by MIS is sent by the caller (createSession in crew-manager.ts) as the first prompt
  // after the session is created. Crew members that use a provider-side agent definition (`.claude/agents/*.md`)
  // pick it with `setAgent` (BaseAcpClient) after the session is created.

  // Context usage arrives via usage_update's sessionUpdate (handled by the base class).
  // Nothing equivalent to _kiro.dev/metadata is needed.
}
