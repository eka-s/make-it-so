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

function runtime() {
  const openShip = vi.fn();
  const kill = vi.fn();
  return { runtime: createDesktopShipRuntime({ dir, openShip, kill }), openShip, kill };
}

describe("the runtime of the desktop app", () => {
  it("says a ship is stopped until its window's process leaves a mark, and keeps the port of its ship.yml", async () => {
    const { runtime: r } = runtime();
    expect(await r.status("alpha")).toEqual({ id: "alpha", port: 3971, state: "stopped" });
    writeShipLock(dir, "alpha", process.pid);
    expect(await r.status("alpha")).toEqual({ id: "alpha", port: 3971, state: "running", pid: process.pid });
  });

  it("starts a ship by opening its window", async () => {
    const { runtime: r, openShip } = runtime();
    expect(await r.start("alpha")).toEqual({ ok: true });
    expect(openShip).toHaveBeenCalledWith("alpha");
  });

  it("stops an open ship with SIGTERM, and says so when it is not open", async () => {
    const { runtime: r, kill } = runtime();
    expect(await r.stop("alpha")).toEqual({ ok: false, reason: "not_running" });
    writeShipLock(dir, "alpha", process.pid);
    expect(await r.stop("alpha")).toEqual({ ok: true });
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
  });
});
