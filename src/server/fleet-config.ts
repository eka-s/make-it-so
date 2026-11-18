import path from "node:path";
import fs from "node:fs";
import { parse } from "yaml";
import type { HostConfig } from "./ssh.js";
import type { CrewRole } from "./types.js";
import { PROVIDERS } from "./config-defaults.js";

// Reads and validates the settings of the fleet and the ships, and builds the crew composition (CrewMemberConfig).
// Split out of config.ts, and **importing it has no side effects**
// (it reads no files and no environment variables). Every needed value is received as an argument — if, as in config.ts,
// merely importing it loaded and validated the ship config, it could not be tested.
// Passing in the runtime values (fleetRoot, environment variables, etc.) and calling it is the job of config.ts.

/**
 * The crew's rank. It decides the authority over tasks (the bulletin board's `dispatch_task`). The code looks only at the rank,
 * not at the role name or the person (behavioral personality is decided in the persona file).
 * - commander: can issue tasks and can handle the reports of **all** tasks of the ship (the orchestrator; at most one per ship).
 * - chief: can issue tasks and can handle the reports of the tasks **they issued**.
 * - crew: cannot issue tasks (does the work). The default.
 */
export type CrewRank = "commander" | "chief" | "crew";
export const CREW_RANKS: readonly CrewRank[] = ["commander", "chief", "crew"];

/** Whether this rank can issue tasks. */
export function canDispatch(rank: CrewRank): boolean {
  return rank === "commander" || rank === "chief";
}

export type CrewMemberConfig = {
  name: string;
  /** Rank on the ship (`rank` in ship.yml). It decides the authority over tasks. */
  rank: CrewRank;
  provider?: string;
  // The model to use at startup (a value of ACP's model options, e.g. "opus", "sonnet").
  // A per-role (post) setting in ship.yml takes priority over the per-member setting in roster.yml.
  // If neither exists, undefined (the provider's default stays).
  // Per-mission overrides from the screen are kept in the DB, not here (see crew-model.ts).
  model?: string;
  // The permission mode to use at startup (a value of ACP's mode options; for claude, "default" = confirm every time,
  // "acceptEdits", "plan", "auto" = Claude decides, "bypassPermissions", etc.).
  // A per-role setting in ship.yml takes priority over the per-member setting in roster.yml.
  // If neither exists, undefined (the provider's default stays).
  permissionMode?: string;
  acp_agent?: string;
  // The cwd of the ACP session (and of the provider process itself). Already resolved to an absolute path.
  // Decided in this order: per-member `cwd` in ship.yml → per-ship `cwd` → the ship root.
  // It only says "where to work" and has nothing to do with where the persona comes from (`agent` below).
  //
  // The process's cwd is aligned with it too (see spawn in base-acp-client.ts) — because kiro-cli
  // looks for the definition of `--agent` (.kiro/agents) from the process's cwd, not the session's cwd
  // (found by testing on a real machine).
  cwd: string;
  // Host information for running the agent on a remote host (another PC or server).
  // When specified, it is started over SSH (see spawn in base-acp-client.ts) and `cwd`
  // is a path on the remote side (`cwd` is required when `host` is specified).
  host?: HostConfig;
  // Name of the provider-side agent definition (`agent` in ship.yml). It decides where the persona comes from:
  // - Specified: the provider's definition (kiro's `.kiro/agents/<name>.json`, claude's
  //   `.claude/agents/<name>.md`) is the persona. make-it-so does not inject `personnel/`.
  //   kiro takes it via the `--agent` startup argument, claude via `set_config_option` after the session is created.
  // - Not specified: make-it-so injects `personnel/{member}.md` (no persona if the file does not exist).
  // Rules, skills, and the system guidance are always injected in either case.
  agent?: string;
  // Rule files injected in full at startup (absolute paths). In the order roster (personal) → ship.
  rules: string[];
  // Skill files for which only the list (frontmatter name/description) is announced (absolute paths).
  // In the order roster (personal) → ship. Separate from what is found by automatically scanning the ship's `skills/` directory.
  skills: string[];
  // The cwd of the ACP session itself is always fixed to the ship root (config.projectRoot) — when several
  // targets are accessible, there is no priority order or hierarchy that decides which one is the base (cwd).
  // However, when `cwd` is given explicitly in ship.yml (the native way), that is used (see `cwd` above). Access to targets is
  // expressed here instead (additionalDirectories, passed as is to the field of the same name in the ACP protocol —
  // a mechanism that extends only the file system scope without changing cwd). The practical benefits are that "the CLAUDE.md/Skills of that
  // directory itself get loaded" and "a Bash cd goes there without approval"; it is not access control
  // itself (see accessNote below).
  additionalDirectories?: string[];
  // Guidance appended to the persona injection prompt, explaining which part of the ship's mission scope (the ship's targets)
  // this role is responsible for. undefined (nothing is appended) if the ship has no targets.
  //
  // This is not technical access control but a "loose" agreement left to the LLM's own judgment —
  // an implementation relying on each provider's permission mechanism (e.g. Claude Code's permission rules)
  // would be deliberately avoided, because beyond ACP it can only be realized with provider-specific extension
  // mechanisms and would not work at all for other providers such as kiro, creating an asymmetry.
  // An instruction in the prompt reaches every provider the same way.
  accessNote?: string;
};

export interface RosterMember {
  name: string;
  provider?: string;
  // The model this member uses (the ship-side post setting takes priority).
  model?: string;
  // This member's permission mode (the ship-side post setting takes priority).
  permission_mode?: string;
  // Rules/skills tied to this member personally (effective whichever ship they are assigned to).
  // Relative paths are resolved against the fleet root.
  rules?: string[];
  skills?: string[];
}

export interface RawRosterFile {
  crew?: Record<string, RosterMember>;
}

export interface ShipCrewAssignment {
  member: string;
  // This role's rank (commander / chief / crew). crew if omitted. At most one commander per ship.
  rank?: string;
  // The model used for this role (takes priority over the roster member-side setting).
  model?: string;
  // This role's permission mode (takes priority over the roster member-side setting).
  permission_mode?: string;
  // Which part of the ship's `targets` (the whole set of the ship's mission scope) this role is in charge of,
  // and with which permission (readonly = read only / readwrite = free to read and write).
  // A target that is not listed is out of scope (forbidden) — it is computed automatically as the rest of the ship's `targets`
  // minus what is in this map, so it does not need to be written here.
  access?: Record<string, "readonly" | "readwrite">;
  // Override of the per-member cwd (working directory). Unrelated to where the persona comes from.
  cwd?: string;
  // Name of the provider-side agent definition (see CrewMemberConfig.agent). If omitted, make-it-so injects the persona.
  agent?: string;
  // An old name (renamed to `agent`). If it is written, an error asking for the rename is raised.
  profile?: string;
  // Host name when running on a remote host (a key of hosts in fleet/hosts.yml).
  // When specified, `cwd` (an absolute path on the remote side) becomes required.
  host?: string;
}

export interface RawShipFile {
  port?: number;
  // Display name of the ship (for the UI). It can be kept separately from the identifier (directory name, config.shipId)
  // — the same pattern as a roster.yml crew member keeping its id (key) and display name (name) apart.
  // If omitted, shipId (the identifier) is used as the display name as is.
  name?: string;
  targets?: Record<string, string>;
  // Per-ship cwd (working directory; can be overridden per member).
  cwd?: string;
  // Rules/skills effective within the ship (common to all members). Relative paths are resolved against the ship root.
  rules?: string[];
  skills?: string[];
  crew?: Record<string, ShipCrewAssignment>;
}

export function loadYaml<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch (err) {
    // The parser's message only shows a line and column, so attach which file is broken
    throw new Error(`[Config] ${filePath} could not be read: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/**
 * Scans under `{home}/ships/` and automatically lists the directories that have a `ship.yml` as ship candidates.
 * The design is that make-it-so's own config.yml holds no list of ships at all, so that adding a ship
 * only means adding a directory under ships/.
 *
 * A ship.yml that cannot be read is an error for that ship (or when no ship was asked for), but not for the others: when `requested`
 * names another ship, the broken one is skipped with a warning, so one broken ship does not keep the healthy ones from starting.
 */
export function discoverShips(shipsDir: string, requested?: string): Record<string, { root: string; file: RawShipFile }> {
  if (!fs.existsSync(shipsDir)) {
    throw new Error(`[Config] Ships directory not found at ${shipsDir}. Create one with \`npm start -- --settings\` (or \`npm run init\`).`);
  }
  const ships: Record<string, { root: string; file: RawShipFile }> = {};
  for (const entry of fs.readdirSync(shipsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = path.join(shipsDir, entry.name);
    let file: RawShipFile | null;
    try {
      file = loadYaml<RawShipFile>(path.join(root, "ship.yml"));
    } catch (err) {
      if (requested !== undefined && requested !== entry.name) {
        console.warn(`[Config] Skipping ship "${entry.name}": ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      throw err;
    }
    if (!file) continue; // A directory without ship.yml is not treated as a ship candidate
    ships[entry.name] = { root, file };
  }
  return ships;
}

/**
 * Checks that no two ships declare the same `port`. Otherwise a duplicate would only be noticed indirectly,
 * by the OS's `EADDRINUSE` when the two ships are started at the same time (and could not be noticed when starting just one ship), so
 * `discoverShips()` checks ahead of time, when it reads the `ship.yml` of every ship.
 */
export function checkForDuplicatePorts(ships: Record<string, { root: string; file: RawShipFile }>, requested?: string): void {
  const idsByPort = new Map<number, string[]>();
  for (const [id, { file }] of Object.entries(ships)) {
    if (!file.port) continue; // A ship without a port gets a separate error when it is selected, so it is ignored here
    const ids = idsByPort.get(file.port);
    if (ids) ids.push(id); else idsByPort.set(file.port, [id]);
  }
  for (const [port, ids] of idsByPort) {
    // When a ship was asked for, a clash between two other ships is not its problem.
    if (ids.length > 1 && (requested === undefined || ids.includes(requested))) {
      throw new Error(`[Config] Ships ${ids.join(", ")} all declare port ${port} in their ship.yml. Each ship must use a distinct port.`);
    }
  }
}

/**
 * Decides which ship to start as. One make-it-so process always handles exactly
 * one ship (complete data separation between ships is guaranteed at the process/DB file level,
 * not by a runtime scope branch).
 *
 * The ship is chosen with the `--ship` argument, and there are no environment-variable overrides of the ship's
 * settings — with several ships running at the same time, a global override (for example one left set in a shell
 * profile) would be a trap that silently breaks the complete data separation per ship. `port` must be stated
 * explicitly in each ship's `ship.yml`, and if not a single ship is found, startup ends with an error.
 */
export function resolveShip(
  shipsDir: string,
  requested: string | undefined,
): { id: string; root: string; port: number; file: RawShipFile } {
  const ships = discoverShips(shipsDir, requested);
  checkForDuplicatePorts(ships, requested);
  const ids = Object.keys(ships);

  if (ids.length === 0) {
    throw new Error(`[Config] No ships found under ${shipsDir}. Add a ship directory with a ship.yml (create one with \`npm start -- --settings\` or \`npm run init\`, or see config.sample.yml).`);
  }

  let id: string;
  if (requested) {
    if (!ships[requested]) {
      throw new Error(`[Config] Ship "${requested}" (--ship) was not found under ${shipsDir}. Available ships: ${ids.join(", ")}`);
    }
    id = requested;
  } else if (ids.length === 1) {
    id = ids[0];
  } else {
    throw new Error(`[Config] Multiple ships found under ${shipsDir} but none was chosen. Start with --ship <id>. Available ships: ${ids.join(", ")}`);
  }

  const { root, file } = ships[id];
  if (!file.port) {
    throw new Error(`[Config] Ship "${id}" is missing "port" in ${path.join(root, "ship.yml")}.`);
  }
  // A string like "abc" would make listen() open a named pipe instead of a TCP port, so the type and range are checked here.
  if (!Number.isInteger(file.port) || file.port < 1 || file.port > 65535) {
    throw new Error(`[Config] Ship "${id}": "port" in ${path.join(root, "ship.yml")} must be an integer between 1 and 65535 (got ${JSON.stringify(file.port)}).`);
  }

  return { id, root, port: file.port, file };
}

/**
 * Resolves a role's `access` (target name → readonly/readwrite) setting against the ship's `targets`
 * (the whole set of the ship's mission scope). It is not technical access control but a "loose" agreement left to the LLM's own judgment
 * (relying on a provider-specific permission mechanism would be deliberately avoided, because it would not work for other
 * providers such as kiro, creating an asymmetry), so what is built here is
 * (1) the list of absolute paths passed as is to ACP's `additionalDirectories`
 * (including both readonly and readwrite — it still has the practical benefit of declaring "that is also a legitimate working scope"),
 * and (2) the guidance text explaining the scope of responsibility, to be appended to the persona injection prompt.
 *
 * The guidance text does not use abstract words such as "the ship root"; it lists the actual absolute paths as they are —
 * testing on a real machine showed that an expression such as "outside the ship root" leaves the LLM room to interpret what it points to.
 * It takes the simple form of an allow list (a list of absolute paths) + the single sentence "everything else is strictly forbidden".
 */
export function resolveAccess(
  role: string,
  access: Record<string, "readonly" | "readwrite"> | undefined,
  targets: Record<string, string>,
  cwd: string,
  projectRoot: string,
): { additionalDirectories: string[]; accessNote?: string } {
  const targetNames = Object.keys(targets);
  if (targetNames.length === 0) return { additionalDirectories: [] };

  for (const name of Object.keys(access ?? {})) {
    if (!targets[name]) console.warn(`[Config] Ship role "${role}" references unknown target "${name}" in access — ignoring`);
  }

  const additionalDirectories: string[] = [];
  // If cwd is the ship root, a single line "the normal working directory" as before.
  // If cwd is something else (an existing project, etc.), places where we do not want to allow writing (such as a read-only target)
  // may be under cwd, so cwd itself is announced as "readable" and writing is left to the individual specifications.
  const elsewhere = cwd !== projectRoot;
  const lines: string[] = elsewhere
    ? [
        `- ${projectRoot} : read/write freely (the ship's make-it-so directory)`,
        `- ${cwd} : working directory (cwd). Readable. Writing is limited to the individual entries below and to the places for temporary files etc. that the working directory's rules define`,
      ]
    : [`- ${projectRoot} : read/write freely (the normal working directory)`];
  for (const name of targetNames) {
    const targetPath = targets[name];
    const mode = access?.[name];
    if (mode === "readwrite") {
      additionalDirectories.push(targetPath);
      lines.push(`- ${targetPath} (${name}): read/write freely`);
    } else if (mode === "readonly") {
      additionalDirectories.push(targetPath);
      lines.push(`- ${targetPath} (${name}): read-only — writing, modifying and deleting are forbidden`);
    }
    // A mode that is not specified (out of scope) is not put on the allow list — only the allowed directories
    // are listed, and everything else is forbidden at once by the sentence below
  }

  const accessNote = [
    "## Directories you may access (everything else is strictly forbidden)",
    ...lines,
    elsewhere
      ? "Do not write to, modify or delete anything in a place that is not listed above."
      : "Do not access any directory that is not listed above.",
  ].join("\n");

  return { additionalDirectories, accessNote };
}

/**
 * Resolves `cwd` in ship.yml (per member → per ship). If not specified, the ship root.
 * A relative path is resolved against the ship root, and if it does not exist, startup stops with an error
 * (it does not silently fall back to the ship root — the same reason as the existing policy: it is more dangerous to
 * start running somewhere else without noticing a missing setting).
 */
export function resolveCwd(
  role: string,
  memberCwd: string | undefined,
  shipCwd: string | undefined,
  host: HostConfig | undefined,
  projectRoot: string,
): string {
  const specified = memberCwd ?? shipCwd;
  if (host) {
    // A remote path cannot be checked on our file system (and it is not converted by path.resolve —
    // so that a Windows main process does not break a remote path).
    if (!specified || !path.posix.isAbsolute(specified)) {
      throw new Error(`[Config] ship role "${role}" uses host "${host.name}": "cwd" must be an absolute path on the remote host (got ${specified ? `"${specified}"` : "nothing"})`);
    }
    return specified;
  }
  if (!specified) return projectRoot;
  const cwd = path.resolve(projectRoot, specified);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`[Config] cwd for ship role "${role}" does not exist or is not a directory: ${cwd}`);
  }
  return cwd;
}

/**
 * Resolves a list of rules/skills files to absolute paths. A relative path is relative to `baseDir`
 * (the fleet root for the roster, the ship root for the ship). A nonexistent file stops startup
 * with an error (to prevent starting without noticing a missed injection).
 */
export function resolveFiles(kind: "rules" | "skills", owner: string, baseDir: string, files: string[] | undefined): string[] {
  return (files ?? []).map((f) => {
    const abs = path.resolve(baseDir, f);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new Error(`[Config] ${kind} file for ${owner} not found: ${abs}`);
    }
    return abs;
  });
}

/**
 * Reads the remote host definitions (`{fleetRoot}/hosts.yml`, name → ssh destination).
 * They are referenced by name with `host:` from the crew in ship.yml. Without the file, remote
 * crew members cannot be used (if there is a reference, loadCrew raises an error).
 *
 * Only the destination name may be written here (fleet settings that may be shared via git).
 * Connection details such as key paths, ports, and host key handling go in ~/.ssh/config
 * (so that information that would be trouble if it were left in the repository by mistake cannot be put here at all).
 * An unknown key is not silently ignored; an error pointing to where to move it is raised.
 */
/**
 * Whether a destination is acceptable: a ~/.ssh/config Host name or user@host. One that starts with "-" would be
 * interpreted by ssh as an option (option injection), and whitespace has no place in one.
 */
export function isValidHostDestination(destination: unknown): destination is string {
  return typeof destination === "string" && destination !== "" && !destination.startsWith("-") && !/\s/.test(destination);
}

export function loadHosts(fleetRoot: string): Record<string, HostConfig> {
  const hostsPath = path.join(fleetRoot, "hosts.yml");
  const file = loadYaml<{ hosts?: Record<string, { destination?: unknown } | null> }>(hostsPath);
  const hosts: Record<string, HostConfig> = {};
  for (const [name, h] of Object.entries(file?.hosts ?? {})) {
    const unknownKeys = Object.keys(h ?? {}).filter((k) => k !== "destination");
    if (unknownKeys.length > 0) {
      throw new Error(`[Config] ${hostsPath}: hosts.${name} has unsupported key(s): ${unknownKeys.join(", ")}. Only "destination" is allowed — put port/identityFile/options etc. in ~/.ssh/config`);
    }
    const destination = h?.destination;
    if (!isValidHostDestination(destination)) {
      throw new Error(`[Config] ${hostsPath}: hosts.${name}.destination must be a ~/.ssh/config Host name or user@host (no spaces, not starting with "-")`);
    }
    hosts[name] = { name, destination };
  }
  return hosts;
}


/**
 * Merges the two files `fleet/roster.yml` (the crew's persona definitions) and `{projectRoot}/ship.yml` (assignment to
 * roles + target allocation), and builds the `Record<role, CrewMemberConfig>` shape that the existing code expects. The kinds of roles
 * themselves can be freely defined in ship.yml (no particular role name is required; authority is decided by `rank`).
 *
 * Neither file has a fallback when omitted (silently starting with a default composition) —
 * the fleet roster and the ship's assignments are the essential settings that make a ship a ship, and it is more dangerous to start without
 * noticing that they are missing unintentionally, so if they are not found, startup ends with an error (the same reason as the
 * policy of removing the environment variable).
 */
export function loadCrew(
  fleetRoot: string,
  projectRoot: string,
  ship: { id: string; file: RawShipFile },
): Record<string, CrewMemberConfig> {
  const hosts = loadHosts(fleetRoot);
  const rosterPath = path.join(fleetRoot, "roster.yml");
  const rosterFile = loadYaml<RawRosterFile>(rosterPath);
  if (!rosterFile?.crew) {
    throw new Error(`[Config] Fleet roster not found at ${rosterPath}. Define "crew:" in roster.yml (see config.sample.yml).`);
  }
  const roster = rosterFile.crew;
  console.log(`[Config] Fleet roster loaded from ${rosterPath}`);

  // ship.yml has already been read when the ship was selected (resolveShip/discoverShips), so
  // it is reused here instead of reading the file again.
  const shipFilePath = path.join(projectRoot, "ship.yml");
  if (!ship.file.crew) {
    throw new Error(`[Config] Ship config not found at ${shipFilePath}. Define "crew:" in ship.yml (see config.sample.yml).`);
  }
  const shipCrew = ship.file.crew;
  const targets = ship.file.targets ?? {};
  console.log(`[Config] Ship config loaded from ${shipFilePath}`);

  const shipRules = resolveFiles("rules", `ship "${ship.id}"`, projectRoot, ship.file.rules);
  const shipSkills = resolveFiles("skills", `ship "${ship.id}"`, projectRoot, ship.file.skills);

  // No prototype: a role name such as "constructor" or "__proto__" (from a URL or a tool call) must not be found as a crew member
  // by a plain `crew[role]` lookup.
  const crew: Record<string, CrewMemberConfig> = Object.create(null);
  for (const [role, assignment] of Object.entries(shipCrew)) {
    // A role name becomes part of ids and directory names (task ids are `<role>_0001`), so it is limited to what those can hold.
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(role)) {
      throw new Error(`[Config] Ship role "${role}": a role name may only have letters, digits, "_" and "-" (and start with a letter or digit).`);
    }
    if (typeof assignment !== "object" || assignment === null || typeof assignment.member !== "string") {
      throw new Error(`[Config] Ship role "${role}" in ${shipFilePath} must be a map with a "member" (the ID of a member in the roster).`);
    }
    const memberInfo = roster[assignment.member];
    if (!memberInfo) {
      // Not skipped: a typo in a member ID would otherwise drop a role (even the commander) without anyone noticing.
      throw new Error(`[Config] Ship role "${role}" references unknown crew member "${assignment.member}" in ${rosterPath} (members: ${Object.keys(roster).join(", ") || "none"}).`);
    }
    // The member ID names its persona and icon files; the display name is what the screens show.
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(assignment.member)) {
      throw new Error(`[Config] Crew member "${assignment.member}" in ${rosterPath}: an ID may only have letters, digits, "_" and "-" (and start with a letter or digit).`);
    }
    if (typeof memberInfo.name !== "string" || memberInfo.name.trim() === "") {
      throw new Error(`[Config] Crew member "${assignment.member}" in ${rosterPath} needs a "name" (the display name).`);
    }
    for (const [target, mode] of Object.entries(assignment.access ?? {})) {
      if (mode !== "readonly" && mode !== "readwrite") {
        throw new Error(`[Config] Ship role "${role}": access to "${target}" must be "readonly" or "readwrite" (got ${JSON.stringify(mode)}).`);
      }
    }
    if (memberInfo.provider !== undefined && !(PROVIDERS as readonly string[]).includes(memberInfo.provider)) {
      throw new Error(`[Config] Crew member "${assignment.member}" in ${rosterPath}: "provider" must be one of ${PROVIDERS.join(", ")} (got ${JSON.stringify(memberInfo.provider)}).`);
    }
    const host = assignment.host ? hosts[assignment.host] : undefined;
    if (assignment.host && !host) {
      throw new Error(`[Config] ship role "${role}" references unknown host "${assignment.host}" (defined: ${Object.keys(hosts).join(", ") || "none"}) — add it to ${path.join(fleetRoot, "hosts.yml")}`);
    }
    if (host && assignment.access && Object.keys(assignment.access).length > 0) {
      // A remote crew member cannot touch the main side's targets (local paths).
      throw new Error(`[Config] ship role "${role}" uses host "${host.name}": "access" (targets) is not supported for remote crew yet`);
    }
    if (assignment.profile !== undefined) {
      throw new Error(`[Config] ship role "${role}": "profile" was renamed to "agent" (the name of the provider's agent definition). Rename it, or remove it to let make-it-so inject the persona from personnel/${assignment.member}.md`);
    }
    const cwd = resolveCwd(role, assignment.cwd, ship.file.cwd, host, projectRoot);
    const owner = `roster member "${assignment.member}"`;
    crew[role] = {
      name: memberInfo.name,
      rank: parseRank(role, assignment.rank),
      provider: memberInfo.provider,
      model: assignment.model ?? memberInfo.model,
      permissionMode: assignment.permission_mode ?? memberInfo.permission_mode,
      acp_agent: assignment.member,
      cwd,
      host,
      agent: assignment.agent,
      rules: [...resolveFiles("rules", owner, fleetRoot, memberInfo.rules), ...shipRules],
      skills: [...resolveFiles("skills", owner, fleetRoot, memberInfo.skills), ...shipSkills],
      // A remote crew member is not given the main side's targets or access guidance.
      ...(host ? { additionalDirectories: [] } : resolveAccess(role, assignment.access, targets, cwd, projectRoot)),
    };
    if (host && crew[role].skills.length > 0) {
      console.warn(`[Config] Crew ${role}: skills are not announced to remote crew yet (local file paths do not exist on host "${host.name}") — ignored`);
    }
    console.log(`[Config] Crew ${role} (${assignment.member}): ${host ? `remote(host=${host.name}), ` : ""}cwd=${cwd}, persona=${assignment.agent ? `provider agent "${assignment.agent}"` : "make-it-so (personnel)"}`);
  }

  if (Object.keys(crew).length === 0) {
    throw new Error(`[Config] ship.yml at ${shipFilePath} must define at least one crew member under "crew:".`);
  }
  const commanders = Object.entries(crew).filter(([, member]) => member.rank === "commander").map(([role]) => role);
  if (commanders.length > 1) {
    throw new Error(`[Config] ship.yml at ${shipFilePath}: only one crew member can have rank "commander" (found: ${commanders.join(", ")}).`);
  }

  return crew;
}

/** Validates and returns the value of `rank`. crew if omitted. */
function parseRank(role: string, value: unknown): CrewRank {
  if (value === undefined) return "crew";
  if (typeof value === "string" && (CREW_RANKS as readonly string[]).includes(value)) return value as CrewRank;
  throw new Error(`[Config] ship role "${role}": rank must be one of ${CREW_RANKS.join(", ")} (got ${JSON.stringify(value)})`);
}

/**
 * The role of the ship's default conversation partner (whom the captain talks to first). The commander if there is one, otherwise
 * the first crew member written in ship.yml. undefined if there are no crew members.
 */
export function defaultCrewRole(crew: Record<string, Pick<CrewMemberConfig, "rank">>): string | undefined {
  const entries = Object.entries(crew);
  return (entries.find(([, member]) => member.rank === "commander") ?? entries[0])?.[0];
}

/**
 * From a crew directory name (the value of the DB's `agent` column — an `acp_agent` name, or a role name), looks up
 * the role name defined by the ship (ship.yml). If there is no corresponding crew member, the given name is returned as is
 * (e.g. a crew member who was in the ship's composition in the past).
 */
export function agentToRole(
  crew: Record<string, { acp_agent?: string }>,
  agentDir: string,
): CrewRole {
  for (const [role, member] of Object.entries(crew)) {
    if (member.acp_agent === agentDir || role === agentDir) return role;
  }
  return agentDir;
}
