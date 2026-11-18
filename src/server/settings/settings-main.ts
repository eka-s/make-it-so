import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { restrictToOwner } from "../private-dirs.js";
import { makeItSoDir } from "../load-config.js";
import { createSettingsApp } from "./settings-app.js";
import { createProcessShipRuntime } from "./process-runtime.js";

// Starts the settings server (`--settings`). It has no authentication, so it listens on loopback only —
// unlike a ship there is no setting to change that.

const HOST = "127.0.0.1";

/** The neighboring `dist/client` only when running as the built `dist/server/settings/settings-main.js`. */
function builtClientDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const server = path.dirname(here);
  return path.basename(here) === "settings" && path.basename(server) === "server" && path.basename(path.dirname(server)) === "dist"
    ? path.join(server, "..", "client")
    : undefined;
}

export async function startSettings(options: { port: number }): Promise<http.Server> {
  const dir = makeItSoDir(os.homedir());
  restrictToOwner(dir);
  const clientDir = builtClientDir();
  const runtime = createProcessShipRuntime(dir);
  const server = http.createServer(createSettingsApp({ dir, clientDir, runtime, shipUi: clientDir !== undefined }));

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      reject(err.code === "EADDRINUSE" ? new Error(`[Settings] Port ${options.port} is already in use. Choose another with --port <number>.`) : err);
    });
    server.listen(options.port, HOST, resolve);
  });

  console.log(`[Settings] Editing ${dir}`);
  console.log(`[Settings] Settings server running on http://${HOST}:${options.port}`);
  if (clientDir) console.log(`[Settings] Open http://${HOST}:${options.port} in your browser`);

  const stop = () => {
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return server;
}
