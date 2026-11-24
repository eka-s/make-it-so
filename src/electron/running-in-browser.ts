import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { isShipId } from "../server/ship-id.js";
import { shipPort } from "../server/settings/ship-settings.js";

export type BrowserRun = {
  port: number;
  /** The process answering, when it said a usable one (the settings can stop it with it). */
  pid: number | null;
  /**
   * true: the ship itself answered. false: something is listening on the port and is, or may be, the browser version, but did not say so (it refused the
   * probe's Host, or it did not answer in time because it is busy): treated as running, because taking the ship from a process that is running it is worse
   * than refusing for nothing.
   */
  confirmed: boolean;
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
 * than the settings screen does when it only asks how things stand, and a port that is listening but does not answer in time counts as running.
 * Only a refused connection (nothing listens) and an answer that is plainly another program's mean the ship is not running.
 */
export async function runningInBrowser(dir: string, id: string, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<BrowserRun | null> {
  if (!isShipId(id)) return null;
  const port = shipPort(dir, id);
  if (port === null) return null;
  const fetchImpl = options.fetch ?? fetch;
  try {
    const res = await fetchImpl(`http://${shipHost(dir)}:${port}/api/health`, { signal: AbortSignal.timeout(options.timeoutMs ?? 800) });
    const body = (await res.json().catch(() => null)) as { shipId?: unknown; pid?: unknown; error?: unknown } | null;
    if (res.ok && body?.shipId === id) {
      // The process ID comes from whatever answers: 0 and negative numbers would signal a process group, and 1 is init.
      const pid = typeof body.pid === "number" && Number.isInteger(body.pid) && body.pid > 1 ? body.pid : null;
      return { port, pid, confirmed: true };
    }
    // The local-request guard of a ship refuses a Host that is a name (config.yml `server.host` can be one): that refusal is a ship's own answer.
    if (!res.ok && typeof body?.error === "string" && body.error.startsWith("forbidden_")) return { port, pid: null, confirmed: false };
    return null; // another ship, or another program, answers there
  } catch (error) {
    // Something listens and does not answer in time (a ship whose event loop is busy): it may well be this ship. A refused connection means nothing listens.
    return error instanceof DOMException && error.name === "TimeoutError" ? { port, pid: null, confirmed: false } : null;
  }
}
