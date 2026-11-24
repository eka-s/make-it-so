import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopShipRuntime } from "./desktop-runtime.js";
import { writeShipLock } from "../server/ship-lock.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mis-desktop-runtime-"));
  fs.mkdirSync(path.join(dir, "ships", "alpha"), { recursive: true });
  fs.writeFileSync(path.join(dir, "ships", "alpha", "ship.yml"), "port: 3971\n");
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function runtime(browser: { port: number; pid: number | null } | null = null) {
  const openShip = vi.fn();
  const kill = vi.fn();
  const inBrowser = vi.fn(async () => browser);
  return { runtime: createDesktopShipRuntime({ dir, openShip, kill, inBrowser }), openShip, kill, inBrowser };
}

describe("the runtime of the desktop app", () => {
  it("says a ship is stopped until its window's process leaves a mark, and keeps the port of its ship.yml", async () => {
    const { runtime: r } = runtime();
    expect(await r.status("alpha")).toEqual({ id: "alpha", port: 3971, state: "stopped" });
    writeShipLock(dir, "alpha", process.pid);
    expect(await r.status("alpha")).toEqual({ id: "alpha", port: 3971, state: "running", pid: process.pid });
  });

  it("says a ship is running when it runs in the browser version (nothing may start it twice or remove it)", async () => {
    const { runtime: r } = runtime({ port: 3971, pid: 4321 });
    expect(await r.status("alpha")).toEqual({ id: "alpha", port: 3971, state: "running", pid: 4321 });
    expect(await runtime({ port: 3971, pid: null }).runtime.status("alpha")).toEqual({ id: "alpha", port: 3971, state: "running" });
  });

  it("starts a ship by opening its window", async () => {
    const { runtime: r, openShip } = runtime();
    expect(await r.start("alpha")).toEqual({ ok: true });
    expect(openShip).toHaveBeenCalledWith("alpha");
  });

  it("opens a ship that is already open again (the app brings its window forward), but not one running in the browser version", async () => {
    writeShipLock(dir, "alpha", process.pid);
    const open = runtime({ port: 3971, pid: 4321 });
    expect(await open.runtime.start("alpha")).toEqual({ ok: true });
    expect(open.openShip).toHaveBeenCalledTimes(1);

    fs.rmSync(path.join(dir, "ships", "alpha", "desktop.pid"));
    const elsewhere = runtime({ port: 3971, pid: 4321 });
    expect(await elsewhere.runtime.start("alpha")).toEqual({ ok: false, reason: "running" });
    expect(elsewhere.openShip).not.toHaveBeenCalled();
  });

  it("stops an open ship with SIGTERM, and a ship of the browser version by the process it said it was, and says so when it is not running", async () => {
    const { runtime: r, kill } = runtime();
    expect(await r.stop("alpha")).toEqual({ ok: false, reason: "not_running" });
    writeShipLock(dir, "alpha", process.pid);
    expect(await r.stop("alpha")).toEqual({ ok: true });
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");

    fs.rmSync(path.join(dir, "ships", "alpha", "desktop.pid"));
    const browser = runtime({ port: 3971, pid: 4321 });
    expect(await browser.runtime.stop("alpha")).toEqual({ ok: true });
    expect(browser.kill).toHaveBeenCalledWith(4321, "SIGTERM");
  });

  it("never touches the file system or a process for an ID that is not a ship", async () => {
    const { runtime: r, openShip, kill, inBrowser } = runtime({ port: 3971, pid: 4321 });
    expect(await r.status("../../etc")).toEqual({ id: "../../etc", port: null, state: "stopped" });
    expect(await r.start("--inspect=127.0.0.1:9229")).toEqual({ ok: false, reason: "no_port" });
    expect(await r.stop("../x")).toEqual({ ok: false, reason: "not_running" });
    expect(openShip).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(inBrowser).not.toHaveBeenCalled();
  });
});
