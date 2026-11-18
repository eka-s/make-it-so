import { BaseAcpClient } from "./base-acp-client.js";

export class KiroAgentClient extends BaseAcpClient {
  override requiresSessionResume(): boolean {
    return true;
  }

  // The kiro agent is passed as a startup argument (--agent), so there is nothing to do after the session is created.
  override async setAgent(): Promise<boolean> {
    return true;
  }

  buildSpawnArgs(agentName?: string): { command: string; args: string[] } {
    const args = agentName
      ? [...this.settings.acp.kiro.args, "--agent", agentName]
      : [...this.settings.acp.kiro.args];
    return { command: this.settings.acp.kiro.command, args };
  }

  protected override handleProviderNotification(msg: Record<string, unknown>): void {
    if (msg.method === "_kiro.dev/metadata") {
      // kiro-cli's credit notification changed from a single `credits` field to a
      // `meteringUsage` array (elements are {value, unit}). To handle both old and new
      // kiro-cli versions, prefer the new format and fall back to the old one.
      const params = msg.params as {
        contextUsagePercentage?: number;
        credits?: number;
        meteringUsage?: Array<{ value: number; unit: string }>;
        turnDurationMs?: number;
      } | undefined;
      if (params?.contextUsagePercentage != null) {
        this.emit("usageUpdate", params.contextUsagePercentage);
      }
      const credits = params?.meteringUsage?.[0]?.value ?? params?.credits;
      if (credits != null) {
        this.emit("creditUsage", credits, params?.turnDurationMs ?? null, "kiro_credits");
      }
    }
  }
}
