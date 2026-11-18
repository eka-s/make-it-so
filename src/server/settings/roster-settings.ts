import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { mkdirPrivate } from "../private-dirs.js";
import { PROVIDERS } from "../config-defaults.js";
import { deleteValue, editYamlFile, readYamlDocument, setValue } from "./yaml-edit.js";

// The form for roster.yml: the crew members (who they are, which provider, model, permission mode, rules and skills),
// and the files that belong to a member by convention: the persona (personnel/{id}.md) and the icon (personnel/{id}.<ext>,
// see crew-icons.ts). The member ID is the key in roster.yml and the name of those files, so it cannot be changed once made.

/** Permission modes offered in the form. The value is a mode of the provider (ACP), so another value can still be typed. */
export const PERMISSION_MODE_SUGGESTIONS = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"] as const;

const MEMBER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type RosterMemberInput = {
  name: string;
  provider: string | null;
  model: string | null;
  permission_mode: string | null;
  rules: string[];
  skills: string[];
};

export type RosterMemberState = RosterMemberInput & {
  id: string;
  hasPersona: boolean;
  /** The ships (and roles) that assign this member (a member in use cannot be removed). */
  usedBy: { ship: string; role: string }[];
};

export type RosterState = { file: string; exists: boolean; members: RosterMemberState[]; permissionModes: readonly string[]; providers: readonly string[] };

export type MemberError =
  | "settings.error.memberId" | "settings.error.memberExists" | "settings.error.memberMissing" | "settings.error.memberInUse"
  | "settings.error.empty" | "settings.error.notAnOption" | "settings.error.notAText" | "settings.error.notAList" | "settings.error.fileNotFound";

type RawMember = { name?: unknown; provider?: unknown; model?: unknown; permission_mode?: unknown; rules?: unknown; skills?: unknown };

const stringOrNull = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
const stringList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function memberUsers(dir: string): Map<string, { ship: string; role: string }[]> {
  const users = new Map<string, { ship: string; role: string }[]>();
  const shipsDir = path.join(dir, "ships");
  if (!fs.existsSync(shipsDir)) return users;
  for (const entry of fs.readdirSync(shipsDir, { withFileTypes: true })) {
    const shipFile = path.join(shipsDir, entry.name, "ship.yml");
    if (!entry.isDirectory() || !fs.existsSync(shipFile)) continue;
    try {
      const ship = parse(fs.readFileSync(shipFile, "utf-8")) as { crew?: Record<string, { member?: unknown } | null> } | null;
      for (const [role, assignment] of Object.entries(ship?.crew ?? {})) {
        const member = assignment?.member;
        if (typeof member === "string") users.set(member, [...(users.get(member) ?? []), { ship: entry.name, role }]);
      }
    } catch {
      // A ship.yml that cannot be read is shown on the overview; here it counts as using nothing.
    }
  }
  return users;
}

export function readRosterState(dir: string): RosterState {
  const file = path.join(dir, "roster.yml");
  const doc = readYamlDocument(file);
  const crew = (doc.toJS() as { crew?: Record<string, RawMember | null> } | null)?.crew ?? {};
  const users = memberUsers(dir);
  const members = Object.entries(crew).map(([id, m]) => ({
    id,
    name: typeof m?.name === "string" ? m.name : "",
    provider: stringOrNull(m?.provider),
    model: stringOrNull(m?.model),
    permission_mode: stringOrNull(m?.permission_mode),
    rules: stringList(m?.rules),
    skills: stringList(m?.skills),
    hasPersona: fs.existsSync(path.join(dir, "personnel", `${id}.md`)),
    usedBy: users.get(id) ?? [],
  }));
  return { file, exists: doc.contents !== null, members, permissionModes: PERMISSION_MODE_SUGGESTIONS, providers: PROVIDERS };
}

export type SaveMemberResult = { ok: true; state: RosterState } | { ok: false; errors: Record<string, MemberError> };

/** Checks a member's fields. Rules and skills must be existing files (relative to the directory), as at startup. */
function validate(dir: string, input: RosterMemberInput): Record<string, MemberError> {
  const errors: Record<string, MemberError> = {};
  if (typeof input.name !== "string" || input.name.trim() === "") errors.name = "settings.error.empty";
  if (input.provider !== null && !(PROVIDERS as readonly string[]).includes(input.provider as string)) errors.provider = "settings.error.notAnOption";
  for (const key of ["model", "permission_mode"] as const) {
    const v = input[key];
    if (v !== null && (typeof v !== "string" || v.trim() === "")) errors[key] = "settings.error.notAText";
  }
  for (const key of ["rules", "skills"] as const) {
    const list = input[key];
    if (!Array.isArray(list) || !list.every((x) => typeof x === "string")) errors[key] = "settings.error.notAList";
    else if (list.some((f) => { const abs = path.resolve(dir, f); return !fs.existsSync(abs) || !fs.statSync(abs).isFile(); })) errors[key] = "settings.error.fileNotFound";
  }
  return errors;
}

// Both tolerate values of the wrong type (they come from an API client); validate() reports those as errors.
const clean = (v: string | null) => (typeof v === "string" ? v.trim() || null : v);
const cleanList = (list: string[]) => list.map((x) => (typeof x === "string" ? x.trim() : x)).filter((x) => x !== "");

/**
 * Creates a member (`create: true`; the ID must be new) or updates one. Only the fields that changed are written, so the
 * comments and the form of the file stay; an empty optional field removes its key. Nothing is written unless it is all valid.
 */
export function saveMember(dir: string, id: string, input: RosterMemberInput, create: boolean): SaveMemberResult {
  if (!MEMBER_ID.test(id)) return { ok: false, errors: { id: "settings.error.memberId" } };
  const current = readRosterState(dir).members.find((m) => m.id === id);
  if (create && current) return { ok: false, errors: { id: "settings.error.memberExists" } };
  if (!create && !current) return { ok: false, errors: { id: "settings.error.memberMissing" } };

  const next: RosterMemberInput = {
    name: typeof input.name === "string" ? input.name.trim() : input.name,
    provider: clean(input.provider),
    model: clean(input.model),
    permission_mode: clean(input.permission_mode),
    rules: Array.isArray(input.rules) ? cleanList(input.rules) : input.rules,
    skills: Array.isArray(input.skills) ? cleanList(input.skills) : input.skills,
  };
  const errors = validate(dir, next);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  editYamlFile(path.join(dir, "roster.yml"), (doc) => {
    const fields: [keyof RosterMemberInput, unknown, unknown][] = [
      ["name", current?.name, next.name],
      ["provider", current?.provider ?? null, next.provider],
      ["model", current?.model ?? null, next.model],
      ["permission_mode", current?.permission_mode ?? null, next.permission_mode],
      ["rules", current?.rules ?? [], next.rules],
      ["skills", current?.skills ?? [], next.skills],
    ];
    for (const [key, before, after] of fields) {
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      const empty = after === null || (Array.isArray(after) && after.length === 0);
      if (empty) deleteValue(doc, ["crew", id, key]);
      else setValue(doc, ["crew", id, key], after);
    }
  });
  return { ok: true, state: readRosterState(dir) };
}

export type DeleteMemberResult = { ok: true; state: RosterState } | { ok: false; errors: Record<string, MemberError>; usedBy?: { ship: string; role: string }[] };

/** Removes a member from the roster. A member a ship assigns cannot be removed. The persona and icon files are kept. */
export function deleteMember(dir: string, id: string): DeleteMemberResult {
  const current = readRosterState(dir).members.find((m) => m.id === id);
  if (!current) return { ok: false, errors: { id: "settings.error.memberMissing" } };
  if (current.usedBy.length > 0) return { ok: false, errors: { id: "settings.error.memberInUse" }, usedBy: current.usedBy };
  editYamlFile(path.join(dir, "roster.yml"), (doc) => deleteValue(doc, ["crew", id]));
  return { ok: true, state: readRosterState(dir) };
}

// --- The persona file (personnel/{id}.md) ---

export function readPersona(dir: string, id: string): { text: string; exists: boolean } | null {
  if (!MEMBER_ID.test(id)) return null;
  const file = path.join(dir, "personnel", `${id}.md`);
  return fs.existsSync(file) ? { text: fs.readFileSync(file, "utf-8"), exists: true } : { text: "", exists: false };
}

/** Writes the persona. Blank text removes the file (no persona). The previous file is kept as `.bak`. Returns false for an invalid ID. */
export function savePersona(dir: string, id: string, text: string): boolean {
  if (!MEMBER_ID.test(id)) return false;
  const file = path.join(dir, "personnel", `${id}.md`);
  if (text.trim() === "") {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, `${file}.bak`);
      fs.unlinkSync(file);
    }
    return true;
  }
  mkdirPrivate(path.dirname(file));
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return true;
}
