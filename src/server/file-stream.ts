import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger.js";

// A generic file work area for "write while streaming → read the final result → delete",
// shared by the commander's own turns (turn-stream.ts) and crew tasks (crew-runner.ts).
// It does not keep a directory/id scheme itself; it operates on explicit paths — each caller decides where
// files go.
//
// Why writes go through a stream instead of calling a fire-and-forget fs.appendFile per chunk:
// concurrent appendFile calls to the same path are not even guaranteed to complete (or take effect) in call order
// (confirmed in nodejs/node-v0.x-archive#8544), so the tail of a streamed response can silently go missing from
// the persisted file. With one WritableStream per turn/task, writes are queued in order internally, and its end()
// callback is guaranteed (Node >= v15) to fire once, after the queued writes have actually reached the disk —
// exactly the trigger for when it is safe to read the file back.

export type FileStream = {
  /**
   * Queues a chunk to write. The order against other write() calls on the same stream is guaranteed by the
   * internal WritableStream — callers do not need to track it. The boolean backpressure signal that Node's
   * Writable.write() normally returns is deliberately ignored here — at this app's scale, chat-sized text chunks
   * will hardly ever fill the internal buffer, so there is nothing meaningful to react to.
   */
  write(text: string): void;
  /**
   * Ends the stream and resolves once the queued writes have actually been flushed to disk — or
   * REJECTS if the stream reports a write error (disk full, etc.) instead of completing cleanly. A caller must not
   * assume that, because finish() resolved, it may read the file without handling a possible rejection
   * (an earlier version always resolved, silently hiding real write failures as normal completion).
   * Normally this is not called directly — see [Symbol.asyncDispose] below.
   */
  finish(): Promise<void>;
  /**
   * Lets a FileStream be managed with `await using`, instead of calling finish() manually in try/finally — disposal (= finish())
   * then runs automatically the moment the `using` block is left, however it is left (normal completion, early return,
   * thrown exception). A rejection here propagates as the block's own error. This structurally rules out the whole class of bugs
   * where finish() is forgotten in a new branch — rather than relying on remembering to add a try/catch every time.
   */
  [Symbol.asyncDispose](): Promise<void>;
};

/**
 * Opens (creates/truncates) a file for the sequential output of one turn/task.
 * The caller owns the returned handle for the duration of that turn/task —
 * typically `await using stream = openFileStream(...)`, so that disposal (flush) is guaranteed however the
 * scope is left. There is no shared/keyed registry here, so even without `using` there is no room for
 * leaks or key collisions.
 */
export function openFileStream(filePath: string): FileStream {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const stream = fs.createWriteStream(filePath, { flags: "w" });
  stream.on("error", (err) => {
    logger.error(`[FileStream] Write error for ${filePath}:`, err);
  });
  const finish = () =>
    new Promise<void>((resolve, reject) => {
      stream.end((err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  return {
    write(text: string) {
      stream.write(text);
    },
    finish,
    [Symbol.asyncDispose]: finish,
  };
}

/**
 * Reads the accumulated full text. A missing file (ENOENT — not written yet,
 * or already cleared) is a legitimate "no content" case and resolves to "". Any other failure (permissions,
 * disk I/O, etc.) is a real problem and is never swallowed here — it throws, so each caller can either let it
 * propagate to its own existing error handling (e.g. the turn completion in bridge.ts, task_done in index.ts), or,
 * where one failed read should not fail a larger operation, catch it locally and give up showing it (see
 * getSnapshot in timeline.ts). Catching everything and returning "" would make a real I/O error look like an
 * ordinary empty response, with no way to tell the two apart.
 */
export async function readFileStream(filePath: string): Promise<string> {
  try {
    return await fsPromises.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Deletes this file after the content has been safely persisted elsewhere (the DB, etc.) — this is a work area, not an archive. Best effort: a failure here only leaves an orphan file, which is harmless.
 */
export async function clearFileStream(filePath: string): Promise<void> {
  try {
    await fsPromises.unlink(filePath);
  } catch {
    // Already gone, or never created — either is fine.
  }
}
