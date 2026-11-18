import fs from "node:fs";
import path from "node:path";
import type { ProviderScan, ScanNote, ScanProvider } from "./project-scan.js";
import { readRosterState, type RosterMemberInput } from "./roster-settings.js";
import { shipPort, type ShipFields } from "./ship-settings.js";

// Turns what a project has (project-scan.ts) into a draft of crew members and one ship, to be looked at and changed on
// the screen and then saved through the same functions as the other forms. Building the draft writes nothing.
//
// - Agent definitions stay in the project: a role refers to one by name (`agent`) and works in the project directory.
// - Every crew member starts as a chief; which one (if any) is the commander is left to the person.
// - A roster member with the same ID may already exist (another ship's); the draft then offers to use that one.

export type DraftMember = {
  id: string;
  input: RosterMemberInput;
  /** A member with this ID is already in the roster. */
  exists: boolean;
  /** Use the existing member instead of creating one. Only meaningful when `exists`. */
  reuse: boolean;
};

export type ImportDraft = {
  provider: ScanProvider;
  projectDir: string;
  members: DraftMember[];
  ship: { id: string; fields: ShipFields };
  /** Files the person may add to the ship's rules (absolute paths). Not added by default: the provider reads them itself. */
  ruleCandidates: { label: string; path: string }[];
  mcp: ProviderScan["mcp"];
  notes: ScanNote[];
};

/** What already exists in the directory, so that the draft does not collide with it. */
export type ImportContext = {
  /** Roster member IDs, with the provider each uses. */
  roster: Map<string, string | null>;
  shipIds: Set<string>;
  ports: Set<number>;
};

export const FIRST_SHIP_PORT = 3939;

export function readImportContext(dir: string): ImportContext {
  const roster = new Map<string, string | null>();
  try {
    for (const m of readRosterState(dir).members) roster.set(m.id, m.provider);
  } catch {
    // A roster that cannot be read is reported by its own form; here nothing is known to collide.
  }
  const shipIds = new Set<string>();
  const ports = new Set<number>();
  const shipsDir = path.join(dir, "ships");
  if (fs.existsSync(shipsDir)) {
    for (const entry of fs.readdirSync(shipsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !fs.existsSync(path.join(shipsDir, entry.name, "ship.yml"))) continue;
      shipIds.add(entry.name);
      const port = shipPort(dir, entry.name);
      if (port !== null) ports.add(port);
    }
  }
  return { roster, shipIds, ports };
}

/** An ID (letters, digits, `_`, `-`; starting with a letter or digit) made from free text. */
export function toId(text: string, fallback: string): string {
  const id = text.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/-+$/, "");
  return id === "" ? fallback : id;
}

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

function freePort(used: Set<number>): number {
  let port = FIRST_SHIP_PORT;
  while (used.has(port)) port++;
  return port;
}

/**
 * Drafts the members and the ship for a project. One member per agent definition found (or a single generic one when the
 * project has none). A member's ID that is already in the roster is kept as it is and offered for reuse; a new ship gets
 * an ID and a port that no other ship has.
 */
export function buildDraft(provider: ScanProvider, projectDir: string, scan: ProviderScan | null, context: ImportContext): ImportDraft {
  const folder = path.basename(projectDir) || "project";
  const agents: { name: string; model: string | null }[] =
    scan && scan.agents.length > 0
      ? scan.agents.map((a) => ({ name: a.name, model: a.model }))
      : [{ name: "lead", model: null }];
  const hasAgents = scan !== null && scan.agents.length > 0;

  const draftIds = new Set<string>();
  const members: DraftMember[] = [];
  const roles: ShipFields["crew"] = [];
  const target = toId(folder, "project");

  for (const agent of agents) {
    // Two definitions can map to the same ID; the second one is told apart. An ID the roster has for another provider
    // is not reused (that member is someone else), so it is told apart from the roster as well.
    let id = uniqueId(toId(agent.name, "crew"), draftIds);
    if (context.roster.has(id) && context.roster.get(id) !== provider) id = uniqueId(id, new Set([...draftIds, ...context.roster.keys()]));
    draftIds.add(id);
    const exists = context.roster.has(id) && context.roster.get(id) === provider;
    const model = agent.model ?? scan?.model ?? null;
    members.push({
      id,
      input: { name: agent.name, provider, model, permission_mode: scan?.permissionMode ?? null, rules: [], skills: [] },
      exists,
      reuse: exists,
    });
    roles.push({
      role: id, member: id, rank: "chief", model: null, permission_mode: null, cwd: projectDir,
      agent: hasAgents ? agent.name : null, host: null, access: [{ target, mode: "readwrite" }],
    });
  }

  const shipId = uniqueId(toId(folder, "ship"), context.shipIds);
  return {
    provider,
    projectDir,
    members,
    ship: {
      id: shipId,
      fields: { port: freePort(context.ports), name: folder, cwd: null, rules: [], skills: [], targets: [{ name: target, path: projectDir }], crew: roles },
    },
    ruleCandidates: (scan?.ruleCandidates ?? []).map((file) => ({ label: file, path: path.join(projectDir, file) })),
    mcp: scan?.mcp ?? null,
    notes: scan?.notes ?? [],
  };
}
