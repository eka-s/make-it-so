// Which ship to start is given as a command-line argument (`--ship <id>` or `--ship=<id>`), not an
// environment variable: a value left set in a shell profile could silently start the wrong ship.
// Other arguments are ignored here, since the same argument list is also seen by the dev tooling (Vite, tsx).

/** Returns the ship ID given with `--ship`, or undefined when there is none. Throws when `--ship` has no value. */
export function parseShipArg(argv: string[]): string | undefined {
  let shipId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ship") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) throw new Error("[Config] --ship needs a ship ID (for example: --ship my-ship).");
      shipId = value;
      i++;
    } else if (arg.startsWith("--ship=")) {
      const value = arg.slice("--ship=".length);
      if (!value) throw new Error("[Config] --ship needs a ship ID (for example: --ship my-ship).");
      shipId = value;
    }
  }
  return shipId;
}
