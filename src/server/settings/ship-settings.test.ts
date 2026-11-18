import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { loadConfig } from "../load-config.js";
import { deleteShip, newShipFields, readShipState, saveShip, type ShipFields } from "./ship-settings.js";

let tmp: string;
let dir: string;
let appDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mis-ship-"));
  dir = path.join(tmp, ".make-it-so");
  appDir = path.join(tmp, "app");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fs.mkdirSync(appDir, { recursive: true });
  write("roster.yml", "crew:\n  alex:\n    name: Alex\n  sam:\n    name: Sam\n");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, text: string): void {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}
const shipText = (id = "alpha") => fs.readFileSync(path.join(dir, "ships", id, "ship.yml"), "utf-8");
const shipObj = (id = "alpha") => parse(shipText(id));

const role = (over: Partial<ShipFields["crew"][number]> = {}): ShipFields["crew"][number] => ({
  role: "lead", member: "alex", rank: "commander", model: null, permission_mode: null, cwd: null, agent: null, host: null, access: [], ...over,
});
const fields = (over: Partial<ShipFields> = {}): ShipFields => ({ ...newShipFields(4000, null, "alex"), ...over });

describe("creating a ship", () => {
  it("writes a minimal ship that loadConfig starts (the same shape as init)", () => {
    const result = saveShip(dir, "alpha", newShipFields(4000, "Alpha", "alex"), true);
    expect(result.ok).toBe(true);
    expect(shipObj()).toEqual({ port: 4000, name: "Alpha", crew: { lead: { member: "alex", rank: "commander" } } });
    const config = loadConfig({ shipId: "alpha", homeDir: tmp, log: () => {} });
    expect([config.port, config.shipName, config.crew.lead.rank]).toEqual([4000, "Alpha", "commander"]);
  });

  it("refuses a bad ID, an existing ship, and an unknown ship on update", () => {
    expect(saveShip(dir, "../x", fields(), true)).toEqual({ ok: false, errors: { id: "settings.error.shipId" } });
    saveShip(dir, "alpha", fields(), true);
    expect(saveShip(dir, "alpha", fields({ port: 4001 }), true)).toEqual({ ok: false, errors: { id: "settings.error.shipExists" } });
    expect(saveShip(dir, "ghost", fields(), false)).toEqual({ ok: false, errors: { id: "settings.error.shipMissing" } });
  });
});

describe("updating a ship", () => {
  beforeEach(() => {
    write("ships/alpha/ship.yml", `# my ship\nport: 4000 # the port\nfuture_key: keep\ntargets:\n  app: ${appDir}\ncrew:\n  lead:\n    member: alex\n    rank: commander # in charge\n  helper:\n    member: sam\n`);
    write("ships/alpha/rules/r.md", "x");
  });

  it("reads the fields back, and what the form offers", () => {
    const state = readShipState(dir, "alpha");
    expect(state?.fields.port).toBe(4000);
    expect(state?.fields.targets).toEqual([{ name: "app", path: appDir }]);
    expect(state?.fields.crew.map((r) => [r.role, r.member, r.rank])).toEqual([["lead", "alex", "commander"], ["helper", "sam", "crew"]]);
    expect(state?.options.members.map((m) => m.id)).toEqual(["alex", "sam"]);
  });

  it("an update with nothing changed leaves the file exactly as it was", () => {
    const before = shipText();
    expect(saveShip(dir, "alpha", readShipState(dir, "alpha")!.fields, false).ok).toBe(true);
    expect(shipText()).toBe(before);
  });

  it("writes only what changed: comments and unknown keys stay, an emptied field is removed", () => {
    const f = readShipState(dir, "alpha")!.fields;
    f.name = "Alpha";
    f.rules = ["rules/r.md"];
    f.crew[1].model = "opus";
    f.crew[0].access = [{ target: "app", mode: "readwrite" }];
    expect(saveShip(dir, "alpha", f, false).ok).toBe(true);
    expect(shipText()).toContain("# my ship");
    expect(shipText()).toContain("# in charge");
    expect(shipObj()).toEqual({
      port: 4000, future_key: "keep", name: "Alpha", rules: ["rules/r.md"], targets: { app: appDir },
      crew: { lead: { member: "alex", rank: "commander", access: { app: "readwrite" } }, helper: { member: "sam", model: "opus" } },
    });
    const g = readShipState(dir, "alpha")!.fields;
    g.name = null; g.rules = []; g.targets = []; g.crew = [g.crew[0]]; g.crew[0].access = [];
    expect(saveShip(dir, "alpha", g, false).ok).toBe(true);
    expect(shipObj()).toEqual({ port: 4000, future_key: "keep", crew: { lead: { member: "alex", rank: "commander" } } });
  });

  it("adds a role, and what it writes is accepted by loadConfig", () => {
    const f = readShipState(dir, "alpha")!.fields;
    f.crew.push(role({ role: "scout", member: "sam", rank: "chief", permission_mode: "plan", access: [{ target: "app", mode: "readonly" }] }));
    f.crew[1].member = "alex"; // helper now alex too (a member can hold several roles)
    expect(saveShip(dir, "alpha", f, false).ok).toBe(true);
    const config = loadConfig({ shipId: "alpha", homeDir: tmp, log: () => {} });
    expect(Object.keys(config.crew)).toEqual(["lead", "helper", "scout"]);
    expect(config.crew.scout).toMatchObject({ rank: "chief", permissionMode: "plan" });
  });
});

describe("what a ship refuses, writing nothing", () => {
  beforeEach(() => {
    write("ships/alpha/ship.yml", "port: 4000\ncrew:\n  lead: { member: alex, rank: commander }\n");
    write("ships/beta/ship.yml", "port: 4001\ncrew:\n  lead: { member: alex }\n");
    write("hosts.yml", "hosts:\n  dev:\n    destination: dev-server\n");
  });

  const attempt = (change: (f: ShipFields) => void) => {
    const before = shipText();
    const f = readShipState(dir, "alpha")!.fields;
    change(f);
    const result = saveShip(dir, "alpha", f, false);
    expect(shipText()).toBe(before);
    return result.ok ? {} : result.errors;
  };

  it("a bad port, or one another ship has", () => {
    expect(attempt((f) => { f.port = 0; })).toEqual({ port: "settings.error.port" });
    expect(attempt((f) => { f.port = 4001; })).toEqual({ port: "settings.error.portInUse" });
  });

  it("missing files and directories", () => {
    expect(attempt((f) => { f.rules = ["nope.md"]; })).toEqual({ rules: "settings.error.fileNotFound" });
    expect(attempt((f) => { f.cwd = "nowhere"; })).toEqual({ cwd: "settings.error.dirNotFound" });
  });

  it("no roles, a role name used twice or malformed, an unknown member", () => {
    expect(attempt((f) => { f.crew = []; })).toEqual({ crew: "settings.error.noRoles" });
    expect(attempt((f) => { f.crew.push(role({ role: "lead", rank: "crew" })); })).toEqual({ "crew.lead.role": "settings.error.roleName" });
    expect(attempt((f) => { f.crew.push(role({ role: "bad role", rank: "crew" })); })).toEqual({ "crew.bad role.role": "settings.error.roleName" });
    expect(attempt((f) => { f.crew[0].member = "ghost"; })).toEqual({ "crew.lead.member": "settings.error.memberMissing" });
  });

  it("two commanders", () => {
    expect(attempt((f) => { f.crew.push(role({ role: "second", member: "sam" })); })).toEqual({ "crew.second.rank": "settings.error.twoCommanders" });
  });

  it("a remote role needs a known host, an absolute cwd, and no access", () => {
    expect(attempt((f) => { f.crew[0].host = "nope"; f.crew[0].cwd = "/remote"; })).toEqual({ "crew.lead.host": "settings.error.hostUnknown" });
    expect(attempt((f) => { f.crew[0].host = "dev"; })).toEqual({ "crew.lead.cwd": "settings.error.remoteCwd" });
    expect(attempt((f) => { f.targets = [{ name: "app", path: appDir }]; f.crew[0].host = "dev"; f.crew[0].cwd = "/r"; f.crew[0].access = [{ target: "app", mode: "readonly" }]; })).toEqual({ "crew.lead.access": "settings.error.remoteAccess" });
  });

  it("targets: blank or repeated names, and access to a target that does not exist", () => {
    expect(attempt((f) => { f.targets = [{ name: "a", path: appDir }, { name: "a", path: appDir }]; })).toEqual({ targets: "settings.error.target" });
    expect(attempt((f) => { f.targets = [{ name: "a", path: path.join(tmp, "missing") }]; })).toEqual({ targets: "settings.error.targetNotFound" });
    expect(attempt((f) => { f.crew[0].access = [{ target: "ghost", mode: "readonly" }]; })).toEqual({ "crew.lead.access": "settings.error.accessTarget" });
  });
});

describe("deleting a ship", () => {
  it("removes the ship's whole directory and leaves the roster and the other ships", () => {
    saveShip(dir, "alpha", newShipFields(4000, null, "alex"), true);
    saveShip(dir, "beta", newShipFields(4001, null, "alex"), true);
    write("ships/alpha/data/ship.db", "data");
    expect(deleteShip(dir, "alpha")).toEqual({ ok: true });
    expect(fs.existsSync(path.join(dir, "ships/alpha"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "ships/beta/ship.yml"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "roster.yml"))).toBe(true);
  });

  it("refuses an ID that is not a ship ID or a directory that is not a ship, touching nothing", () => {
    write("ships/stray/notes.txt", "x");
    write("keep.txt", "x");
    expect(deleteShip(dir, "../")).toEqual({ ok: false, error: "settings.error.shipId" });
    expect(deleteShip(dir, "..")).toEqual({ ok: false, error: "settings.error.shipId" });
    expect(deleteShip(dir, "stray")).toEqual({ ok: false, error: "settings.error.shipMissing" });
    expect(deleteShip(dir, "nope")).toEqual({ ok: false, error: "settings.error.shipMissing" });
    expect(fs.existsSync(path.join(dir, "ships/stray/notes.txt"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "keep.txt"))).toBe(true);
  });

  it("can remove a ship whose ship.yml is broken (the caller decides whether to allow it)", () => {
    write("ships/bad/ship.yml", "port: [unclosed");
    expect(deleteShip(dir, "bad")).toEqual({ ok: true });
  });
});
