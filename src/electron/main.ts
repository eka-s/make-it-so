import { app, BrowserWindow, dialog, Menu, protocol, shell } from "electron";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { restrictToOwner } from "../server/private-dirs.js";
import { makeItSoDir } from "../server/load-config.js";
import { logger } from "../server/logger.js";
import { createSettingsApp } from "../server/settings/settings-app.js";
import { readOverview } from "../server/settings/settings-overview.js";
import { buildMenuTemplate } from "./application-menu.js";
import { createDesktopShipRuntime } from "./desktop-runtime.js";
import { createInMemoryFetch } from "./in-memory-fetch.js";
import { launcherLanguage, renderLauncherPage, renderOpeningPage, settingsLabel } from "./launcher-page.js";
import { removeShipLock, writeShipLock } from "../server/ship-lock.js";
import { runningInBrowser } from "./running-in-browser.js";
import { chooseStartMode } from "./start-mode.js";

// The desktop app. Opening it runs a ship in this process, and its page is served over an in-memory connection (in-memory-fetch.ts), so no
// port is opened for the UI. (The bulletin-board MCP still has its own loopback listener: the agents are separate processes.)
// With no ship named and not exactly one ship to run, a list lets the person choose one. A process holds one ship (config.ts reads the ship
// once), so a chosen ship, and the settings, each run as a process of their own; a ship lives as long as its window.
//
// Run it from the build: `npm run build`, then `npm run start:electron` (`-- --ship <id>`, `-- --settings`). The page is the built client, which
// the ship's own Express app serves like it does on a port.

// The page's own scheme. `standard` + `secure` give it a real origin and the same-origin rules of a web page; `supportFetchAPI` and
// `stream` let `fetch` and `EventSource` use it. It has to be declared before the app is ready.
const SCHEME = "app";
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

const here = path.dirname(fileURLToPath(import.meta.url));

// The name shown in the menu bar and the About box (the package name is lower case). Where the data lives does not depend on it.
app.setName("Make-It-So");

// The ship's configuration (config.ts) and the choice of how to start read `process.argv.slice(2)`: the arguments after a script. A packaged app
// has no script, so its arguments follow the executable at once and the first of them would be dropped. A stand-in for the script is put
// there, so the same code reads the arguments either way.
if (app.isPackaged) process.argv.splice(1, 0, fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const dir = makeItSoDir(os.homedir());
  const mode = chooseStartMode(process.argv.slice(2), readOverview(dir).ships);
  if (mode.kind === "ship") await runShip(dir);
  else if (mode.kind === "settings") await runSettings(dir);
  else await runLauncher(dir);
}

/**
 * One instance per name: a second launch focuses the first instead of starting another one on the same data. The lock is per user-data
 * directory, so it is scoped to the name before it is asked for. Returns false when another instance holds it (this one is quitting).
 */
function holdInstance(name: string, window: () => BrowserWindow | null): boolean {
  app.setPath("userData", path.join(app.getPath("appData"), "make-it-so", name));
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on("second-instance", () => {
    const w = window();
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.focus();
  });
  return true;
}

/** Runs one ship in this process, in one window. */
async function runShip(dir: string): Promise<void> {
  // Loaded only now: loading it reads the ship's configuration, which has to be the one being run (and fails when there is no ship to run).
  const { buildShip, shipId } = await import("../server/index.js");
  const id = shipId ?? "default";

  let window: BrowserWindow | null = null;
  if (!holdInstance(id, () => window)) return;
  // The browser version may be running this ship: its port tells (the desktop app's own lock cannot).
  const browserPort = await runningInBrowser(dir, id);
  if (browserPort !== null) throw new Error(`Ship "${id}" is already running in the browser version (port ${browserPort}). Stop it first.`);
  // The mark that tells the settings this ship is open. It comes before anything else the ship does, and goes with the ship.
  writeShipLock(dir, id);
  try {
    const ship = await buildShip();
    // Nothing else holds this ship now (the lock above), so what the last run left unfinished can be recorded as interrupted.
    await ship.recordInterrupted();
    const serve = createInMemoryFetch(ship.app);

    await app.whenReady();
    protocol.handle(SCHEME, (request) => serve(request));
    const language = launcherLanguage(app.getLocale());
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({
      platform: process.platform,
      appName: app.name,
      settingsLabel: `${settingsLabel(language)}…`,
      onSettings: openSettings,
    })));

    window = createWindow(`${SCHEME}://ship/`, { width: 1280, height: 860 });
    window.on("closed", () => { window = null; });
    app.on("window-all-closed", () => app.quit());

    // Stopping the ship (the agents' processes, the database) takes a moment: quit is held until it is done.
    let stopping = false;
    app.on("before-quit", (event) => {
      if (stopping) return;
      stopping = true;
      event.preventDefault();
      ship.stop()
        .catch((error: unknown) => logger.warn("[make-it-so] Could not stop the ship cleanly:", error))
        .finally(() => {
          removeShipLock(dir, id);
          app.exit(0);
        });
    });
    // Quits the same way when the process is asked to stop (Ctrl+C in the terminal, or "stop" in the settings).
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit());
  } catch (error) {
    removeShipLock(dir, id);
    throw error;
  }
}

/** Shows the settings, in one window: the settings screen answers over the same in-memory connection as a ship's page. */
async function runSettings(dir: string): Promise<void> {
  let window: BrowserWindow | null = null;
  if (!holdInstance("settings", () => window)) return;
  restrictToOwner(dir);
  const runtime = createDesktopShipRuntime({ dir, openShip, kill: (pid, signal) => process.kill(pid, signal) });
  const serve = createInMemoryFetch(createSettingsApp({ dir, clientDir: path.join(here, "..", "client"), runtime, desktop: true }));

  await app.whenReady();
  protocol.handle(SCHEME, (request) => serve(request));
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({ platform: process.platform, appName: app.name, settingsLabel: "" })));
  window = createWindow(`${SCHEME}://settings/`, { width: 1100, height: 820 });
  window.on("closed", () => { window = null; });
  app.on("window-all-closed", () => app.quit());
}

/** Shows the ships to choose from; what is chosen is started as a process of its own and this one ends. */
async function runLauncher(dir: string): Promise<void> {
  await app.whenReady();
  const language = launcherLanguage(app.getLocale());
  const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
  let window: BrowserWindow | null = null;
  // The choice has been handed to another process: the list is closed a moment later, so the "opening" page is seen first.
  const handOver = (start: () => void): Response => {
    start();
    setTimeout(() => window?.close(), 500);
    return html(renderOpeningPage(language));
  };
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/open") {
      const id = new URLSearchParams(await request.text()).get("ship");
      // Read again: only a ship that exists and can be read is started.
      if (id === null || !readOverview(dir).ships.some((s) => s.id === id && !s.error)) return new Response("unknown ship", { status: 400 });
      return handOver(() => openShip(id));
    }
    if (request.method === "POST" && url.pathname === "/settings") return handOver(openSettings);
    // The list is read for every visit, so a ship made meanwhile is there.
    return html(renderLauncherPage({ ships: readOverview(dir).ships, language }));
  });
  window = createWindow(`${SCHEME}://launcher/`, { width: 480, height: 560 });
  window.on("closed", () => { window = null; });
  app.on("window-all-closed", () => app.quit());
}

/**
 * Starts the app again with these arguments, as a process of its own (its own dock icon, its own lock). It is not tied to this process:
 * closing the chooser must not close the ship. An unpackaged run has to pass the script too; a packaged app is the executable itself.
 */
function spawnSelf(args: string[]): void {
  const entry = app.isPackaged ? [] : [fileURLToPath(import.meta.url)];
  spawn(process.execPath, [...entry, ...args], { detached: true, stdio: "ignore" }).unref();
}

function openShip(id: string): void {
  spawnSelf(["--ship", id]);
}

function openSettings(): void {
  spawnSelf(["--settings"]);
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
