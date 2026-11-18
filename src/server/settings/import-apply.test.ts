import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { applyImport } from "./import-apply.js";
import { buildDraft, readImportContext } from "./import-draft.js";
import { scanProject } from "./project-scan.js";

let tmp: string;
let dir: string;
let project: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mis-apply-"));
  dir = path.join(tmp, ".make-it-so");
  project = path.join(tmp, "my-app");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fs.mkdirSync(path.join(project, ".claude/agents"), { recursive: true });
  fs.writeFileSync(path.join(project, ".claude/agents/reviewer.md"), "---\nname: reviewer\nmodel: opus\n---\nReview.");
  fs.writeFileSync(path.join(project, ".claude/agents/builder.md"), "---\nname: builder\n---\nBuild.");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The draft the screen would be given, turned into what it sends back unchanged. */
function draftInput() {
  const draft = buildDraft("claude", project, scanProject(project).claude, readImportContext(dir));
  return { members: draft.members.map((m) => ({ id: m.id, reuse: m.reuse, input: m.input })), ship: draft.ship };
}

describe("applyImport", () => {
  it("creates the directory, the members and the ship from nothing", () => {
    const result = applyImport(dir, draftInput());
    expect(result).toEqual({ ok: true, shipId: "my-app", createdMembers: ["builder", "reviewer"] });
    const roster = parse(fs.readFileSync(path.join(dir, "roster.yml"), "utf-8"));
    expect(roster.crew.reviewer).toMatchObject({ name: "reviewer", provider: "claude", model: "opus" });
    const ship = parse(fs.readFileSync(path.join(dir, "ships/my-app/ship.yml"), "utf-8"));
    expect(ship.targets).toEqual({ "my-app": project });
    expect(ship.crew.reviewer).toMatchObject({ member: "reviewer", rank: "chief", agent: "reviewer", cwd: project });
  });

  it("uses an existing member instead of creating it, and leaves the roster's other content as it is", () => {
    fs.mkdirSync(dir, { recursive: true });
    const roster = "# my roster\ncrew:\n  reviewer:\n    name: Rev\n    provider: claude\n";
    fs.writeFileSync(path.join(dir, "roster.yml"), roster);
    const input = draftInput();
    expect(input.members.map((m) => [m.id, m.reuse])).toEqual([["builder", false], ["reviewer", true]]);
    const result = applyImport(dir, input);
    expect(result).toMatchObject({ ok: true, createdMembers: ["builder"] });
    const after = fs.readFileSync(path.join(dir, "roster.yml"), "utf-8");
    expect(after).toContain("# my roster");
    expect(after).toContain("name: Rev");
  });

  it("puts everything back when the ship is refused", () => {
    const input = draftInput();
    input.ship.fields.port = 70000;
    const result = applyImport(dir, input);
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(dir, "roster.yml"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "ships"))).toBe(false);
  });

  it("puts an existing roster back byte for byte when the ship is refused", () => {
    fs.mkdirSync(dir, { recursive: true });
    const roster = "crew:\n  other:\n    name: Other\n";
    fs.writeFileSync(path.join(dir, "roster.yml"), roster);
    const input = draftInput();
    input.ship.fields.port = 0;
    expect(applyImport(dir, input).ok).toBe(false);
    expect(fs.readFileSync(path.join(dir, "roster.yml"), "utf-8")).toBe(roster);
    expect(fs.existsSync(path.join(dir, "roster.yml.bak"))).toBe(false);
  });

  it("refuses a new member whose ID is taken, and a reused one that does not exist, writing nothing", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "roster.yml"), "crew:\n  builder:\n    name: B\n    provider: claude\n");
    const input = draftInput();
    expect(input.members.map((m) => [m.id, m.reuse])).toEqual([["builder", true], ["reviewer", false]]);
    input.members[1].id = "ghost"; // reuse of a member that is not in the roster
    input.members[1].reuse = true;
    input.members[0].reuse = false; // creating "builder" again
    const result = applyImport(dir, input);
    expect(result).toEqual({ ok: false, errors: { ship: {}, members: { ghost: { id: "settings.error.memberMissing" }, builder: { id: "settings.error.memberExists" } } } });
    expect(fs.existsSync(path.join(dir, "ships"))).toBe(false);
  });

  it("reports a ship ID that already exists", () => {
    expect(applyImport(dir, draftInput()).ok).toBe(true);
    const again = draftInput();
    again.ship.id = "my-app";
    again.members.forEach((m) => { m.reuse = true; });
    const result = applyImport(dir, again);
    expect(result.ok).toBe(false);
  });
});

describe("applyImport: what is left behind", () => {
  it("a later member that the saves cannot handle leaves the roster exactly as it was (nothing half-written)", () => {
    fs.mkdirSync(dir, { recursive: true });
    const roster = "crew:\n  other:\n    name: Other\n";
    fs.writeFileSync(path.join(dir, "roster.yml"), roster);
    const input = draftInput();
    (input.members[1].input as unknown as { rules: unknown }).rules = 5; // wrong type
    expect(applyImport(dir, input).ok).toBe(false);
    expect(fs.readFileSync(path.join(dir, "roster.yml"), "utf-8")).toBe(roster);
    expect(fs.existsSync(path.join(dir, "roster.yml.bak"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "ships"))).toBe(false);
  });

  it("after a successful import, roster.yml.bak holds the roster as it was before the import", () => {
    fs.mkdirSync(dir, { recursive: true });
    const roster = "crew:\n  other:\n    name: Other\n";
    fs.writeFileSync(path.join(dir, "roster.yml"), roster);
    expect(applyImport(dir, draftInput()).ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, "roster.yml.bak"), "utf-8")).toBe(roster);
  });

  it("with no roster before, a successful import leaves no .bak", () => {
    expect(applyImport(dir, draftInput()).ok).toBe(true);
    expect(fs.existsSync(path.join(dir, "roster.yml.bak"))).toBe(false);
  });
});

describe("applyImport with a roster that is a symlink", () => {
  it("the .bak next to the real file holds the roster before the import, and no stray .bak appears beside the link", () => {
    fs.mkdirSync(dir, { recursive: true });
    const realDir = path.join(tmp, "dotfiles");
    fs.mkdirSync(realDir);
    const real = path.join(realDir, "roster.yml");
    const original = "crew:\n  other:\n    name: Other\n";
    fs.writeFileSync(real, original);
    fs.symlinkSync(real, path.join(dir, "roster.yml"));
    expect(applyImport(dir, draftInput()).ok).toBe(true);
    expect(fs.readFileSync(`${real}.bak`, "utf-8")).toBe(original);
    expect(fs.existsSync(path.join(dir, "roster.yml.bak"))).toBe(false);
    expect(fs.lstatSync(path.join(dir, "roster.yml")).isSymbolicLink()).toBe(true);
  });
});
