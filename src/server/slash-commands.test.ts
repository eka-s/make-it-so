import { describe, expect, it } from "vitest";
import { isSlashCommand, parseAvailableCommands, parseStoredCommands } from "./slash-commands.js";

describe("parseAvailableCommands", () => {
  it("reads the name, description, and argument hint (omitted if there is no hint)", () => {
    expect(
      parseAvailableCommands([
        { name: "context", description: "Show context usage", input: null },
        { name: "loop", description: "Run on an interval", input: { hint: "[interval] [prompt]" } },
      ]),
    ).toEqual([
      { name: "context", description: "Show context usage" },
      { name: "loop", description: "Run on an interval", hint: "[interval] [prompt]" },
    ]);
  });

  it("drops entries with the wrong shape, no name, or duplicates. Empty if not an array", () => {
    expect(parseAvailableCommands([null, 3, { description: "x" }, { name: "" }, { name: "a" }, { name: "a" }])).toEqual([
      { name: "a", description: "" },
    ]);
    expect(parseAvailableCommands(undefined)).toEqual([]);
    expect(parseAvailableCommands({})).toEqual([]);
  });
});

describe("parseStoredCommands", () => {
  it("reads back the saved shape (name, description, hint) as is. Drops entries with the wrong shape and duplicates", () => {
    expect(
      parseStoredCommands([
        { name: "loop", description: "l", hint: "[x]" },
        { name: "context", description: "c" },
        { name: "context", description: "dup" },
        { name: "" },
        null,
        { description: "no name" },
      ]),
    ).toEqual([
      { name: "loop", description: "l", hint: "[x]" },
      { name: "context", description: "c" },
    ]);
    expect(parseStoredCommands("x")).toEqual([]);
  });
});

describe("isSlashCommand", () => {
  const commands = [
    { name: "context", description: "" },
    { name: "plugin:run", description: "" },
  ];

  it("if it starts with /name that is in the list and what follows is whitespace or the end of the text, it is a command", () => {
    expect(isSlashCommand("/context", commands)).toBe(true);
    expect(isSlashCommand("/context now", commands)).toBe(true);
    expect(isSlashCommand("/context\nmore", commands)).toBe(true);
    expect(isSlashCommand("/plugin:run arg", commands)).toBe(true);
  });

  it("a text starting with / that is not in the list (a path etc.), a / in the middle, or a prefix match of a name is an ordinary sentence", () => {
    expect(isSlashCommand("/usr/bin/ls please", commands)).toBe(false);
    expect(isSlashCommand("/unknown", commands)).toBe(false);
    expect(isSlashCommand("/contextual", commands)).toBe(false);
    expect(isSlashCommand("see /context", commands)).toBe(false);
    expect(isSlashCommand(" /context", commands)).toBe(false);
    expect(isSlashCommand("/", commands)).toBe(false);
  });

  it("if the list is empty, nothing is a command", () => {
    expect(isSlashCommand("/context", [])).toBe(false);
  });
});
