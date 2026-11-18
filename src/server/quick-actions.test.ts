import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { listFleetShips, quickActionsOfShip, readQuickActions, saveQuickActions, saveQuickActionsOfShip, validateQuickActions } from "./quick-actions.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "mis-qa-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const file = () => path.join(dir, "quick-actions.yml");
const item = (name: string, extra: object = {}) => ({ name, kind: "message", command: `say ${name}`, send: "now", ...extra });

describe("readQuickActions", () => {
  it("offers Resume and Compact on every ship when there is no file", () => {
    const actions = readQuickActions(dir);
    expect(actions.map((a) => a.command)).toEqual(["/resume", "/compact"]);
    expect(actions.every((a) => a.ships === "all")).toBe(true);
    expect(fs.existsSync(file())).toBe(false);
  });

  it("skips items it cannot understand", () => {
    fs.writeFileSync(file(), "actions:\n  - id: a\n    name: A\n    kind: message\n    command: hi\n    ships: [s1]\n  - id: b\n    name: B\n    kind: weird\n    command: x\n  - 7\n");
    expect(readQuickActions(dir).map((a) => a.id)).toEqual(["a"]);
  });
});

describe("validateQuickActions", () => {
  it("adds a leading slash to a slash command and gives new items an ID", () => {
    const r = validateQuickActions([{ name: " Review ", kind: "slash", command: "review src", ships: "all" }]);
    expect(r.ok && r.actions[0]).toMatchObject({ name: "Review", command: "/review src", send: "now", ships: "all" });
    expect(r.ok && r.actions[0].id).toMatch(/^qa-[0-9a-f]{8}$/);
  });

  it("reports an error per index and rejects the whole list", () => {
    const r = validateQuickActions([item("ok", { ships: [] }), item(" ", { ships: [] }), { ...item("x"), command: "", ships: [] }, { ...item("y"), kind: "slash", command: "/a\nb", ships: [] }, item("z", { ships: ["bad id"] })]);
    expect(r).toEqual({ ok: false, errors: { 1: "settings.error.quickName", 2: "settings.error.quickCommand", 3: "settings.error.quickCommand", 4: "settings.error.quickShips" } });
  });

  it("limits the number of items", () => {
    expect(validateQuickActions(Array.from({ length: 51 }, (_, i) => item(`n${i}`)))).toMatchObject({ ok: false });
  });
});

describe("saveQuickActions", () => {
  it("writes a readable file and nothing when invalid", () => {
    expect(saveQuickActions(dir, [item(" ")]).ok).toBe(false);
    expect(fs.existsSync(file())).toBe(false);
    saveQuickActions(dir, [item("A", { ships: ["s1", "s2"] })]);
    expect(parse(fs.readFileSync(file(), "utf-8")).actions[0]).toMatchObject({ name: "A", ships: ["s1", "s2"] });
    expect(readQuickActions(dir)).toHaveLength(1);
  });
});

describe("saveQuickActionsOfShip", () => {
  it("adds a new item to this ship only", () => {
    saveQuickActionsOfShip(dir, "s1", [item("Mine")]);
    expect(quickActionsOfShip(dir, "s1").map((a) => a.name)).toEqual(["Mine"]);
    expect(quickActionsOfShip(dir, "s2").map((a) => a.name)).toEqual(["Resume", "Compact"]);
  });

  it("dropping an item that is enabled on all ships turns it off for this ship only", () => {
    // The defaults (all ships) are on screen; this ship keeps only Resume.
    const [resume] = quickActionsOfShip(dir, "s1");
    saveQuickActionsOfShip(dir, "s1", [resume]);
    expect(quickActionsOfShip(dir, "s1").map((a) => a.id)).toEqual(["resume"]);
    expect(quickActionsOfShip(dir, "s2").map((a) => a.id)).toEqual(["resume", "compact"]);
    // Switched off for s1 only: ships made later still get it.
    expect(readQuickActions(dir).find((a) => a.id === "compact")).toMatchObject({ ships: "all", except: ["s1"] });
    expect(quickActionsOfShip(dir, "s3").map((a) => a.id)).toEqual(["resume", "compact"]);
  });

  it("removes an item when the last ship drops it", () => {
    saveQuickActions(dir, [item("Other", { id: "o", ships: ["s2"] })]);
    saveQuickActionsOfShip(dir, "s1", [item("Mine")]);
    saveQuickActionsOfShip(dir, "s1", []);
    expect(readQuickActions(dir).map((a) => a.name)).toEqual(["Other"]);
  });

  it("marks an item shared by other ships, and editing it changes it for them", () => {
    saveQuickActions(dir, [item("Both", { id: "both", ships: ["s1", "s2"] })]);
    const [shared] = quickActionsOfShip(dir, "s1");
    expect(shared.shared).toBe(true);
    saveQuickActionsOfShip(dir, "s1", [{ ...shared, name: "Renamed" }]);
    expect(quickActionsOfShip(dir, "s2")[0].name).toBe("Renamed");
  });

  it("keeps this ship's items in the order it sent, in the places they had", () => {
    saveQuickActions(dir, [item("A", { id: "a", ships: ["s1"] }), item("X", { id: "x", ships: ["s2"] }), item("B", { id: "b", ships: ["s1"] })]);
    const [a, b] = quickActionsOfShip(dir, "s1");
    saveQuickActionsOfShip(dir, "s1", [b, a, item("C")]);
    expect(readQuickActions(dir).map((x) => x.name)).toEqual(["B", "X", "A", "C"]);
  });

  it("does not let a ship take over an item it does not have", () => {
    saveQuickActions(dir, [item("Theirs", { id: "theirs", ships: ["s2"] })]);
    saveQuickActionsOfShip(dir, "s1", [{ ...item("Mine"), id: "theirs" }]);
    expect(quickActionsOfShip(dir, "s2").map((a) => a.name)).toEqual(["Theirs"]);
    expect(quickActionsOfShip(dir, "s1").map((a) => a.name)).toEqual(["Mine"]);
  });
});

describe("saveQuickActionsOfShip: concurrent edits and bad neighbours", () => {
  it("leaves an item that appeared after the editor loaded its list alone", () => {
    const [resume, compact] = quickActionsOfShip(dir, "s1");
    saveQuickActions(dir, [...readQuickActions(dir), item("Added later", { id: "late", ships: "all" })]);
    saveQuickActionsOfShip(dir, "s1", [resume, compact], ["resume", "compact"]);
    expect(quickActionsOfShip(dir, "s1").map((a) => a.id)).toEqual(["resume", "compact", "late"]);
    expect(readQuickActions(dir).find((a) => a.id === "late")?.ships).toBe("all");
  });

  it("is not blocked by a hand-edited mistake in another ship's item", () => {
    fs.writeFileSync(file(), "actions:\n  - id: theirs\n    name: ''\n    kind: message\n    command: x\n    ships: [s2]\n  - id: mine\n    name: Mine\n    kind: message\n    command: hi\n    ships: [s1]\n");
    const [mine] = quickActionsOfShip(dir, "s1");
    expect(saveQuickActionsOfShip(dir, "s1", [{ ...mine, name: "Renamed" }]).ok).toBe(true);
    const saved = readQuickActions(dir);
    expect(saved.find((a) => a.id === "mine")?.name).toBe("Renamed");
    expect(saved.find((a) => a.id === "theirs")).toBeDefined();
  });

  it("treats a repeated ID in the request as a new item for this ship only", () => {
    const [resume] = quickActionsOfShip(dir, "s1");
    saveQuickActionsOfShip(dir, "s1", [resume, { ...resume, name: "Copy" }]);
    const copy = readQuickActions(dir).find((a) => a.name === "Copy");
    expect(copy?.id).not.toBe("resume");
    expect(copy?.ships).toEqual(["s1"]);
  });
});

describe("hand-written items", () => {
  it("a slash command without its leading slash is read as a slash command", () => {
    fs.writeFileSync(file(), "actions:\n  - id: a\n    name: A\n    kind: slash\n    command: review\n    ships: all\n");
    expect(readQuickActions(dir)[0].command).toBe("/review");
  });

  it("keeps the except list of an all-ships item and ignores it otherwise", () => {
    expect(validateQuickActions([item("A", { ships: "all", except: ["s1"] }), item("B", { ships: ["s1"], except: ["s2"] })])).toMatchObject({
      ok: true,
      actions: [{ ships: "all", except: ["s1"] }, { ships: ["s1"] }],
    });
  });
});

describe("listFleetShips", () => {
  it("lists ships with their display names", () => {
    fs.mkdirSync(path.join(dir, "ships", "alpha"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ships", "alpha", "ship.yml"), "name: Alpha Ship\n");
    fs.mkdirSync(path.join(dir, "ships", "beta"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ships", "beta", "ship.yml"), "port: 1\n");
    fs.mkdirSync(path.join(dir, "ships", "empty"), { recursive: true });
    expect(listFleetShips(dir)).toEqual([{ id: "alpha", name: "Alpha Ship" }, { id: "beta", name: "beta" }]);
  });
});
