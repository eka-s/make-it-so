import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse, parseDocument, type Document } from "yaml";
import { deleteValue, editYamlFile, setValue, YamlUnreadableError } from "./yaml-edit.js";

let tmp: string;
let file: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mis-yaml-"));
  file = path.join(tmp, "dir", "config.yml");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function seed(text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

describe("editYamlFile", () => {
  it("keeps comments, key order and unknown keys; only the edited value changes", () => {
    seed("# top comment\nlanguage: en   # the UI language\nmystery:\n  keep: me\nlogging:\n  level: info\n");
    editYamlFile(file, (doc) => setValue(doc, ["language"], "ja"));
    const text = fs.readFileSync(file, "utf-8");
    expect(text).toContain("# top comment");
    expect(text).toContain("language: ja # the UI language");
    expect(parse(text)).toEqual({ language: "ja", mystery: { keep: "me" }, logging: { level: "info" } });
  });

  it("creates the file (and its directory) when there is none, and there is then no backup", () => {
    editYamlFile(file, (doc) => setValue(doc, ["acp", "provider"], "kiro"));
    expect(parse(fs.readFileSync(file, "utf-8"))).toEqual({ acp: { provider: "kiro" } });
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });

  it("keeps the previous file as .bak, and leaves no temporary file", () => {
    seed("language: en\n");
    editYamlFile(file, (doc) => setValue(doc, ["language"], "ja"));
    expect(fs.readFileSync(`${file}.bak`, "utf-8")).toBe("language: en\n");
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it("writes a list inline, and removes a key together with the parents it leaves empty", () => {
    seed("acp:\n  claude:\n    command: foo\n");
    editYamlFile(file, (doc) => setValue(doc, ["acp", "kiro", "args"], ["acp", "--x"]));
    expect(fs.readFileSync(file, "utf-8")).toContain('args: [ acp, --x ]');
    editYamlFile(file, (doc) => { deleteValue(doc, ["acp", "kiro", "args"]); deleteValue(doc, ["acp", "claude", "command"]); });
    expect(fs.readFileSync(file, "utf-8").trim()).toBe("{}");
  });

  it("does not remove a parent that still has other keys", () => {
    seed("acp:\n  provider: claude\n  claude:\n    command: foo\n");
    editYamlFile(file, (doc) => deleteValue(doc, ["acp", "claude", "command"]));
    expect(parse(fs.readFileSync(file, "utf-8"))).toEqual({ acp: { provider: "claude" } });
  });

  it("a broken file is never overwritten", () => {
    seed("language: [unclosed\n");
    expect(() => editYamlFile(file, (doc) => setValue(doc, ["language"], "ja"))).toThrow(YamlUnreadableError);
    expect(fs.readFileSync(file, "utf-8")).toBe("language: [unclosed\n");
  });
});

describe("setValue through an empty parent key", () => {
  const edit = (text: string, run: (doc: Document) => void): string => {
    const doc = parseDocument(text) as Document;
    run(doc);
    return doc.toString();
  };

  it("a `crew:` with nothing under it becomes a map, keeping the comments around it", () => {
    const out = edit("# my roster\ncrew:\n  # alex:\n  #   name: Alex\n", (doc) => setValue(doc, ["crew", "sam", "name"], "Sam"));
    expect(out).toContain("# my roster");
    expect(parse(out)).toEqual({ crew: { sam: { name: "Sam" } } });
  });

  it("a key that is only a null (`hosts:`) and a nested empty path both work", () => {
    expect(parse(edit("hosts:\n", (doc) => setValue(doc, ["hosts", "dock", "destination"], "dock")))).toEqual({ hosts: { dock: { destination: "dock" } } });
    expect(parse(edit("a:\n  b:\n", (doc) => setValue(doc, ["a", "b", "c"], 1)))).toEqual({ a: { b: { c: 1 } } });
  });

  it("a parent that holds a real value is not overwritten", () => {
    expect(() => edit("crew: text\n", (doc) => setValue(doc, ["crew", "sam", "name"], "Sam"))).toThrow();
  });
});

describe("keys that YAML reads as numbers (hand-written)", () => {
  const edit = (text: string, run: (doc: Document) => void): string => {
    const doc = parseDocument(text) as Document;
    run(doc);
    return doc.toString();
  };

  it("an existing key `42` is edited in place, not duplicated beside a new string key", () => {
    const out = edit("crew:\n  42:\n    name: X\n    model: m1\n", (doc) => setValue(doc, ["crew", "42", "name"], "Y"));
    expect(parse(out)).toEqual({ crew: { 42: { name: "Y", model: "m1" } } });
    expect(out.match(/name:/g)).toHaveLength(1);
  });

  it("deleting under it works on the same entry", () => {
    const out = edit("crew:\n  42:\n    name: X\n    model: m1\n", (doc) => deleteValue(doc, ["crew", "42", "model"]));
    expect(parse(out)).toEqual({ crew: { 42: { name: "X" } } });
  });

  it("adding a new member next to it leaves it alone", () => {
    const out = edit("crew:\n  42:\n    name: X\n", (doc) => setValue(doc, ["crew", "sam", "name"], "Sam"));
    expect(parse(out)).toEqual({ crew: { 42: { name: "X" }, sam: { name: "Sam" } } });
  });
});
