import { describe, expect, it } from "vitest";
import { completeSlash, filterSlashCommands, slashMenuMode, slashQuery } from "./slash-menu";

const cmd = (name: string) => ({ name, description: "" });

describe("slashQuery", () => {
  it("if what is before the cursor is a leading / + a string with no whitespace, returns that search term", () => {
    expect(slashQuery("/", 1)).toBe("");
    expect(slashQuery("/con", 4)).toBe("con");
    expect(slashQuery("/context", 3)).toBe("co"); // the search term runs up to the cursor
  });

  it("if it does not start with /, contains whitespace (arguments started), or is multi-line, a command is not being typed", () => {
    expect(slashQuery("hello /con", 10)).toBeNull();
    expect(slashQuery("/context now", 12)).toBeNull();
    expect(slashQuery("/a\nb", 4)).toBeNull();
    expect(slashQuery(" /con", 5)).toBeNull();
    expect(slashQuery("", 0)).toBeNull();
  });

  it("if the cursor is before whitespace, what is after the whitespace is not looked at", () => {
    expect(slashQuery("/con now", 4)).toBe("con");
  });
});

describe("filterSlashCommands", () => {
  const all = [cmd("code-review"), cmd("context"), cmd("compact"), cmd("recontext")];

  it("if the search term is empty, everything as is", () => {
    expect(filterSlashCommands(all, "")).toEqual(all);
  });

  it("prefix matches on the name first, then partial matches. Case-insensitive", () => {
    expect(filterSlashCommands(all, "CON").map((c) => c.name)).toEqual(["context", "recontext"]);
    expect(filterSlashCommands(all, "co").map((c) => c.name)).toEqual(["code-review", "context", "compact", "recontext"]);
  });

  it("empty if nothing matches", () => {
    expect(filterSlashCommands(all, "zzz")).toEqual([]);
  });
});

describe("completeSlash", () => {
  it("replaces the search term with /name + whitespace and puts the cursor after it", () => {
    expect(completeSlash("/con", 4, "context")).toEqual({ text: "/context ", cursor: 9 });
  });

  it("keeps what remains after the cursor. If what follows starts with whitespace, no extra space is added", () => {
    expect(completeSlash("/co rest", 3, "context")).toEqual({ text: "/context rest", cursor: 9 });
    expect(completeSlash("/corest", 3, "context")).toEqual({ text: "/context rest", cursor: 9 });
  });
});

describe("slashMenuMode", () => {
  it("while a command is being typed and there are matching candidates, show the candidates (even the cache from before startup)", () => {
    expect(slashMenuMode("con", false, 3, true)).toBe("candidates");
    expect(slashMenuMode("con", false, 3, false)).toBe("candidates");
  });

  it("if there are no candidates and the partner has not started yet, show guidance. If already started (a path etc.), show nothing", () => {
    expect(slashMenuMode("", false, 0, false)).toBe("not-started");
    expect(slashMenuMode("usr/bin", false, 0, true)).toBe("none");
  });

  it("when not typing a command, or closed with Esc, show nothing", () => {
    expect(slashMenuMode(null, false, 3, false)).toBe("none");
    expect(slashMenuMode("con", true, 3, false)).toBe("none");
    expect(slashMenuMode("", true, 0, false)).toBe("none");
  });
});
