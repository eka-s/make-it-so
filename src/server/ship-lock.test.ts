import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("compares start times that differ only in the spacing ps pads a one-digit day with", () => {
    writeShipLock(dir, "alpha", 4242, "Wed Nov  5 07:36:28 2026");
    expect(readShipLock(dir, "alpha", processes(true, "Wed Nov 5 07:36:28 2026"))).toBe(4242);
    expect(readShipLock(dir, "alpha", processes(true, "Wed Nov 6 07:36:28 2026"))).toBeNull();
  });

  it("errs toward open for a start time written in a form this code does not write (a mark from another version, or another locale)", () => {
    for (const legacy of ["水 11/25 07:36:28 2026", "Mi. 25 Nov. 07:36:28 2026", "garbage"]) {
      fs.writeFileSync(lockPath(), `4242\n${legacy}\n`);
      expect(readShipLock(dir, "alpha", processes(true, "Wed Nov 25 07:36:28 2026"))).toBe(4242);
    }
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
    expect(first).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d\d:\d\d:\d\d \d{4}$/);
    expect(processStartTime(process.pid)).toBe(first);
    expect(processStartTime(2 ** 22 + 12345)).toBeNull();
  });

  // The mark is written by one process and read by another: the desktop app started from the Dock has no LANG, a terminal has one, and a time zone can differ too.
  it.skipIf(process.platform === "win32")("reads the same text whatever locale and time zone the asking process has", () => {
    const reference = processStartTime(process.pid);
    expect(reference).not.toBeNull();
    for (const [lang, tz] of [["ja_JP.UTF-8", "Asia/Tokyo"], ["de_DE.UTF-8", "Europe/Berlin"], ["C", "UTC"], ["", ""]] as const) {
      vi.stubEnv("LC_ALL", lang);
      vi.stubEnv("LANG", lang);
      vi.stubEnv("TZ", tz);
      expect(processStartTime(process.pid)).toBe(reference);
    }
    vi.unstubAllEnvs();
  });
});
