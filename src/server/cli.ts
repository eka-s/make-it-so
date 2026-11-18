import { parseStartMode } from "./cli-args.js";

// The entry point (`npm start`, `npm run dev`). Reads the arguments and starts the settings server (`--settings`),
// a ship (`--ship <id>`) or every ship (`--all`). Each side is loaded only when chosen: loading a ship reads its configuration, which the
// settings server must be able to run without.

let mode;
try {
  mode = parseStartMode(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}

if (mode.kind === "all") {
  const os = await import("node:os");
  const { makeItSoDir } = await import("./load-config.js");
  const { createProcessShipRuntime } = await import("./settings/process-runtime.js");
  const { startAllShips } = await import("./settings/start-all.js");
  const dir = makeItSoDir(os.homedir());
  const results = await startAllShips(dir, createProcessShipRuntime(dir));
  if (results.length === 0) console.log(`[Ships] No ships in ${dir}. Make one with --settings (or npm run init).`);
  for (const r of results) console.log(`[Ships] ${r.id}: ${r.outcome}${r.url ? ` (${r.url})` : ""}`);
  // `conflict` (something else holds the port) and `no_port` are not started, so the exit code says so.
  process.exit(results.some((r) => r.outcome === "conflict" || r.outcome === "no_port") ? 1 : 0);
} else if (mode.kind === "settings") {
  const { startSettings } = await import("./settings/settings-main.js");
  try {
    await startSettings({ port: mode.port });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
} else {
  try {
    await import("./index.js");
  } catch (err) {
    // A configuration problem (no ships, several ships and none chosen, ...) is a message for the person, not a stack trace.
    // Anything else is a bug and keeps its stack.
    if (err instanceof Error && err.message.startsWith("[Config]")) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
