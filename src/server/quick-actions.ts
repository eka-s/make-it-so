import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parse } from "yaml";
import { editYamlFile, readYamlDocument } from "./settings/yaml-edit.js";

// The custom menu of the message box: messages and slash commands the user keeps at hand. The items live in one file of the
// fleet (quick-actions.yml) and each item names the ships it is enabled on, so the same item can be shared by ships
// and a ship can still have items of its own.

export type QuickActionKind = "message" | "slash";
export const QUICK_ACTION_KINDS: readonly QuickActionKind[] = ["message", "slash"];
/** now = send at once; fill = only put it in the message box so it can be edited first. */
export type QuickActionSend = "now" | "fill";
export const QUICK_ACTION_SENDS: readonly QuickActionSend[] = ["now", "fill"];

export type QuickAction = {
  id: string;
  name: string;
  kind: QuickActionKind;
  /** The text to send. For `slash` it starts with "/". */
  command: string;
  send: QuickActionSend;
  /** The ships (by ID) this item is enabled on, or "all" for every ship, present and future. */
  ships: "all" | string[];
  /** With `ships: "all"`: the ships the item is switched off on (so a ship can drop it while ships made later still get it). */
  except?: string[];
};

export type QuickActionError = "settings.error.quickName" | "settings.error.quickCommand" | "settings.error.quickShips" | "settings.error.quickTooMany";

export const QUICK_ACTION_LIMIT = 50;
const NAME_MAX = 40;
const COMMAND_MAX = 4000;
const SHIP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const QUICK_ACTIONS_FILE = "quick-actions.yml";

/** What a fleet that has no quick-actions.yml yet offers on every ship. */
export const DEFAULT_QUICK_ACTIONS: readonly QuickAction[] = [
  { id: "resume", name: "Resume", kind: "slash", command: "/resume", send: "now", ships: "all" },
  { id: "compact", name: "Compact", kind: "slash", command: "/compact", send: "now", ships: "all" },
];

function newId(): string {
  return `qa-${randomBytes(4).toString("hex")}`;
}

function isKind(v: unknown): v is QuickActionKind {
  return QUICK_ACTION_KINDS.includes(v as QuickActionKind);
}

function isSend(v: unknown): v is QuickActionSend {
  return QUICK_ACTION_SENDS.includes(v as QuickActionSend);
}

/** Reads one item from the file; an item that cannot be understood is skipped (the file is hand-editable). */
function fromRaw(raw: unknown): QuickAction | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID.test(r.id)) return null;
  if (typeof r.name !== "string" || typeof r.command !== "string" || !isKind(r.kind)) return null;
  const shipIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && SHIP_ID.test(x)) : []);
  // A hand-written slash command that lacks its "/" is still a slash command.
  const command = r.kind === "slash" && !r.command.trim().startsWith("/") ? `/${r.command.trim()}` : r.command;
  const base = { id: r.id, name: r.name, kind: r.kind, command, send: isSend(r.send) ? r.send : "now" };
  if (r.ships === "all") {
    const except = shipIds(r.except);
    return except.length > 0 ? { ...base, ships: "all", except } : { ...base, ships: "all" };
  }
  return { ...base, ships: shipIds(r.ships) };
}

/** All items of the file (the defaults when the file does not exist). Throws YamlUnreadableError when the file is broken. */
export function readQuickActions(dir: string): QuickAction[] {
  const file = path.join(dir, QUICK_ACTIONS_FILE);
  if (!fs.existsSync(file)) return DEFAULT_QUICK_ACTIONS.map((a) => ({ ...a }));
  const doc = readYamlDocument(file);
  const list = (doc.toJS() as { actions?: unknown } | null)?.actions;
  if (!Array.isArray(list)) return [];
  return list.map(fromRaw).filter((a): a is QuickAction => a !== null);
}

/** What a request may carry for one item: everything except the ID is required; a missing ID means a new item. */
export type QuickActionInput = Partial<Omit<QuickAction, "ships" | "except">> & { ships?: unknown; except?: unknown };

export type ValidateResult = { ok: true; actions: QuickAction[] } | { ok: false; errors: Record<string, QuickActionError> };

/** Validates and normalizes a whole list (the key of an error is the index in the list). Gives each new item an ID. */
export function validateQuickActions(input: unknown[]): ValidateResult {
  const errors: Record<string, QuickActionError> = {};
  if (input.length > QUICK_ACTION_LIMIT) return { ok: false, errors: { "-1": "settings.error.quickTooMany" } };
  const used = new Set<string>();
  const actions: QuickAction[] = [];
  input.forEach((raw, index) => {
    const r = (typeof raw === "object" && raw !== null ? raw : {}) as QuickActionInput;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    let command = typeof r.command === "string" ? r.command.trim() : "";
    const kind: QuickActionKind = isKind(r.kind) ? r.kind : "message";
    if (name.length === 0 || name.length > NAME_MAX) errors[index] = "settings.error.quickName";
    else if (kind === "slash") {
      // A slash command is one line: "/name" or "/name arguments". A leading "/" is added when it was left out.
      if (!command.startsWith("/")) command = `/${command}`;
      if (!/^\/\S/.test(command) || command.includes("\n") || command.length > COMMAND_MAX) errors[index] = "settings.error.quickCommand";
    } else if (command.length === 0 || command.length > COMMAND_MAX) errors[index] = "settings.error.quickCommand";

    let ships: "all" | string[] = [];
    if (r.ships === "all") ships = "all";
    else if (Array.isArray(r.ships) && r.ships.every((s) => typeof s === "string" && SHIP_ID.test(s))) ships = [...new Set(r.ships as string[])];
    else if (r.ships !== undefined) errors[index] ??= "settings.error.quickShips";

    let except: string[] = [];
    if (ships === "all" && r.except !== undefined) {
      if (Array.isArray(r.except) && r.except.every((s) => typeof s === "string" && SHIP_ID.test(s))) except = [...new Set(r.except as string[])];
      else errors[index] ??= "settings.error.quickShips";
    }

    let id = typeof r.id === "string" && ID.test(r.id) ? r.id : "";
    if (!id || used.has(id)) id = newId();
    used.add(id);
    const base = { id, name, kind, command, send: isSend(r.send) ? r.send : "now" } as const;
    actions.push(except.length > 0 ? { ...base, ships, except } : { ...base, ships });
  });
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, actions };
}

/** Writes a list as it is (no validation: the caller has validated the items it changed). */
function writeQuickActions(dir: string, actions: QuickAction[]): void {
  const file = path.join(dir, QUICK_ACTIONS_FILE);
  const isNew = !fs.existsSync(file);
  editYamlFile(file, (doc) => {
    doc.set("actions", doc.createNode(actions));
    if (isNew) doc.commentBefore = " Custom menu of the message box. ships: all (optionally with except: [ship IDs]), or a list of ship IDs.";
  });
}

/** Writes the whole list. Nothing is written when the list is not valid. */
export function saveQuickActions(dir: string, input: unknown[]): ValidateResult {
  const result = validateQuickActions(input);
  if (!result.ok) return result;
  writeQuickActions(dir, result.actions);
  return result;
}

/** The ships of the fleet (ID and display name), for choosing where an item is enabled. */
export function listFleetShips(dir: string): { id: string; name: string }[] {
  const shipsDir = path.join(dir, "ships");
  if (!fs.existsSync(shipsDir)) return [];
  const ships: { id: string; name: string }[] = [];
  for (const entry of fs.readdirSync(shipsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SHIP_ID.test(entry.name)) continue;
    const shipFile = path.join(shipsDir, entry.name, "ship.yml");
    if (!fs.existsSync(shipFile)) continue;
    let name = entry.name;
    try {
      const raw = parse(fs.readFileSync(shipFile, "utf-8")) as { name?: unknown } | null;
      if (typeof raw?.name === "string" && raw.name.trim()) name = raw.name.trim();
    } catch {
      // A ship.yml that cannot be read is still a ship; it is shown by its ID.
    }
    ships.push({ id: entry.name, name });
  }
  return ships.sort((a, b) => a.id.localeCompare(b.id));
}

export function enabledOn(action: QuickAction, shipId: string): boolean {
  return action.ships === "all" ? !(action.except ?? []).includes(shipId) : action.ships.includes(shipId);
}

/** What a ship sees of an item: whether other ships share it tells the editor that a change reaches them too. */
export type ShipQuickAction = Omit<QuickAction, "ships"> & { shared: boolean };

export function quickActionsOfShip(dir: string, shipId: string): ShipQuickAction[] {
  return readQuickActions(dir)
    .filter((a) => enabledOn(a, shipId))
    .map(({ ships, ...rest }) => ({ ...rest, shared: ships === "all" || ships.some((s) => s !== shipId) }));
}

/**
 * Saves the list as one ship edited it.
 * - An item with a known ID is updated (a shared item changes for every ship that has it); an item without one, or with an ID this
 *   ship does not have, or a repeated ID, is new and is enabled on this ship only.
 * - An item this ship had and that the request leaves out is taken off this ship (an item enabled on "all" gets this ship in its
 *   `except`, so ships made later still get it; an item no ship has any more is removed) — but only if the editor had seen it
 *   (`seen`, the IDs it loaded). An item that appeared after that is left alone. Without `seen`, every item counts as seen.
 * - Only this ship's own items are validated; the other ships' items are written back as they are, so a hand-edited mistake in
 *   them cannot block this ship's save.
 * The ship's items keep the places they had in the file, in the order the request gave.
 */
export function saveQuickActionsOfShip(dir: string, shipId: string, input: unknown[], seen?: string[]): ValidateResult {
  const all = readQuickActions(dir);
  const taken = new Set<string>();
  const requested = input.map((raw) => {
    const r = (typeof raw === "object" && raw !== null ? raw : {}) as QuickActionInput;
    const current = all.find((a) => a.id === r.id && enabledOn(a, shipId) && !taken.has(a.id));
    if (!current) return { ...r, id: undefined, ships: [shipId], except: undefined };
    taken.add(current.id);
    return { ...r, ships: current.ships, except: current.except };
  });
  const checked = validateQuickActions(requested);
  if (!checked.ok) return checked;

  const seenIds = seen ? new Set(seen) : null;
  // The file's items in order; this ship's kept items become holes (null) to be filled in the request's order.
  const layout: (QuickAction | null)[] = [];
  for (const action of all) {
    if (!enabledOn(action, shipId)) layout.push(action);
    else if (taken.has(action.id)) layout.push(null);
    else if (seenIds && !seenIds.has(action.id)) layout.push(action);
    else if (action.ships === "all") layout.push({ ...action, except: [...(action.except ?? []), shipId] });
    else {
      const others = action.ships.filter((s) => s !== shipId);
      if (others.length > 0) layout.push({ ...action, ships: others });
    }
  }
  const mine = [...checked.actions];
  const final = layout.map((slot) => slot ?? mine.shift()).filter((a): a is QuickAction => a !== undefined);
  final.push(...mine);
  writeQuickActions(dir, final);
  return { ok: true, actions: checked.actions };
}
