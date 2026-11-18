import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { HostConfig } from "./ssh.js";
import type { ModelState } from "./crew-model.js";
import type { SlashCommand } from "./slash-commands.js";

export type PermissionOption = {
  kind: string;
  name: string;
  optionId?: string;
};

export type PermissionRequest = {
  requestId: number;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  options: PermissionOption[];
};

export type AgentClientEvents = {
  chunk: [text: string];
  toolCall: [title: string];
  toolCallUpdate: [text: string];
  usageUpdate: [percentage: number];
  creditUsage: [credits: number, turnDurationMs: number | null, unit: "usd" | "kiro_credits"];
  complete: [result: { stopReason: string }];
  error: [error: Error];
  exit: [code: number | null];
  permissionRequest: [request: PermissionRequest];
  /** The permission requests that were still pending were answered as cancelled, because the captain stopped the turn. */
  permissionsCancelled: [requestIds: number[]];
  /** The list of available slash commands arrived (the whole list is sent again on every update). */
  commands: [commands: SlashCommand[]];
};

/** Agent startup command per provider. */
export type AcpCommand = { command: string; args: string[] };

/**
 * Settings the agent client needs. The caller (index.ts) passes them in so that this does not depend on the ship config (config.ts).
 */
export type AgentClientSettings = {
  /** HTTP port of make-it-so. Used for the URL of the bulletin-board MCP (`http://127.0.0.1:{port}/mcp`). */
  port: number;
  acp: { kiro: AcpCommand; claude: AcpCommand };
};

export abstract class BaseAgentClient extends EventEmitter<AgentClientEvents> {
  abstract get pid(): number | null;
  /** Whether a permission request is waiting for the captain's answer (a wait that is not a hang; see the idle timers). */
  hasPendingPermissions(): boolean {
    return false;
  }
  abstract get childProcess(): ChildProcess | null;
  // `agentName` is the name of the provider-side agent definition (`agent` in ship.yml; for kiro it is passed as the
  // `--agent` startup argument; undefined if not specified). claude does not use it at startup and gets it
  // via `setAgent` after the session is created. `cwd` is the process's own cwd —
  // pass the same value as the session's cwd (newSession) (kiro looks for the agent definition from the
  // process's cwd, so a mismatch makes the setting silently ignored).
  //
  // When `host` is given, it is started on the remote host over SSH (in that case `cwd` is a path
  // on the remote side; see ssh.ts).
  abstract spawn(agentName?: string, cwd?: string, host?: HostConfig): void;
  abstract initialize(): Promise<Record<string, unknown>>;
  // `mcpIdentity` is the HTTP header put in the MCP server config dedicated to this session.
  // It lets the bulletin-board MCP receive "which session (= which crew member's which mission) the call came from"
  // as an objective fact in an HTTP header, not as the model's self-report.
  abstract newSession(cwd: string, additionalDirectories?: string[], mcpIdentity?: Record<string, string>): Promise<string>;
  abstract sendPrompt(sessionId: string, text: string): Promise<{ stopReason: string }>;
  abstract sendCancel(sessionId: string): void;
  abstract kill(): void;

  /**
   * The model this client is using now and the list of selectable ones. null when model switching
   * is not supported (the session creation response has no options) or before the session is created.
   */
  getModelState(): ModelState | null {
    return null;
  }

  /** Switches the session's model (does nothing if not supported). */
  async setModel(_sessionId: string, _model: string): Promise<void> {}

  /**
   * Switches the session's permission mode. If the given mode cannot be selected (a provider that does not
   * support it, or a value not among the options), does nothing and returns false.
   */
  async setPermissionMode(_sessionId: string, _mode: string): Promise<boolean> {
    return false;
  }

  /**
   * Selects the session's agent (provider-side agent definition). If that agent cannot be selected (a provider that
   * does not support it, or a name not among the options), does nothing and returns false. A provider that takes it at startup
   * (kiro) has already applied it, so it returns true.
   */
  async setAgent(_sessionId: string, _agent: string): Promise<boolean> {
    return false;
  }

  /**
   * Slash commands available in this session. Empty if not yet received or if the provider does not support them.
   */
  getCommands(): SlashCommand[] {
    return [];
  }

  requiresSessionResume(): boolean {
    return false;
  }
}
