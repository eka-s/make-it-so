import { getUnfinishedTasks, getUnfinishedTurns, recordTaskError, recordTurnError } from "./database.js";
import { SERVER_MESSAGES } from "./messages.js";

// When the server stops in the middle of a turn or a crew task (Ctrl-C, a crash, power loss), the database holds the start
// and never an outcome, so the captain would see their message with no reply, no error and no card, and a delegated task
// would be gone. At the next start, what was left unfinished is recorded as an error, with the text that had been written so
// far (the stream files that exist for exactly this reason).

export type InterruptedWork = {
  turns: Array<{ turnId: string; missionId: string; agent: string }>;
  tasks: Array<{ taskId: string; missionId: string; agent: string }>;
};

export type RecoverDeps = {
  turnStreams: { exists: (turnId: string) => boolean; read: (turnId: string) => Promise<string>; clear: (turnId: string) => Promise<void> };
  /** Reads and removes the result file of a crew task. */
  taskFiles: { read: (agent: string, taskId: string) => Promise<string>; clear: (agent: string, taskId: string) => Promise<void> };
  log: (message: string) => void;
};

/**
 * Finds what the last run left unfinished. It only reads, so it is safe to call before this process owns the port: it is
 * taken BEFORE the port is bound and recorded AFTER, so that a second start of a ship that is already running (which fails to
 * bind and exits) never records the running ship's live turns as interrupted, and a turn that starts after the bind is never
 * taken for an old one.
 */
export function findInterruptedWork(turnStreams: Pick<RecoverDeps["turnStreams"], "exists">): InterruptedWork {
  return {
    // A turn whose reply was empty ends without an outcome on purpose, and its file is removed; only a turn whose file is
    // still there was cut off while it streamed.
    turns: getUnfinishedTurns().filter((turn) => turnStreams.exists(turn.turnId)),
    tasks: getUnfinishedTasks(),
  };
}

/** Records what `findInterruptedWork` found as interrupted (an error, with the text written so far). */
export async function recordInterruptedWork(work: InterruptedWork, deps: RecoverDeps): Promise<{ turns: number; tasks: number }> {
  for (const turn of work.turns) {
    const partial = await deps.turnStreams.read(turn.turnId).catch(() => "");
    recordTurnError(turn.turnId, turn.missionId, partial || null, SERVER_MESSAGES.interrupted, turn.agent, "interrupted");
    await deps.turnStreams.clear(turn.turnId).catch(() => {});
    deps.log(`[Recover] Turn ${turn.turnId} (mission=${turn.missionId}) was interrupted by a stop of the server`);
  }

  for (const task of work.tasks) {
    const partial = await deps.taskFiles.read(task.agent, task.taskId).catch(() => "");
    recordTaskError(task.taskId, task.missionId, partial.trim() || null, SERVER_MESSAGES.interrupted);
    await deps.taskFiles.clear(task.agent, task.taskId).catch(() => {});
    deps.log(`[Recover] Task ${task.taskId} (mission=${task.missionId}) was interrupted by a stop of the server`);
  }

  return { turns: work.turns.length, tasks: work.tasks.length };
}
