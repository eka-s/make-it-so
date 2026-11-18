import fs from "node:fs";
import path from "node:path";

// The content of `npm run init`. From an empty state, creates the smallest working configuration (config.yml, roster.yml, ship.yml).
// The pure function that decides what to write (planInit) is separate from the function that actually writes (applyInitPlan).
// Generated files contain no proper names taken from any particular work (only neutral names).

export const INIT_PROVIDERS = ["claude", "kiro"] as const;
export type InitProvider = (typeof INIT_PROVIDERS)[number];

export type InitOptions = {
  provider: InitProvider;
  /** Ship ID (becomes the directory name). */
  shipId: string;
  port: number;
  /** The directory that holds config.yml, roster.yml and ships/ (`~/.make-it-so`). */
  homeDir: string;
};

export type PlannedFile = { path: string; content: string };

/** ID of the default crew member (the key in roster.yml) and its display name. */
export const DEFAULT_MEMBER = { id: "alex", name: "Alex" };
export const DEFAULT_SHIP_NAME = "My Ship";

const SHIP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Throws an exception with the reason if the input is invalid. */
function validate(options: InitOptions): void {
  if (!INIT_PROVIDERS.includes(options.provider)) {
    throw new Error(`provider must be one of ${INIT_PROVIDERS.join(", ")} (got ${JSON.stringify(options.provider)})`);
  }
  if (!SHIP_ID_PATTERN.test(options.shipId)) {
    throw new Error(`ship id must contain only letters, digits, "-" and "_" (got ${JSON.stringify(options.shipId)})`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error(`port must be an integer between 1 and 65535 (got ${options.port})`);
  }
  if (!options.homeDir.trim()) {
    throw new Error("home directory must not be empty");
  }
}

/**
 * Returns the list of files to write (absolute paths and contents). It has no side effects and returns the same output for the same input.
 */
export function planInit(options: InitOptions): PlannedFile[] {
  validate(options);
  // A YAML string is safe to write, even with symbols or spaces, if wrapped in double quotes with JSON.stringify
  const config = [
    "# Created by `npm run init`. See config.sample.yml for every available option.",
    "language: en",
    "",
    "acp:",
    `  provider: ${JSON.stringify(options.provider)}`,
    "",
  ].join("\n");
  const roster = [
    "# The fleet roster: who the crew members are. Shared by every ship.",
    "# Add a persona by creating personnel/<id>.md next to this file (optional).",
    "crew:",
    `  ${DEFAULT_MEMBER.id}:`,
    `    name: ${JSON.stringify(DEFAULT_MEMBER.name)}`,
    `    provider: ${JSON.stringify(options.provider)}`,
    "",
  ].join("\n");
  const ship = [
    "# This ship's configuration: its port and which roster member holds which role.",
    "# A role's name is free. \"rank\" sets the task authority: commander (delegates tasks and oversees all of",
    "# them; at most one per ship), chief (delegates tasks and reports on its own), crew (the default: does the work).",
    "# The crew member you talk to by default is the commander, or else the first one listed.",
    `port: ${options.port}`,
    `name: ${JSON.stringify(DEFAULT_SHIP_NAME)}`,
    "",
    "crew:",
    "  lead:",
    `    member: ${DEFAULT_MEMBER.id}`,
    "    rank: commander",
    "",
  ].join("\n");
  return [
    { path: path.join(options.homeDir, "config.yml"), content: config },
    { path: path.join(options.homeDir, "roster.yml"), content: roster },
    { path: path.join(options.homeDir, "ships", options.shipId, "ship.yml"), content: ship },
  ];
}

export type ApplyResult = {
  written: string[];
  /** Files that already existed. If there is even one, nothing is written. */
  conflicts: string[];
};

/**
 * Writes the planned files. **Existing files are never overwritten**: if even one already exists,
 * nothing is written and the existing files are returned in `conflicts` (no half-written state is left behind).
 */
export function applyInitPlan(files: PlannedFile[]): ApplyResult {
  const conflicts = files.filter((f) => fs.existsSync(f.path)).map((f) => f.path);
  if (conflicts.length > 0) return { written: [], conflicts };
  const written: string[] = [];
  for (const file of files) {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    // "wx": even if someone created it after the check, fail instead of overwriting
    fs.writeFileSync(file.path, file.content, { flag: "wx" });
    written.push(file.path);
  }
  return { written, conflicts: [] };
}
