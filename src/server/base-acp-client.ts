import { spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";
import { BaseAgentClient, type AgentClientSettings } from "./agent-client.interface.js";
import { logger } from "./logger.js";
import type { JsonRpcRequest, AcpStreamEvent } from "./types.js";
import { buildRemoteSpawn, type HostConfig } from "./ssh.js";
import { parseModelState, parseModeValues, parseAgentValues, type ModelState } from "./crew-model.js";
import { parseAvailableCommands, type SlashCommand } from "./slash-commands.js";

/**
 * Function that starts the agent's child process. Production uses node:child_process spawn; tests pass a fake.
 */
export type SpawnProcess = (
  command: string,
  args: string[],
  options: { cwd: string },
) => ChildProcess;

const spawnAgentProcess: SpawnProcess = (command, args, options) =>
  nodeSpawn(command, args, { stdio: ["pipe", "pipe", "pipe"], cwd: options.cwd, windowsHide: true });

/** How long an agent process gets to leave after SIGTERM before it is killed with SIGKILL. */
const KILL_GRACE_MS = 5000;

export abstract class BaseAcpClient extends BaseAgentClient {
  protected process: ChildProcess | null = null;
  private idCounter = 0;
  private pendingRequests = new Map<number, {
    resolve: (result: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();
  private pendingPermissions = new Map<number, (optionId?: string) => void>();
  private currentPromptId: number | null = null;
  // Claude Code's usage_update.cost.amount is the "cumulative cost of the whole session
  // (USD, an estimate)", so using it as is would give a value that keeps growing with every call.
  // To get the consumption per turn, we have to compute the difference from the cumulative value
  // at the start of the turn ourselves.
  private lastCostUsd = 0;
  private costAtTurnStart = 0;
  // Model information extracted from the session/new response (null for a provider that does not support it).
  private modelState: ModelState | null = null;
  // Selectable permission mode values extracted from the session/new response (empty for a provider that does not support it).
  private modeValues: string[] = [];
  private agentValues: string[] = [];
  // Available slash commands delivered by `available_commands_update`.
  private commands: SlashCommand[] = [];

  constructor(
    protected readonly settings: AgentClientSettings,
    private readonly spawnProcess: SpawnProcess = spawnAgentProcess,
  ) {
    super();
  }

  abstract buildSpawnArgs(agentName?: string): { command: string; args: string[] };

  get childProcess(): ChildProcess | null {
    return this.process;
  }

  get pid(): number | null {
    return this.process?.pid ?? null;
  }

  spawn(agentName?: string, cwd?: string, host?: HostConfig): void {
    const local = this.buildSpawnArgs(agentName);
    // When a remote host is specified, the same agent command is run over SSH
    // (cwd is cd'd to inside the command as a path on the remote side; authentication and encryption are left to SSH).
    const { command, args } = host
      ? buildRemoteSpawn(host, cwd ?? "~", local.command, local.args)
      : local;

    // The `process.cwd()` used when it is not specified (the directory make-it-so was started in) is a default
    // for compatibility. crew-manager.ts always passes the same cwd as the session. In the remote
    // case cwd is a path on the remote side, so the local process stays in the start directory.
    const proc = this.spawnProcess(command, args, { cwd: host ? process.cwd() : (cwd ?? process.cwd()) });
    this.process = proc;

    const rl = createInterface({ input: proc.stdout! });

    rl.on("line", (line) => {
      this.handleLine(line);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        logger.error(`[acp:stderr] ${msg}`);
      }
    });

    // The process has ended (or never started) once, whichever of "exit" and "error" tells it first.
    let ended = false;
    const end = (code: number | null, error: Error) => {
      if (ended) return;
      ended = true;
      if (this.process === proc) this.process = null;
      this.rejectAllPending(error);
      this.emit("exit", code);
    };

    proc.on("exit", (code) => end(code, new Error(`ACP process exited with code ${code}`)));
    // A command that cannot be started (not installed, not executable) emits "error" and no "exit". Without a listener
    // that would be an uncaught exception and stop the whole server; it is a failure of this one agent.
    proc.on("error", (err: Error) => {
      logger.error(`[acp] The agent process could not run (${command}): ${err.message}`);
      end(null, new Error(`The agent process could not be started or failed: ${err.message}`));
    });
    // Writing to a process that has just died is reported on stdin's "error"; the "exit" event follows.
    proc.stdin?.on("error", (err: Error) => {
      logger.error(`[acp] Could not write to the agent process: ${err.message}`);
    });
  }

  async initialize(): Promise<Record<string, unknown>> {
    return this.sendRequest("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "make-it-so", version: "1.0" },
      capabilities: {},
    });
  }

  async newSession(cwd: string, additionalDirectories?: string[], mcpIdentity?: Record<string, string>): Promise<string> {
    // Passes the bulletin-board MCP server dynamically through session/new, **with an identification header
    // dedicated to this session**.
    //
    // A static `.mcp.json` in the ship directory is not used: it would be one file shared by all sessions, so a call to the
    // bulletin board could not be told apart as coming from "which crew member's which mission" (which would mix up the attribution of
    // `dispatch_task` when several missions run in parallel). This dynamic injection is the
    // **only path**. With the identification carried in a header, it can be judged objectively
    // without relying on the model's self-report.
    //
    // Verified: claude-agent-acp converts `params.mcpServers` into the CLI's mcpServers setting, and `dispatch_task` works with no static file.
    // additionalDirectories is a standard ACP field that extends the file system scope
    // without changing cwd (the targets mechanism).
    const mcpServers = [{
      name: "board",
      type: "http",
      url: `http://127.0.0.1:${this.settings.mcpPort}/mcp`,
      headers: Object.entries(mcpIdentity ?? {}).map(([name, value]) => ({ name, value })),
    }];
    const result = await this.sendRequest("session/new", {
      cwd,
      additionalDirectories: additionalDirectories ?? [],
      mcpServers,
    });
    this.modelState = parseModelState(result);
    this.modeValues = parseModeValues(result);
    this.agentValues = parseAgentValues(result);
    return result.sessionId as string;
  }

  override getCommands(): SlashCommand[] {
    return this.commands;
  }

  override getModelState(): ModelState | null {
    return this.modelState;
  }

  override async setPermissionMode(sessionId: string, mode: string): Promise<boolean> {
    if (!this.modeValues.includes(mode)) return false;
    await this.sendRequest("session/set_config_option", { sessionId, configId: "mode", value: mode });
    return true;
  }

  override async setAgent(sessionId: string, agent: string): Promise<boolean> {
    if (!this.agentValues.includes(agent)) return false;
    await this.sendRequest("session/set_config_option", { sessionId, configId: "agent", value: agent });
    return true;
  }

  override async setModel(sessionId: string, model: string): Promise<void> {
    if (!this.modelState) return; // a provider that does not support model switching
    const result = await this.sendRequest("session/set_config_option", {
      sessionId,
      configId: "model",
      value: model,
    });
    this.modelState = parseModelState(result) ?? { ...this.modelState, current: model };
  }

  async sendPrompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    const id = this.nextId();
    this.currentPromptId = id;
    this.costAtTurnStart = this.lastCostUsd;

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text }],
      },
    };

    this.write(request);

    return new Promise<{ stopReason: string }>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (result) => {
          const stopReason = (result.stopReason as string) ?? "unknown";
          this.emit("complete", { stopReason });
          this.currentPromptId = null;
          resolve({ stopReason });
        },
        reject: (error) => {
          this.currentPromptId = null;
          reject(error);
        },
      });
    });
  }

  sendCancel(sessionId: string): void {
    if (!this.process?.stdin?.writable) {
      throw new Error("ACP process stdin is not writable");
    }
    const notification = {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId },
    };
    this.process.stdin.write(JSON.stringify(notification) + "\n");
    // ACP: after a cancel, every permission request still waiting for an answer is answered as "cancelled". Otherwise the agent
    // keeps waiting for the captain and only the force-kill ends the turn.
    const waiting = [...this.pendingPermissions.entries()];
    this.pendingPermissions.clear();
    for (const [, resolver] of waiting) resolver(undefined);
    if (waiting.length > 0) this.emit("permissionsCancelled", waiting.map(([id]) => id));
  }

  kill(): void {
    const proc = this.process;
    if (!proc) return;
    this.process = null;
    // Whoever is waiting on this process is told now: a process that ignores SIGTERM never reports an exit.
    this.rejectAllPending(new Error("The ACP process was killed"));
    proc.kill();
    // An agent that does not leave on SIGTERM is stopped for good, so it cannot linger.
    const force = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    }, KILL_GRACE_MS);
    force.unref();
  }

  private nextId(): number {
    return ++this.idCounter;
  }

  private write(request: JsonRpcRequest): void {
    if (!this.process?.stdin?.writable) {
      throw new Error("ACP process stdin is not writable");
    }
    this.process.stdin.write(JSON.stringify(request) + "\n");
  }

  protected async sendRequest(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId();
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.write(request);
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    const msg = parsed as Record<string, unknown>;

    // Streaming event
    if (!("id" in msg) && msg.method === "session/update") {
      const params = msg.params as { update?: Record<string, unknown> } | undefined;
      if (params?.update) {
        this.handleStreamEvent(params.update as unknown as AcpStreamEvent);
      }
      return;
    }

    // Provider-specific notifications (overridden in subclasses)
    if (!("id" in msg) && typeof msg.method === "string") {
      this.handleProviderNotification(msg);
      return;
    }

    // A request from the server to the client (has both id and method)
    if ("id" in msg && "method" in msg) {
      this.handleServerRequest(msg);
      return;
    }

    // JSON-RPC response
    if ("id" in msg) {
      const id = msg.id as number;
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        if (msg.error) {
          const err = msg.error as { code?: number; message: string };
          pending.reject(new Error(err.message));
        } else {
          pending.resolve((msg.result as Record<string, unknown>) ?? {});
        }
      }
    }
  }

  private handleServerRequest(msg: Record<string, unknown>): void {
    const id = msg.id as number;
    const method = msg.method as string;
    const params = (msg.params ?? {}) as Record<string, unknown>;

    if (method === "session/request_permission") {
      const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
      const request = {
        requestId: id,
        sessionId: params.sessionId as string,
        toolName: (toolCall.title as string) ?? (toolCall.toolCallId as string) ?? "unknown",
        toolInput: (toolCall.rawInput ?? {}) as Record<string, unknown>,
        options: (params.options ?? []) as Array<{ kind: string; name: string; optionId?: string }>,
      };
      this.pendingPermissions.set(id, (optionId) => {
        const result = optionId
          ? { outcome: { outcome: "selected", optionId } }
          : { outcome: { outcome: "cancelled" } };
        this.writeResponse(id, result);
      });
      this.emit("permissionRequest", request);
    } else {
      // Unknown server request — rejected by default so it does not hang
      this.writeResponse(id, { behavior: "deny", message: `Unhandled method: ${method}` });
    }
  }

  override hasPendingPermissions(): boolean {
    return this.pendingPermissions.size > 0;
  }

  /** Answers a pending permission request. Returns false when there is no such request (already answered, or cancelled). */
  respondToPermission(requestId: number, optionId: string): boolean {
    const resolver = this.pendingPermissions.get(requestId);
    if (!resolver) return false;
    this.pendingPermissions.delete(requestId);
    resolver(optionId);
    return true;
  }

  private writeResponse(id: number, result: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) return;
    const response = { jsonrpc: "2.0", id, result };
    this.process.stdin.write(JSON.stringify(response) + "\n");
  }

  // Override in a subclass to handle provider-specific notifications
  protected handleProviderNotification(_msg: Record<string, unknown>): void {}

  private handleStreamEvent(event: AcpStreamEvent): void {
    if (!event || typeof (event as Record<string, unknown>).sessionUpdate !== "string") return;

    const raw = event as Record<string, unknown>;

    switch (event.sessionUpdate) {
      case "agent_message_chunk": {
        const content = raw.content as { type?: string; text?: string } | undefined;
        this.emit("chunk", content?.text ?? "");
        break;
      }
      case "tool_call": {
        this.emit("toolCall", (raw.title as string) ?? "");
        break;
      }
      case "tool_call_update": {
        const contentArr = raw.content as Array<{ type?: string; content?: { type?: string; text?: string } }> | undefined;
        let text = "";
        if (Array.isArray(contentArr)) {
          text = contentArr.map((item) => item?.content?.text ?? "").filter(Boolean).join("");
        }
        if (!text && raw.title) {
          text = raw.title as string;
        }
        this.emit("toolCallUpdate", text);
        break;
      }
      case "available_commands_update": {
        this.commands = parseAvailableCommands(raw.availableCommands);
        this.emit("commands", this.commands);
        break;
      }
      case "usage_update": {
        const used = raw.used as number;
        const size = raw.size as number;
        if (size > 0) {
          this.emit("usageUpdate", (used / size) * 100);
        }
        // cost is an extension field that Claude Code ACP adds on its own (claude-agent-acp
        // puts `total_cost_usd` here; it is not a standard field of the ACP spec,
        // so other provider implementations may not have it). It is cumulative, so
        // the difference from the start of the turn is reported as what was consumed this time — even when it arrives
        // several times during a turn, we always send the "cumulative difference since the start of the turn"
        // (not a difference of differences), so bridge.ts/crew-manager.ts can use the last received
        // value as is to get the correct turn total.
        const cost = raw.cost as { amount?: number } | undefined;
        if (typeof cost?.amount === "number") {
          this.lastCostUsd = cost.amount;
          const turnCost = this.lastCostUsd - this.costAtTurnStart;
          if (turnCost > 0) this.emit("creditUsage", turnCost, null, "usd");
        }
        break;
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}
