import fs from "node:fs";
import path from "node:path";

// Which ships are open in a window of the desktop app. A ship that is open has no port to ask, so it leaves its process ID in a file
// of its own directory and removes it when it stops. A file that outlives a crash is told by its process: one that no longer runs is not an open ship.
// A ship is one process's, whichever way it is opened: the browser version looks here before it starts (the desktop app looks at the ship's port,
// running-in-browser.ts), so the two never run the same ship on the same data at once.
// The settings use it to refuse removing a ship that is open, so a mistake has to err toward "open": the file is written before the ship
// does anything, and a process that cannot be signalled for lack of permission still counts as running.

const lockFile = (dir: string, id: string) => path.join(dir, "ships", id, "desktop.pid");

/** Whether a process with this ID exists (signal 0 only checks; EPERM means it exists but belongs to someone else). */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Marks the ship as open in the process `pid`. */
export function writeShipLock(dir: string, id: string, pid: number = process.pid): void {
  fs.writeFileSync(lockFile(dir, id), String(pid), { mode: 0o600 });
}

/** Removes the mark, but only the one of this process: a newer process may have taken the ship over after a crash. */
export function removeShipLock(dir: string, id: string, pid: number = process.pid): void {
  try {
    if (fs.readFileSync(lockFile(dir, id), "utf-8").trim() === String(pid)) fs.unlinkSync(lockFile(dir, id));
  } catch {
    // no mark, or already gone
  }
}

/** The process ID of the window the ship is open in, or null when it is not open. */
export function readShipLock(dir: string, id: string, exists: (pid: number) => boolean = processExists): number | null {
  try {
    const pid = Number(fs.readFileSync(lockFile(dir, id), "utf-8").trim());
    // The ID comes from a file: 0 and negative numbers would signal a process group, and 1 is init.
    return Number.isInteger(pid) && pid > 1 && exists(pid) ? pid : null;
  } catch {
    return null;
  }
}
