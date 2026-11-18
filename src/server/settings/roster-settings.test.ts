import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadConfig } from "../load-config.js";
import { deleteMember, readPersona, readRosterState, saveMember, savePersona, type RosterMemberInput } from "./roster-settings.js";

let tmp: string;
let dir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mis-roster-"));
  dir = path.join(tmp, ".make-it-so");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(rel: string, text: string): void {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}
const rosterFile = () => fs.readFileSync(path.join(dir, "roster.yml"), "utf-8");
const crew = () => (parse(rosterFile()) as { crew: Record<string, unknown> }).crew;

const input = (over: Partial<RosterMemberInput> = {}): RosterMemberInput => ({
  name: "Sam", provider: null, model: null, permission_mode: null, rules: [], skills: [], ...over,
});

describe("readRosterState", () => {
  it("no roster.yml: no members, and the choices the form offers", () => {
    const state = readRosterState(dir);
    expect(state).toMatchObject({ exists: false, members: [], providers: ["kiro", "claude"] });
    expect(state.permissionModes).toContain("bypassPermissions");
  });

  it("lists the members with their fields, whether they have a persona, and which ships assign them", () => {
    write("roster.yml", "crew:\n  alex:\n    name: Alex\n    provider: claude\n    model: opus\n    rules: [r.md]\n");
    write("personnel/alex.md", "I am Alex.");
    write("ships/alpha/ship.yml", "port: 4000\ncrew:\n  lead: { member: alex }\n  helper: { member: alex }\n");
    expect(readRosterState(dir).members).toEqual([{
      id: "alex", name: "Alex", provider: "claude", model: "opus", permission_mode: null, rules: ["r.md"], skills: [],
      hasPersona: true, usedBy: [{ ship: "alpha", role: "lead" }, { ship: "alpha", role: "helper" }],
    }]);
  });
});

describe("saveMember", () => {
  it("creates a member (and roster.yml) with only the fields that are set", () => {
    expect(saveMember(dir, "sam", input({ provider: "kiro", model: "sonnet" }), true).ok).toBe(true);
    expect(crew()).toEqual({ sam: { name: "Sam", provider: "kiro", model: "sonnet" } });
  });

  it("an update writes only what changed: comments and other members stay, an emptied field is removed", () => {
    write("roster.yml", "# the fleet\ncrew:\n  alex:\n    name: Alex # the first one\n    model: opus\n  sam:\n    name: Sam\n");
    saveMember(dir, "alex", input({ name: "Alex", model: null, provider: "claude" }), false);
    const text = rosterFile();
    expect(text).toContain("# the fleet");
    expect(text).toContain("name: Alex # the first one");
    expect(crew()).toEqual({ alex: { name: "Alex", provider: "claude" }, sam: { name: "Sam" } });
  });

  it("what it writes is read by loadConfig (a member assigned to a ship starts up)", () => {
    write("rules/r.md", "be kind");
    write("ships/alpha/ship.yml", "port: 4000\ncrew:\n  lead: { member: sam }\n");
    saveMember(dir, "sam", input({ provider: "claude", model: "sonnet", permission_mode: "plan", rules: ["rules/r.md"] }), true);
    const config = loadConfig({ homeDir: tmp, log: () => {} });
    expect(config.crew.lead).toMatchObject({ name: "Sam", provider: "claude", model: "sonnet", permissionMode: "plan" });
    expect(config.crew.lead.rules).toEqual([path.join(dir, "rules/r.md")]);
  });

  it("refuses a bad ID, a duplicate, an unknown member, and invalid fields, writing nothing", () => {
    write("roster.yml", "crew:\n  alex:\n    name: Alex\n");
    const before = rosterFile();
    expect(saveMember(dir, "../evil", input(), true)).toEqual({ ok: false, errors: { id: "settings.error.memberId" } });
    expect(saveMember(dir, "alex", input(), true)).toEqual({ ok: false, errors: { id: "settings.error.memberExists" } });
    expect(saveMember(dir, "ghost", input(), false)).toEqual({ ok: false, errors: { id: "settings.error.memberMissing" } });
    expect(saveMember(dir, "new", input({ name: "  ", provider: "gpt", rules: ["nope.md"] }), true)).toEqual({
      ok: false, errors: { name: "settings.error.empty", provider: "settings.error.notAnOption", rules: "settings.error.fileNotFound" },
    });
    expect(rosterFile()).toBe(before);
  });
});

describe("deleteMember", () => {
  it("removes a member who no ship assigns, keeping the persona file", () => {
    write("roster.yml", "crew:\n  alex:\n    name: Alex\n  sam:\n    name: Sam\n");
    write("personnel/sam.md", "x");
    expect(deleteMember(dir, "sam").ok).toBe(true);
    expect(Object.keys(crew())).toEqual(["alex"]);
    expect(fs.existsSync(path.join(dir, "personnel/sam.md"))).toBe(true);
  });

  it("refuses to remove a member a ship assigns, saying where", () => {
    write("roster.yml", "crew:\n  alex:\n    name: Alex\n");
    write("ships/alpha/ship.yml", "port: 4000\ncrew:\n  lead: { member: alex }\n");
    expect(deleteMember(dir, "alex")).toEqual({ ok: false, errors: { id: "settings.error.memberInUse" }, usedBy: [{ ship: "alpha", role: "lead" }] });
    expect(Object.keys(crew())).toEqual(["alex"]);
  });

  it("an unknown member is an error", () => {
    expect(deleteMember(dir, "ghost")).toMatchObject({ ok: false, errors: { id: "settings.error.memberMissing" } });
  });
});

describe("the persona file", () => {
  it("reads, writes (keeping the old one as .bak) and removes on blank text", () => {
    expect(readPersona(dir, "sam")).toEqual({ text: "", exists: false });
    expect(savePersona(dir, "sam", "I am Sam.")).toBe(true);
    expect(readPersona(dir, "sam")).toEqual({ text: "I am Sam.", exists: true });
    savePersona(dir, "sam", "Changed.");
    expect(fs.readFileSync(path.join(dir, "personnel/sam.md.bak"), "utf-8")).toBe("I am Sam.");
    savePersona(dir, "sam", "   \n");
    expect(readPersona(dir, "sam")).toEqual({ text: "", exists: false });
  });

  it("an ID that could escape the directory is refused", () => {
    expect(readPersona(dir, "../x")).toBeNull();
    expect(savePersona(dir, "../x", "evil")).toBe(false);
    expect(fs.existsSync(path.join(tmp, "x.md"))).toBe(false);
  });
});

describe("a roster whose crew key is empty (a template with everything commented out)", () => {
  it("the first member can still be added, and the comments stay", () => {
    write("roster.yml", "# my roster\ncrew:\n  # alex:\n  #   name: Alex\n");
    expect(saveMember(dir, "sam", input(), true).ok).toBe(true);
    expect(rosterFile()).toContain("# my roster");
    expect(crew()).toEqual({ sam: { name: "Sam" } });
  });

  it("works the same when the file is only `crew:`", () => {
    write("roster.yml", "crew:\n");
    expect(saveMember(dir, "sam", input(), true).ok).toBe(true);
    expect(crew()).toEqual({ sam: { name: "Sam" } });
  });
});

describe("input of the wrong type is refused with errors, not a crash", () => {
  it("a non-text model, permission mode or provider, and a list that is not a list, are field errors", () => {
    const bad = { name: "S", provider: 5, model: 5, permission_mode: {}, rules: "x", skills: [3] } as unknown as RosterMemberInput;
    const result = saveMember(dir, "sam", bad, true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors).sort()).toEqual(["model", "permission_mode", "provider", "rules", "skills"]);
    expect(fs.existsSync(path.join(dir, "roster.yml"))).toBe(false);
  });
});
