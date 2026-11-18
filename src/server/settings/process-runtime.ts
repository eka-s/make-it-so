import { spawn } from "node:child_process";
import fs from "node:fs";
import { createShipRuntime, type ShipRuntime } from "./ship-runtime.js";
import { shipPort } from "./ship-settings.js";

const MAX_STDOUT_LOG_BYTES = 5 * 1024 * 1024;

/**
 * The ship runtime of this machine: a ship is started with the same program and entry point as this process (node, or node
 * with tsx in development), detached and with its output in a file, so it keeps running when this process ends.
 */
export function createProcessShipRuntime(dir: string): ShipRuntime {
  return createShipRuntime({
    dir,
    command: { execPath: process.execPath, args: [...process.execArgv, process.argv[1]] },
    portOf: (id) => shipPort(dir, id),
    fetch,
    spawn: (command, args, logFile) => {
      // The output of a ship started here is kept across starts (appended), up to a size; past it the file starts over, so it cannot
      // grow without limit (the ship's own app.log rotates; this file holds what the process printed).
      const tooLarge = fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_STDOUT_LOG_BYTES;
      const fd = fs.openSync(logFile, tooLarge ? "w" : "a");
      const child = spawn(command, args, { detached: true, stdio: ["ignore", fd, fd] });
      child.unref();
      fs.closeSync(fd);
    },
    kill: (pid, signal) => process.kill(pid, signal),
  });
}
