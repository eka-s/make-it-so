import fs from "node:fs";
import path from "node:path";
import { saveMember, readRosterState, type RosterMemberInput } from "./roster-settings.js";
import { saveShip, type ShipFields } from "./ship-settings.js";

// Saves a drafted import (import-draft.ts): the new roster members and the ship, as one step. The members and the ship
// are saved through the same functions as their own forms, so they are checked the same way. If anything fails, the
// roster is put back exactly as it was, so a failed import leaves nothing behind.

export type ApplyMember = { id: string; reuse: boolean; input: RosterMemberInput };
export type ApplyInput = { members: ApplyMember[]; ship: { id: string; fields: ShipFields } };

export type ApplyErrors = {
  /** Field errors of the ship (message keys), as saveShip reports them. */
  ship: Record<string, string>;
  /** Field errors per member ID. */
  members: Record<string, Record<string, string>>;
};
export type ApplyResult = { ok: true; shipId: string; createdMembers: string[] } | { ok: false; errors: ApplyErrors };

/** The state of a file, so it can be put back (a file that did not exist is removed again). */
function snapshot(file: string): () => void {
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  return () => {
    if (before === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, before);
  };
}

export function applyImport(dir: string, input: ApplyInput): ApplyResult {
  // A roster that is a symlink is edited where it really is (see editYamlFile), so its backup lives there too.
  const rosterLink = path.join(dir, "roster.yml");
  const rosterFile = fs.existsSync(rosterLink) ? fs.realpathSync(rosterLink) : rosterLink;
  const before = fs.existsSync(rosterFile) ? fs.readFileSync(rosterFile) : null;
  const restore = [snapshot(rosterFile), snapshot(`${rosterFile}.bak`)];
  const rollback = () => restore.forEach((r) => r());
  try {
    const result = applyAll(dir, input);
    if (!result.ok) {
      rollback();
      return result;
    }
    // Each member was saved one by one, so the .bak the saves left holds the roster after the second to last one. It is made to
    // hold the roster as it was before the import (or none, when there was no roster).
    if (before !== null) fs.writeFileSync(`${rosterFile}.bak`, before);
    else fs.rmSync(`${rosterFile}.bak`, { force: true });
    return result;
  } catch (err) {
    // Whatever went wrong (a value of a type the saves do not expect, a disk error), nothing is left half-written.
    rollback();
    throw err;
  }
}

/** The saves themselves. Returns the errors when one is refused; the caller puts the roster back. */
function applyAll(dir: string, input: ApplyInput): ApplyResult {
  const errors: ApplyErrors = { ship: {}, members: {} };
  const created: string[] = [];

  const existing = new Set(readRosterState(dir).members.map((m) => m.id));
  for (const member of input.members) {
    if (member.reuse) {
      if (!existing.has(member.id)) errors.members[member.id] = { id: "settings.error.memberMissing" };
      continue;
    }
    const result = saveMember(dir, member.id, member.input, true);
    if (result.ok) created.push(member.id);
    else errors.members[member.id] = result.errors;
  }
  if (Object.keys(errors.members).length > 0) return { ok: false, errors };

  const ship = saveShip(dir, input.ship.id, input.ship.fields, true);
  if (!ship.ok) return { ok: false, errors: { ship: ship.errors, members: {} } };
  return { ok: true, shipId: input.ship.id, createdMembers: created };
}
