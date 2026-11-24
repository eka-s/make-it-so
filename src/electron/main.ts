import { app, BrowserWindow, protocol, shell } from "electron";
import path from "node:path";
import { buildShip, shipId } from "../server/index.js";
import { logger } from "../server/logger.js";
import { createInMemoryFetch } from "./in-memory-fetch.js";

// The desktop shell: the ship runs inside this process and its page is served over an in-memory connection (in-memory-fetch.ts), so no
// port is opened for the UI. (The bulletin-board MCP still has its own loopback listener: the agents are separate processes.)
//
// Run it from the build (`npm run build`, then `npm run start:electron -- --ship <id>`): the page is the built client, which the ship's own
// Express app serves like it does on a port.

// The page's own scheme. `standard` + `secure` give it a real origin and the same-origin rules of a web page; `supportFetchAPI` and
// `stream` let `fetch` and `EventSource` use it. It has to be declared before the app is ready.
const SCHEME = "app";
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const PAGE_URL = `${SCHEME}://ship/`;

async function main(): Promise<void> {
  // One window per ship: a second launch for the same ship focuses the first instead of opening a second server on the same data.
  // The lock is per user-data directory, so it is scoped to the ship before it is asked for.
  app.setPath("userData", path.join(app.getPath("appData"), "make-it-so", shipId ?? "default"));
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  const ship = await buildShip();
  // Nothing else holds this ship now (the lock above), so what the last run left unfinished can be recorded as interrupted.
  await ship.recordInterrupted();
  const serve = createInMemoryFetch(ship.app);

  await app.whenReady();
  protocol.handle(SCHEME, (request) => serve(request));

  let window: BrowserWindow | null = createWindow();
  app.on("second-instance", () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  window.on("closed", () => { window = null; });
  app.on("window-all-closed", () => app.quit());

  // Stopping the ship (the agents' processes, the database) takes a moment: quit is held until it is done.
  let stopping = false;
  app.on("before-quit", (event) => {
    if (stopping) return;
    stopping = true;
    event.preventDefault();
    ship.stop().catch((error: unknown) => logger.warn("[make-it-so] Could not stop the ship cleanly:", error)).finally(() => app.exit(0));
  });
  // Quits the same way when the process is asked to stop (Ctrl+C in the terminal).
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit());
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // The page never leaves its own scheme: a link to the web opens in the person's browser, and anything else is refused.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(PAGE_URL)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });
  void window.loadURL(PAGE_URL);
  return window;
}

main().catch((error: unknown) => {
  logger.error("[make-it-so] Fatal error:", error);
  app.exit(1);
});
