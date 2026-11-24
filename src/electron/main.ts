import { app, BrowserWindow, dialog, protocol, shell } from "electron";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeItSoDir } from "../server/load-config.js";
import { logger } from "../server/logger.js";
import { readOverview } from "../server/settings/settings-overview.js";
import { createInMemoryFetch } from "./in-memory-fetch.js";
import { launcherLanguage, renderLauncherPage, renderOpeningPage } from "./launcher-page.js";
import { chooseStartMode } from "./start-mode.js";

// The desktop shell: opening the app runs a ship in this process, and its page is served over an in-memory connection (in-memory-fetch.ts),
// so no port is opened for the UI. (The bulletin-board MCP still has its own loopback listener: the agents are separate processes.)
// With no ship named and not exactly one ship to run, a list lets the person choose one; the chosen ship runs as a process of its own,
// because a process holds one ship (config.ts reads the ship once).
//
// Run it from the build: `npm run build`, then `npm run start:electron` (or `-- --ship <id>`). The page is the built client, which the
// ship's own Express app serves like it does on a port.

// The page's own scheme. `standard` + `secure` give it a real origin and the same-origin rules of a web page; `supportFetchAPI` and
// `stream` let `fetch` and `EventSource` use it. It has to be declared before the app is ready.
const SCHEME = "app";
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

async function main(): Promise<void> {
  const dir = makeItSoDir(os.homedir());
  const mode = chooseStartMode(process.argv.slice(2), readOverview(dir).ships);
  await (mode.kind === "ship" ? runShip() : runLauncher(dir));
}

/** Runs one ship in this process, in one window. */
async function runShip(): Promise<void> {
  // Loaded only now: loading it reads the ship's configuration, which has to be the one being run (and fails when there is no ship to run).
  const { buildShip, shipId } = await import("../server/index.js");

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

  let window: BrowserWindow | null = createWindow(`${SCHEME}://ship/`, { width: 1280, height: 860 });
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

/** Shows the ships to choose from; the chosen one is started as a process of its own and this one ends. */
async function runLauncher(dir: string): Promise<void> {
  await app.whenReady();
  const language = launcherLanguage(app.getLocale());
  const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/open") {
      const id = new URLSearchParams(await request.text()).get("ship");
      // Read again: only a ship that exists and can be read is started.
      if (id === null || !readOverview(dir).ships.some((s) => s.id === id && !s.error)) return new Response("unknown ship", { status: 400 });
      openShip(id);
      setTimeout(() => app.quit(), 500);
      return html(renderOpeningPage(language));
    }
    // The list is read for every visit, so a ship made meanwhile is there.
    return html(renderLauncherPage({ ships: readOverview(dir).ships, language }));
  });
  createWindow(`${SCHEME}://launcher/`, { width: 480, height: 560 });
  app.on("window-all-closed", () => app.quit());
}

/**
 * Starts the app again for one ship, as a process of its own (its own dock icon, its own lock). It is not tied to this process: closing the
 * chooser must not close the ship. An unpackaged run has to pass the script too; a packaged app is the executable itself.
 */
function openShip(id: string): void {
  const entry = app.isPackaged ? [] : [fileURLToPath(import.meta.url)];
  spawn(process.execPath, [...entry, "--ship", id], { detached: true, stdio: "ignore" }).unref();
}

function createWindow(url: string, size: { width: number; height: number }): BrowserWindow {
  const window = new BrowserWindow({
    ...size,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const origin = new URL(url).origin;
  // The page never leaves its own scheme: a link to the web opens in the person's browser, and anything else is refused.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== origin) {
      event.preventDefault();
      if (/^https?:\/\//i.test(target)) void shell.openExternal(target);
    }
  });
  void window.loadURL(url);
  return window;
}

main().catch(async (error: unknown) => {
  logger.error("[make-it-so] Fatal error:", error);
  // Someone who opened the app from its icon has no terminal: the reason is shown in a window.
  await app.whenReady();
  dialog.showErrorBox("Make-It-So", error instanceof Error ? error.message : String(error));
  app.exit(1);
});
