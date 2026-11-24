import { isShipId } from "../server/ship-id.js";
import { readShipLock } from "../server/ship-lock.js";
import type { ShipRuntime } from "../server/settings/ship-runtime.js";
import { shipPort } from "../server/settings/ship-settings.js";
import { runningInBrowser, type BrowserRun } from "./running-in-browser.js";

export type DesktopRuntimeDeps = {
  /** ~/.make-it-so */
  dir: string;
  /** Opens the ship in a window of its own (the app started again for it). */
  openShip: (id: string) => void;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  /** Where the ship runs in the browser version, if it does (replaced in tests). */
  inBrowser?: (id: string) => Promise<BrowserRun | null>;
};

/**
 * What the settings ask of a ship's process, answered for the desktop app: a ship is open when its window's process left a mark
 * (ship-lock.ts), not when something answers on a port. A ship running in the browser version counts as running too, whichever way the settings
 * are opened: it must not be started a second time nor removed. Starting a ship opens its window (a second request for an open ship focuses it:
 * the app keeps one instance per ship).
 */
export function createDesktopShipRuntime(deps: DesktopRuntimeDeps): ShipRuntime {
  const inBrowser = deps.inBrowser ?? ((id: string) => runningInBrowser(deps.dir, id));

  return {
    async status(id) {
      if (!isShipId(id)) return { id, port: null, state: "stopped" };
      const port = shipPort(deps.dir, id);
      const pid = readShipLock(deps.dir, id);
      if (pid !== null) return { id, port, state: "running", pid };
      const browser = await inBrowser(id);
      return browser === null ? { id, port, state: "stopped" } : { id, port, state: "running", ...(browser.pid !== null ? { pid: browser.pid } : {}) };
    },
    isStarting: () => false,
    async start(id) {
      if (!isShipId(id)) return { ok: false, reason: "no_port" };
      // Open in a window already: opening it again focuses that window. Running in the browser version: it is not this app's to open.
      if (readShipLock(deps.dir, id) === null && (await inBrowser(id)) !== null) return { ok: false, reason: "running" };
      deps.openShip(id);
      return { ok: true };
    },
    async stop(id) {
      if (!isShipId(id)) return { ok: false, reason: "not_running" };
      const pid = readShipLock(deps.dir, id) ?? (await inBrowser(id))?.pid ?? null;
      if (pid === null) return { ok: false, reason: "not_running" };
      deps.kill(pid, "SIGTERM");
      return { ok: true };
    },
    // The output of a ship opened here is not kept: it has a window, and its own log file (logs/app.log).
    log: () => "",
  };
}
