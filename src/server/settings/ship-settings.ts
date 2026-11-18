import fs from "node:fs";
import path from "node:path";
import type { Document } from "yaml";
import { loadCrew, loadHosts, type RawShipFile } from "../fleet-config.js";
import { deleteValue, editYamlFile, readYamlDocument, setValue } from "./yaml-edit.js";
import { PERMISSION_MODE_SUGGESTIONS, readRosterState } from "./roster-settings.js";

// The form for a ship's ship.yml: its port and name, the directories it covers (targets), the rules and skills every crew
// member gets, and which roster member holds which role. A ship is created here too (the same minimal ship as `npm run init`).
// A ship's directory is only removed by deleteShip, which the caller guards (a typed confirmation, and the ship must be stopped).

export const RANKS = ["commander", "chief", "crew"] as const;
export const ACCESS_MODES = ["readonly", "readwrite"] as const;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type ShipRole = {
  role: string;
  member: string;
  rank: (typeof RANKS)[number];
  model: string | null;
  permission_mode: string | null;
  cwd: string | null;
  agent: string | null;
  host: string | null;
  access: { target: string; mode: (typeof ACCESS_MODES)[number] }[];
};

export type ShipFields = {
  port: number;
  name: string | null;
  cwd: string | null;
  rules: string[];
  skills: string[];
  targets: { name: string; path: string }[];
  crew: ShipRole[];
};

export type ShipState = {
  id: string;
  fields: ShipFields;
  /** What the form offers to pick from. */
  options: { members: { id: string; name: string }[]; hosts: string[]; ranks: readonly string[]; permissionModes: readonly string[]; accessModes: readonly string[] };
};

type RawRole = { member?: unknown; rank?: unknown; model?: unknown; permission_mode?: unknown; cwd?: unknown; agent?: unknown; host?: unknown; access?: unknown };
type RawShip = { port?: unknown; name?: unknown; cwd?: unknown; rules?: unknown; skills?: unknown; targets?: unknown; crew?: unknown };

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const shipRoot = (dir: string, id: string) => path.join(dir, "ships", id);

function fieldsOf(raw: RawShip): ShipFields {
  return {
    port: typeof raw.port === "number" ? raw.port : 0,
    name: str(raw.name),
    cwd: str(raw.cwd),
    rules: strList(raw.rules),
    skills: strList(raw.skills),
    targets: Object.entries(obj(raw.targets)).map(([name, p]) => ({ name, path: typeof p === "string" ? p : "" })),
    crew: Object.entries(obj(raw.crew)).map(([role, a]) => {
      const r = obj(a) as RawRole;
      return {
        role,
        member: typeof r.member === "string" ? r.member : "",
        rank: (RANKS as readonly unknown[]).includes(r.rank) ? (r.rank as ShipRole["rank"]) : "crew",
        model: str(r.model),
        permission_mode: str(r.permission_mode),
        cwd: str(r.cwd),
        agent: str(r.agent),
        host: str(r.host),
        access: Object.entries(obj(r.access)).map(([target, mode]) => ({ target, mode: mode === "readwrite" ? "readwrite" : "readonly" })),
      };
    }),
  };
}

function rawShip(dir: string, id: string): RawShip | null {
  const file = path.join(shipRoot(dir, id), "ship.yml");
  if (!fs.existsSync(file)) return null;
  return (readYamlDocument(file).toJS() as RawShip | null) ?? {};
}

function optionsOf(dir: string): ShipState["options"] {
  return {
    members: readRosterState(dir).members.map((m) => ({ id: m.id, name: m.name })),
    hosts: Object.keys(loadHosts(dir)),
    ranks: RANKS,
    permissionModes: PERMISSION_MODE_SUGGESTIONS,
    accessModes: ACCESS_MODES,
  };
}

/**
 * Whether a ship's ship.yml can be read. When it cannot, nothing says which port the ship uses, so whether it is running cannot be
 * found out either (and deleting it could take a running ship's directory away).
 */
export function isShipFileReadable(dir: string, id: string): boolean {
  if (!ID_PATTERN.test(id)) return false;
  try {
    rawShip(dir, id);
    return true;
  } catch {
    return false;
  }
}

/** The port in a ship's ship.yml, or null when the ship does not exist, has no port, or its file cannot be read. */
export function shipPort(dir: string, id: string): number | null {
  if (!ID_PATTERN.test(id)) return null;
  try {
    const port = rawShip(dir, id)?.port;
    return typeof port === "number" ? port : null;
  } catch {
    return null;
  }
}

/** Reads a ship. Returns null when there is no such ship. */
export function readShipState(dir: string, id: string): ShipState | null {
  if (!ID_PATTERN.test(id)) return null;
  const raw = rawShip(dir, id);
  return raw ? { id, fields: fieldsOf(raw), options: optionsOf(dir) } : null;
}

/** The ports of the other ships (a port must differ between ships). */
function otherPorts(dir: string, id: string): Set<number> {
  const ports = new Set<number>();
  const shipsDir = path.join(dir, "ships");
  if (!fs.existsSync(shipsDir)) return ports;
  for (const e of fs.readdirSync(shipsDir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === id) continue;
    try {
      const port = rawShip(dir, e.name)?.port;
      if (typeof port === "number") ports.add(port);
    } catch {
      // A ship.yml that cannot be read is shown on the overview.
    }
  }
  return ports;
}

const isFile = (p: string) => fs.existsSync(p) && fs.statSync(p).isFile();
const isDir = (p: string) => fs.existsSync(p) && fs.statSync(p).isDirectory();

/** Checks the fields the way startup would. Returns message keys by field (`crew.<role>.<field>` for a role's field). */
function validate(dir: string, id: string, f: ShipFields): Record<string, string> {
  const errors: Record<string, string> = {};
  const root = shipRoot(dir, id);

  if (!Number.isInteger(f.port) || f.port < 1 || f.port > 65535) errors.port = "settings.error.port";
  else if (otherPorts(dir, id).has(f.port)) errors.port = "settings.error.portInUse";

  if (f.cwd !== null && !isDir(path.resolve(root, f.cwd))) errors.cwd = "settings.error.dirNotFound";
  for (const key of ["rules", "skills"] as const) {
    if (f[key].some((file) => !isFile(path.resolve(root, file)))) errors[key] = "settings.error.fileNotFound";
  }

  const targetNames = new Set<string>();
  for (const t of f.targets) {
    if (t.name === "" || t.path === "" || targetNames.has(t.name)) errors.targets = "settings.error.target";
    else if (!isDir(path.resolve(root, t.path))) errors.targets ??= "settings.error.targetNotFound";
    targetNames.add(t.name);
  }

  if (f.crew.length === 0) errors.crew = "settings.error.noRoles";
  const members = new Set(readRosterState(dir).members.map((m) => m.id));
  const hosts = loadHosts(dir);
  const roleNames = new Set<string>();
  let commanders = 0;
  for (const r of f.crew) {
    const at = (field: string) => `crew.${r.role}.${field}`;
    if (!ID_PATTERN.test(r.role) || roleNames.has(r.role)) errors[at("role")] = "settings.error.roleName";
    roleNames.add(r.role);
    if (!members.has(r.member)) errors[at("member")] = "settings.error.memberMissing";
    if (r.rank === "commander" && ++commanders > 1) errors[at("rank")] = "settings.error.twoCommanders";
    if (r.host !== null) {
      if (!Object.hasOwn(hosts, r.host)) errors[at("host")] = "settings.error.hostUnknown";
      if (r.cwd === null || !path.posix.isAbsolute(r.cwd)) errors[at("cwd")] = "settings.error.remoteCwd";
      if (r.access.length > 0) errors[at("access")] = "settings.error.remoteAccess";
    } else if (r.cwd !== null && !isDir(path.resolve(root, f.cwd ?? "", r.cwd)) && !isDir(path.resolve(root, r.cwd))) {
      errors[at("cwd")] = "settings.error.dirNotFound";
    }
    if (r.access.some((a) => !targetNames.has(a.target))) errors[at("access")] = "settings.error.accessTarget";
  }
  return errors;
}

/** The plain object a ship.yml holds for the given fields (empty things are left out; an unchanged `rank: crew` default stays unwritten). */
function toRaw(f: ShipFields, before: RawShip | null): RawShip {
  const beforeCrew = obj(before?.crew);
  const raw: Record<string, unknown> = { port: f.port };
  if (f.name) raw.name = f.name;
  if (f.cwd) raw.cwd = f.cwd;
  if (f.rules.length) raw.rules = f.rules;
  if (f.skills.length) raw.skills = f.skills;
  if (f.targets.length) raw.targets = Object.fromEntries(f.targets.map((t) => [t.name, t.path]));
  raw.crew = Object.fromEntries(f.crew.map((r) => {
    const role: Record<string, unknown> = { member: r.member };
    // `rank: crew` is the default: written only when the file already spells it out.
    if (r.rank !== "crew" || obj(beforeCrew[r.role]).rank !== undefined) role.rank = r.rank;
    if (r.model) role.model = r.model;
    if (r.permission_mode) role.permission_mode = r.permission_mode;
    if (r.cwd) role.cwd = r.cwd;
    if (r.agent) role.agent = r.agent;
    if (r.host) role.host = r.host;
    if (r.access.length) role.access = Object.fromEntries(r.access.map((a) => [a.target, a.mode]));
    return [r.role, role];
  }));
  return raw as RawShip;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Brings one map in the document in line with `after`, touching only keys that differ (and only the keys in `known` if given). */
function syncMap(doc: Document, base: string[], before: Record<string, unknown>, after: Record<string, unknown>, known?: readonly string[]): void {
  for (const key of Object.keys(before)) {
    if (known && !known.includes(key)) continue;
    if (!(key in after)) deleteValue(doc, [...base, key]);
  }
  for (const [key, value] of Object.entries(after)) {
    if (!same(before[key], value)) setValue(doc, [...base, key], value);
  }
}

const SHIP_KEYS = ["port", "name", "cwd", "rules", "skills", "targets", "crew"] as const;
const ROLE_KEYS = ["member", "rank", "model", "permission_mode", "cwd", "agent", "host", "access"] as const;

function writeShip(dir: string, id: string, before: RawShip | null, after: RawShip): void {
  editYamlFile(path.join(shipRoot(dir, id), "ship.yml"), (doc) => {
    const b = before ?? {};
    // The simple keys, and the targets map (every key in it is the user's).
    syncMap(doc, [], Object.fromEntries(SHIP_KEYS.filter((k) => k !== "crew" && k !== "targets" && k in b).map((k) => [k, (b as Record<string, unknown>)[k]])),
      Object.fromEntries(SHIP_KEYS.filter((k) => k !== "crew" && k !== "targets" && k in after).map((k) => [k, (after as Record<string, unknown>)[k]])));
    const bt = obj(b.targets);
    const at = obj(after.targets);
    if (Object.keys(at).length === 0) { if (Object.keys(bt).length > 0) deleteValue(doc, ["targets"]); }
    else if (Object.keys(bt).length === 0) setValue(doc, ["targets"], at);
    else syncMap(doc, ["targets"], bt, at);

    // The crew: a role removed or added as a whole; a kept role changes field by field (its access map too).
    const bc = obj(b.crew);
    const ac = obj(after.crew);
    for (const role of Object.keys(bc)) if (!(role in ac)) deleteValue(doc, ["crew", role]);
    for (const [role, value] of Object.entries(ac)) {
      if (!(role in bc)) { setValue(doc, ["crew", role], value); continue; }
      const br = obj(bc[role]);
      const ar = obj(value);
      const brSimple = Object.fromEntries(ROLE_KEYS.filter((k) => k !== "access" && k in br).map((k) => [k, br[k]]));
      const arSimple = Object.fromEntries(ROLE_KEYS.filter((k) => k !== "access" && k in ar).map((k) => [k, ar[k]]));
      syncMap(doc, ["crew", role], brSimple, arSimple);
      const bAccess = obj(br.access);
      const aAccess = obj(ar.access);
      if (Object.keys(aAccess).length === 0) { if (Object.keys(bAccess).length > 0) deleteValue(doc, ["crew", role, "access"]); }
      else if (Object.keys(bAccess).length === 0) setValue(doc, ["crew", role, "access"], aAccess);
      else syncMap(doc, ["crew", role, "access"], bAccess, aAccess);
    }
  });
}

export type SaveShipResult = { ok: true; state: ShipState } | { ok: false; errors: Record<string, string> };

/**
 * Saves a ship (creating it when `create`). The whole field set is validated like startup would — field by field, and then by
 * the real loader, whose message is reported under `ship` if it still finds a problem. Nothing is written unless all is valid.
 */
export function saveShip(dir: string, id: string, fields: ShipFields, create: boolean): SaveShipResult {
  if (!ID_PATTERN.test(id)) return { ok: false, errors: { id: "settings.error.shipId" } };
  const exists = rawShip(dir, id) !== null;
  if (create && exists) return { ok: false, errors: { id: "settings.error.shipExists" } };
  if (!create && !exists) return { ok: false, errors: { id: "settings.error.shipMissing" } };

  const errors = validate(dir, id, fields);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const before = create ? null : rawShip(dir, id);
  const after = toRaw(fields, before);
  try {
    // The real loader as a backstop: whatever it would refuse at startup is refused here.
    const log = console.log;
    console.log = () => {};
    try {
      loadCrew(dir, shipRoot(dir, id), { id, file: after as RawShipFile });
    } finally {
      console.log = log;
    }
  } catch (err) {
    return { ok: false, errors: { ship: err instanceof Error ? err.message : String(err) } };
  }
  writeShip(dir, id, before, after);
  return { ok: true, state: readShipState(dir, id) as ShipState };
}

/** What a new ship starts as (the same minimal ship as `npm run init`): one commander role holding the given member. */
export function newShipFields(port: number, name: string | null, member: string): ShipFields {
  return {
    port, name, cwd: null, rules: [], skills: [], targets: [],
    crew: [{ role: "lead", member, rank: "commander", model: null, permission_mode: null, cwd: null, agent: null, host: null, access: [] }],
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optStr = (v: unknown) => v === null || v === undefined || typeof v === "string";
const strArray = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Checks that a request body has the shape of ShipFields (the values are checked by saveShip). Returns null when it does not. */
export function parseShipFields(body: unknown): ShipFields | null {
  if (!isObj(body)) return null;
  const { port, name, cwd, rules, skills, targets, crew } = body;
  if (typeof port !== "number" || !optStr(name) || !optStr(cwd) || !strArray(rules) || !strArray(skills)) return null;
  if (!Array.isArray(targets) || !targets.every((t) => isObj(t) && typeof t.name === "string" && typeof t.path === "string")) return null;
  if (!Array.isArray(crew)) return null;
  for (const r of crew) {
    if (!isObj(r) || typeof r.role !== "string" || typeof r.member !== "string" || !optStr(r.model) || !optStr(r.permission_mode) || !optStr(r.cwd) || !optStr(r.agent) || !optStr(r.host)) return null;
    if (!(RANKS as readonly unknown[]).includes(r.rank)) return null;
    if (!Array.isArray(r.access) || !r.access.every((a) => isObj(a) && typeof a.target === "string" && (ACCESS_MODES as readonly unknown[]).includes(a.mode))) return null;
  }
  const n = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  return {
    port,
    name: n(name),
    cwd: n(cwd),
    rules: (rules as string[]).map((x) => x.trim()).filter(Boolean),
    skills: (skills as string[]).map((x) => x.trim()).filter(Boolean),
    targets: (targets as { name: string; path: string }[]).map((t) => ({ name: t.name.trim(), path: t.path.trim() })),
    crew: (crew as ShipRole[]).map((r) => ({
      role: r.role.trim(), member: r.member.trim(), rank: r.rank, model: n(r.model), permission_mode: n(r.permission_mode),
      cwd: n(r.cwd), agent: n(r.agent), host: n(r.host), access: r.access.map((a) => ({ target: a.target.trim(), mode: a.mode })),
    })),
  };
}

export type DeleteShipResult = { ok: true } | { ok: false; error: "settings.error.shipId" | "settings.error.shipMissing" };

/**
 * Removes a ship: its whole directory (ship.yml, the database, logs, everything it kept), which cannot be undone.
 * Roster members stay (they are shared). The caller makes sure the ship is not running. Only a directory directly under
 * `ships/` that holds a ship.yml is removed, whatever the ID is.
 */
export function deleteShip(dir: string, id: string): DeleteShipResult {
  if (!ID_PATTERN.test(id)) return { ok: false, error: "settings.error.shipId" };
  const root = shipRoot(dir, id);
  if (!isFile(path.join(root, "ship.yml"))) return { ok: false, error: "settings.error.shipMissing" };
  fs.rmSync(root, { recursive: true });
  return { ok: true };
}
