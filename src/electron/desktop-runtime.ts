import type { ShipRuntime } from "../server/settings/ship-runtime.js";
import { shipPort } from "../server/settings/ship-settings.js";
import { readShipLock } from "./ship-lock.js";

export type DesktopRuntimeDeps = {
  /** ~/.make-it-so */
  dir: string;
  /** Opens the ship in a window of its own (the app started again for it). */
  openShip: (id: string) => void;
  kill: (pid: number, signal: NodeJS.Signals) => void;
};

/**
 * What the settings ask of a ship's process, answered for the desktop app: a ship is open when its window's process left a mark
 * (ship-lock.ts), not when something answers on a port. Starting a ship opens its window (a second request for an open ship focuses it:
 * the app keeps one instance per ship).
 */
export function createDesktopShipRuntime(deps: DesktopRuntimeDeps): ShipRuntime {
  return {
    async status(id) {
      const port = shipPort(deps.dir, id);
      const pid = readShipLock(deps.dir, id);
      return pid === null ? { id, port, state: "stopped" } : { id, port, state: "running", pid };
    },
    isStarting: () => false,
    async start(id) {
      deps.openShip(id);
      return { ok: true };
    },
    async stop(id) {
      const pid = readShipLock(deps.dir, id);
      if (pid === null) return { ok: false, reason: "not_running" };
      deps.kill(pid, "SIGTERM");
      return { ok: true };
    },
    // The output of a ship opened here is not kept: it has a window, and its own log file (logs/app.log).
    log: () => "",
  };
}
