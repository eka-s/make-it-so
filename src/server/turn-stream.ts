import fs from "node:fs";
import path from "node:path";
import { openFileStream, readFileStream, clearFileStream, type FileStream } from "./file-stream.js";

// Work area for the in-progress text of the commander's turn. It exists for two reasons, both of which occur right away in practice —
// it is not speculative infrastructure:
//   1. When a client reloads in the middle of streaming, or an SSE tab
//      reconnects, the in-progress text has to be shown — this happens very routinely while the process is alive
//      (getSnapshot in timeline.ts reads this, for a live turn it finds in the "streaming" state).
//   2. A hard crash (process hang, kill -9, power loss) slips past every try/catch — only incremental
//      writes to disk survive it. This is the same pattern crew-runner.ts uses for crew task results
//      (both now share the generic implementation in file-stream.ts).
// A file left behind by a crash or a stop in the middle of a turn is how that turn is found again at the next start
// (see recover-interrupted.ts): it is recorded as interrupted, with what had been written so far.

/**
 * Creates the functions that handle turn streams for `turnsDir` (the directory where turn files are placed).
 * It does not depend on the ship config (config.ts); the directory is passed in as an argument.
 */
export function createTurnStreams(turnsDir: string) {
  const turnFilePath = (turnId: string): string => path.join(turnsDir, `${turnId}.md`);

  return {
    /**
     * Opens the stream of a turn (or of a retry that reuses the same turnId — the file is truncated/recreated, discarding the now-meaningless content of the previous attempt). The caller holds the returned handle as a local variable during that attempt.
     */
    open: (turnId: string): FileStream => openFileStream(turnFilePath(turnId)),
    read: (turnId: string): Promise<string> => readFileStream(turnFilePath(turnId)),
    /** Whether a stream file exists for the turn (a turn that ended normally has none: it is removed at its end). */
    exists: (turnId: string): boolean => fs.existsSync(turnFilePath(turnId)),
    clear: (turnId: string): Promise<void> => clearFileStream(turnFilePath(turnId)),
  };
}

export type TurnStreams = ReturnType<typeof createTurnStreams>;
