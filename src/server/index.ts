import express from "express";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { config, agentToRole, crewDisplayName } from "./config.js";
import { createBridge, type Bridge } from "./bridge.js";
import * as timeline from "./timeline.js";
import { onNewConnection } from "./sse-emitter.js";
import { createUsageFetcher } from "./usage-fetcher.js";
import { createAccountUsage } from "./account-usage.js";
import { parseClaudeAuthStatus, runClaudeAuthStatus } from "./account-identity.js";
import { broadcast } from "./sse-emitter.js";
import { CrewManager } from "./crew-manager.js";
import { createAgentClient } from "./agent-client-factory.js";
import { createHostTunnels } from "./host-tunnel.js";
import { resolveHostAddresses, type HostConfig } from "./ssh.js";
import os from "node:os";
import { restrictToOwner } from "./private-dirs.js";
import { isAcceptedHost } from "./local-guard.js";
import { CrewRunner, missionFromTaskScope, taskSessionScope } from "./crew-runner.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, getCrewModelOverride, getOpenUiTurnId, getUiOfTurn, recordUiDismissed, recordUiShown, getProviderCommands, getProviderModelOptions, getSetting, initDatabase, saveProviderCommands, saveProviderModelOptions, searchTimeline, setSetting, missionExists, setCrewModelOverride } from "./database.js";
import { resolveLanguage } from "./language.js";
import { clearFileStream, readFileStream } from "./file-stream.js";
import { findInterruptedWork, recordInterruptedWork } from "./recover-interrupted.js";
import { crewResultPath } from "./crew-paths.js";
import { createTurnStreams } from "./turn-stream.js";
import { createMcpHandler } from "./mcp-board.js";
import { createStatusRouter } from "./routes/status.js";
import { createSearchRouter } from "./routes/search.js";
import { createCrewProfileRouter, crewIconUrl } from "./routes/crew-profile.js";
import { findCrewIcon } from "./crew-icons.js";
import { crewHostInfo } from "./crew-hosts.js";
import { createMissionsRouter } from "./routes/missions.js";
import { createTimelineRouter } from "./routes/timeline.js";
import { createConversationRouter } from "./routes/conversation.js";
import { createA2uiRouter } from "./routes/a2ui.js";
import { createTasksRouter } from "./routes/tasks.js";
import { createPermissionsRouter } from "./routes/permissions.js";
import { createAgentsRouter } from "./routes/agents.js";
import { createPinsRouter } from "./routes/pins.js";
import { createCrewModelsRouter } from "./routes/crew-models.js";
import { createSettingsRouter } from "./routes/settings.js";
import { createQuickActionsRouter } from "./routes/quick-actions.js";
import { quickActionsOfShip } from "./quick-actions.js";
import { createApp } from "./app.js";
import { createActivityLog } from "./activity-log.js";
import { connectCrewEvents } from "./crew-events.js";
import { logger, configureLogger } from "./logger.js";
import { systemPathLookup, missingCliMessage } from "./agent-cli-check.js";

// Logger configuration (from the ship config). Done before any other log output.
configureLogger({
  level: config.logging.level,
  maxFileSizeMb: config.logging.maxFileSizeMb,
  logsDir: config.logsDir,
});

let server: http.Server | null = null;
// Crew management, directly inside the main process (no separate process).
let crewManager: CrewManager | null = null;
let crewRunner: CrewRunner | null = null;
// Created in start() (routes are only called after startup, so it is always set by the time it is used).
let bridge!: Bridge;

// --- Server startup ---
async function start(): Promise<void> {
  logger.info("[make-it-so] Starting...");
  logger.info(`[make-it-so] Workspace root: ${config.projectRoot}`);
  // The local-request guard only accepts IP addresses and "localhost" as the Host (see local-guard.ts): a host NAME here would be bound but
  // every request addressed to it would be refused, which looks like a dead server.
  if (!isAcceptedHost(config.host)) {
    logger.warn(`[make-it-so] server.host is "${config.host}", a name: requests addressed to a host name other than localhost are refused (403). Use an IP address.`);
  }
  logger.info(`[make-it-so] ACP provider: ${config.acp.provider}`);
  // If the CLI of an agent in use is missing, show guidance up front, before the startup failure (spawn ENOENT)
  const lookup = systemPathLookup();
  const usedProviders = new Set<"kiro" | "claude">([config.acp.provider, ...Object.values(config.crew).map((c) => (c.provider ?? config.acp.provider) as "kiro" | "claude")]);
  for (const provider of usedProviders) {
    const warning = missingCliMessage(provider, config.acp[provider].command, lookup);
    if (warning) logger.warn(`[make-it-so] ${warning}`);
  }

  // What the ship keeps (conversations in plain text, logs) and the settings are for this user only.
  restrictToOwner(config.fleetRoot);
  restrictToOwner(config.projectRoot);

  // Initializes the SQLite database
  initDatabase({
    path: path.join(config.projectRoot, "data", "bridge.db"),
    agentToRole,
  });
  // The language in effect: the value saved from the UI, else the default in config.yml.
  // Read on every use, so a change from the UI applies to new sessions without a restart.
  const currentLanguage = () => resolveLanguage(getSetting("language"), config.language);
  // The language the crew speaks is a separate setting (saved under its own key).
  const currentCrewLanguage = () => resolveLanguage(getSetting("crew_language"), config.crewLanguage);
  // Credits are handled grouped by authenticated account (account-usage.ts)
  const accounts = createAccountUsage({
    crew: config.crew,
    defaultProvider: config.acp.provider,
    usage: createUsageFetcher(),
    identify: { claude: async () => parseClaudeAuthStatus(await runClaudeAuthStatus()) },
  });
  const turnStreams = createTurnStreams(config.turnsDir);
  const activityLog = createActivityLog({ dir: config.activityDir, onChange: timeline.notifyActivity });
  activityLog.prune();
  timeline.configureTimeline({
    readActivity: activityLog.read,
    readTaskText: (agent, taskId) => readFileStream(crewResultPath(config.agentsDir, agent, taskId)),
    readTurnText: turnStreams.read,
  });

  // What the last run left unfinished (the server stopped in the middle) is looked up now, and recorded as interrupted only after
  // the port is bound (below): a second start of a ship that is already running must not touch its live turns.
  const interruptedRecoveryDeps = {
    turnStreams,
    taskFiles: {
      read: (agent: string, taskId: string) => readFileStream(crewResultPath(config.agentsDir, agent, taskId)),
      clear: (agent: string, taskId: string) => clearFileStream(crewResultPath(config.agentsDir, agent, taskId)),
    },
    log: (message: string) => logger.warn(message),
  };
  const interrupted = findInterruptedWork(turnStreams);

  onNewConnection((res) => {
    // Show which crew members belong to which account first, even if the usage has not been fetched yet
    try { res.write(`event: credits:usage\ndata: ${JSON.stringify(accounts.snapshot())}\n\n`); } catch { /* broken */ }

    // No catch-up push of streaming is done here: on every (re)connection, the client
    // fetches the full snapshot from GET /api/timeline (see handleReconnect in App.tsx), which already
    // rebuilds the turn in progress — now that a single authoritative fetch covers it, pushing partial-text hints over the SSE
    // channel would be redundant.

    accounts.refresh({ force: true }).then((data) => broadcast({ type: "credits:usage", data })).catch(() => {});
  });

  // Starts crew management directly inside the main process. Everything here arrives as an event in the same process.
  const hostTunnels = createHostTunnels(config.port);
  // Resolve the connection targets (host name/IP) shown on screen once with `ssh -G` (for display).
  const remoteHosts = new Map<string, HostConfig>();
  for (const member of Object.values(config.crew)) {
    if (member.host) remoteHosts.set(member.host.name, member.host);
  }
  const hostAddresses = await resolveHostAddresses([...remoteHosts.values()]);
  // Regenerated at every start: it only has to match what the sessions of this process were given.
  const mcpToken = randomBytes(32).toString("hex");
  crewManager = new CrewManager({
    settings: {
      mcpToken,
      crew: config.crew,
      defaultProvider: config.acp.provider,
      fleetRoot: config.fleetRoot,
      projectRoot: config.projectRoot,
      skillsDir: config.skillsDir,
      crewLanguage: currentCrewLanguage,
    },
    createClient: (provider) => createAgentClient(provider, { port: config.port, acp: config.acp }),
    ensureTunnel: hostTunnels.ensureTunnel,
    // The scope for running tasks ("__tasks__:missionId") looks up the override of the original mission
    getModelOverride: (role, scope) => getCrewModelOverride(missionFromTaskScope(scope) ?? scope, role),
    modelOptionsStore: { load: getProviderModelOptions, save: saveProviderModelOptions },
    commandsStore: { load: getProviderCommands, save: saveProviderCommands },
  });
  const liveCrewManager = crewManager; // tells the type it is not null inside the closure
  crewRunner = new CrewRunner(crewManager, config.agentsDir);
  // Lets the `dispatch_task`/`get_task` tools of the MCP bulletin board (mcp-board.ts) dispatch directly to this
  // same crewRunner — this is the only path that issues tasks.
  // Management of the captain's conversation with the crew (turns). Direct chat with a crew member uses the
  // resident session of crewManager as it is.
  bridge = createBridge({
    crewManager,
    turnStreams,
    activityLog,
    isCrewRole: (role) => Boolean(config.crew[role]),
    displayName: crewDisplayName,
    fetchUsage: () => accounts.refresh(),
    crewLanguage: currentCrewLanguage,
  });
  // Routers per feature (mounted together by createApp())
  const routers: express.Router[] = [];
  const status = createStatusRouter({
    crew: config.crew,
    shipName: config.shipName,
    shipId: config.shipId,
    defaultProvider: config.acp.provider,
    language: currentLanguage,
    crewLanguage: currentCrewLanguage,
    theme: config.theme,
    bridge,
    crewRunner,
    contextPercent: (role, missionId) => liveCrewManager.getContextPercent(role, missionId),
    commands: (role, missionId) => liveCrewManager.getCommands(role, missionId),
    commandsLive: (role, missionId) => liveCrewManager.hasLiveCommands(role, missionId),
    iconUrl: (role) => {
      const memberId = config.crew[role]?.acp_agent;
      return memberId ? crewIconUrl(role, findCrewIcon(config.fleetRoot, memberId)) : undefined;
    },
    sessionPhase: (role, missionId) => liveCrewManager.sessionPhase(role, missionId),
    hosts: {
      localHostname: os.hostname(),
      hostAddress: (name) => hostAddresses.get(name),
      tunnelState: hostTunnels.state,
    },
  });
  routers.push(status.router);
  routers.push(createCrewProfileRouter({
    crew: config.crew,
    defaultProvider: config.acp.provider,
    fleetRoot: config.fleetRoot,
    home: os.homedir(),
    briefingDeps: () => ({
      fleetRoot: config.fleetRoot,
      projectRoot: config.projectRoot,
      skillsDir: config.skillsDir,
      crew: config.crew,
      crewLanguage: currentCrewLanguage(),
    }),
    hostInfo: (member) => crewHostInfo(member, { localHostname: os.hostname(), hostAddress: (name) => hostAddresses.get(name), tunnelState: hostTunnels.state }),
  }));
  routers.push(createSearchRouter({ search: searchTimeline, agentToRole }));
  routers.push(createMissionsRouter());
  routers.push(createSettingsRouter({
    setLanguage: (language) => setSetting("language", language),
    setCrewLanguage: (language) => setSetting("crew_language", language),
  }));
  routers.push(createQuickActionsRouter({ dir: config.fleetRoot, shipId: config.shipId }));
  routers.push(createCrewModelsRouter({
    crew: config.crew,
    defaultProvider: config.acp.provider,
    crewManager,
    missionExists,
    getOverride: getCrewModelOverride,
    setOverride: setCrewModelOverride,
    taskScope: taskSessionScope,
  }));
  routers.push(createTimelineRouter({
    fixedMessages: () => {
      // The buttons' messages, and what the custom menu sends at once. A broken quick-actions.yml just means no menu items to leave out.
      let menu: string[] = [];
      try {
        menu = quickActionsOfShip(config.fleetRoot, config.shipId).filter((a) => a.send === "now").map((a) => a.command);
      } catch {
        // ignored
      }
      return ["report", "engage", "make it so", ...menu];
    },
    openUiItemId: getOpenUiTurnId,
  }));
  routers.push(createAgentsRouter({
    crew: config.crew,
    agentStatus: status.agentStatus,
    bridge,
    crewRunner,
    crewManager,
    debug: config.debug,
  }));
  routers.push(createTasksRouter({ crewRunner }));
  routers.push(createPermissionsRouter({ crewManager }));
  routers.push(createConversationRouter({
    crew: config.crew,
    bridge,
    fetchCredits: () => accounts.refresh({ force: true }),
    broadcast,
    openUiItemId: getOpenUiTurnId,
  }));
  routers.push(createA2uiRouter({ bridge, getUi: getUiOfTurn, dismissUi: recordUiDismissed }));
  const handleMcpRequest = createMcpHandler({
    token: mcpToken,
    crewRunner,
    recordUnreportedFetch: bridge.recordUnreportedFetch,
    displayName: crewDisplayName,
    currentTurnId: (missionId) => bridge.getCurrentTurnId(missionId) ?? undefined,
    roleOf: (agent) => {
      const role = agentToRole(agent);
      return config.crew[role] ? role : undefined;
    },
    rankOf: (role) => config.crew[role]?.rank,
    currentTurn: (missionId) => bridge.getCurrentTurn(missionId) ?? undefined,
    uiStateOf: (turnId) => getUiOfTurn(turnId)?.state,
    recordUi: ({ turnId, role, missionId, messages }) => { recordUiShown(turnId, missionId, role, messages); },
  });

  connectCrewEvents({
    crewRunner,
    crewManager,
    agentsDir: config.agentsDir,
    agentToRole,
    broadcast,
    activityLog,
  });

  // The sessions of all crew members, including the commander, are started lazily "the first time they are addressed".

  const app = createApp({
    routers,
    pinsRouter: createPinsRouter({ crewRoles: Object.keys(config.crew) }),
    handleMcpRequest,
    clientDir: builtClientDir(),
  });
  server = await listenWithRetry(app, config.port, config.host);
  await recordInterruptedWork(interrupted, interruptedRecoveryDeps);
  logger.info(`[make-it-so] Server running on http://${config.host}:${config.port}`);
  if (builtClientDir()) logger.info(`[make-it-so] Open http://${config.host}:${config.port} in your browser`);
}

/**
 * Returns the neighboring `dist/client` only when running as the built `dist/server/index.js` (the UI is then served on the same port).
 * It does not return it with `npm run dev` (tsx): the UI is served by Vite, so an old build that happens to be left over is not used.
 */
function builtClientDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(here) === "server" && path.basename(path.dirname(here)) === "dist" ? path.join(here, "..", "client") : undefined;
}

function listenWithRetry(expressApp: express.Express, port: number, host: string): Promise<http.Server> {
  const RETRY_DELAYS = [500, 1000, 2000];

  return new Promise((resolve, reject) => {
    let attempt = 0;

    const tryListen = () => {
      const httpServer = http.createServer(expressApp);

      httpServer.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attempt < RETRY_DELAYS.length) {
          const delay = RETRY_DELAYS[attempt];
          logger.warn(`[make-it-so] Port ${port} in use, retrying in ${delay}ms (attempt ${attempt + 1}/${RETRY_DELAYS.length})...`);
          attempt++;
          setTimeout(tryListen, delay);
        } else if (err.code === "EADDRINUSE") {
          // The raw error names no way out. Another ship (or another program) holds this port.
          reject(new Error(`[make-it-so] Port ${port} is already in use: another ship or another program is using it. Stop it, or give this ship another "port" in its ship.yml (the settings screen: Ships).`, { cause: err }));
        } else {
          reject(err);
        }
      });

      httpServer.listen(port, host, () => resolve(httpServer));
    };

    tryListen();
  });
}

async function shutdown(): Promise<void> {
  // The sessions of all agents (including the commander) are managed by crewManager,
  // so closeAll() alone kills every process.
  crewManager?.closeAll();
  server?.close();
  // The agents' last words (their exit events) are written first; then the database is folded into one file and closed, so that
  // a copy of bridge.db alone is a complete backup (see docs/guides/backup-and-restore.md).
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    closeDatabase();
  } catch (err) {
    logger.warn("[make-it-so] Could not close the database cleanly:", err);
  }
}

process.on("SIGINT", async () => {
  logger.info("\n[make-it-so] Shutting down...");
  await shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  logger.info("[make-it-so] SIGTERM received, shutting down...");
  await shutdown();
  process.exit(0);
});

start().catch((error) => {
  logger.error("[make-it-so] Fatal error:", error);
  process.exit(1);
});
