import { app, BrowserWindow, dialog, Menu, protocol, screen, shell } from "electron";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { restrictToOwner } from "../server/private-dirs.js";
import { isShipId } from "../server/ship-id.js";
import { makeItSoDir } from "../server/load-config.js";
import { logger } from "../server/logger.js";
import { createSettingsApp } from "../server/settings/settings-app.js";
import { readOverview } from "../server/settings/settings-overview.js";
import { buildMenuTemplate } from "./application-menu.js";
import { withScript } from "./argv.js";
import { createDesktopShipRuntime } from "./desktop-runtime.js";
import { createInMemoryFetch } from "./in-memory-fetch.js";
import { createLauncherHandler } from "./launcher-handler.js";
import { launcherLanguage, settingsLabel } from "./launcher-page.js";
import { removeShipLock, writeShipLock } from "../server/ship-lock.js";
import { withShellRequests, type PageReport } from "./shell-requests.js";
import { minimumWindowWidth, windowButtonsTop } from "./window-fit.js";
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

// The ship's configuration (config.ts) and the choice of how to start read `process.argv.slice(2)`: see withScript for what a packaged app needs.
process.argv = withScript(process.argv, app.isPackaged, fileURLToPath(import.meta.url));

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
  // The mark that tells the settings, and the browser version, this ship is open. It comes before anything else the ship does (the browser version looks
  // for it after it has bound its port, so whichever of the two comes second sees the other), and goes with the ship.
  writeShipLock(dir, id);
  try {
    // The browser version may be running this ship: its port tells (the desktop app's own lock cannot). A busy ship is slow to answer, so this waits for it.
    const browser = await runningInBrowser(dir, id, { timeoutMs: 2500 });
    if (browser !== null) {
      throw new Error(browser.confirmed
        ? `Ship "${id}" is already running in the browser version (port ${browser.port}). Stop it first.`
        : `Something is listening on port ${browser.port}, the port of ship "${id}" in the browser version, and did not say what it is. If it is that ship, stop it first.`);
    }
    const ship = await buildShip();
    // Once the ship is built, a failure has to stop it (its sessions, the MCP listener, the database) before the mark goes: the mark is what tells the other
    // version this ship is taken.
    try {
      // Nothing else holds this ship now (the lock above), so what the last run left unfinished can be recorded as interrupted.
      await ship.recordInterrupted();
      const serve = withShellRequests(createInMemoryFetch(ship.app), (report) => fitWindowToPage(window, report, SHIP_MIN_WIDTH));

      await app.whenReady();
      protocol.handle(SCHEME, (request) => serve(request));
      const language = launcherLanguage(app.getLocale());
      Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({
        platform: process.platform,
        appName: app.name,
        settingsLabel: `${settingsLabel(language)}…`,
        onSettings: openSettings,
      })));

      window = createWindow(`${SCHEME}://ship/`, { width: 1280, height: 860 }, { pageIsTitleBar: true, minWidth: SHIP_MIN_WIDTH });
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
      await ship.stop().catch((stopError: unknown) => logger.warn("[make-it-so] Could not stop the ship cleanly:", stopError));
      throw error;
    }
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
  const serve = withShellRequests(
    createInMemoryFetch(createSettingsApp({ dir, clientDir: path.join(here, "..", "client"), runtime, desktop: true })),
    (report) => fitWindowToPage(window, report, SETTINGS_MIN_WIDTH),
  );

  await app.whenReady();
  protocol.handle(SCHEME, (request) => serve(request));
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({ platform: process.platform, appName: app.name, settingsLabel: "" })));
  window = createWindow(`${SCHEME}://settings/`, { width: 1100, height: 820 }, { pageIsTitleBar: true, minWidth: SETTINGS_MIN_WIDTH });
  window.on("closed", () => { window = null; });
  app.on("window-all-closed", () => app.quit());
}

/** Shows the ships to choose from; what is chosen is started as a process of its own and this one ends. */
async function runLauncher(dir: string): Promise<void> {
  await app.whenReady();
  const language = launcherLanguage(app.getLocale());
  let window: BrowserWindow | null = null;
  protocol.handle(SCHEME, createLauncherHandler({
    readShips: () => readOverview(dir).ships,
    language,
    openShip,
    openSettings,
    // The list is closed a moment later, so the "opening" page is seen first.
    onHandedOver: () => { setTimeout(() => window?.close(), 500); },
  }));
  window = createWindow(`${SCHEME}://launcher/`, { width: 480, height: 560 });
  window.on("closed", () => { window = null; });
  app.on("window-all-closed", () => app.quit());
}

// Narrower than this (in CSS pixels, at no zoom) the header (title, buttons, language, and the room kept at both ends) no longer fits on its one line.
const SHIP_MIN_WIDTH = 960;
const SETTINGS_MIN_WIDTH = 800;

/**
 * Fits the window to what the page reported about its header, and returns the page's zoom. The page is laid out in CSS pixels and the window in screen
 * points: the header's height on the screen decides where the window buttons go, and a page zoomed in needs a proportionally wider window for the same header.
 * The zoom is the window's own (the page cannot work it out right while the window is being resized).
 * The room kept at the ends of the header is for the window buttons, which are in points: it does not grow with the zoom, only what is between does.
 */
function fitWindowToPage(window: BrowserWindow | null, report: PageReport, minWidth: number): { zoom: number } {
  if (!window) return { zoom: 1 };
  const zoom = window.webContents.getZoomFactor();
  if (process.platform === "darwin") window.setWindowButtonPosition({ x: 16, y: windowButtonsTop(report.height, zoom) });
  const needed = minimumWindowWidth({ minWidth, room: report.room, zoom, screenWidth: screen.getDisplayMatching(window.getBounds()).workAreaSize.width });
  const [, minHeight] = window.getMinimumSize();
  window.setMinimumSize(needed, minHeight);
  const [width, height] = window.getSize();
  if (width < needed) window.setSize(needed, height);
  return { zoom };
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
  // The `--ship=` form keeps an ID from being read as an option of its own, whatever it begins with.
  if (!isShipId(id)) return;
  spawnSelf([`--ship=${id}`]);
}

function openSettings(): void {
  spawnSelf(["--settings"]);
}

function createWindow(url: string, size: { width: number; height: number }, options: { pageIsTitleBar?: boolean; minWidth?: number } = {}): BrowserWindow {
  const window = new BrowserWindow({
    ...size,
    // The minimum is changed with the page's zoom (fitWindowToPage); this is the one before the page has said anything.
    ...(options.minWidth ? { minWidth: options.minWidth } : {}),
    // On macOS the page's own header is the title bar (desktop-shell.css leaves room for the window buttons, which are put at the middle of its height).
    ...(options.pageIsTitleBar && process.platform === "darwin" ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 16, y: 20 } } : {}),
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
