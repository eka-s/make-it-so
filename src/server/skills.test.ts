import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCommonAnnouncement, buildDispatchNote, loadAnnouncedSkills, parseFrontmatter, type SkillsContext } from "./skills.js";

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

  it("always lists the built-in skills, which are read with get_skill, since they have no file", () => {
    expect(buildCommonAnnouncement(ctx)).toMatch(/- memory \(read it with the `get_skill` tool\): /);
  });

  it("a skill of the ship cannot take the name of a built-in one", () => {
    skill(path.join(ctx.skillsDir, "memory"), fm("memory", "Mine"));
    expect(buildCommonAnnouncement(ctx)).not.toContain("Mine");
    expect(loadAnnouncedSkills(ctx, []).read("memory")).toContain("The ship's Memory");
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

  it("for a remote, the workspace and the report format are left out, and the Skills are listed by name only, to be read with get_skill", () => {
    const file = skill(path.join(ctx.skillsDir, "weather"), fm("weather", "Check the weather"));
    const text = buildCommonAnnouncement(ctx, [], { remote: true });
    expect(text).toContain("get_task");
    expect(text).not.toContain("workspace");
    expect(text).not.toContain("report-format");
    expect(text).toContain("- weather: Check the weather");
    expect(text).toContain("get_skill");
    expect(text).toContain("files it mentions beside it are not available");
    expect(text).not.toContain(file);
  });

  it("for a remote without skills of its own, the built-in ones are still announced, to be read with get_skill", () => {
    const text = buildCommonAnnouncement(ctx, [], { remote: true });
    expect(text).toContain("Available skills");
    expect(text).toMatch(/- memory: /);
    expect(text).toContain("get_skill");
  });
});

describe("loadAnnouncedSkills", () => {
  it("returns the body without the frontmatter", () => {
    skill(path.join(ctx.skillsDir, "weather"), "---\nname: weather\ndescription: Check the weather\n---\n# Weather\n\nLook outside.\n");
    expect(loadAnnouncedSkills(ctx, []).read("weather")).toBe("# Weather\n\nLook outside.");
  });

  it("strips the frontmatter of a file with CRLF line endings, and keeps a --- line inside the body", () => {
    skill(path.join(ctx.skillsDir, "crlf"), "---\r\nname: crlf\r\ndescription: d\r\n---\r\nfirst\r\n---\r\nsecond\r\n");
    expect(loadAnnouncedSkills(ctx, []).read("crlf")).toBe("first\r\n---\r\nsecond");
  });

  it("reads the explicitly given skills too, and the ship's skills/ wins on a name clash", () => {
    skill(path.join(ctx.skillsDir, "shared"), "---\nname: shared\ndescription: d\n---\nthe ship's\n");
    const mine = skill(path.join(root, "extra", "mine"), fm("mine", "personal"));
    const dup = skill(path.join(root, "extra", "shared"), "---\nname: shared\ndescription: d\n---\nthe duplicate\n");
    const skills = loadAnnouncedSkills(ctx, [mine, dup]);
    expect(skills.read("shared")).toBe("the ship's");
    expect(skills.read("mine")).toBe("body");
  });

  it("returns undefined for a skill that is not announced (it cannot be used to read other files)", () => {
    skill(path.join(ctx.skillsDir, "weather"), fm("weather", "d"));
    const skills = loadAnnouncedSkills(ctx, []);
    expect(skills.read("other")).toBeUndefined();
    expect(skills.read("../../etc/passwd")).toBeUndefined();
  });

  it("lists the names that are announced", () => {
    skill(path.join(ctx.skillsDir, "a"), fm("a", "d"));
    skill(path.join(ctx.skillsDir, "b"), fm("b", "d"));
    expect(loadAnnouncedSkills(ctx, []).names.sort()).toEqual(["a", "b", "memory"]);
  });

  it("a skill whose name YAML reads as a number is announced and can be read by that name", () => {
    skill(path.join(ctx.skillsDir, "n"), "---\nname: 123\ndescription: d\n---\nnumbered\n");
    const skills = loadAnnouncedSkills(ctx, []);
    expect(skills.names).toEqual(["memory", "123"]);
    expect(skills.read("123")).toBe("numbered");
  });

  it("a file that is gone after it was announced reads as not found, and its path is not thrown to the caller", () => {
    const file = skill(path.join(ctx.skillsDir, "gone"), fm("gone", "d"));
    const skills = loadAnnouncedSkills(ctx, []);
    fs.rmSync(file);
    expect(skills.read("gone")).toBeUndefined();
  });

  it("an explicitly given file that is gone is left out with a warning instead of failing for the others", () => {
    const keep = skill(path.join(root, "extra", "keep"), fm("keep", "d"));
    const gone = skill(path.join(root, "extra", "gone"), fm("gone", "d"));
    fs.rmSync(gone);
    expect(loadAnnouncedSkills(ctx, [gone, keep]).names).toEqual(["memory", "keep"]);
    expect(buildCommonAnnouncement(ctx, [gone, keep], { remote: true })).toContain("- keep: d");
    expect(console.warn).toHaveBeenCalled();
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
