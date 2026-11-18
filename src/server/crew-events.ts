import type { ActivityLog } from "./activity-log.js";
import type { CrewManager } from "./crew-manager.js";
import type { CrewRole, SSEEvent } from "./types.js";
import { crewResultPath } from "./crew-paths.js";
import { missionFromTaskScope, taskSessionScope, type CrewRunner } from "./crew-runner.js";
import {
  DEFAULT_MISSION_ID,
  getTaskStarted,
  recordTaskCompleted,
  recordTaskError,
  recordTaskStarted,
} from "./database.js";
import { clearFileStream, readFileStream } from "./file-stream.js";
import { logger } from "./logger.js";
import { clearScope, registerPermission } from "./permission-registry.js";
import * as timeline from "./timeline.js";

// Wiring that reflects the events of CrewRunner (task execution) and CrewManager (conversation) into the DB, the timeline, SSE, and
// pending permissions. The core path by which a task's result reaches the screen.

/** What the wiring needs. index.ts passes it in production; tests pass fakes. */
export type CrewEventsDeps = {
  crewRunner: CrewRunner;
  crewManager: CrewManager;
  /** Looks up the turn that issued a task (getCurrentTurnId). */
  /** Directory where the result files of crew tasks are placed. */
  agentsDir: string;
  /** Looks up the role name from the agent name in the DB (directory name/acp_agent name/role name). */
  agentToRole: (agent: string) => CrewRole;
  /** Broadcasts to all clients over SSE. */
  broadcast: (event: SSEEvent) => void;
  /** Keeps what each task did (its tool calls) so it can be shown again later. Nothing is kept when omitted. */
  activityLog?: Pick<ActivityLog, "recordCall" | "recordOutput" | "finish">;
};

/** Starts subscribing to the events of CrewRunner and CrewManager. Call it only once, at startup. */
export function connectCrewEvents(deps: CrewEventsDeps): void {
  deps.crewRunner.on("started", (taskId, agent, originalName, instruction, missionId, dispatchedBy, turnId) => {
    const trimmedInstruction = instruction.trim();
    // `turnId` is the turn that issued this task (mcp-board.ts takes it at dispatch time and passes it through TaskEvent). The card
    // hangs off that turn of the same mission. It is not looked up now: a task that waited in the queue starts after that turn ended.
    // The permanent record of this issue — it stays forever (it is not deleted), so the task_done/task_error below
    // can always have a real source for missionId/turnId/taskName/instruction.
    // There is no need to guess "whatever turn is active right now".
    recordTaskStarted(taskId, missionId, agent, originalName, trimmedInstruction, turnId, dispatchedBy);
    // Created immediately, at a stage when the result file does not necessarily exist yet —
    // the same pattern as the commander's own turn (bridge.ts) and the early
    // "started" emission in crew-runner.ts: the card should appear the moment the task is issued,
    // not once there is something to show.
    timeline.upsert({
      id: taskId,
      missionId,
      role: deps.agentToRole(agent),
      text: "",
      timestamp: new Date().toISOString(),
      taskName: originalName,
      status: "streaming",
      ...(trimmedInstruction ? { instruction: trimmedInstruction } : {}),
      ...(turnId ? { turnId } : {}),
    });
  });

  deps.crewRunner.on("chunk", (taskId, _agent, text) => {
    // The text is persisted (via the result file, using the file-stream.ts mechanism shared by crew-runner.ts and the commander's own
    // turn) and is not accumulated in this process's memory. broadcastAppend keeps
    // delivering deltas over SSE exactly like append().
    timeline.broadcastAppend(taskId, text);
  });

  // What the task does is recorded in the activity log; the timeline tells the screen about it (timeline.ts).
  deps.crewRunner.on("toolCall", (taskId, _agent, title) => {
    deps.activityLog?.recordCall(taskId, title);
  });
  deps.crewRunner.on("toolCallUpdate", (taskId, _agent, text) => {
    deps.activityLog?.recordOutput(taskId, text);
  });

  deps.crewRunner.on("done", (taskId, agent, credits, cancelled) => {
    deps.activityLog?.finish(taskId);
    const existing = timeline.get(taskId);
    // If this process's in-memory map has never seen task_started
    // (e.g. Bridge Console restarted in the middle of a task), the value is restored from the permanent record
    // instead of being guessed — only if even that is missing (rare) does it
    // fall back to "the turn active right now".
    const started = getTaskStarted(taskId);
    const turnId = existing?.turnId ?? started?.turnId ?? undefined;
    const taskName = existing?.taskName ?? started?.taskName ?? undefined;
    const instruction = existing?.instruction ?? started?.instruction ?? undefined;
    const role = existing?.role ?? deps.agentToRole(agent);
    // The mission this task belongs to is held by the permanent record made when it was issued
    // (the spine row of task_started_events) — it must not be guessed from "the turn active
    // right now" (another mission may be running in parallel).
    const missionId = existing?.missionId ?? started?.missionId ?? DEFAULT_MISSION_ID;
    const resultPath = crewResultPath(deps.agentsDir, agent, taskId);
    readFileStream(resultPath).then(async (text) => {
      const cleanText = text.trim();
      recordTaskCompleted(taskId, missionId, cleanText, credits, cancelled);
      // The completion is recorded: a failure in what follows must not record a contradicting task_error as well.
      try {
        timeline.upsert({ ...(existing ?? { id: taskId, missionId, role, timestamp: new Date().toISOString() }), text: cleanText, status: "done", ...(cancelled ? { cancelled: true } : {}), ...(taskName ? { taskName } : {}), ...(instruction ? { instruction } : {}), ...(turnId ? { turnId } : {}), ...(credits ? { credits } : {}) });
        timeline.forget(taskId);
        await clearFileStream(resultPath);
      } catch (err) {
        logger.error(`[make-it-so] Crew result ${taskId} was recorded, but showing it or removing its file failed:`, err);
      }
    }).catch((err: unknown) => {
      // A real read failure (not the normal ENOENT = empty case that readFileStream already handles)
      // would otherwise only be logged here, and the card would stay stuck in "streaming" forever with no error shown,
      // leaving the captain no way to tell what happened. Instead, it is recorded as a proper task_error, in the same way
      // bridge.ts handles the same kind of failure for the commander's own turn.
      logger.error(`[make-it-so] Failed to read/persist crew result ${taskId}:`, err);
      try {
        const message = err instanceof Error ? err.message : String(err);
        const errorText = `⚠️ Error: ${message}`;
        recordTaskError(taskId, missionId, null, errorText);
        timeline.upsert({ ...(existing ?? { id: taskId, missionId, role, timestamp: new Date().toISOString() }), text: errorText, status: "error", ...(taskName ? { taskName } : {}), ...(instruction ? { instruction } : {}), ...(turnId ? { turnId } : {}) });
        timeline.forget(taskId);
        void clearFileStream(resultPath);
      } catch (recordErr) {
        // Even recording the failure failed (the database is unusable): nothing more can be done than saying so.
        logger.error(`[make-it-so] Could not record the failure of crew result ${taskId}:`, recordErr);
      }
    });
  });

  deps.crewRunner.on("error", (taskId, agent, error) => {
    deps.activityLog?.finish(taskId);
    // Fallback via the permanent record, same as for done above.
    const existing = timeline.get(taskId);
    const started = getTaskStarted(taskId);
    const turnId = existing?.turnId ?? started?.turnId ?? undefined;
    const taskName = existing?.taskName ?? started?.taskName ?? undefined;
    const instruction = existing?.instruction ?? started?.instruction ?? undefined;
    const role = existing?.role ?? deps.agentToRole(agent);
    const missionId = existing?.missionId ?? started?.missionId ?? DEFAULT_MISSION_ID;
    const resultPath = crewResultPath(deps.agentsDir, agent, taskId);
    const errorText = `⚠️ Error: ${error}`;
    // This branch must read the result file: the output produced before the failure is kept as partial_output,
    // separate from the error text for display —
    // crew-runner.ts reads what had been written so far, instead of silently losing it.
    readFileStream(resultPath).then(async (partialOutput) => {
      recordTaskError(taskId, missionId, partialOutput || null, errorText);
      timeline.upsert({ ...(existing ?? { id: taskId, missionId, role, timestamp: new Date().toISOString() }), text: errorText, status: "error", ...(taskName ? { taskName } : {}), ...(instruction ? { instruction } : {}), ...(turnId ? { turnId } : {}) });
      timeline.forget(taskId);
      await clearFileStream(resultPath);
    }).catch((err: unknown) => {
      // This chain must have a `.catch()`: without one, a failure here (the read, or something inside
      // `.then()`) would become an unhandled Promise rejection.
      // This is already an error-handling path, so a simple log is enough — there is no need to handle "an error
      // while handling an error" in any more elaborate way.
      logger.error(`[make-it-so] Failed to persist crew error ${taskId}:`, err);
    });
  });

  // Permission during a running task (via crewRunner — labeled with taskId).
  // The key includes the "task" marker dedicated to task execution — it is a different process and a different request ID series
  // from the permission on the conversation session side (deps.crewManager.on("permissionRequest", ...) below), so the keys do
  // not collide even if the same (agent, missionId,
  // requestId) happens to coincide.
  // `missionId` is the scope string with the original mission ID restored by taskSessionScope() in crew-runner.ts —
  // so that routing a response through crewManager.respondToPermission()
  // can look it up by the same key that was used when the session was created (see the explanation of
  // PendingPermission.missionId in permission-registry.ts).
  deps.crewRunner.on("permissionRequest", (agent, request, taskId, missionId) => {
    // taskId is best-effort display metadata (it can be undefined if this fired before task_started) —
    // register it in every case so that it is never dropped on the grounds that the correspondence cannot be made.
    registerPermission({
      key: `${agent}:task:${missionId}:${request.requestId}`,
      scope: agent,
      missionId: taskSessionScope(missionId),
      ownerMissionId: missionId,
      role: deps.agentToRole(agent),
      requestId: request.requestId,
      taskId,
      toolName: request.toolName,
      toolInput: request.toolInput,
      options: request.options,
      receivedAt: new Date().toISOString(),
    });
  });

  deps.crewRunner.on("agentExited", (agent, missionId) => {
    // The task-running process of this crew member "for this mission" died — its
    // pending permission requests can never be answered again. Task-running sessions are separated per mission
    // (see taskSessionScope in crew-runner.ts), so tasks this crew member is running in other
    // missions are not affected.
    clearScope(agent, taskSessionScope(missionId));
  });

  // Permission during a mission's conversation (directly from crewManager — the single path shared by all crew members).
  // The crewRunner side only handles the task scope, so the conversation scope is picked up here.
  deps.crewManager.on("permissionRequest", (agent, request, missionId) => {
    if (missionFromTaskScope(missionId) !== undefined) return;
    registerPermission({
      key: `${agent}:${missionId}:${request.requestId}`,
      scope: agent,
      missionId,
      ownerMissionId: missionId,
      role: deps.agentToRole(agent),
      requestId: request.requestId,
      toolName: request.toolName,
      toolInput: request.toolInput,
      options: request.options,
      receivedAt: new Date().toISOString(),
    });
  });

  deps.crewManager.on("agentExited", (agent, missionId) => {
    if (missionFromTaskScope(missionId) !== undefined) return;
    clearScope(agent, missionId);
  });

  // The captain stopped a turn: the agent was told its pending permission requests are cancelled, so their cards go too
  // (conversation sessions and task-running sessions alike; the scope string tells which).
  deps.crewManager.on("permissionsCancelled", (agent, scope) => {
    clearScope(agent, scope);
  });

  // Forwards to the screen the signal that the conversation session's starting/restarting state changed.
  deps.crewManager.on("sessionStatusChanged", (role, missionId) => {
    deps.broadcast({ type: "crew:status_changed", data: { role, missionId } });
  });
}
