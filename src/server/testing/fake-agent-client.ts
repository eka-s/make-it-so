import type { ChildProcess } from "node:child_process";
import {
  BaseAgentClient,
  type PermissionRequest,
} from "../agent-client.interface.js";
import type { HostConfig } from "../ssh.js";
import type { ModelState } from "../crew-model.js";
import type { SlashCommand } from "../slash-commands.js";

/**
 * A fake agent for tests. It does not start a real process: it records what was called
 * and lets tests fire events (chunks, completion, permission requests, etc.).
 * Used to exercise the flows of CrewManager and Bridge without a real agent.
 */
export class FakeAgentClient extends BaseAgentClient {
  // --- Records ---
  spawnCalls: Array<{ agentName?: string; cwd?: string; host?: HostConfig }> = [];
  initializeCalls = 0;
  newSessionCalls: Array<{
    cwd: string;
    additionalDirectories?: string[];
    mcpIdentity?: Record<string, string>;
  }> = [];
  prompts: Array<{ sessionId: string; text: string }> = [];
  cancels: string[] = [];
  permissionResponses: Array<{ requestId: number; optionId: string }> = [];
  killed = false;
  /** Fake model info. null mimics a provider that does not support model switching. */
  modelState: ModelState | null = null;
  setModelCalls: Array<{ sessionId: string; model: string }> = [];
  /** Selectable permission modes (empty mimics a provider that does not support them). */
  modeValues: string[] = [];
  setPermissionModeCalls: Array<{ sessionId: string; mode: string }> = [];
  /** Selectable agents (provider-side agent definitions; empty means no agent can be selected). */
  agentValues: string[] = [];
  setAgentCalls: Array<{ sessionId: string; agent: string }> = [];
  /** Available slash commands (delivered as a notification from the agent via `pushCommands`). */
  commands: SlashCommand[] = [];

  /** Creates the situation where the agent has notified the list of available commands. */
  pushCommands(commands: SlashCommand[]): void {
    this.commands = commands;
    this.emit("commands", commands);
  }

  override getCommands(): SlashCommand[] {
    return this.commands;
  }

  // --- Behavior settings ---
  /** Replaces the response of sendPrompt (default: completes right away with end_turn). */
  promptHandler: (text: string) => Promise<{ stopReason: string }> = async () => ({ stopReason: "end_turn" });
  /** When true, initialize fails. */
  failInitialize = false;
  /**
   * When true, initialize never finishes (it fails when killed; mimics a provider that does not respond).
   */
  hangInitialize = false;
  /**
   * When set, initialize waits until this Promise resolves (it does not fail when killed; mimics a slow start that eventually finishes).
   */
  initializeGate: Promise<void> | null = null;
  private onKill: (() => void) | null = null;
  sessionId = "fake-session";
  readonly requiresResume: boolean;

  constructor(options: { requiresSessionResume?: boolean } = {}) {
    super();
    this.requiresResume = options.requiresSessionResume ?? false;
  }

  /** Set to true to look like a client with a permission request waiting for the captain. */
  pendingPermission = false;
  /** Set to make the fake look like a process that has ended. */
  ended = false;

  override hasPendingPermissions(): boolean {
    return this.pendingPermission;
  }

  get pid(): number | null {
    return this.ended ? null : 12345;
  }

  get childProcess(): ChildProcess | null {
    return null;
  }

  spawn(agentName?: string, cwd?: string, host?: HostConfig): void {
    this.spawnCalls.push({ agentName, cwd, host });
  }

  async initialize(): Promise<Record<string, unknown>> {
    this.initializeCalls++;
    if (this.failInitialize) throw new Error("initialize failed");
    if (this.hangInitialize) {
      await new Promise<void>((_, reject) => {
        this.onKill = () => reject(new Error("killed while initializing"));
      });
    }
    if (this.initializeGate) await this.initializeGate;
    return {};
  }

  async newSession(
    cwd: string,
    additionalDirectories?: string[],
    mcpIdentity?: Record<string, string>,
  ): Promise<string> {
    this.newSessionCalls.push({ cwd, additionalDirectories, mcpIdentity });
    return this.sessionId;
  }

  async sendPrompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    this.prompts.push({ sessionId, text });
    return this.promptHandler(text);
  }

  sendCancel(sessionId: string): void {
    this.cancels.push(sessionId);
  }

  kill(): void {
    this.killed = true;
    this.onKill?.();
  }

  override getModelState(): ModelState | null {
    return this.modelState;
  }

  override async setModel(sessionId: string, model: string): Promise<void> {
    if (!this.modelState) return;
    this.setModelCalls.push({ sessionId, model });
    this.modelState = { ...this.modelState, current: model };
  }

  override async setPermissionMode(sessionId: string, mode: string): Promise<boolean> {
    if (!this.modeValues.includes(mode)) return false;
    this.setPermissionModeCalls.push({ sessionId, mode });
    return true;
  }

  override async setAgent(sessionId: string, agent: string): Promise<boolean> {
    if (!this.agentValues.includes(agent)) return false;
    this.setAgentCalls.push({ sessionId, agent });
    return true;
  }

  override requiresSessionResume(): boolean {
    return this.requiresResume;
  }

  /** Called by CrewManager.respondToPermission (same shape as BaseAcpClient). */
  respondToPermission(requestId: number, optionId: string): void {
    this.permissionResponses.push({ requestId, optionId });
  }

  // --- Firing events from tests ---
  emitExit(code: number | null = 1): void {
    this.emit("exit", code);
  }

  emitPermissionRequest(request: Partial<PermissionRequest> = {}): PermissionRequest {
    const full: PermissionRequest = {
      requestId: 1,
      sessionId: this.sessionId,
      toolName: "Write",
      toolInput: {},
      options: [],
      ...request,
    };
    this.emit("permissionRequest", full);
    return full;
  }

  emitUsage(percentage: number): void {
    this.emit("usageUpdate", percentage);
  }
}
