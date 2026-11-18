import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirPrivate, restrictToOwner } from "./private-dirs.js";
import { editYamlFile } from "./settings/yaml-edit.js";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mis-priv-")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
const mode = (p: string) => fs.statSync(p).mode & 0o777;

// File modes mean nothing on Windows.
describe.skipIf(process.platform === "win32")("directories for the owner only", () => {
  it("mkdirPrivate creates the directory and its parents with mode 0700", () => {
    const dir = path.join(tmp, "a", "b");
    mkdirPrivate(dir);
    expect(mode(dir)).toBe(0o700);
    expect(mode(path.join(tmp, "a"))).toBe(0o700);
  });

  it("restrictToOwner tightens an existing directory, and ignores one that does not exist", () => {
    const dir = path.join(tmp, "open");
    fs.mkdirSync(dir, { mode: 0o775 });
    fs.chmodSync(dir, 0o775);
    restrictToOwner(dir);
    expect(mode(dir)).toBe(0o700);
    expect(() => restrictToOwner(path.join(tmp, "none"))).not.toThrow();
  });
});

describe("editing a YAML file that is a symlink", () => {
  it("changes the real file and keeps the link", () => {
    const real = path.join(tmp, "dotfiles", "roster.yml");
    fs.mkdirSync(path.dirname(real));
    fs.writeFileSync(real, "crew: {}\n");
    const link = path.join(tmp, "roster.yml");
    fs.symlinkSync(real, link);
    editYamlFile(link, (doc) => doc.setIn(["crew", "a"], doc.createNode({ name: "A" })));
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, "utf-8")).toContain("name: A");
  });

  it("keeps the mode of the file it replaces", () => {
    const file = path.join(tmp, "config.yml");
    fs.writeFileSync(file, "a: 1\n", { mode: 0o600 });
    editYamlFile(file, (doc) => doc.setIn(["a"], 2));
    if (process.platform !== "win32") expect(mode(file)).toBe(0o600);
  });
});
