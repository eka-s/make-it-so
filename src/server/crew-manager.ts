import { EventEmitter } from "node:events";
import type { BaseAgentClient } from "./agent-client.interface.js";
import type { PermissionRequest } from "./agent-client.interface.js";
import type { CrewMemberConfig } from "./fleet-config.js";
import type { HostConfig } from "./ssh.js";
import type { SlashCommand } from "./slash-commands.js";
import { resolveCrewModel, type ModelOption } from "./crew-model.js";
import type { Language } from "./language.js";
import { buildBriefing } from "./crew-briefing.js";
import { reportActivity } from "./bridge-activity.js";
import { missionFromTaskScope } from "./crew-runner.js";
import { logger } from "./logger.js";


/**
 * Name of the HTTP header that lets calls to the bulletin-board MCP (mcp-board.ts) identify the calling session.
 * It is passed as that session's own MCP server config when the session is created (see newSession in base-acp-client.ts).
 */
export const MCP_AGENT_HEADER = "x-makeitso-agent";
export const MCP_MISSION_HEADER = "x-makeitso-mission";
/**
 * The header that carries the ship's secret for `/mcp`. The endpoint listens on a TCP port that a browser page or another local
 * process could reach, so a call is accepted only when it carries the value that make-it-so itself put into the session's config.
 */
export const MCP_TOKEN_HEADER = "x-makeitso-token";

// If persona injection shows no activity for this long, it is considered hung, rather than
// blocking the session's startup forever with no signal at all
// — the same safeguard against the same failure mode as in crew-runner.ts (task execution) and bridge.ts (turn execution).
// If there is no response for a long time, it is treated as a startup failure (a model that does not respond is as good as unusable.
// A reply to the briefing can be a single word, so this long a silence almost certainly means a hang).
const PERSONA_IDLE_TIMEOUT_MS = 90 * 1000;

// Upper limit for the whole session startup (process start, initialization, session creation, sending the briefing).
// Beyond it, the starting process is stopped and the startup is treated as a failure — a mission is never left stuck
// in a processing state because the provider does not respond.
const STARTUP_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * A marker that tells the startup code that the startup was treated as a failure (limit exceeded or aborted).
 */
type StartToken = { aborted: boolean };

/** Sending the briefing timed out with no response (treated as a startup failure). */
class PersonaHungError extends Error {}

/** The caller aborted a session that was starting up (e.g. the captain stopped it). */
export class SessionStartAbortedError extends Error {}

/**
 * One session = one (crew member, mission) pair. Even the same crew member has a different process and a different context
 * in a different mission — the design decision is that "crew member X on mission A and crew member X on mission B
 * are the same crew member but have different memories".
 */
export type AgentSession = {
  client: BaseAgentClient;
  sessionId: string;
  crewConfig: CrewMemberConfig;
  agentName: string;
  missionId: string;
  /**
   * Spine id of the timeline event last injected into this session
   * (0 = nothing injected yet). The next time this crew member is addressed,
   * only the mission conversation after this point is passed as a delta.
   *
   * **It is essential to hold this as part of the session object**:
   * when the process dies and is recreated, this goes away along with the session and returns to 0 —
   * so the accident of wrongly judging "a delta is enough" for a new session (which truly remembers nothing)
   * cannot structurally happen.
   */
  lastSeenSeq: number;
  /**
   * The model right after the session was created (before switching the model). What to go back to when an override is cleared.
   */
  defaultModel?: string;
};

/**
 * Key for session management and permission routing. Folds a (crew member, mission) pair into one string.
 */
function sessionKey(agentName: string, missionId: string): string {
  return `${agentName}::${missionId}`;
}

type CrewManagerEvents = {
  permissionRequest: [agent: string, request: PermissionRequest, missionId: string];
  /** The pending permission requests of this session were cancelled together with a stopped turn. */
  permissionsCancelled: [agent: string, missionId: string];
  // Even if only the real process of one crew agent dies, the main process itself is
  // not affected — the pending permission requests of that agent can never be
  // answered again.
  agentExited: [agent: string, missionId: string];
  // Fired when a conversation session's "starting" or "restarting" begins/ends.
  // A signal for the screen to re-fetch the crew status (role is aligned to the role name).
  sessionStatusChanged: [role: string, missionId: string];
};

/** Stage of a conversation session coming up (used for the crew status display). */
export type SessionPhase = "starting" | "restarting";

/**
 * The ship settings CrewManager needs. The caller passes them in so that this does not depend on the ship config (config.ts).
 */
export type CrewManagerSettings = {
  /** The ship's crew (role name → crew config). */
  crew: Record<string, CrewMemberConfig>;
  /** Default provider for crew members whose provider is not specified in the roster. */
  defaultProvider: string;
  /** Location of the fleet roster (where `personnel/` lives). */
  fleetRoot: string;
  /** Ship root (where workspace/ and report-format.md live). */
  projectRoot: string;
  /** Directory for the ship's own Skills. */
  skillsDir: string;
  /** The language the crew speaks. Read each time a session starts. */
  crewLanguage: () => Language;
  /** The secret that `/mcp` requires (see MCP_TOKEN_HEADER). */
  mcpToken: string;
};

/** External dependencies of CrewManager. index.ts wires them in production; tests pass fakes. */
export type CrewManagerDeps = {
  settings: CrewManagerSettings;
  /** Creates an agent client from a provider. */
  createClient: (provider: string) => BaseAgentClient;
  /** Waits until the reverse tunnel to the remote host is established. */
  ensureTunnel: (host: HostConfig) => Promise<void>;
  /**
   * Returns the model overridden per mission for this session's crew member (undefined if none).
   * `scope` is the session's scope (a mission ID, or a task-running scope), and
   * translating it to the real mission ID is done by the caller (index.ts).
   */
  getModelOverride: (role: string, scope: string) => string | undefined;
  /**
   * A cache (optional) of each provider's "selectable model list". It lets the screen show something for crew members
   * whose session has not been created yet, even right after a server restart.
   */
  modelOptionsStore?: {
    load: (provider: string) => ModelOption[];
    save: (provider: string, options: ModelOption[]) => void;
  };
  /**
   * A cache (optional) of each provider's "available slash commands". The list only arrives once a session has started,
   * so the last known content is kept so that the previous list can be offered as candidates even before startup.
   */
  commandsStore?: {
    load: (provider: string) => SlashCommand[];
    save: (provider: string, commands: SlashCommand[]) => void;
  };
  /**
   * Upper limit for the whole session startup (milliseconds). 3 minutes when omitted. Can be specified to shorten it in tests.
   */
  startupTimeoutMs?: number;
  /**
   * Upper limit for no response while sending the briefing (milliseconds). 90 seconds when omitted. Can be specified to shorten it in tests.
   */
  personaIdleTimeoutMs?: number;
};

export class CrewManager extends EventEmitter<CrewManagerEvents> {
  constructor(private readonly deps: CrewManagerDeps) {
    super();
  }

  // Every key is `sessionKey()` (= a (crew member, mission) pair).
  private sessions = new Map<string, AgentSession>();
  // A client is keyed from the moment it is created — before the session is cached
  // (sessions.set only happens after persona injection completes).
  // A permission request can fire during that setup period too, so its response must always be routable.
  // Routing through `sessions` would silently drop it and
  // the agent would deadlock in the middle of the injection.
  private clients = new Map<string, BaseAgentClient>();
  // Sessions that are starting up (the key is sessionKey). Holds a handle for aborting them.
  private starts = new Map<string, { abort: () => void }>();
  // A start that is running, by session key: a second request for the same session (a restart, then a message) waits for it
  // instead of starting another one, which would kill the first one's client as "stale" and fail both.
  private startsInFlight = new Map<string, Promise<AgentSession>>();
  // The bump function for the persona injection happening right now (per key) — reset by
  // permission requests/responses, so that a slow human approval is
  // not treated as a hang.
  private personaInjectionBump = new Map<string, () => void>();
  // The "selectable model list" per provider. It becomes known once a session of that provider has been
  // created (it is in the session creation response). Also used for the screen display of crew members
  // who have no session yet.
  private modelOptionsByProvider = new Map<string, ModelOption[]>();
  // Context usage (%) per conversation session (crew member, mission).
  // Held in memory only — when a session goes away its context returns to empty,
  // so it matches reality that the value goes away with the session. Task-running sessions
  // are throwaway, so they are not tracked.
  private contextPercent = new Map<string, number>();
  // Available slash commands per conversation session (notified by the agent; held in memory only).
  private commands = new Map<string, SlashCommand[]>();
  // Conversation sessions that are starting or restarting (the key is a sessionKey aligned to the role). A count is kept
  // so that overlapping startups of the same session do not clear the state too early.
  private starting = new Map<string, number>();
  private restarting = new Map<string, number>();

  private bump(map: Map<string, number>, key: string, delta: 1 | -1): void {
    const next = (map.get(key) ?? 0) + delta;
    if (next > 0) map.set(key, next);
    else map.delete(key);
  }

  /**
   * Stage of a conversation session coming up. restarting > starting. undefined if neither.
   * Without `missionId`, any mission will do (for the overall picture).
   */
  sessionPhase(role: string, missionId?: string): SessionPhase | undefined {
    const matches = (map: Map<string, number>): boolean =>
      missionId !== undefined
        ? map.has(sessionKey(role, missionId))
        : [...map.keys()].some((k) => k.startsWith(`${role}::`));
    if (matches(this.restarting)) return "restarting";
    if (matches(this.starting)) return "starting";
    return undefined;
  }

  /**
   * Context usage (%) of the conversation session. undefined if there is no session or it is not known yet.
   */
  getContextPercent(role: string, missionId: string): number | undefined {
    return this.contextPercent.get(sessionKey(role, missionId));
  }

  /**
   * Slash commands available in the conversation session. If the session's list has not arrived yet (before startup, etc.),
   * returns the list last known for that provider (the cache). Empty if there is no cache either.
   */
  getCommands(role: string, missionId: string): SlashCommand[] {
    const live = this.commands.get(sessionKey(this.roleOf(role), missionId));
    if (live) return live;
    const crew = this.deps.settings.crew[this.roleOf(role)];
    const provider = crew?.provider ?? this.deps.settings.defaultProvider;
    return this.deps.commandsStore?.load(provider) ?? [];
  }

  /**
   * Whether the `getCommands` list is the latest one that arrived from the running session (if false, it is the cache, or empty).
   */
  hasLiveCommands(role: string, missionId: string): boolean {
    return this.commands.has(sessionKey(this.roleOf(role), missionId));
  }

  /** Returns the role name (`agentName` may be a role name or an acp_agent name). */
  private roleOf(agentName: string): string {
    if (this.deps.settings.crew[agentName]) return agentName;
    const entry = Object.entries(this.deps.settings.crew)
      .find(([, c]) => (c.acp_agent ?? c.name.toLowerCase()) === agentName);
    return entry ? entry[0] : agentName;
  }

  /** The model list selectable for that provider (empty if no session has ever been created). */
  getModelOptions(provider: string): ModelOption[] {
    const known = this.modelOptionsByProvider.get(provider);
    if (known) return known;
    const stored = this.deps.modelOptionsStore?.load(provider) ?? [];
    if (stored.length > 0) this.modelOptionsByProvider.set(provider, stored);
    return stored;
  }

  /**
   * The model the actual session of (crew member, mission) is using now.
   * The conversation session takes priority; if there is none, the task-running session is looked at.
   * undefined if neither exists.
   */
  getLiveModel(role: string, missionId: string, taskScope: string): string | undefined {
    for (const scope of [missionId, taskScope]) {
      const session = this.sessions.get(sessionKey(role, scope));
      const current = session?.client.getModelState()?.current;
      if (current) return current;
    }
    return undefined;
  }

  /**
   * Reflects a mission's crew model in the running sessions.
   * If `model` is undefined, goes back to the original model from right after the session was created.
   * It is reflected in both the conversation and task-running sessions, and does nothing if there is no session
   * (it will be applied via `getModelOverride` the next time one is created).
   */
  async applyModel(role: string, missionId: string, taskScope: string, model: string | undefined): Promise<void> {
    for (const scope of [missionId, taskScope]) {
      const session = this.sessions.get(sessionKey(role, scope));
      if (!session) continue;
      const target = model ?? session.defaultModel;
      if (!target || session.client.getModelState()?.current === target) continue;
      await session.client.setModel(session.sessionId, target);
    }
  }


  /**
   * Only peeks at an existing session (without creating one) — used when bridge.ts looks for a cancel/restart target. undefined if there is none (the caller may treat it as "does not exist right now").
   */
  getExistingSession(agentName: string, missionId: string): AgentSession | undefined {
    return this.sessions.get(sessionKey(agentName, missionId));
  }

  /**
   * Forcibly discards a session — used by bridge.ts's auto-recovery and by an explicit restart by the captain.
   * The next time `getOrCreateSession()` is called, a new process and a new session
   * are started (and lastSeenSeq also goes back to 0, so the mission's conversation is injected afresh).
   */
  killSession(agentName: string, missionId: string): void {
    const key = sessionKey(agentName, missionId);
    // A start that is running is killed with its client; the next request must not wait for that failing start.
    this.startsInFlight.delete(key);
    const client = this.clients.get(key);
    if (client) client.kill();
    this.clients.delete(key);
    this.sessions.delete(key);
    this.contextPercent.delete(sessionKey(this.roleOf(agentName), missionId));
    this.commands.delete(sessionKey(this.roleOf(agentName), missionId));
  }

  private buildAgentMap(): Map<string, CrewMemberConfig> {
    const map = new Map<string, CrewMemberConfig>();
    for (const [role, member] of Object.entries(this.deps.settings.crew)) {
      // As a directory name, both the role name (chief_engineer) and the acp_agent name (e.g. a roster member id) are supported
      map.set(role, member);
      const acpAgent = member.acp_agent ?? member.name.toLowerCase();
      if (acpAgent !== role) map.set(acpAgent, member);
    }
    return map;
  }

  async getOrCreateSession(agentName: string, missionId: string): Promise<AgentSession> {
    const key = sessionKey(agentName, missionId);
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const running = this.startsInFlight.get(key);
    if (running) return running;

    // While a conversation session is starting, show "starting" on screen (a task-running one is throwaway, so it is not shown).
    const trackedKey = missionFromTaskScope(missionId) ? undefined : sessionKey(this.roleOf(agentName), missionId);
    const start = (async () => {
      if (trackedKey) {
        this.bump(this.starting, trackedKey, 1);
        this.emit("sessionStatusChanged", this.roleOf(agentName), missionId);
      }
      try {
        return await this.startWithGuard(agentName, missionId, key);
      } finally {
        if (trackedKey) {
          this.bump(this.starting, trackedKey, -1);
          this.emit("sessionStatusChanged", this.roleOf(agentName), missionId);
        }
      }
    })();
    this.startsInFlight.set(key, start);
    try {
      return await start;
    } finally {
      if (this.startsInFlight.get(key) === start) this.startsInFlight.delete(key);
    }
  }

  /**
   * Adds a time limit and a way to abort to the startup. If the limit is exceeded or `abortStartup` is called,
   * the starting process is stopped and the startup fails (the caller is not made to wait forever).
   * On a startup failure, a half-made client that is left over is always discarded.
   */
  private startWithGuard(agentName: string, missionId: string, key: string): Promise<AgentSession> {
    const timeoutMs = this.deps.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    const token: StartToken = { aborted: false };
    return new Promise<AgentSession>((resolve, reject) => {
      let settled = false;
      const handle = { abort: () => fail(new SessionStartAbortedError(`Starting "${agentName}" was cancelled`)) };
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.starts.get(key) === handle) this.starts.delete(key);
        action();
      };
      const fail = (error: Error) => {
        if (settled) return;
        token.aborted = true;
        this.discardClient(key);
        settle(() => reject(error));
      };
      const timer = setTimeout(
        () => fail(new Error(`Starting "${agentName}" timed out after ${Math.round(timeoutMs / 1000)}s: the provider did not respond. Check the provider's login and network, then try again.`)),
        timeoutMs,
      );
      this.starts.set(key, handle);
      this.createSession(agentName, missionId, key, token).then(
        (session) => settle(() => resolve(session)),
        (err: unknown) => {
          if (!settled) this.discardClient(key);
          settle(() => reject(err));
        },
      );
    });
  }

  /** Stops and discards the client that is starting up (does nothing if there is none). */
  private discardClient(key: string): void {
    const client = this.clients.get(key);
    if (!client) return;
    try {
      client.kill();
    } catch {
      // It does not matter if it has already ended
    }
    this.clients.delete(key);
  }

  /**
   * Aborts a session that is starting up (the captain's stop operation, etc.). Stops the starting process and makes the startup fail.
   * If nothing is starting, does nothing and returns false.
   */
  abortStartup(agentName: string, missionId: string): boolean {
    const handle = this.starts.get(sessionKey(agentName, missionId));
    if (!handle) return false;
    handle.abort();
    return true;
  }

  /**
   * Discards a conversation session and recreates it (an explicit restart by the captain). While it is being recreated it is
   * "restarting". Even if it fails, "restarting" is cleared when it finishes.
   */
  async restartSession(agentName: string, missionId: string): Promise<void> {
    const trackedKey = sessionKey(this.roleOf(agentName), missionId);
    this.bump(this.restarting, trackedKey, 1);
    this.emit("sessionStatusChanged", this.roleOf(agentName), missionId);
    try {
      this.killSession(agentName, missionId);
      await this.getOrCreateSession(agentName, missionId);
    } finally {
      this.bump(this.restarting, trackedKey, -1);
      this.emit("sessionStatusChanged", this.roleOf(agentName), missionId);
    }
  }

  private async createSession(agentName: string, missionId: string, key: string, token: StartToken): Promise<AgentSession> {

    const crewConfig = this.buildAgentMap().get(agentName);
    if (!crewConfig) throw new Error(`No crew config for agent "${agentName}"`);

    const provider = crewConfig.provider ?? this.deps.settings.defaultProvider;
    // A previous attempt may have failed partway through setup and left a client that has
    // no cached session — kill it before starting a replacement, so that it does not leak.
    const stale = this.clients.get(key);
    if (stale) {
      logger.warn(`[Crew:Manager] Replacing stale client for ${key} (previous setup did not complete)`);
      stale.kill();
      this.clients.delete(key);
    }
    const client = this.deps.createClient(provider);
    // Key for context usage. agentName can be a role name or an acp_agent name, so it is aligned to the role.
    const contextKey = sessionKey(this.roleOf(agentName), missionId);

    // A remote host's crew member is started only after the reverse tunnel to the bulletin-board MCP has been established
    // (one per host, shared; see host-tunnel.ts). If it fails, an exception is thrown here, and because it is
    // before registration in clients, no half-made state is left.
    if (crewConfig.host) await this.deps.ensureTunnel(crewConfig.host);
    client.spawn(crewConfig.agent, crewConfig.cwd, crewConfig.host);
    // Registered before any prompt (initialize / persona injection / task) is sent,
    // so a permission response that arrives in the middle of setup can always be
    // routed.
    this.clients.set(key, client);
    // A permission request is not auto-approved; it is forwarded to Bridge Console so that
    // the captain can approve it inline on that member's card.
    client.on("permissionRequest", (req) => {
      logger.info(`[Crew:Manager] Permission request from ${key}: ${req.toolName}`);
      // Waiting for a human to click approve/deny is legitimate activity,
      // not a hang — by resetting bridge.ts's idle timer (if a turn is active) and the idle timer of
      // the persona injection in progress, a prompt is never silently cancelled
      // under a captain who is slow to respond.
      // missionId is this session's scope (the mission ID for a conversation, the string of taskSessionScope()
      // for a running task) — bridge.ts only registers idle guards for conversation missions,
      // so for a task-running session there is simply no match and it is ignored (see reportActivity()).
      reportActivity(missionId);
      this.personaInjectionBump.get(key)?.();
      this.emit("permissionRequest", agentName, req, missionId);
    });
    client.on("permissionsCancelled", () => this.emit("permissionsCancelled", agentName, missionId));
    client.on("exit", (code) => {
      // A crew member that went down is not special-cased: the cache is discarded, so the next time it is called it comes up through
      // the same path as the first startup (process start → persona injection → rebuilding the prompt from the conversation log in the DB).
      // On screen it stays "idle".
      logger.info(`[Crew:Manager] Agent ${key} exited (code=${code}) — clearing cached session`);
      // Only when this client is still the registered one. An old process that is slow to exit (after killSession or a restart)
      // must not wipe the session a newer client has already registered under the same key.
      if (this.clients.get(key) === client) {
        this.sessions.delete(key);
        this.contextPercent.delete(contextKey);
        this.commands.delete(contextKey);
        this.clients.delete(key);
      }
      this.emit("agentExited", agentName, missionId);
    });
    // Context usage is remembered only for conversation sessions (task-running ones are throwaway, so they are not looked at).
    if (!missionFromTaskScope(missionId)) {
      client.on("usageUpdate", (percentage) => {
        this.contextPercent.set(contextKey, percentage);
      });
      // When the list of slash commands arrives, remember it and signal the screen to re-fetch the crew state
      client.on("commands", (commands) => {
        this.commands.set(contextKey, commands);
        // Called from the agent's output handler: a failure to store the list (disk full, a busy database) must not throw into it.
        try {
          if (commands.length > 0) this.deps.commandsStore?.save(provider, commands);
        } catch (err) {
          logger.warn(`[Crew:Manager] Could not store the slash commands of ${provider}:`, err);
        }
        this.emit("sessionStatusChanged", this.roleOf(agentName), missionId);
      });
    }
    await client.initialize();

    // Passes the bulletin-board MCP with an identification header dedicated to this session — so that
    // calls to `dispatch_task` can receive "which crew member's which mission they came from"
    // objectively as an HTTP header, not as the model's self-report.
    const sessionId = await client.newSession(
      crewConfig.cwd,
      crewConfig.additionalDirectories,
      { [MCP_AGENT_HEADER]: agentName, [MCP_MISSION_HEADER]: missionId, [MCP_TOKEN_HEADER]: this.deps.settings.mcpToken },
    );

    // A crew member that uses a provider-side agent definition as its persona selects it here (kiro already got it
    // via a startup argument). If it cannot be selected, it is an error and we stop — if it silently carried on with the default agent,
    // we could not notice that the persona is different (a misspelled name, etc.).
    if (crewConfig.agent) {
      let applied = false;
      try {
        applied = await client.setAgent(sessionId, crewConfig.agent);
      } finally {
        if (!applied) {
          client.kill();
          this.clients.delete(key);
        }
      }
      if (!applied) {
        throw new Error(`agent "${crewConfig.agent}" (ship.yml) is not available for ${key} (${provider}). Check the name against the provider's agent definitions in the cwd (${crewConfig.cwd}).`);
      }
    }

    // Applies the model. For a provider with no options (no support for switching),
    // it does nothing. The session is usable even if this fails, so it only warns.
    const modelState = client.getModelState();
    const defaultModel = modelState?.current;
    if (modelState) {
      this.modelOptionsByProvider.set(provider, modelState.options);
      this.deps.modelOptionsStore?.save(provider, modelState.options);
      const { model } = resolveCrewModel({
        override: this.deps.getModelOverride(this.roleOf(agentName), missionId),
        configured: crewConfig.model,
      });
      if (model && model !== modelState.current) {
        try {
          await client.setModel(sessionId, model);
        } catch (err) {
          logger.warn(`[Crew:Manager] Failed to set model "${model}" for ${key}:`, err);
        }
      }
    }

    // Applies the permission mode (only for crew members that specify one). If the mode cannot be selected, warn and
    // carry on with the default — leave a log so that we do not miss that, when approval was meant to be requested,
    // it silently stays on auto-approve.
    if (crewConfig.permissionMode) {
      try {
        const applied = await client.setPermissionMode(sessionId, crewConfig.permissionMode);
        if (!applied) logger.warn(`[Crew:Manager] Permission mode "${crewConfig.permissionMode}" is not available for ${key} — keeping the default`);
      } catch (err) {
        logger.warn(`[Crew:Manager] Failed to set permission mode "${crewConfig.permissionMode}" for ${key}:`, err);
      }
    }

    // The briefing at session start (persona, rules, skills, and system guidance combined into one text).
    // It is built with the same function as the profile display on screen (crew-briefing.ts).
    const persona = buildBriefing(
      {
        fleetRoot: this.deps.settings.fleetRoot,
        projectRoot: this.deps.settings.projectRoot,
        skillsDir: this.deps.settings.skillsDir,
        crew: this.deps.settings.crew,
        crewLanguage: this.deps.settings.crewLanguage(),
      },
      crewConfig,
      this.roleOf(agentName),
    );
    await this.injectPersona(client, sessionId, key, persona);
    // An agent that died while it was being briefed has already been dropped by its exit handler; a session made of it would be cached
    // dead, and every later message would fail with an opaque "stdin is not writable".
    if (this.clients.get(key) !== client || client.pid === null) {
      throw new Error(`Starting "${agentName}" failed: the agent process ended while it was being briefed.`);
    }

    const session: AgentSession = {
      client,
      sessionId,
      crewConfig,
      agentName,
      missionId,
      lastSeenSeq: 0,
      defaultModel,
    };
    // If the startup has already been treated as a failure because the time limit was exceeded or it was aborted, do not register this session
    if (token.aborted) {
      client.kill();
      throw new SessionStartAbortedError(`Starting "${agentName}" was abandoned`);
    }
    this.sessions.set(key, session);
    logger.info(`[Crew:Manager] Session started for ${key} (${provider})`);
    return session;
  }

  /**
   * Sends the persona injection prompt. With an idle guard — without it, if the
   * injection prompt got stuck (or stopped on a permission request that is never answered),
   * the startup of this session would be blocked forever with no signal at all. If it times out with no response,
   * the startup fails (we do not carry on with a provider that does not respond). Other injection failures
   * are not treated as fatal (only a warning) — a conversation is possible even without a persona,
   * so it is kept to a light degradation rather than failing the whole session startup.
   */
  private async injectPersona(client: BaseAgentClient, sessionId: string, key: string, persona: string): Promise<void> {
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectOnIdle: ((err: Error) => void) | undefined;
    const idleMs = this.deps.personaIdleTimeoutMs ?? PERSONA_IDLE_TIMEOUT_MS;
    const bump = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        // Waiting for the captain to answer a permission request is not a hang: the timer starts over.
        if (client.hasPendingPermissions()) { bump(); return; }
        logger.warn(`[Crew:Manager] Persona injection for ${key} idle for ${idleMs / 1000}s — treating as hung`);
        try { client.sendCancel(sessionId); } catch { /* best effort */ }
        rejectOnIdle?.(new PersonaHungError(`Starting "${key}" failed: the provider did not answer the briefing for ${Math.round(idleMs / 1000)}s. Check the provider's login and network, then try again.`));
      }, idleMs);
    };
    this.personaInjectionBump.set(key, bump);
    const onChunk = () => bump();
    client.on("chunk", onChunk);
    bump();
    try {
      await Promise.race([
        client.sendPrompt(sessionId, persona),
        new Promise<never>((_, reject) => { rejectOnIdle = reject; }),
      ]);
      logger.info(`[Crew:Manager] Injected persona for ${key}`);
    } catch (err) {
      // If it times out with no response, it is treated as a startup failure (we do not carry on in an unusable state).
      // Other failures are not treated as fatal (only a warning)
      if (err instanceof PersonaHungError) throw err;
      logger.warn(`[Crew:Manager] Failed to inject persona for ${key}:`, err);
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      client.off("chunk", onChunk);
      if (this.personaInjectionBump.get(key) === bump) this.personaInjectionBump.delete(key);
    }
  }

  /**
   * Advances the reference point for delta injection (called after bridge.ts has injected the mission's conversation).
   */
  markSeen(agentName: string, missionId: string, seq: number): void {
    const session = this.sessions.get(sessionKey(agentName, missionId));
    if (session && seq > session.lastSeenSeq) session.lastSeenSeq = seq;
  }

  // Route through the `clients` map (filled at spawn time), not the `sessions` cache
  // (filled only after persona injection completes) — a response to a request that fired
  // in the middle of setup must never be dropped.
  // Otherwise the injection prompt would wait for it and deadlock forever.
  /** Returns whether the answer reached a request that was still waiting (false: no such session, or the request is gone). */
  respondToPermission(agentName: string, missionId: string, requestId: number, optionId: string): boolean {
    const key = sessionKey(agentName, missionId);
    this.personaInjectionBump.get(key)?.();
    const rawClient = this.clients.get(key);
    if (!rawClient) {
      logger.warn(`[Crew:Manager] Permission response for ${key} (request ${requestId}) but no client exists — dropping`);
      return false;
    }
    const client = rawClient as unknown as { respondToPermission?(id: number, o: string): boolean | void };
    if (typeof client.respondToPermission !== "function") return false;
    // A client that does not say (an older fake) is taken as having delivered it.
    return client.respondToPermission(requestId, optionId) !== false;
  }

  closeAll(): void {
    // Kill through the `clients` map — this also covers a client that is still in the middle of setup and
    // never reached the `sessions` cache.
    for (const client of this.clients.values()) {
      client.kill();
    }
    this.clients.clear();
    this.sessions.clear();
    this.contextPercent.clear();
    this.commands.clear();
  }
}
