import type { ActivityLog } from "./activity-log.js";
import { randomUUID } from "node:crypto";
import type { CrewManager } from "./crew-manager.js";
import {
  recordCaptainMessage,
  recordTurnCompleted,
  recordTurnStarted,
  recordTurnCancelled,
  recordTurnError,
  recordTurnRecoveryStarted,
  recordSystemNotice,
  getTaskStarted,
  getMissionTranscript,
} from "./database.js";
import type { TurnStreams } from "./turn-stream.js";
import * as timeline from "./timeline.js";
import { broadcast } from "./sse-emitter.js";
import { setActivityHandler } from "./bridge-activity.js";
import type { AccountsSnapshot, MeteringUsage } from "./types.js";
import type { BaseAgentClient } from "./agent-client.interface.js";
import { logger } from "./logger.js";
import { SERVER_MESSAGES } from "./messages.js";
import { LANGUAGE_NAMES, type Language } from "./language.js";
import { isSlashCommand } from "./slash-commands.js";


// If the commander's own response shows no chunk/tool/permission activity for this long,
// it is considered hung instead of being waited for forever — symmetric with the same kind of safeguard in
// crew task execution (src/server/crew-runner.ts).
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const HUNG_MARKER = "treated as hung";

// Grace period from sending a stop (cancel) until the turn is forcibly cut off if it has not ended.
// An escape hatch so that a stop always takes effect even when the other side does not respond (is hung).
const DEFAULT_CANCEL_GRACE_MS = 15 * 1000;

/**
 * Maximum number of mission conversation entries prepended to one prompt
 * (see buildPromptWithMissionContext). A cap so that a huge history is not sent
 * for a mission left alone for a long time or right after a session was recreated.
 */
const MISSION_CONTEXT_LIMIT = 30;

/**
 * Puts an idle-timeout safeguard on one sendPrompt call. The caller must call `bump()` from its own
 * chunk/toolCall/toolCallUpdate listeners to reset the timer on every real activity.
 * Activity from permission requests/responses to the other side is conveyed automatically via bridge-activity.ts
 * (crew-manager.ts/index.ts call reportActivity(missionId) — they live in other modules and
 * cannot import this module directly without a circular import, so a shared channel is used.
 * It is keyed by mission ID so that turns of different missions do not fight over the same
 * channel and overwrite each other's bump functions).
 *
 * Declare it with `using` (e.g. `using idleGuard = createIdleGuard(...)`) rather than calling
 * `dispose()` manually in a `finally` block — then the cleanup
 * (clearing the timer, removing the activity handler) is guaranteed the moment the enclosing scope is left.
 * This is for the same structural reason as FileStream's [Symbol.asyncDispose].
 */
function createIdleGuard(client: BaseAgentClient, sessionId: string, missionId: string, label: string, idleTimeoutMs: number) {
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectOnIdle: ((err: Error) => void) | undefined;
  const bump = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // Waiting for the captain to answer a permission request is not a hang: the timer starts over.
      if (client.hasPendingPermissions()) { bump(); return; }
      logger.warn(`[Bridge] ${label} idle for ${idleTimeoutMs / 1000}s with no activity — treating as hung`);
      try { client.sendCancel(sessionId); } catch { /* best-effort */ }
      rejectOnIdle?.(new Error(`No response for ${idleTimeoutMs / 1000}s — ${HUNG_MARKER}`));
    }, idleTimeoutMs);
  };
  setActivityHandler(missionId, bump);
  bump();
  const dispose = () => {
    if (idleTimer) clearTimeout(idleTimer);
    setActivityHandler(missionId, null);
  };
  return {
    bump,
    race: <T>(p: Promise<T>): Promise<T> =>
      Promise.race([p, new Promise<never>((_, reject) => { rejectOnIdle = reject; })]),
    [Symbol.dispose]: dispose,
  };
}

/**
 * One conversation turn in progress.
 *
 *  - `turnId` plays three roles at once: (1) the `id` of the other side's own live
 *    TimelineItem in this turn (it is stable across chunk streaming, completion, and auto-recovery
 *    retries, so the client only has to update one item in place), (2) the `turnId` tag
 *    given to the crew tasks issued during this turn (they gather into one card), and (3) the `id`
 *    the persisted message is written under (the turn_id of turn_completed_events etc. — a later snapshot
 *    fetch can reproduce exactly the same id).
 *  - `captainMessage` is for resending at auto-recovery.
 *  - `isRecovering` is to prevent double recovery.
 *  - `cancelRequested`, `forceAbort` and `forced` make sure a stop always takes effect (see cancelMessage).
 */
type ActiveTurn = {
  turnId: string;
  agentName: string;
  captainMessage: string;
  isRecovering: boolean;
  /**
   * The captain requested a stop. From then on a failure is treated as "cancelled", not as an "error", and there is no auto-recovery.
   */
  cancelRequested: boolean;
  /** Forcibly cuts it off (ends the waiting processing even if the other side does not respond). */
  forceAbort: (error: Error) => void;
  /** Rejected by `forceAbort`. Used by racing it against the processing that is waiting (untilForced). */
  forced: Promise<never>;
};

function isRecoverableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  return message.includes("-32603") || message.includes("Internal error")
    || message.includes("Kiro failed to generate a response")
    || message.includes("overloaded") || message.includes("rate limit")
    || message.includes(HUNG_MARKER);
}

type SessionHandle = { client: BaseAgentClient; sessionId: string };

/** External dependencies of Bridge. index.ts wires them in production; tests pass fakes. */
export type BridgeDeps = {
  /** Session management (only the part of CrewManager that Bridge uses). */
  crewManager: Pick<CrewManager, "getExistingSession" | "getOrCreateSession" | "killSession" | "abortStartup" | "markSeen" | "getCommands">;
  /** Streams that hold the in-progress text of a turn. */
  turnStreams: TurnStreams;
  /** Keeps what each turn did (its tool calls) so it can be shown again later. Nothing is kept when omitted. */
  activityLog?: Pick<ActivityLog, "recordCall" | "recordOutput" | "finish">;
  /**
   * Whether the role exists in the ship's composition (sending to a nonexistent destination is rejected).
   */
  isCrewRole: (role: string) => boolean;
  /**
   * Looks up the human-readable display name from a role name (used when prepending the mission's conversation).
   */
  displayName: (role: string) => string;
  /** Fetches usage (credits) (broadcast to the screen at the start of a conversation with the commander). */
  fetchUsage: () => Promise<AccountsSnapshot>;
  /** The language the crew speaks. Read on every prompt. */
  crewLanguage: () => Language;
  /** Idle timeout (milliseconds). 5 minutes when omitted. Can be specified to shorten it in tests. */
  idleTimeoutMs?: number;
  /**
   * Grace period from sending a stop until the turn is forcibly cut off (milliseconds). 15 seconds when omitted. Can be specified to shorten it in tests.
   */
  cancelGraceMs?: number;
};

/**
 * Creates the Bridge that manages the conversation (turns) between the captain and the crew. State such as turns in progress
 * is held inside the created instance (no module-level state).
 */
export function createBridge(deps: BridgeDeps) {
  const idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const cancelGraceMs = deps.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;

  /**
   * Turns in progress (per mission ID).
   *
   * The design decision is that **concurrency is per mission**: within the same mission,
   * no matter which crew member is addressed with an `@` mention, only one turn runs at a time (this Map can hold only one entry).
   * Different missions can run in parallel. This is simpler than keying by (crew member × mission) pairs.
   */
  const activeTurns = new Map<string, ActiveTurn>();

  /** Whether a turn is running in that mission now. */
  function isMissionBusy(missionId: string): boolean {
    return activeTurns.has(missionId);
  }

  /** The turnId of the turn in progress in that mission (null if none). */
  function getCurrentTurnId(missionId: string): string | null {
    return activeTurns.get(missionId)?.turnId ?? null;
  }

  /**
   * Whether that crew member is in a conversation turn "in some mission"
   * (used by the crew status display to decide "working").
   * If `missionId` is given, the judgment is limited to that mission.
   */
  function isAgentBusy(agentName: string, missionId?: string): boolean {
    if (missionId) return activeTurns.get(missionId)?.agentName === agentName;
    for (const turn of activeTurns.values()) {
      if (turn.agentName === agentName) return true;
    }
    return false;
  }

  /** For debugging: simulates an RPC -32603 error in the next executePrompt (one-shot) */
  let simulateErrorOnNext = false;

  /**
   * For debugging: arms the error simulator. The next executePrompt call throws
   * an error equivalent to RPC -32603 and triggers auto-recovery.
   * One-shot: once it fires, the flag is reset.
   */
  function armErrorSimulation(): void {
    simulateErrorOnNext = true;
    logger.debug("[Bridge:Debug] Error simulation armed — next prompt will trigger -32603");
  }

  /**
   * Stops the turn in progress. It is made to **always take effect at any stage**:
   * - If there is a session, a cancel is sent (if the other side complies, the turn ends as cancelled).
   * - If the session is starting up, the startup is aborted (the starting process is stopped).
   * - In either case, if the turn has not ended after the grace period (15 seconds by default), the session is forcibly terminated and the waiting processing is cut off
   *   (an escape hatch for when the other side is hung and does not comply with the cancel).
   * A failure after a stop was requested is recorded as "cancelled", not as an "error" (see the catch in executePrompt).
   * Returns false if there is no turn in progress.
   */
  /**
   * Removes a turn's temporary stream file. A failure here is only logged: this runs after the turn's outcome has been recorded,
   * and an exception would make the caller record a second, contradicting outcome (an error after a completion).
   */
  async function clearTurnStream(turnId: string): Promise<void> {
    try {
      await deps.turnStreams.clear(turnId);
    } catch (err) {
      logger.error(`[Bridge] Failed to remove the stream file of ${turnId}:`, err);
    }
  }

  /**
   * The last resort for a turn whose own error handling failed (e.g. the database threw while recording the error): the turn
   * is released, so the mission is not busy forever, and the failure is logged instead of becoming an unhandled rejection.
   */
  function settleBrokenTurn(missionId: string, turnId: string, err: unknown): void {
    logger.error(`[Bridge] Turn ${turnId} (mission=${missionId}) could not be settled:`, err);
    try {
      timeline.forget(turnId);
    } catch {
      // nothing more can be done
    }
    if (activeTurns.get(missionId)?.turnId === turnId) activeTurns.delete(missionId);
  }

  function cancelMessage(missionId: string): boolean {
    const turn = activeTurns.get(missionId);
    if (!turn) return false;
    turn.cancelRequested = true;
    const session = peekSession(turn.agentName, missionId);
    if (session) {
      // If asking the agent to stop fails (its stdin is gone), the forced cut-off below still has to be scheduled.
      try {
        session.client.sendCancel(session.sessionId);
      } catch (err) {
        logger.warn(`[Bridge] Could not send the cancel to ${turn.agentName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      deps.crewManager.abortStartup(turn.agentName, missionId);
    }

    const { turnId, agentName } = turn;
    const timer = setTimeout(() => {
      if (activeTurns.get(missionId)?.turnId !== turnId) return; // already ended
      logger.warn(`[Bridge] Cancel of ${agentName} (mission=${missionId}) was not honoured within ${cancelGraceMs / 1000}s — forcing it`);
      deps.crewManager.abortStartup(agentName, missionId);
      deps.crewManager.killSession(agentName, missionId);
      turn.forceAbort(new Error("Cancelled (forced)"));
    }, cancelGraceMs);
    timer.unref?.();
    return true;
  }

  /**
   * When a forced cut-off happens, cuts off the waiting processing (to end the turn even if the other side does not respond).
   */
  function untilForced<T>(turn: ActiveTurn | undefined, work: Promise<T>): Promise<T> {
    return turn ? Promise.race([work, turn.forced]) : work;
  }

  /** Ends the turn by recording/broadcasting it as "cancelled". */
  function recordCancelledTurn(turnId: string, missionId: string, agentName: string, text: string, credits?: MeteringUsage): void {
    recordTurnCancelled(turnId, missionId, text, credits, agentName);
    clearUnreportedFetch(turnId);
    timeline.upsert({ id: turnId, missionId, role: agentName, text, timestamp: new Date().toISOString(), cancelled: true, credits });
    timeline.forget(turnId);
  }

  /**
   * Session management is unified in crew-manager.ts for all crew members
   * (the commander is treated as "just a crew member" too, so
   * there is no need to branch on whether it is first_officer).
   */

  /**
   * Only peeks at an existing session (without creating one) — for paths such as cancelMessage() where missing it does little harm.
   */
  function peekSession(agentName: string, missionId: string): SessionHandle | null {
    const session = deps.crewManager.getExistingSession(agentName, missionId);
    return session ? { client: session.client, sessionId: session.sessionId } : null;
  }

  /** Gets the session for starting a turn (creating one if there is none). */
  async function resolveSession(agentName: string, missionId: string): Promise<SessionHandle> {
    const session = await deps.crewManager.getOrCreateSession(agentName, missionId);
    return { client: session.client, sessionId: session.sessionId };
  }

  /**
   * Forcibly recreates the session to recover from a temporary error (discards the existing session and starts a new process at the next getOrCreateSession).
   */
  async function restartSession(agentName: string, missionId: string): Promise<SessionHandle> {
    deps.crewManager.killSession(agentName, missionId);
    const session = await deps.crewManager.getOrCreateSession(agentName, missionId);
    return { client: session.client, sessionId: session.sessionId };
  }

  /**
   * Builds a prompt that has the mission's conversation prepended. It does not rely on the crew session's own
   * LLM memory; every time, it builds "what has been said in this mission" from the DB and passes it —
   * the latest part if the session has not started, or only the delta since the last injection if it has.
   *
   * The reference point of the delta (`lastSeenSeq`) is part of the session object, so
   * when the process dies and is recreated it automatically returns to 0 — the accident of
   * "the new session truly remembers nothing, yet a stale reference point is trusted and only a delta is passed"
   * cannot structurally happen.
   */
  function buildPromptWithMissionContext(agentName: string, missionId: string, text: string): string {
    // A provider's slash command (such as `/context`) would no longer start with `/` if a preamble were prepended, and would not be
    // recognized as a command, so it is sent as the bare text. The conversation reference point (markSeen) is not advanced either —
    // advancing it would stop other participants' messages accumulated in the meantime from being injected with the next ordinary message.
    if (isSlashCommand(text, deps.crewManager.getCommands(agentName, missionId))) return text;

    const session = deps.crewManager.getExistingSession(agentName, missionId);
    const afterSeq = session?.lastSeenSeq ?? 0;
    const { entries, maxSeq } = getMissionTranscript(missionId, afterSeq, MISSION_CONTEXT_LIMIT);

    // The reference point is advanced regardless of whether the injection actually happened (this turn's own
    // message and response are accumulated after this, but they are picked up by the next delta).
    deps.crewManager.markSeen(agentName, missionId, maxSeq);

    if (entries.length === 0) return text;

    const transcript = entries
      .map((entry) => `${entry.role === "captain" ? "Captain" : deps.displayName(entry.role)}: ${entry.text}`)
      .join("\n\n");

    return [
      "[SYSTEM: This is the conversation so far in this mission. It includes parts you did not take part in directly (participants in the same mission share the conversation). Take it into account as context and respond to the captain's last message.]",
      "",
      transcript,
      "",
      `[SYSTEM: That is the end of the past conversation. What follows is the captain's current message. Respond in ${LANGUAGE_NAMES[deps.crewLanguage()]}, even if the past conversation above is in another language.]`,
      "",
      text,
    ].join("\n");
  }

  /**
   * Calls sendPrompt once, broadcasting all the streaming chunks/tool calls/credits,
   * and returns the result (full text, stopReason, credits).
   * Called from both executePrompt (the first send) and performAutoRecovery (the retry): it gathers in one place the
   * "start stream → register listeners → sendPrompt → clean up" sequence that used to be repeated identically in both.
   */
  async function runStreamedPrompt(
    session: SessionHandle,
    turnId: string,
    missionId: string,
    prompt: string,
    label: string
  ): Promise<{ fullText: string; stopReason: string; turnCredits: MeteringUsage | null }> {
    const { client, sessionId } = session;
    let turnCredits: MeteringUsage | null = null;
    let stopReason = "unknown";

    // The stream's lifetime is scoped to this block by `await using` —
    // its cleanup (= finish(), which flushes all queued writes to disk) is guaranteed
    // the moment the block is left, however it is left (falling through, an early
    // `return` inside, or an exception).
    {
      await using stream = deps.turnStreams.open(turnId);
      using idleGuard = createIdleGuard(client, sessionId, missionId, label, idleTimeoutMs);

      const onChunk = (chunk: string) => {
        idleGuard.bump();
        // The text is persisted via the turn-stream file and is not accumulated
        // in memory.
        stream.write(chunk);
        timeline.broadcastAppend(turnId, chunk);
      };
      const onToolCall = (title: string) => {
        idleGuard.bump();
        deps.activityLog?.recordCall(turnId, title);
      };
      const onToolCallUpdate = (text: string) => {
        idleGuard.bump();
        deps.activityLog?.recordOutput(turnId, text);
      };
      const onCreditUsage = (credits: number, turnDurationMs: number | null, unit: "usd" | "kiro_credits") => {
        turnCredits = { credits, turnDurationMs, unit };
      };

      client.on("chunk", onChunk);
      client.on("toolCall", onToolCall);
      client.on("toolCallUpdate", onToolCallUpdate);
      client.on("creditUsage", onCreditUsage);

      try {
        if (simulateErrorOnNext) {
          simulateErrorOnNext = false;
          logger.debug("[Bridge:Debug] Simulating RPC error -32603");
          throw new Error("RPC error -32603: Internal error (simulated for debug)");
        }

        const result = await idleGuard.race(client.sendPrompt(sessionId, prompt));
        stopReason = result.stopReason;
      } finally {
        // idleGuard is cleaned up automatically when this block ends (it is declared with `using` above).
        // It is important to remove the listeners before the block ends (= before the stream
        // is cleaned up) — otherwise, if a stray "chunk" event arrived in that gap,
        // it would `stream.write()` to a stream that has already had `.end()` called.
        client.removeListener("chunk", onChunk);
        deps.activityLog?.finish(turnId);
        client.removeListener("toolCall", onToolCall);
        client.removeListener("toolCallUpdate", onToolCallUpdate);
        client.removeListener("creditUsage", onCreditUsage);
      }
    } // <- the stream is surely flushed and closed here

    // The text accumulated in the turn-stream file (see onChunk above) is the final full text
    // — there is no need to read an in-memory aggregate any more. A read failure here (other than the ordinary
    // "still empty" case) is deliberately not caught — it propagates to the caller's
    // `catch`, which records a turn_error and shows the captain a proper error card.
    const fullText = await deps.turnStreams.read(turnId);
    return { fullText, stopReason, turnCredits };
  }

  // For each turn, records "the taskIds the list_unreported_tasks tool returned during that turn".
  // Having the model write a marker such as `<!-- REPORT_COMPLETED: ... -->` exactly into its response text and parsing it
  // with a regex repeatedly dropped some taskIds when reporting multiple tasks — the root cause is the fragility of
  // depending on the format of the model's free-form writing. Instead, the `list_unreported_tasks`
  // tool itself records on the server side "what it returned", and when the turn completes normally
  // that is adopted as is as "reported". It requires no additional action from the commander
  // (writing a marker, calling another tool, etc.).
  // If it is called several times within the same turn, it is overwritten (the most recent call is adopted).
  // The record of a turn that ended in an error or cancellation is discarded with `clearUnreportedFetch`
  // (it is not only left unmarked; the record itself is not left behind either — no leak).
  const fetchedUnreportedTasks = new Map<string, string[]>();

  /**
   * Records the taskIds returned by the `list_unreported_tasks` tool (mcp-board.ts), tied to the calling
   * turn.
   *
   * The caller (agent/missionId) comes from the MCP session's identification header, so
   * the matching turn can be looked up directly — the logic of "if exactly one commander turn is running,
   * assume it is the caller" would silently mix things up when several missions run in parallel, so it was removed.
   *
   * When the caller is a task-running session (`__tasks__` scope),
   * activeTurns has no matching entry so nothing is recorded — the report mechanism only has meaning for
   * the mission's conversation turns, so this is correct behavior
   * (it only means no reported mark is attached; the reporting itself proceeds normally).
   */
  function recordUnreportedFetch(caller: { agent: string; missionId: string }, taskIds: string[]): void {
    const turn = activeTurns.get(caller.missionId);
    if (!turn || turn.agentName !== caller.agent) return;
    fetchedUnreportedTasks.set(turn.turnId, taskIds);
  }

  function clearUnreportedFetch(turnId: string): void {
    fetchedUnreportedTasks.delete(turnId);
  }

  /**
   * Post-processing when a turn completes normally (DB recording and broadcast).
   * Called from both the normal-completion path of `executePrompt` and the success path of
   * `performAutoRecovery`.
   *
   * Each taskId is checked for existence with `getTaskStarted` — even if a nonexistent taskId slips in through
   * hallucination or the like, no orphan row is created in `task_reported_events`. If it exists,
   * the `agent` (the internal directory name) can also be obtained, which is used to build
   * `reportMeta` (what `/api/results/:agent/:taskId` expects is this internal directory
   * name, not the display name).
   */
  function finalizeCompletedTurn(turnId: string, missionId: string, agentName: string, rawFullText: string, turnCredits?: MeteringUsage): void {
    const reportedTaskIds = fetchedUnreportedTasks.get(turnId) ?? [];
    fetchedUnreportedTasks.delete(turnId);
    const cleanText = rawFullText;

    const reportedTasks = reportedTaskIds
      .map((taskId) => {
        const started = getTaskStarted(taskId);
        return started ? { taskId, agent: started.agent } : null;
      })
      .filter((t): t is { taskId: string; agent: string } => t !== null);

    const reportMeta = reportedTasks.length > 0
      ? { tasks: reportedTasks.map((t) => ({ agent: t.agent, taskId: t.taskId })) }
      : undefined;

    recordTurnCompleted(turnId, missionId, cleanText, turnCredits, reportedTasks.map((t) => t.taskId), agentName);
    timeline.upsert({ id: turnId, missionId, role: agentName, text: cleanText, timestamp: new Date().toISOString(), reportMeta, credits: turnCredits });
    timeline.forget(turnId);
  }

  /**
   * Sends the captain's message. If `agentName` is omitted it is addressed to the commander (first_officer)
   * — the default behavior is unchanged. If a crew member's role name is given, it talks to that crew member
   * directly (without going through the commander).
   *
   * **Concurrency is per mission**: if a turn is already running in the same mission it is rejected,
   * but a turn running in another mission has no effect. Within the same mission, no matter which
   * crew member is addressed with an `@` mention, only one turn runs at a time.
   */
  function sendMessage(text: string, agentName: string, missionId: string): string {
    if (activeTurns.has(missionId)) throw new Error("This mission is busy processing a previous message");
    if (!deps.isCrewRole(agentName)) throw new Error(`Unknown crew role "${agentName}"`);

    const messageId = randomUUID();
    let forceAbort!: (error: Error) => void;
    const forced = new Promise<never>((_, reject) => { forceAbort = reject; });
    forced.catch(() => {}); // Even if it is rejected before being raced, do not leave an unhandled rejection
    activeTurns.set(missionId, {
      turnId: messageId,
      agentName,
      // Save the captain's message in preparation for auto-recovery
      captainMessage: text,
      isRecovering: false,
      cancelRequested: false,
      forceAbort,
      forced,
    });

    executePrompt(text, agentName, missionId, messageId).catch((err: unknown) => settleBrokenTurn(missionId, messageId, err));

    return messageId;
  }

  async function executePrompt(text: string, agentName: string, missionId: string, turnId: string): Promise<void> {
    // Create the other side's own live item right away, before awaiting anything — the captain
    // should see the response placeholder immediately, without waiting for the session setup (which can take a while).
    // The same pattern as crew tasks.
    timeline.upsert({ id: turnId, missionId, role: agentName, text: "", timestamp: new Date().toISOString(), status: "streaming" });

    try {
      // Every branch of this turn is persisted via the event log tables.
      recordTurnStarted(turnId, missionId, agentName);
      recordCaptainMessage(text, missionId);

      // In a conversation with any crew member, update and broadcast the credit usage (fetching is throttled to once per 5 minutes)
      deps.fetchUsage()
        .then((data) => broadcast({ type: "credits:usage", data }))
        .catch(() => {});

      // Prepare the session first, then build the prompt with this mission's conversation prepended
      // (the order matters — if it has not started, the session is created in resolveSession above
      // with lastSeenSeq=0, so the latest part is injected all at once).
      const turn = activeTurns.get(missionId);
      const session = await untilForced(turn, resolveSession(agentName, missionId));
      const prompt = buildPromptWithMissionContext(agentName, missionId, text);

      const { fullText, stopReason, turnCredits } = await untilForced(turn, runStreamedPrompt(session, turnId, missionId, prompt, `${agentName} prompt`));

      // stopReason is the only source of information about the result. Even if cancelMessage()
      // was called, if ACP responded with "end_turn", the response completed before the cancel took effect.
      if (stopReason === "cancelled") {
        recordCancelledTurn(turnId, missionId, agentName, fullText || "(cancelled)", turnCredits ?? undefined);
        await clearTurnStream(turnId);
        activeTurns.delete(missionId);
        return;
      }

      if (!fullText.trim()) {
        // Skip an empty response (e.g. when an automatic resume after a restart produced no output)
        timeline.remove(turnId);
        await clearTurnStream(turnId);
        activeTurns.delete(missionId);
        return;
      }

      finalizeCompletedTurn(turnId, missionId, agentName, fullText, turnCredits ?? undefined);
      await clearTurnStream(turnId);

      activeTurns.delete(missionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const turn = activeTurns.get(missionId);

      // If the captain requested a stop, this failure (a startup abort, a forced termination, or the process exiting) ends as
      // "cancelled", not as an error. There is no auto-recovery either.
      if (turn?.cancelRequested && turn.turnId === turnId) {
        logger.info(`[Bridge] sendMessage(${agentName}, mission=${missionId}) ended by the captain's stop (${message})`);
        let partial: string | null = null;
        try {
          partial = await deps.turnStreams.read(turnId);
        } catch (readErr) {
          logger.error(`[Bridge] Failed to read partial output for ${turnId}:`, readErr);
        }
        recordCancelledTurn(turnId, missionId, agentName, partial || "(cancelled)");
        await clearTurnStream(turnId);
        activeTurns.delete(missionId);
        return;
      }

      logger.error(`[Bridge] sendMessage(${agentName}, mission=${missionId}) failed: ${message}`);

      if (isRecoverableError(error) && turn && !turn.isRecovering) {
        logger.info("[Bridge] Recoverable error detected. Starting auto-recovery...");
        // The turn-stream file is deliberately not cleared here — the retry reuses the same
        // turnId and truncates/recreates the file via deps.turnStreams.open,
        // so the partial content of this attempt is meaningless anyway.
        performAutoRecovery(missionId).catch((err: unknown) => settleBrokenTurn(missionId, turnId, err));
        return;
      }

      // Not recoverable, or already recovering — fail as usual. This is already an error-handling path,
      // so a read failure is caught on the spot and falls back to no partial output
      // — to avoid the risk of failing twice (on top of one another).
      const errorText = `⚠️ Error: ${message}`;
      let partialOutput: string | null = null;
      try {
        partialOutput = await deps.turnStreams.read(turnId);
      } catch (readErr) {
        logger.error(`[Bridge] Failed to read partial output for ${turnId}:`, readErr);
      }
      recordTurnError(turnId, missionId, partialOutput || null, errorText, agentName);
      clearUnreportedFetch(turnId);
      timeline.upsert({ id: turnId, missionId, role: agentName, text: errorText, timestamp: new Date().toISOString() });
      timeline.forget(turnId);
      await clearTurnStream(turnId);
      activeTurns.delete(missionId);
    }
  }

  /**
   * Auto-recovery flow:
   * 1. Notify the frontend that recovery is in progress
   * 2. Restart the session (the whole process for the commander, only the session for a crew member)
   * 3. Resend the latest captain message with the system preamble
   * 4. On success: broadcast the response as usual
   * 5. On failure: notify the frontend and set the failed state
   *
   * The same turnId/agentName/live item as the original attempt are reused throughout —
   * to the captain it looks like one item moving smoothly from "generating" through the recovery notice to the
   * response after the retry, not like a string of disconnected placeholder messages.
   */
  async function performAutoRecovery(missionId: string): Promise<void> {
    const turn = activeTurns.get(missionId);
    if (!turn) return;
    turn.isRecovering = true;
    const { turnId, agentName, captainMessage } = turn;

    const recoveryNotice = SERVER_MESSAGES.recovery_started;
    recordTurnRecoveryStarted(turnId, missionId, recoveryNotice, agentName);
    timeline.upsert({ id: turnId, missionId, role: agentName, text: recoveryNotice, timestamp: new Date().toISOString(), status: "streaming", messageKey: "recovery_started" });

    try {
      logger.info(`[Bridge:Recovery] Restarting session for ${agentName} (mission=${missionId})...`);
      const session = await untilForced(turn, restartSession(agentName, missionId));
      logger.info(`[Bridge:Recovery] Session for ${agentName} restarted successfully`);

      if (session.client.requiresSessionResume()) {
        logger.info("[Bridge:Recovery] Sending silent resume...");
        await untilForced(turn, session.client.sendPrompt(session.sessionId, "resume"));
        logger.info("[Bridge:Recovery] Silent resume completed");
      }

      // The session was recreated (= lastSeenSeq went back to 0), so the mission's
      // conversation is prepended again here — the new session after recovery truly remembers
      // nothing, and without this the retry would proceed having lost the context.
      const recoveryPrompt = buildPromptWithMissionContext(agentName, missionId, [
        "[SYSTEM: A server error (-32603) occurred while the previous response was being generated, so the reply was not delivered.",
        "Treat the following captain message as if you were receiving it for the first time.]",
        "",
        captainMessage,
      ].join("\n"));

      // Before starting to stream the retry's chunks, reset the item's text
      // to empty — the "recovering..." notice above is replaced, not appended. This becomes
      // the second turn_started event for the same turn_id
      // — the expected behavior for an append-only log (see the doc comment of recordTurnStarted) — and
      // the stream file is truncated/recreated, discarding the now-meaningless partial content of the original attempt.
      recordTurnStarted(turnId, missionId, agentName);
      timeline.upsert({ id: turnId, missionId, role: agentName, text: "", timestamp: new Date().toISOString(), status: "streaming" });

      const { fullText, stopReason, turnCredits } = await untilForced(turn, runStreamedPrompt(session, turnId, missionId, recoveryPrompt, `${agentName} recovery prompt`));

      if (stopReason === "cancelled") {
        recordCancelledTurn(turnId, missionId, agentName, fullText || "(cancelled)", turnCredits ?? undefined);
        await clearTurnStream(turnId);
      } else {
        finalizeCompletedTurn(turnId, missionId, agentName, fullText, turnCredits ?? undefined);
        await clearTurnStream(turnId);

        // An independent notice — it is added next to the other side's actual response above,
        // not in place of it.
        const noticeText = SERVER_MESSAGES.recovery_rerun;
        const notice = recordSystemNotice(noticeText, missionId, agentName, "recovery_rerun");
        timeline.upsert({ id: notice.id, missionId, role: agentName, text: noticeText, timestamp: notice.timestamp, messageKey: "recovery_rerun" });
        timeline.forget(notice.id);
      }

      logger.info("[Bridge:Recovery] Auto-recovery completed successfully");
    } catch (recoveryError) {
      const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);

      // If the captain requested a stop, it ends as "cancelled", not as an error
      if (turn.cancelRequested) {
        logger.info(`[Bridge:Recovery] Ended by the captain's stop (${message})`);
        let partial: string | null = null;
        try {
          partial = await deps.turnStreams.read(turnId);
        } catch {
          // If it cannot be read, no partial output
        }
        recordCancelledTurn(turnId, missionId, agentName, partial || "(cancelled)");
        await clearTurnStream(turnId);
        return;
      }

      logger.error(`[Bridge:Recovery] Auto-recovery failed: ${message}`);

      const failureText = SERVER_MESSAGES.recovery_failed;
      let partialOutput: string | null = null;
      try {
        partialOutput = await deps.turnStreams.read(turnId);
      } catch (readErr) {
        logger.error(`[Bridge:Recovery] Failed to read partial output for ${turnId}:`, readErr);
      }
      recordTurnError(turnId, missionId, partialOutput || null, failureText, agentName, "recovery_failed");
      clearUnreportedFetch(turnId);
      timeline.upsert({ id: turnId, missionId, role: agentName, text: failureText, timestamp: new Date().toISOString(), messageKey: "recovery_failed" });
      timeline.forget(turnId);
      await clearTurnStream(turnId);
    } finally {
      activeTurns.delete(missionId);
    }
  }

  // --- Report API ---

  /**
   * A shortcut for the report button. It goes through exactly the same path as `sendMessage("report")` (executePrompt)
   * — there is no dedicated path that embeds the DB contents directly in the prompt. Both as the message the captain sees
   * and as what is actually sent to the commander, it is the text "report" itself
   * (the crew member that receives it hits the API itself through the `report` skill and builds the actual report content). The destination is decided by the caller (the current conversation partner).
   */
  function sendReport(agentName: string, missionId: string): { messageId: string } {
    return { messageId: sendMessage("report", agentName, missionId) };
  }

  return {
    sendMessage,
    sendReport,
    cancelMessage,
    isMissionBusy,
    getCurrentTurnId,
    isAgentBusy,
    armErrorSimulation,
    recordUnreportedFetch,
  };
}

export type Bridge = ReturnType<typeof createBridge>;
