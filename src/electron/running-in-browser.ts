import { shipPort } from "../server/settings/ship-settings.js";

const PROBE_TIMEOUT_MS = 800;

/**
 * The port the ship is running on in the browser version, or null when it is not. The browser version serves its screen on the ship's port and
 * answers `GET /api/health` with the ship's ID, so asking is how to find it (the same way the settings tell a running ship). The desktop app
 * must not take a ship that is running there: two processes would share its data.
 */
export async function runningInBrowser(dir: string, id: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  const port = shipPort(dir, id);
  if (port === null) return null;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const body = (await res.json().catch(() => null)) as { shipId?: unknown } | null;
    return res.ok && body?.shipId === id ? port : null;
  } catch {
    return null; // nothing answers there
  }
}
