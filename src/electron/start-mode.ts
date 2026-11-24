import { parseShipArg } from "../server/ship-arg.js";
import type { OverviewShip } from "../server/settings/settings-overview.js";

/** What the app does when it starts: run one ship, or let the person choose one. */
export type StartMode = { kind: "ship" } | { kind: "launcher" };

/**
 * A ship is run straight away when the person names it (`--ship`) or when there is only one to run: the icon should open the ship
 * without a question. With none or several, the ship has to be chosen from a list.
 * Whether `--ship` names an existing ship is not checked here: loading the ship reports it.
 */
export function chooseStartMode(argv: string[], ships: OverviewShip[]): StartMode {
  if (parseShipArg(argv) !== undefined) return { kind: "ship" };
  return ships.length === 1 ? { kind: "ship" } : { kind: "launcher" };
}
