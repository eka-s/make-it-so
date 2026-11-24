import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { isShipId } from "../server/ship-id.js";
import { shipPort } from "../server/settings/ship-settings.js";

export type BrowserRun = {
  port: number;
  /** The process answering, when it said a usable one (the settings can stop it with it). */
  pid: number | null;
};

const DEFAULT_HOST = "127.0.0.1";

/**
 * The address the browser version of the ships listens on: `server.host` of config.yml (a ship binds that host, not always the loopback one).
 * A wildcard address cannot be connected to, but means every interface, the loopback one included.
 */
export function shipHost(dir: string): string {
  let host: unknown;
  try {
    host = (parse(fs.readFileSync(path.join(dir, "config.yml"), "utf-8")) as { server?: { host?: unknown } } | null)?.server?.host;
  } catch {
    return DEFAULT_HOST; // no config file, or one that cannot be read: the ship's own loading reports it
  }
  if (typeof host !== "string" || host.trim() === "" || host === "0.0.0.0" || host === "::") return DEFAULT_HOST;
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Where, and in which process, the ship is running in the browser version, or null when it is not. The browser version serves its screen on the ship's
 * port and answers `GET /api/health` with the ship's ID, so asking is how to find it (the same way the settings tell a running ship). The desktop app
 * must not take a ship that is running there: two processes would share its data. A busy ship can be slow to answer, so a start waits longer
 * than the settings screen does when it only asks how things stand.
 */
export async function runningInBrowser(dir: string, id: string, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<BrowserRun | null> {
  if (!isShipId(id)) return null;
  const port = shipPort(dir, id);
  if (port === null) return null;
  const fetchImpl = options.fetch ?? fetch;
  try {
    const res = await fetchImpl(`http://${shipHost(dir)}:${port}/api/health`, { signal: AbortSignal.timeout(options.timeoutMs ?? 800) });
    const body = (await res.json().catch(() => null)) as { shipId?: unknown; pid?: unknown } | null;
    if (!res.ok || body?.shipId !== id) return null;
    // The process ID comes from whatever answers: 0 and negative numbers would signal a process group, and 1 is init.
    const pid = typeof body.pid === "number" && Number.isInteger(body.pid) && body.pid > 1 ? body.pid : null;
    return { port, pid };
  } catch {
    return null; // nothing answers there
  }
}
