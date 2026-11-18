import express from "express";
import type { Bridge } from "../bridge.js";
import type { CrewRunner } from "../crew-runner.js";
import { crewHostInfo, groupCrewByHost, type CrewHostGroupDeps } from "../crew-hosts.js";
import { defaultCrewRole, type CrewMemberConfig } from "../fleet-config.js";
import { getTaskHistory, getTaskStarted, getUnreportedTasks } from "../database.js";
import type { HealthResponse } from "../types.js";
import type { Language } from "../language.js";
import type { SlashCommand } from "../slash-commands.js";

// Routes that return the health check, the app config, and the crew's composition and running state.
// The actual running state (bridge, crewRunner, crewManager) and the ship's composition are passed in by the caller.

/** What this router needs. index.ts wires it in production; tests pass fakes. */
export type StatusRouterDeps = {
  /** The ship's crew (role name → crew config). */
  crew: Record<string, CrewMemberConfig>;
  /** Display name of the ship. */
  shipName: string;
  /** Identifier of the ship (its directory name). */
  shipId: string;
  /** Default provider when the roster does not specify one. */
  defaultProvider: string;
  /** The UI language in effect. Read on every request: it can change at runtime. */
  language: () => Language;
  /** The language the crew speaks. Read on every request, like `language`. */
  crewLanguage: () => Language;
  bridge: Pick<Bridge, "isAgentBusy">;
  crewRunner: Pick<CrewRunner, "isRunning" | "getCurrentTaskId">;
  /** Stage of the conversation session coming up (starting or restarting). undefined if neither. */
  sessionPhase: (role: string, missionId?: string) => "starting" | "restarting" | undefined;
  /** Context usage (%) of the conversation session. undefined if there is no session. */
  contextPercent: (role: string, missionId: string) => number | undefined;
  /**
   * Slash commands available in the conversation session. Before the session's list arrives, the previous list (the cache). Empty if there is no cache either.
   */
  commands: (role: string, missionId: string) => SlashCommand[];
  /**
   * Whether `commands` is the latest one that arrived from the running session (if false, it is the cache, or empty).
   */
  commandsLive: (role: string, missionId: string) => boolean;
  /** URL of the crew member's icon (undefined if there is no image). */
  iconUrl: (role: string) => string | undefined;
  /** Information for grouping crew members by host (host name, connection target, tunnel state). */
  hosts: CrewHostGroupDeps;
};

export type AgentStatus = "idle" | "working" | "starting" | "restarting";

export function createStatusRouter(deps: StatusRouterDeps): {
  router: express.Router;
  /** Derives one crew member's state from the running state (also used by other routes). */
  agentStatus: (role: string, missionId?: string) => AgentStatus;
} {
  const router = express.Router();

  /**
   * Derives one crew member's state from the actual running state. With `missionId` it judges for that mission only,
   * and without it looks across all missions (the display is narrowed per mission, but the overall picture
   * can be had from the same function and the same API).
   *
   * The priority is "restarting > starting > working > idle". A conversation (a turn in bridge.ts) and a task (crew-runner)
   * are both shown as "working" — from the captain's point of view they mean the same thing: "busy right now".
   */
  function agentStatus(role: string, missionId?: string): AgentStatus {
    // Starting up and restarting are more specific states than working, so they take priority (a turn that handles the first message
    // is already "working" even while the session is coming up).
    const phase = deps.sessionPhase(role, missionId);
    if (phase) return phase;
    if (deps.bridge.isAgentBusy(role, missionId)) return "working";
    // Task-running sessions are separated per mission (see taskSessionScope in crew-runner.ts), but here
    // `missionId` is not passed and all missions are looked at together — even when narrowing by mission, the fact that
    // "this crew member is tied up in some task somewhere" should be reflected in common.
    if (deps.crewRunner.isRunning(role)) return "working";
    return "idle";
  }

  // --- Health check ---
  // The agent's state is derived from the ship's composition (deps.crew): whether it is in a conversation in some
  // mission right now, running a task, or has a process that died and stayed down.
  router.get("/api/health", (_req, res) => {
    const agents: Record<string, string> = {};
    for (const role of Object.keys(deps.crew)) {
      agents[role] = agentStatus(role);
    }
    const response: HealthResponse = {
      status: "ok",
      shipId: deps.shipId,
      pid: process.pid,
      uptime: process.uptime(),
      agents: agents as HealthResponse["agents"],
    };
    res.json(response);
  });

  // --- App config (provider information and ship name for the frontend) ---
  router.get("/api/config", (_req, res) => {
    // shipName (the display name) is used by the frontend to tell which ship is being viewed when several ships are open in different tabs.
    // defaultTarget is the role of the person the captain talks to first (the commander if there is one, otherwise the first crew member).
    res.json({
      defaultTarget: defaultCrewRole(deps.crew) ?? null,
      shipName: deps.shipName,
      language: deps.language(),
      crewLanguage: deps.crewLanguage(),
    });
  });

  // --- Crew config (for display names in the frontend) ---
  // Only the items needed for display are returned (not the settings themselves — cwd, rules, ssh destination, etc.).
  // `host` is attached only for a remote crew member (the policy is not to show host information for a local crew member).
  router.get("/api/crew", (_req, res) => {
    const view = Object.fromEntries(Object.entries(deps.crew).map(([role, member]) => [role, {
      name: member.name,
      provider: member.provider,
      acp_agent: member.acp_agent,
      rank: member.rank,
      ...(deps.iconUrl(role) ? { icon: deps.iconUrl(role) } : {}),
      ...(member.host ? { host: crewHostInfo(member, deps.hosts) } : {}),
    }]));
    res.json(view);
  });

  // --- Crew status (for the crew status display in the left pane) ---
  // The actual composition is read from `deps.crew` and derived from the internal state of crewRunner/crewManager and the existing
  // getUnreportedTasks() (the same single source of truth as the report mechanism) — no new persistence and no new SSE kind is added.
  // The commander (first_officer) is included as one row, too — since the talk target can be switched, it is natural to see the commander's
  // state in the same list as the other crew members. The commander has no notion of tasks, so the unreported count is always 0.
  // With `?missionId=` it is narrowed to that mission; without it, it is an overview across all missions
  // (no new endpoint is added: the same single data source is reused, only narrowed).
  router.get("/api/crew/status", (req, res) => {
    const missionId = typeof req.query.missionId === "string" ? req.query.missionId : undefined;
    const unreportedCountByAgent = new Map<string, number>();
    for (const t of getUnreportedTasks(missionId)) {
      unreportedCountByAgent.set(t.agent, (unreportedCountByAgent.get(t.agent) ?? 0) + 1);
    }

    // Returned grouped by host (local/remote). The grouping is decided on the server,
    // and the client just renders in the order received.
    res.json(groupCrewByHost(deps.crew, deps.hosts, (role) => ({
      role,
      status: agentStatus(role, missionId),
      unreportedCount: unreportedCountByAgent.get(role) ?? 0,
      // Context is a value of the per-mission session, so it is not shown in an overview with no mission specified
      contextPercent: (missionId ? deps.contextPercent(role, missionId) : undefined) ?? null,
      // Slash commands also belong to the per-mission session (not shown in an overview). Before startup, the previous list (the cache) is shown
      commands: missionId ? deps.commands(role, missionId) : [],
      commandsLive: missionId ? deps.commandsLive(role, missionId) : false,
    })));
  });

  // --- Task history of one crew member (for row expansion in the crew status panel in the left pane) ---
  // The "task running now" comes from crewRunner's agentTask, and the "past completed/error
  // tasks" from the existing getTaskHistory() (it only JOINs task_started/completed/error_events).
  // No new persistence is added. By default the latest 5 are returned, and the client re-fetches with the ?limit query to get more
  // (the volume is not large enough to justify cursor-based pagination).
  router.get("/api/crew/:role/tasks", (req, res) => {
    const { role } = req.params;
    if (!deps.crew[role]) {
      res.status(404).json({ error: "Unknown crew role" });
      return;
    }
    const rawLimit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : NaN;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 5;
    const missionId = typeof req.query.missionId === "string" ? req.query.missionId : undefined;

    // Pass `missionId` so that only the tasks of the mission being viewed are shown as "currently running" —
    // even if this crew member is running another task in another mission, it is not mixed in (task-running sessions are
    // separated per mission; see taskSessionScope in crew-runner.ts).
    const currentTaskId = deps.crewRunner.getCurrentTaskId(role, missionId);
    const currentStarted = currentTaskId ? getTaskStarted(currentTaskId) : null;
    const { items, hasMore } = getTaskHistory(role, limit, missionId);

    res.json({
      current: currentTaskId && currentStarted ? { taskId: currentTaskId, taskName: currentStarted.taskName } : null,
      history: items,
      hasMore,
    });
  });

  return { router, agentStatus };
}
