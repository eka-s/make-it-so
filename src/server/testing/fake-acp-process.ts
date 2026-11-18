import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

/**
 * A fake ACP agent process for tests. It does not start a real process: it records the lines the client
 * writes to stdin and emits lines to stdout to reproduce responses and events.
 */
export class FakeAcpProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  killed = false;
  /** JSON lines the client wrote to stdin (oldest first). */
  written: Array<Record<string, unknown>> = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) this.written.push(JSON.parse(line));
      }
    });
  }

  /** Emits one line to stdout (an object is turned into JSON). */
  send(message: Record<string, unknown> | string): void {
    this.stdout.write((typeof message === "string" ? message : JSON.stringify(message)) + "\n");
  }

  /** Returns a success response to the id of the most recently written request. */
  respond(id: unknown, result: Record<string, unknown> = {}): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  /** Emits a session update notification (a streaming event). */
  update(update: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update } });
  }

  /** The signals kill() was called with. */
  signals: Array<string | undefined> = [];
  /** As on a real ChildProcess: null while it runs. */
  exitCode: number | null = null;
  signalCode: string | null = null;

  kill(signal?: string): void {
    this.killed = true;
    this.signals.push(signal);
  }

  exit(code: number | null = 1): void {
    this.emit("exit", code);
  }

  /** Emits an "error" event, as a child process does when its command cannot be started (ENOENT). */
  fail(message = "spawn agent ENOENT"): void {
    this.emit("error", new Error(message));
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}
