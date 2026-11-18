import { EventEmitter } from "node:events";
import type { CrewManager } from "./crew-manager.js";
import type { BaseAgentClient, PermissionRequest } from "./agent-client.interface.js";
import type { MeteringUsage } from "./types.js";
import { crewResultPath } from "./crew-paths.js";
import { openFileStream } from "./file-stream.js";
import { logger } from "./logger.js";

// Represents one task issued to a crew member. The MCP bulletin board's `dispatch_task` tool
// is the only path that issues tasks.
/**
 * Scope of the task-running session (a pseudo mission ID used for the mission side of the session key in
 * crew-manager.ts).
 *
 * A task is something to use "when you want the context completely separated from the conversation with the captain", so it runs in a
 * dedicated scope that is shared with no mission's conversation session.
 *
 * **It is separated per mission**: if a single pseudo scope keyed only by `agent` were used, tasks issued to the same
 * crew member from different missions would fight over the same queue/session and be serialized, with the real-world bug that
 * "the card of the later-issued task shows up late, and because the issuing turn has already completed it gets no turnId
 * and drops out of the grouping". With a scope per mission, consecutive issues within the same mission are
 * still processed in order, while issues from different missions run completely in parallel.
 */
const TASK_SESSION_PREFIX = "__tasks__:";

/** Builds the task-running session scope string dedicated to the given mission. */
export function taskSessionScope(missionId: string): string {
  return `${TASK_SESSION_PREFIX}${missionId}`;
}

/**
 * If the session scope string is a task-running scope, returns the original mission ID
 * extracted from it. If it is not a task-running scope (= it is the mission's conversation
 * session itself), returns undefined.
 */
export function missionFromTaskScope(scope: string): string | undefined {
  return scope.startsWith(TASK_SESSION_PREFIX) ? scope.slice(TASK_SESSION_PREFIX.length) : undefined;
}

/** Folds an agent + mission pair into one string (the internal key of queues/agentTask/idleBump). */
function taskKey(agent: string, missionId: string): string {
  return `${agent}::${missionId}`;
}

export type TaskEvent = {
  agent: string;
  taskId: string;
  // The mission this task belongs to (which mission's timeline it appears in on screen, and which mission's
  // scope the running session is separated by — see taskSessionScope). It still
  // shares no context with the conversation session.
  missionId: string;
  originalName: string;
  content: string;
  /** Role of the crew member who issued this task (decides how unreported tasks appear). */
  dispatchedBy: string;
  /** The conversation turn that issued the task, taken when it was dispatched (a queued task may start long after that turn ended). */
  turnId?: string;
  // The prompt actually sent to the live session. When omitted, `content` is used as is.
  // `dispatch_task` passes only a short notice here, separate from `content` (the complete instruction
  // for recording and for reading back later with `get_task`).
  livePrompt?: string;
};

type RunnerEvents = {
  started: [taskId: string, agent: string, originalName: string, instruction: string, missionId: string, dispatchedBy: string, turnId: string | undefined];
  chunk:   [taskId: string, agent: string, text: string];
  // The same mechanism as the "thinking" display of the commander's own turn (bridge.ts) —
  // for a crew task, tool calls need to be forwarded too, or no "thinking" display appears.
  // Several tasks of a crew member can run at the same time, so they are emitted so as to
  // be told apart by taskId.
  toolCall:       [taskId: string, agent: string, title: string];
  toolCallUpdate: [taskId: string, agent: string, text: string];
  done:    [taskId: string, agent: string, credits?: MeteringUsage, cancelled?: boolean];
  error:   [taskId: string, agent: string, error: string];
  // taskId is best-effort (a request can fire before this agent's current task has
  // claimed `agentTask`, e.g. right after the first issue) — it is only display metadata and must never
  // be required for routing the response. missionId is "which mission's task is running" (the task-running session itself is
  // independent of missions, but it is required for separating the scope of display/permission
  // registration — see index.ts).
  permissionRequest: [agent: string, request: PermissionRequest, taskId: string | undefined, missionId: string];
  agentExited: [agent: string, missionId: string];
};

type RunningTask = { client: BaseAgentClient; sessionId: string; agent: string };

// If a crew member shows no chunk/permission activity for this long, it is considered hung, rather than
// waiting forever with no signal at all — when an upstream API call is stuck (or in any other silent failure mode)
// it becomes a visible task_error instead of hanging indefinitely with no error, no chunks, and nothing.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export class CrewRunner extends EventEmitter<RunnerEvents> {
  // Every key is `taskKey(agent, missionId)` — separated per mission
  // (see taskSessionScope at the top of this file).
  private queues  = new Map<string, Promise<void>>();
  private running = new Map<string, RunningTask>();
  // taskKey(agent, missionId) -> taskId. Claimed before session setup starts (not once the
  // client/sessionId is known) — a permission request can fire in the middle of setup (spawn/initialize/persona
  // injection), before an entry exists in `running`. It is only used to label which task a request is
  // for and never affects the forwarding itself.
  private agentTask = new Map<string, string>();
  // taskKey(agent, missionId) -> the callback that "resets the idle timeout" for the current run.
  // A permission request/response takes human reaction time (not just model latency), so it also
  // counts as activity and does not get the task timed out.
  private idleBump = new Map<string, () => void>();
  // Tasks that were dispatched and have not started running a prompt yet (queued behind another task, or still setting up
  // their session), and, among them, the ones the captain has cancelled. A cancel can only reach a running prompt through
  // the agent; for these, it is remembered and honored when the task's turn comes.
  private waiting = new Set<string>();
  private cancelledWhileWaiting = new Set<string>();

  constructor(
    private crewManager: CrewManager,
    // Directory for the result files of crew tasks (passed in by the caller from the ship config).
    private agentsDir: string,
  ) {
    super();
    // crewManager manages both task-running sessions and the missions' conversation sessions.
    // Only the task side is handled here — permission/exit on the conversation side are received by index.ts directly from crewManager.
    this.crewManager.on("permissionRequest", (agent, request, scope) => {
      const missionId = missionFromTaskScope(scope);
      if (missionId === undefined) return;
      const key = taskKey(agent, missionId);
      this.idleBump.get(key)?.();
      this.emit("permissionRequest", agent, request, this.agentTask.get(key), missionId);
    });
    this.crewManager.on("agentExited", (agent, scope) => {
      const missionId = missionFromTaskScope(scope);
      if (missionId === undefined) return;
      this.emit("agentExited", agent, missionId);
    });
  }

  dispatch(event: TaskEvent): void {
    const { agent, missionId } = event;
    const key = taskKey(agent, missionId);
    this.waiting.add(event.taskId);
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.run(event)).catch((err: unknown) => {
      logger.error(`[Crew:Runner] Unhandled queue error for ${key}:`, err);
    });
    this.queues.set(key, next);
  }

  // For the crew status display. When `missionId` is omitted, it looks across all missions at "is it running
  // somewhere" — the same crew member can be busy with tasks of different missions at the same time,
  // so "is it idle now" cannot be decided per mission.
  isRunning(agent: string, missionId?: string): boolean {
    if (missionId !== undefined) return this.agentTask.has(taskKey(agent, missionId));
    const prefix = `${agent}::`;
    for (const key of this.agentTask.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  // For showing "the task running now" in the crew status panel of the left pane
  // (a plain lookup of the same agentTask as isRunning). When `missionId` is given, only that
  // mission's task is looked at — when omitted, the first one found across all missions
  // (for mission-independent lists such as /api/agents).
  getCurrentTaskId(agent: string, missionId?: string): string | undefined {
    if (missionId !== undefined) return this.agentTask.get(taskKey(agent, missionId));
    const prefix = `${agent}::`;
    for (const [key, taskId] of this.agentTask) {
      if (key.startsWith(prefix)) return taskId;
    }
    return undefined;
  }

  /** Cancels a task. Returns false when no such task is queued or running (it may have finished already). */
  cancel(taskId: string): boolean {
    const task = this.running.get(taskId);
    if (task) {
      task.client.sendCancel(task.sessionId);
      logger.info(`[Crew:Runner] Cancel requested: ${taskId}`);
      return true;
    }
    if (this.waiting.has(taskId)) {
      // Queued, or still starting its session: it ends as cancelled instead of running (see run()).
      this.cancelledWhileWaiting.add(taskId);
      logger.info(`[Crew:Runner] Cancel requested before it started: ${taskId}`);
      return true;
    }
    return false;
  }

  private async run(event: TaskEvent): Promise<void> {
    const { agent, taskId, missionId, originalName, content, livePrompt, dispatchedBy } = event;
    const resultPath = crewResultPath(this.agentsDir, agent, taskId);
    const key = taskKey(agent, missionId);

    // Claim this agent for this task before any asynchronous work starts — so that
    // a permission request that fires during the session setup below can also be routed correctly.
    this.agentTask.set(key, taskId);

    // Emit "started" right away, before session setup — the captain should see the cards of all
    // issued members open immediately, and not wait for each member's session setup (spawn/initialize/persona injection,
    // which includes its own permission prompts and can take a while) to finish.
    // A failing listener must not leave this crew member marked busy for good, nor fail the task.
    try {
      this.emit("started", taskId, agent, originalName, content, missionId, dispatchedBy, event.turnId);
    } catch (err) {
      logger.error(`[Crew:Runner] ${taskId} "started" listener failed:`, err);
    }

    // The whole step "run the task and reach a result" is wrapped in one inner
    // async function. This way the result file stream opened with `await using` is guaranteed to be flushed and
    // closed by the time this function returns, whichever branch was reached and even if something
    // threw midway. This structurally rules out the whole class of bugs where, with a manually called finish(), someone forgot
    // to flush/clean up in a new branch — rather than relying on remembering to add a try/catch every time a branch is added.
    // Importantly, the `this.emit("done"/"error", ...)` below runs
    // only after this resolves, i.e. after the stream has already been flushed — index.ts reads the result file the moment it
    // receives that message, so only a fully flushed file is safe to read.
    type Outcome = { kind: "done"; credits?: MeteringUsage; cancelled: boolean } | { kind: "error"; message: string };
    let outcome: Outcome;
    try {
      outcome = await (async (): Promise<Outcome> => {
        await using stream = openFileStream(resultPath);
        // Cancelled while it was queued: it never runs.
        if (this.cancelledWhileWaiting.has(taskId)) return { kind: "done", cancelled: true };
        logger.info(`[Crew:Runner] ${taskId} → running`);

        let session;
        try {
          session = await this.crewManager.getOrCreateSession(agent, taskSessionScope(missionId));
        } catch (err) {
          const message = String(err);
          logger.error(`[Crew:Runner] ${taskId} session error:`, err);
          stream.write(`<!-- ERROR: session failed: ${message} -->\n`);
          return { kind: "error", message };
        }

        const { client, sessionId } = session;
        this.running.set(taskId, { client, sessionId, agent });
        this.waiting.delete(taskId);
        // Cancelled while the session was being set up: stop it before the prompt is sent. The entry is removed again: it is
        // only for a prompt that is running, and a stale one would let a later cancel stop the session's next task.
        if (this.cancelledWhileWaiting.has(taskId)) {
          this.running.delete(taskId);
          return { kind: "done", cancelled: true };
        }

        // A last line of defense, regardless of whether the original process honors sendCancel properly —
        // if it does not, this lets us give up and report the task as failed instead of hanging forever in silence.
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        let rejectOnIdle: ((err: Error) => void) | undefined;
        const bumpIdleTimer = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            // Waiting for the captain to answer a permission request is not a hang: the timer starts over.
            if (client.hasPendingPermissions()) { bumpIdleTimer(); return; }
            logger.warn(`[Crew:Runner] ${taskId} idle for ${IDLE_TIMEOUT_MS / 1000}s with no activity — treating as hung`);
            try { client.sendCancel(sessionId); } catch { /* best effort */ }
            rejectOnIdle?.(new Error(`No response for ${IDLE_TIMEOUT_MS / 1000}s — treated as hung`));
          }, IDLE_TIMEOUT_MS);
        };
        this.idleBump.set(key, bumpIdleTimer);

        const onChunk = (text: string) => {
          bumpIdleTimer();
          stream.write(text);
          this.emit("chunk", taskId, agent, text);
        };
        client.on("chunk", onChunk);

        const onToolCall = (title: string) => {
          bumpIdleTimer();
          this.emit("toolCall", taskId, agent, title);
        };
        const onToolCallUpdate = (text: string) => {
          bumpIdleTimer();
          this.emit("toolCallUpdate", taskId, agent, text);
        };
        client.on("toolCall", onToolCall);
        client.on("toolCallUpdate", onToolCallUpdate);
        bumpIdleTimer();

        // The same pattern as bridge.ts (the commander's own turn) — subscribe only during this task's
        // sendPrompt call, and adopt the last received value as this task's consumption.
        let taskCredits: MeteringUsage | undefined;
        const onCreditUsage = (credits: number, turnDurationMs: number | null, unit: "usd" | "kiro_credits") => {
          taskCredits = { credits, turnDurationMs, unit };
        };
        client.on("creditUsage", onCreditUsage);

        try {
          const { stopReason } = await Promise.race([
            // If livePrompt is given (the short notice via dispatch_task), send that; otherwise send `content` as is.
            client.sendPrompt(sessionId, livePrompt ?? content),
            new Promise<never>((_, reject) => { rejectOnIdle = reject; }),
          ]);
          stream.write("\n");
          // A task the captain cancelled ends with the stop reason "cancelled" (ACP) and the output so far.
          return { kind: "done", credits: taskCredits, cancelled: stopReason === "cancelled" };
        } catch (err) {
          const message = String(err);
          logger.error(`[Crew:Runner] ${taskId} prompt error:`, err);
          stream.write(`\n\n<!-- ERROR: ${message} -->\n`);
          // The session may still have this prompt pending (hung, or failed half-way): the next task must not be written to
          // the same process, so the session is discarded and the next task starts a fresh one.
          try {
            this.crewManager.killSession(agent, taskSessionScope(missionId));
          } catch (killErr) {
            logger.error(`[Crew:Runner] ${taskId} could not discard the session:`, killErr);
          }
          return { kind: "error", message };
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
          client.off("chunk", onChunk);
          client.off("toolCall", onToolCall);
          client.off("toolCallUpdate", onToolCallUpdate);
          client.off("creditUsage", onCreditUsage);
          this.running.delete(taskId);
          if (this.idleBump.get(key) === bumpIdleTimer) this.idleBump.delete(key);
        }
      })();
    } catch (flushErr) {
      // The disposal (finish()) of the `await using` block itself rejected — this is a real
      // write failure (disk full, etc.), not a prompt-level error.
      // index.ts cannot trust a file it cannot confirm was completely written, so this too
      // becomes a task_error instead of a quiet task_done.
      logger.error(`[Crew:Runner] ${taskId} failed to flush result file:`, flushErr);
      outcome = { kind: "error", message: String(flushErr) };
    } finally {
      this.agentTask.delete(key);
      this.waiting.delete(taskId);
      this.cancelledWhileWaiting.delete(taskId);
    }

    if (outcome.kind === "done") {
      logger.info(`[Crew:Runner] ${taskId} ${outcome.cancelled ? "■ cancelled" : "✓ done"}`);
      this.emit("done", taskId, agent, outcome.credits, outcome.cancelled);
    } else {
      this.emit("error", taskId, agent, outcome.message);
    }
  }
}
