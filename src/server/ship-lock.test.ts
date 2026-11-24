import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { processExists, readShipLock, removeShipLock, writeShipLock } from "./ship-lock.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mis-lock-"));
  fs.mkdirSync(path.join(dir, "ships", "alpha"), { recursive: true });
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("the mark of an open ship", () => {
  it("says a ship is not open when it left no mark", () => {
    expect(readShipLock(dir, "alpha")).toBeNull();
  });

  it("gives the process the ship is open in", () => {
    writeShipLock(dir, "alpha", process.pid);
    expect(readShipLock(dir, "alpha")).toBe(process.pid);
  });

  it("does not count a mark left by a process that no longer runs", () => {
    writeShipLock(dir, "alpha", 4242);
    expect(readShipLock(dir, "alpha", () => false)).toBeNull();
    expect(readShipLock(dir, "alpha", () => true)).toBe(4242);
  });

  it("does not trust a process ID that would signal a group or init", () => {
    for (const bad of ["0", "-5", "1", "abc", "", "3.5"]) {
      fs.writeFileSync(path.join(dir, "ships", "alpha", "desktop.pid"), bad);
      expect(readShipLock(dir, "alpha", () => true)).toBeNull();
    }
  });

  it("removes its own mark, and leaves the mark of another process alone", () => {
    writeShipLock(dir, "alpha", process.pid);
    removeShipLock(dir, "alpha", 999999);
    expect(readShipLock(dir, "alpha")).toBe(process.pid);
    removeShipLock(dir, "alpha", process.pid);
    expect(readShipLock(dir, "alpha")).toBeNull();
  });

  it("tells a running process from one that does not exist", () => {
    expect(processExists(process.pid)).toBe(true);
    expect(processExists(2 ** 22 + 12345)).toBe(false);
  });
});
