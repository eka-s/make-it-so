import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isShipId } from "./ship-id.js";

// Which ships are open in a window of the desktop app. A ship that is open has no port to ask, so it leaves its process ID in a file
// of its own directory and removes it when it stops. A file that outlives a crash is told by its process: one that no longer runs is not an open ship,
// and neither is one whose process ID has since been given to another program (the file also holds when the process started).
// A ship is one process's, whichever way it is opened: the browser version looks here before it starts and after it has bound its port, and the desktop app
// leaves its mark before it looks at the ship's port (running-in-browser.ts), so the two never run the same ship on the same data at once.
// The settings use it to refuse removing a ship that is open, so a mistake has to err toward "open": the file is written before the ship
// does anything, and a process that cannot be signalled for lack of permission (or whose start time cannot be read) still counts as running.

const lockFile = (dir: string, id: string) => {
  if (!isShipId(id)) throw new Error(`Not a ship ID: ${id}`);
  return path.join(dir, "ships", id, "desktop.pid");
};

/** What is known about processes: whether one exists and when it started (both replaced in tests). */
export type ProcessInfo = {
  exists: (pid: number) => boolean;
  /** A text that is the same for as long as the process runs and differs for another process of the same ID; null when it cannot be read. */
  startTime: (pid: number) => string | null;
};

/** Whether a process with this ID exists (signal 0 only checks; EPERM means it exists but belongs to someone else). */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** When the process started, as `ps` prints it, or null where `ps` is missing or does not know the process. */
export function processStartTime(pid: number): string | null {
  try {
    const text = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

const SYSTEM: ProcessInfo = { exists: processExists, startTime: processStartTime };

/** Marks the ship as open in the process `pid`. */
export function writeShipLock(dir: string, id: string, pid: number = process.pid, startTime: string | null = processStartTime(pid)): void {
  fs.writeFileSync(lockFile(dir, id), `${pid}\n${startTime ?? ""}\n`, { mode: 0o600 });
}

/** Removes the mark, but only the one of this process: a newer process may have taken the ship over after a crash. */
export function removeShipLock(dir: string, id: string, pid: number = process.pid): void {
  try {
    if (fs.readFileSync(lockFile(dir, id), "utf-8").split("\n")[0].trim() === String(pid)) fs.unlinkSync(lockFile(dir, id));
  } catch {
    // no mark, or already gone
  }
}

/** The process ID of the window the ship is open in, or null when it is not open. */
export function readShipLock(dir: string, id: string, processes: ProcessInfo = SYSTEM): number | null {
  try {
    const [pidText, startedText] = fs.readFileSync(lockFile(dir, id), "utf-8").split("\n");
    const pid = Number(pidText.trim());
    // The ID comes from a file: 0 and negative numbers would signal a process group, and 1 is init.
    if (!Number.isInteger(pid) || pid <= 1 || !processes.exists(pid)) return null;
    const recorded = (startedText ?? "").trim();
    if (recorded === "") return pid; // written where the start time could not be read: the process ID is all there is
    const current = processes.startTime(pid);
    return current === null || current === recorded ? pid : null;
  } catch {
    return null;
  }
}
