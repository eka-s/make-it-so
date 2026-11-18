import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { isValidHostDestination } from "../fleet-config.js";
import { deleteValue, editYamlFile, readYamlDocument, setValue } from "./yaml-edit.js";

// The form for hosts.yml (remote hosts: name → ssh destination). Only the destination can be written there;
// connection details belong in ~/.ssh/config.

export type HostEntry = { name: string; destination: string };
export type HostState = HostEntry & {
  /** The ships whose crew refer to this host (a host in use cannot be removed or renamed). */
  usedBy: string[];
};
export type HostsState = { file: string; exists: boolean; hosts: HostState[] };

export type HostError = "settings.error.hostName" | "settings.error.hostDuplicate" | "settings.error.hostDestination" | "settings.error.hostInUse";

const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The ships (by ID) whose ship.yml has a crew member with `host: <name>`. */
function hostUsers(dir: string): Map<string, string[]> {
  const users = new Map<string, string[]>();
  const shipsDir = path.join(dir, "ships");
  if (!fs.existsSync(shipsDir)) return users;
  for (const entry of fs.readdirSync(shipsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const shipFile = path.join(shipsDir, entry.name, "ship.yml");
    if (!fs.existsSync(shipFile)) continue;
    try {
      const ship = parse(fs.readFileSync(shipFile, "utf-8")) as { crew?: Record<string, { host?: unknown } | null> } | null;
      for (const member of Object.values(ship?.crew ?? {})) {
        const host = member?.host;
        if (typeof host === "string") users.set(host, [...new Set([...(users.get(host) ?? []), entry.name])]);
      }
    } catch {
      // A ship.yml that cannot be read is shown on the overview; here it simply counts as using nothing.
    }
  }
  return users;
}

export function readHostsState(dir: string): HostsState {
  const file = path.join(dir, "hosts.yml");
  const doc = readYamlDocument(file);
  const raw = (doc.toJS() as { hosts?: Record<string, { destination?: unknown } | null> } | null)?.hosts ?? {};
  const users = hostUsers(dir);
  const hosts = Object.entries(raw).map(([name, h]) => ({
    name,
    destination: typeof h?.destination === "string" ? h.destination : "",
    usedBy: users.get(name) ?? [],
  }));
  return { file, exists: doc.contents !== null, hosts };
}

export type SaveHostsResult = { ok: true; state: HostsState } | { ok: false; errors: Record<string, HostError> };

/**
 * Saves the whole list of hosts. Nothing is written unless every entry is valid. Entries that did not change are not
 * touched (their comments stay); a host in use by a ship cannot be removed or renamed.
 */
export function saveHosts(dir: string, hosts: HostEntry[]): SaveHostsResult {
  const errors: Record<string, HostError> = {};
  const seen = new Set<string>();
  for (const h of hosts) {
    if (typeof h.name !== "string" || !HOST_NAME.test(h.name)) errors[String(h.name)] = "settings.error.hostName";
    else if (seen.has(h.name)) errors[h.name] = "settings.error.hostDuplicate";
    else if (!isValidHostDestination(h.destination)) errors[h.name] = "settings.error.hostDestination";
    if (typeof h.name === "string") seen.add(h.name);
  }

  const current = readHostsState(dir);
  for (const existing of current.hosts) {
    if (!seen.has(existing.name) && existing.usedBy.length > 0) errors[existing.name] = "settings.error.hostInUse";
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const before = new Map(current.hosts.map((h) => [h.name, h.destination]));
  editYamlFile(path.join(dir, "hosts.yml"), (doc) => {
    for (const name of before.keys()) {
      if (!seen.has(name)) deleteValue(doc, ["hosts", name]);
    }
    for (const h of hosts) {
      if (!before.has(h.name)) setValue(doc, ["hosts", h.name], { destination: h.destination });
      else if (before.get(h.name) !== h.destination) setValue(doc, ["hosts", h.name, "destination"], h.destination);
    }
  });
  return { ok: true, state: readHostsState(dir) };
}
