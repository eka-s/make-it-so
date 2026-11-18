import { readOverview } from "./settings-overview.js";
import type { ShipRuntime } from "./ship-runtime.js";

// `--all`: starts every ship that is not running, each as a process of its own, as the settings screen does one by one.

export type StartAllResult = { id: string; outcome: "started" | "running" | "conflict" | "no_port"; /** Where the ship answers, when it has a port. */ url?: string };

/** Starts the ships of the directory that are stopped. A ship that is already running is left as it is. */
export async function startAllShips(dir: string, runtime: ShipRuntime): Promise<StartAllResult[]> {
  const results: StartAllResult[] = [];
  for (const ship of readOverview(dir).ships) {
    const result = await runtime.start(ship.id);
    results.push({ id: ship.id, outcome: result.ok ? "started" : result.reason, ...(ship.port !== undefined ? { url: `http://127.0.0.1:${ship.port}` } : {}) });
  }
  return results;
}
