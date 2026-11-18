import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

// What the settings screen shows first: whether ~/.make-it-so exists, which of its files exist, and the ships in it.
// It only reads. A file that cannot be read is reported on its own entry instead of failing the whole overview.

/** The files directly under ~/.make-it-so that the settings cover (config.yml is optional; the others are needed to start a ship). */
export const SETTINGS_FILES = ["config.yml", "roster.yml", "hosts.yml"] as const;

export type OverviewShip = { id: string; name?: string; port?: number; error?: string };

export type SettingsOverview = {
  /** The absolute path of the directory (shown to the user). */
  dir: string;
  exists: boolean;
  files: { name: string; exists: boolean }[];
  /** Number of persona files (personnel/*.md). */
  personnelCount: number;
  ships: OverviewShip[];
};

function readShip(shipsDir: string, id: string): OverviewShip | null {
  const file = path.join(shipsDir, id, "ship.yml");
  if (!fs.existsSync(file)) return null; // a directory without ship.yml is not a ship
  try {
    const raw = parse(fs.readFileSync(file, "utf-8")) as { name?: unknown; port?: unknown } | null;
    return {
      id,
      ...(typeof raw?.name === "string" ? { name: raw.name } : {}),
      ...(typeof raw?.port === "number" ? { port: raw.port } : {}),
    };
  } catch (err) {
    return { id, error: err instanceof Error ? err.message : String(err) };
  }
}

export function readOverview(dir: string): SettingsOverview {
  if (!fs.existsSync(dir)) return { dir, exists: false, files: SETTINGS_FILES.map((name) => ({ name, exists: false })), personnelCount: 0, ships: [] };

  const personnelDir = path.join(dir, "personnel");
  const personnelCount = fs.existsSync(personnelDir) ? fs.readdirSync(personnelDir).filter((f) => f.endsWith(".md")).length : 0;

  const shipsDir = path.join(dir, "ships");
  const ships = fs.existsSync(shipsDir)
    ? fs.readdirSync(shipsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => readShip(shipsDir, e.name))
        .filter((s): s is OverviewShip => s !== null)
        .sort((a, b) => a.id.localeCompare(b.id))
    : [];

  return {
    dir,
    exists: true,
    files: SETTINGS_FILES.map((name) => ({ name, exists: fs.existsSync(path.join(dir, name)) })),
    personnelCount,
    ships,
  };
}
