// The two ways to start the server, told apart by the command-line arguments:
//   --ship <id>                   start a ship (the default mode; see ship-arg.ts)
//   --settings [--port <number>]  start the settings server, where the files in ~/.make-it-so are edited
//   --all                         start every ship that is not running, each as a process of its own, and exit

export const DEFAULT_SETTINGS_PORT = 3938;

export type StartMode = { kind: "ship" } | { kind: "settings"; port: number } | { kind: "all" };

function parsePort(value: string | undefined): number {
  const port = Number(value);
  if (value === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`[Config] --port must be an integer between 1 and 65535 (got ${JSON.stringify(value)}).`);
  }
  return port;
}

/**
 * Decides the start mode. `--settings`, `--ship` and `--all` are three different modes and cannot be combined, and `--port` belongs to `--settings` only
 * (a ship's port is written in its ship.yml). Other arguments are ignored: the dev tooling shares the argument list.
 */
export function parseStartMode(argv: string[]): StartMode {
  let settings = false;
  let all = false;
  let hasShip = false;
  let port: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--settings") settings = true;
    else if (arg === "--all") all = true;
    else if (arg === "--ship" || arg.startsWith("--ship=")) hasShip = true;
    else if (arg === "--port") port = parsePort(argv[++i]);
    else if (arg.startsWith("--port=")) port = parsePort(arg.slice("--port=".length));
  }
  const modes = [settings && "--settings", hasShip && "--ship", all && "--all"].filter(Boolean);
  if (modes.length > 1) throw new Error(`[Config] ${modes.join(" and ")} cannot be used together.`);
  if (!settings && port !== undefined) throw new Error("[Config] --port is only for --settings (a ship's port is set in its ship.yml).");
  if (all) return { kind: "all" };
  return settings ? { kind: "settings", port: port ?? DEFAULT_SETTINGS_PORT } : { kind: "ship" };
}
