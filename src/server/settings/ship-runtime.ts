import fs from "node:fs";
import path from "node:path";
import { mkdirPrivate } from "../private-dirs.js";
import { isShipId } from "../ship-id.js";

// Starting and stopping ships from the settings server. A ship stays an ordinary process of its own: it is started detached
// (so it keeps running when the settings server is closed) and is found again later through its port. Which ship is on a port
// is asked of the ship itself (`GET /api/health` answers its ID and process ID), so there is no pid file to go stale.

export type ShipRuntimeState = "running" | "stopped" | "conflict";

export type ShipRuntimeStatus = {
  id: string;
  port: number | null;
  /** running: this ship answers on its port. conflict: something else answers there. stopped: nothing does. */
  state: ShipRuntimeState;
  pid?: number;
};

/** How to start a ship: the same program and entry point as the settings server itself (node, or node with tsx in development). */
export type ShipCommand = { execPath: string; args: string[] };

export type ShipRuntimeDeps = {
  /** ~/.make-it-so */
  dir: string;
  command: ShipCommand;
  /** The port of a ship (from its ship.yml), or null when it has none. */
  portOf: (id: string) => number | null;
  fetch: typeof fetch;
  /** Starts a detached process whose output goes to the given file. */
  spawn: (command: string, args: string[], logFile: string) => void;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  /**
   * The process ID of a window of the desktop app the ship is open in, or null. A ship open there has no port to find it by, so a ship that does not
   * answer on its port is looked for here too: the settings must not start it, nor remove it.
   */
  openElsewhere?: (id: string) => number | null;
};

export type ShipRuntime = ReturnType<typeof createShipRuntime>;

const PROBE_TIMEOUT_MS = 800;
const LOG_TAIL_LINES = 60;
const LOG_TAIL_BYTES = 64 * 1024;
const STARTING_GRACE_MS = 3000;


export function createShipRuntime(deps: ShipRuntimeDeps) {
  const logFile = (id: string) => path.join(deps.dir, "ships", id, "logs", "stdout.log");
  // Ships being started right now: asking is not atomic with spawning, so a second request that arrives in between would
  // start a second process (which would also overwrite the first one's log).
  const starting = new Set<string>();

  async function portStatus(id: string): Promise<ShipRuntimeStatus> {
    if (!isShipId(id)) return { id, port: null, state: "stopped" };
    const port = deps.portOf(id);
    if (port === null) return { id, port, state: "stopped" };
    try {
      const res = await deps.fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const body = (await res.json().catch(() => null)) as { shipId?: unknown; pid?: unknown } | null;
      // The pid comes from whatever answers on the port, so it is checked: 0 and negative numbers would make kill() signal a
      // whole process group, and 1 is init.
      if (res.ok && body?.shipId === id && typeof body.pid === "number" && Number.isInteger(body.pid) && body.pid > 1) return { id, port, state: "running", pid: body.pid };
      return { id, port, state: "conflict" };
    } catch {
      return { id, port, state: "stopped" }; // nothing is listening (or it did not answer in time)
    }
  }

  async function status(id: string): Promise<ShipRuntimeStatus> {
    const found = await portStatus(id);
    if (found.state !== "stopped" || !isShipId(id)) return found;
    const pid = deps.openElsewhere?.(id) ?? null;
    return pid === null ? found : { ...found, state: "running", pid };
  }

  return {
    status,

    /** Whether a start was just made: the ship may not answer on its port yet, so it must not be taken for stopped (nor deleted). */
    isStarting: (id: string): boolean => starting.has(id),

    /** Starts a ship that is stopped. Returns the reason when it cannot be started. */
    async start(id: string): Promise<{ ok: true } | { ok: false; reason: "running" | "conflict" | "no_port" }> {
      if (!isShipId(id)) return { ok: false, reason: "no_port" };
      if (starting.has(id)) return { ok: false, reason: "running" };
      starting.add(id);
      let spawned = false;
      try {
        const current = await status(id);
        if (current.port === null) return { ok: false, reason: "no_port" };
        if (current.state !== "stopped") return { ok: false, reason: current.state };
        mkdirPrivate(path.dirname(logFile(id)));
        deps.spawn(deps.command.execPath, [...deps.command.args, "--ship", id], logFile(id));
        spawned = true;
        return { ok: true };
      } finally {
        if (spawned) {
          // Kept for a moment after the spawn: the new process needs a little time before it answers on its port, and
          // until then a second start would look like "stopped" again.
          setTimeout(() => starting.delete(id), STARTING_GRACE_MS).unref();
        } else {
          starting.delete(id);
        }
      }
    },

    /** Stops a running ship (it shuts down on SIGTERM). */
    async stop(id: string): Promise<{ ok: true } | { ok: false; reason: "not_running" }> {
      const current = await status(id);
      if (current.state !== "running" || current.pid === undefined) return { ok: false, reason: "not_running" };
      deps.kill(current.pid, "SIGTERM");
      return { ok: true };
    },

    /** The last lines of what the ship printed when it was started from here (for finding out why it did not start). */
    log(id: string): string {
      if (!isShipId(id)) return "";
      // Only the end of the file is read: the file can be large (a noisy agent), and 60 lines are all that is shown.
      try {
        const file = logFile(id);
        const size = fs.statSync(file).size;
        const length = Math.min(size, LOG_TAIL_BYTES);
        const fd = fs.openSync(file, "r");
        try {
          const buffer = Buffer.alloc(length);
          fs.readSync(fd, buffer, 0, length, size - length);
          return buffer.toString("utf-8").split("\n").slice(-LOG_TAIL_LINES).join("\n");
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        return "";
      }
    },
  };
}
