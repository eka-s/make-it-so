import path from "node:path";
import { loadYaml, loadCrew, resolveShip } from "./fleet-config.js";
import { DEFAULT_LANGUAGE, LANGUAGES, isLanguage, type Language } from "./language.js";
import { DEFAULT_THEME, THEMES, isTheme, type Theme } from "./theme.js";
import { CONFIG_DEFAULTS, LOG_LEVELS, PROVIDERS, type LogLevel, type Provider } from "./config-defaults.js";

interface RawConfig {
  // Global settings shared by all ship processes, not per ship (the host to bind to).
  server?: { host?: string };
  acp?: {
    provider?: Provider;
    kiro?: { command?: string; args?: string[] };
    claude?: { command?: string; args?: string[] };
  };
  // UI language ("en" | "ja"). Default: "en". A value saved from the UI overrides this at runtime.
  language?: string;
  // The language the crew speaks ("en" | "ja"). Default: the value of `language`.
  // A value saved from the UI overrides this at runtime.
  crew_language?: string;
  // The default look of the screen ("classic" | "light"). Default: "classic". A choice made in a browser wins over this in that browser.
  theme?: string;
  debug?: boolean;
  // Logging (see logger.ts). A global setting shared by all ship processes —
  // it is one process per ship, so there is no point in separating it per ship; it lives in the same place as debug.
  // When unset, the defaults are `level: "info"` and `maxFileSizeMb: 5`.
  logging?: {
    level?: LogLevel;
    maxFileSizeMb?: number;
  };
}

/** Name of the directory in the user's home that holds everything: config.yml, the roster, and the ships. */
export const HOME_DIR_NAME = ".make-it-so";

/** The directory that holds config.yml, roster.yml, hosts.yml, personnel/ and ships/ (the fleet). */
export function makeItSoDir(homeDir: string): string {
  return path.join(homeDir, HOME_DIR_NAME);
}

function loadRawConfig(dir: string, log: (msg: string) => void): RawConfig {
  const file = path.join(dir, "config.yml");
  const raw = loadYaml<RawConfig>(file);
  if (raw) {
    log(`[Config] Loaded from ${file}`);
    return raw;
  }
  log(`[Config] No config.yml found at ${file}, using defaults`);
  return {};
}

function parseLanguage(value: unknown, key: string, fallback: Language = DEFAULT_LANGUAGE): Language {
  if (value === undefined) return fallback;
  if (!isLanguage(value)) {
    throw new Error(`[Config] "${key}" must be one of ${LANGUAGES.join(", ")} (got ${JSON.stringify(value)}).`);
  }
  return value;
}

function parseTheme(value: unknown): Theme {
  if (value === undefined) return DEFAULT_THEME;
  if (!isTheme(value)) {
    throw new Error(`[Config] "theme" must be one of ${THEMES.join(", ")} (got ${JSON.stringify(value)}).`);
  }
  return value;
}

function fail(key: string, expected: string, value: unknown): never {
  throw new Error(`[Config] "${key}" in config.yml must be ${expected} (got ${JSON.stringify(value)}).`);
}

/** Checks the values of config.yml that would otherwise fail much later, or silently do something else (a typo in a provider, a non-boolean debug). */
function validateRawConfig(config: RawConfig): void {
  const { acp, server, logging } = config;
  if (acp?.provider !== undefined && !(PROVIDERS as readonly string[]).includes(acp.provider)) fail("acp.provider", `one of ${PROVIDERS.join(", ")}`, acp.provider);
  for (const provider of PROVIDERS) {
    const entry = acp?.[provider];
    if (entry?.command !== undefined && (typeof entry.command !== "string" || entry.command.trim() === "")) fail(`acp.${provider}.command`, "a non-empty text", entry.command);
    if (entry?.args !== undefined && !(Array.isArray(entry.args) && entry.args.every((a) => typeof a === "string"))) fail(`acp.${provider}.args`, "a list of texts", entry.args);
  }
  if (server?.host !== undefined && (typeof server.host !== "string" || server.host.trim() === "")) fail("server.host", "a non-empty text", server.host);
  if (config.debug !== undefined && typeof config.debug !== "boolean") fail("debug", "true or false", config.debug);
  if (logging?.level !== undefined && !(LOG_LEVELS as readonly string[]).includes(logging.level)) fail("logging.level", `one of ${LOG_LEVELS.join(", ")}`, logging.level);
  const size = logging?.maxFileSizeMb;
  if (size !== undefined && !(typeof size === "number" && Number.isFinite(size) && size > 0)) fail("logging.maxFileSizeMb", "a positive number", size);
}

/**
 * External values used for loading (the chosen ship, the user's home directory, log output). Tests pass fakes.
 */
export type LoadConfigDeps = {
  /** The ship to start (the `--ship` argument). It can be omitted when there is only one ship. */
  shipId?: string;
  /** The user's home directory; everything is read from `.make-it-so` inside it. */
  homeDir: string;
  log: (msg: string) => void;
};

/**
 * Reads config.yml and the fleet (both live in `~/.make-it-so`) and builds the runtime config object.
 * Problems in the configuration (no ship found, etc.) throw.
 * Files are only seen through the arguments, so it can be tested with a temporary directory.
 */
export function loadConfig({ shipId, homeDir, log }: LoadConfigDeps) {
  const fleetRoot = makeItSoDir(homeDir);
  const raw = loadRawConfig(fleetRoot, log);
  validateRawConfig(raw);
  const shipsDir = path.join(fleetRoot, "ships");

  const ship = resolveShip(shipsDir, shipId);
  log(`[Config] Ship: ${ship.id} (port ${ship.port})`);

  const projectRoot = ship.root;
  const uiLanguage = parseLanguage(raw.language, "language");


  const provider: Provider = raw.acp?.provider ?? CONFIG_DEFAULTS.provider;

  return {
    port:        ship.port,
    // Loopback only by default: this server has no authentication, so binding to all
    // interfaces would let any process/page reachable from the LAN (or even a malicious web page open in the same browser,
    // via CORS/CSRF) send arbitrary instructions to the commander. Override explicitly only
    // when you understand that risk (server.host in config.yml).
    host:        raw.server?.host ?? CONFIG_DEFAULTS.host,
    shipId:      ship.id,
    // Display name (for the UI). If ship.yml has no "name:", the identifier (shipId) as is.
    shipName:    ship.file.name ?? ship.id,
    projectRoot,
    fleetRoot,
    language:    uiLanguage,
    crewLanguage: parseLanguage(raw.crew_language, "crew_language", uiLanguage),
    theme:       parseTheme(raw.theme),
    debug:       raw.debug ?? CONFIG_DEFAULTS.debug,

    // Logging (see logger.ts). When unset: info level, rotation at 5 MB.
    logging: {
      level:         raw.logging?.level         ?? CONFIG_DEFAULTS.logLevel,
      maxFileSizeMb: raw.logging?.maxFileSizeMb ?? CONFIG_DEFAULTS.maxFileSizeMb,
    },

    // Work area for the commander's own turn streaming (turn-stream.ts).
    // A turn file is created at turn_started, appended to per chunk, read back at the turn's terminal event,
    // and then deleted — it is not meant to accumulate. Unlike a crew member's agents_dir/results,
    // it is pure working scratch that is not persisted to the DB, so it lives in this directory, separate from agentsDir.
    get turnsDir()        { return path.join(this.projectRoot, "turns"); },
    // What the crew did (tool calls) for each recent turn and task, one file each (see activity-log.ts).
    get activityDir()     { return path.join(this.projectRoot, "activity"); },
    get agentsDir()       { return path.join(this.projectRoot, "agents"); },
    get skillsDir()       { return path.join(this.projectRoot, "skills"); },
    // Where log files go (see logger.ts). As a concern separate from the DB (data/), an independent directory
    // is created directly under the ship root, matching the plain subdirectory layout of the ship root alongside
    // agents/skills/workspace/archive/turns (so data/ stays dedicated to DB files).
    get logsDir()         { return path.join(this.projectRoot, "logs"); },

    acp: {
      provider,
      kiro: {
        command: raw.acp?.kiro?.command ?? CONFIG_DEFAULTS.kiro.command,
        args:    raw.acp?.kiro?.args    ?? CONFIG_DEFAULTS.kiro.args,
      },
      claude: {
        command: raw.acp?.claude?.command ?? CONFIG_DEFAULTS.claude.command,
        args:    raw.acp?.claude?.args    ?? CONFIG_DEFAULTS.claude.args,
      },
    },

    crew: loadCrew(fleetRoot, projectRoot, ship),

  };
}

/** The return type of `loadConfig`. */
export type Config = ReturnType<typeof loadConfig>;
