import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCommonAnnouncement, buildDispatchNote, parseFrontmatter, type SkillsContext } from "./skills.js";

// skills.ts does not depend on the ship config and receives the ship's information as arguments, so it can be
// called against a temporary directory without a mock.
let root: string;
let ctx: SkillsContext;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mis-skills-"));
  ctx = { projectRoot: root, skillsDir: path.join(root, "skills") };
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function skill(dir: string, content: string): string {
  const file = path.join(dir, "skill.md");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
const fm = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`;

describe("parseFrontmatter", () => {
  it("extracts name and description from the leading YAML frontmatter", () => {
    expect(parseFrontmatter(fm("weather", "Check the weather"))).toEqual({ name: "weather", description: "Check the weather" });
  });

  it("can be read even with CRLF line endings", () => {
    expect(parseFrontmatter("---\r\nname: a\r\ndescription: b\r\n---\r\nbody")).toEqual({ name: "a", description: "b" });
  });

  it.each([
    ["no frontmatter", "body only"],
    ["no name", "---\ndescription: b\n---\n"],
    ["no description", "---\nname: a\n---\n"],
    ["broken YAML", "---\nname: [unclosed\n---\n"],
    ["empty frontmatter", "---\n\n---\n"],
  ])("an invalid one is null: %s", (_label, content) => {
    expect(parseFrontmatter(content)).toBeNull();
  });
});

describe("language note", () => {
  it("tells the crew which language to speak, in both the full and the remote announcement", () => {
    const full = buildCommonAnnouncement(ctx, [], { language: "ja" });
    const remote = buildCommonAnnouncement(ctx, [], { remote: true, language: "ja" });
    for (const text of [full, remote]) {
      expect(text).toContain("## Language");
      expect(text).toContain("Always respond in Japanese");
    }
    expect(buildCommonAnnouncement(ctx, [], { language: "en" })).toContain("Always respond in English");
  });

  it("says nothing about the language when none is given", () => {
    expect(buildCommonAnnouncement(ctx)).not.toContain("## Language");
  });
});

describe("buildCommonAnnouncement", () => {
  it("the common operating rules include the ship root's absolute path (workspace), how to treat task notices, and guidance on the report format", () => {
    const text = buildCommonAnnouncement(ctx);
    expect(text).toContain("## Common operating rules");
    expect(text).toContain(path.join(root, "workspace"));
    expect(text).toContain("make a \"report\"");
    expect(text).toContain("get_task");
  });

  it("if the ship has report-format.md, it tells them to read it. If not (a ship made by init or the sample), the default format is included in the guidance and a nonexistent file is not made to be read", () => {
    const without = buildCommonAnnouncement(ctx);
    expect(without).not.toContain(path.join(root, "report-format.md"));
    expect(without).toContain("list_unreported_tasks");
    expect(without).toContain("Do not leave out cautions or risks");

    fs.writeFileSync(path.join(root, "report-format.md"), "format");
    const withFile = buildCommonAnnouncement(ctx);
    expect(withFile).toContain(`read ${path.join(root, "report-format.md")}`);
    expect(withFile).not.toContain("Do not leave out cautions or risks");
  });

  it("if there are no Skills, it says so", () => {
    expect(buildCommonAnnouncement(ctx)).toContain("(No skills are registered at the moment.)");
  });

  it("lists the directories under skills/ that have a skill.md, with name, absolute path, and description", () => {
    const file = skill(path.join(ctx.skillsDir, "weather"), fm("weather", "Check the weather"));
    skill(path.join(ctx.skillsDir, "broken"), "no frontmatter"); // invalid ones are not listed
    fs.mkdirSync(path.join(ctx.skillsDir, "empty")); // a directory without skill.md is not listed
    fs.writeFileSync(path.join(ctx.skillsDir, "loose-file.md"), "x"); // something that is not a directory is not listed

    const text = buildCommonAnnouncement(ctx);
    expect(text).toContain(`- weather (${file}): Check the weather`);
    expect(text).not.toContain("broken");
    expect(text).not.toContain("loose-file");
    expect(text).not.toContain("(No skills are registered at the moment.)");
  });

  it("explicitly given skills are placed after the ship's skills/. On a name clash, the one that comes first is preferred", () => {
    skill(path.join(ctx.skillsDir, "shared"), fm("shared", "the ship's"));
    const extra = skill(path.join(root, "extra", "mine"), fm("mine", "the personal one"));
    const dup = skill(path.join(root, "extra", "shared"), fm("shared", "the duplicate"));

    const text = buildCommonAnnouncement(ctx, [extra, dup]);
    expect(text).toContain("the ship's");
    expect(text).not.toContain("the duplicate");
    expect(text.indexOf("- shared")).toBeLessThan(text.indexOf("- mine"));
  });

  it("if the frontmatter of an explicitly given skill is invalid, it is excluded with a warning", () => {
    const bad = skill(path.join(root, "extra", "bad"), "no frontmatter");
    const text = buildCommonAnnouncement(ctx, [bad]);
    expect(text).not.toContain(bad);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("no valid frontmatter"));
  });

  it("for a remote, the content that points to local paths (workspace, report format, Skill list) is not included", () => {
    skill(path.join(ctx.skillsDir, "weather"), fm("weather", "Check the weather"));
    const text = buildCommonAnnouncement(ctx, [], { remote: true });
    expect(text).toContain("get_task");
    expect(text).not.toContain("workspace");
    expect(text).not.toContain("report-format");
    expect(text).not.toContain("weather");
    expect(text).not.toContain("Available skills");
  });
});

describe("buildDispatchNote", () => {
  const crew = {
    lead: { name: "Alex" },
    engineer: { name: "Sam" },
    ensign: { name: "Jo" },
  };

  it("includes how to use dispatch_task and the crew roster table excluding oneself", () => {
    const text = buildDispatchNote(crew, "lead");
    expect(text).toContain("dispatch_task");
    expect(text).toContain("| engineer | Sam |");
    expect(text).toContain("| ensign | Jo |");
    expect(text).not.toContain("| lead |");
  });

  it("no special-casing by role name: whoever receives it, only oneself is left off the roster table", () => {
    const text = buildDispatchNote(crew, "engineer");
    expect(text).toContain("| lead | Alex |");
    expect(text).not.toContain("| engineer |");
  });

  it("behavioral instructions such as \"delegate everything\" are not written (decided on the persona side)", () => {
    expect(buildDispatchNote(crew, "lead")).not.toMatch(/always delegate|most important/i);
  });
});
