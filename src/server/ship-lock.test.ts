import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { processExists, processStartTime, readShipLock, removeShipLock, writeShipLock, type ProcessInfo } from "./ship-lock.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mis-lock-"));
  fs.mkdirSync(path.join(dir, "ships", "alpha"), { recursive: true });
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const lockPath = () => path.join(dir, "ships", "alpha", "desktop.pid");
const processes = (exists: boolean, startTime: string | null): ProcessInfo => ({ exists: () => exists, startTime: () => startTime });

describe("the mark of an open ship", () => {
  it("says a ship is not open when it left no mark", () => {
    expect(readShipLock(dir, "alpha")).toBeNull();
  });

  it("gives the process the ship is open in", () => {
    writeShipLock(dir, "alpha", process.pid);
    expect(readShipLock(dir, "alpha")).toBe(process.pid);
  });

  it("does not count a mark left by a process that no longer runs", () => {
    writeShipLock(dir, "alpha", 4242, "Mon Nov 24 20:00:00 2026");
    expect(readShipLock(dir, "alpha", processes(false, "Mon Nov 24 20:00:00 2026"))).toBeNull();
    expect(readShipLock(dir, "alpha", processes(true, "Mon Nov 24 20:00:00 2026"))).toBe(4242);
  });

  it("does not count a mark whose process ID now belongs to another program (it started at another time)", () => {
    writeShipLock(dir, "alpha", 4242, "Mon Nov 24 20:00:00 2026");
    expect(readShipLock(dir, "alpha", processes(true, "Tue Nov 25 09:15:00 2026"))).toBeNull();
  });

  it("errs toward open when the start time cannot be read now, or was not recorded", () => {
    writeShipLock(dir, "alpha", 4242, "Mon Nov 24 20:00:00 2026");
    expect(readShipLock(dir, "alpha", processes(true, null))).toBe(4242);
    writeShipLock(dir, "alpha", 4242, null);
    expect(readShipLock(dir, "alpha", processes(true, "Tue Nov 25 09:15:00 2026"))).toBe(4242);
  });

  it("does not trust a process ID that would signal a group or init", () => {
    for (const bad of ["0", "-5", "1", "abc", "", "3.5"]) {
      fs.writeFileSync(lockPath(), bad);
      expect(readShipLock(dir, "alpha", processes(true, null))).toBeNull();
    }
  });

  it("removes its own mark, and leaves the mark of another process alone", () => {
    writeShipLock(dir, "alpha", process.pid);
    removeShipLock(dir, "alpha", 999999);
    expect(readShipLock(dir, "alpha")).toBe(process.pid);
    removeShipLock(dir, "alpha", process.pid);
    expect(readShipLock(dir, "alpha")).toBeNull();
  });

  it("never builds a path from something that is not a ship ID", () => {
    expect(readShipLock(dir, "../../etc")).toBeNull();
    expect(() => writeShipLock(dir, "../x", process.pid)).toThrow();
    expect(() => removeShipLock(dir, "../x")).not.toThrow();
  });

  it("tells a running process from one that does not exist", () => {
    expect(processExists(process.pid)).toBe(true);
    expect(processExists(2 ** 22 + 12345)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("reads when this process started, the same on every look and not for a process that does not exist", () => {
    const first = processStartTime(process.pid);
    expect(first).toMatch(/\d/);
    expect(processStartTime(process.pid)).toBe(first);
    expect(processStartTime(2 ** 22 + 12345)).toBeNull();
  });
});
