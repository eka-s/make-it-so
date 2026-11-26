import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insideRoot, isRealDirectory, linkInPath, MAX_MEMORY_FILE_BYTES, readRegularFile, writeFileAtomic } from "./memory-files.js";

let root: string;
let outside: string;
beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "memory-files-"));
  root = path.join(base, "bundle");
  outside = path.join(base, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
});
afterEach(() => fs.rmSync(path.dirname(root), { recursive: true, force: true }));

describe("readRegularFile", () => {
  it("reads an ordinary file, and says when there is none", () => {
    fs.writeFileSync(path.join(root, "a.md"), "hello");
    expect(readRegularFile(path.join(root, "a.md"))).toMatchObject({ kind: "ok" });
    expect(readRegularFile(path.join(root, "none.md"))).toEqual({ kind: "missing" });
    expect(readRegularFile(path.join(root, "a.md", "b.md"))).toEqual({ kind: "missing" });
  });

  it("does not read a link, a hard link, a directory or a pipe", () => {
    fs.writeFileSync(path.join(outside, "victim.md"), "secret");
    fs.symlinkSync(path.join(outside, "victim.md"), path.join(root, "link.md"));
    fs.linkSync(path.join(outside, "victim.md"), path.join(root, "hard.md"));
    fs.mkdirSync(path.join(root, "dir.md"));
    execFileSync("mkfifo", [path.join(root, "pipe.md")]);
    for (const name of ["link.md", "hard.md", "dir.md", "pipe.md"]) expect(readRegularFile(path.join(root, name)), name).toEqual({ kind: "unsafe" });
  });

  it("does not read a file past the size cap", () => {
    const big = path.join(root, "big.md");
    fs.closeSync(fs.openSync(big, "w"));
    fs.truncateSync(big, MAX_MEMORY_FILE_BYTES + 1);
    expect(readRegularFile(big)).toEqual({ kind: "too-large", size: MAX_MEMORY_FILE_BYTES + 1 });
  });
});

describe("writeFileAtomic", () => {
  it("writes a new file, and replaces a link at the target instead of writing through it", () => {
    fs.writeFileSync(path.join(outside, "victim.md"), "keep");
    fs.symlinkSync(path.join(outside, "victim.md"), path.join(root, "a.md"));
    writeFileAtomic(root, path.join(root, "a.md"), "new");
    expect(fs.readFileSync(path.join(outside, "victim.md"), "utf-8")).toBe("keep");
    expect(fs.lstatSync(path.join(root, "a.md")).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(root, "a.md"), "utf-8")).toBe("new");
  });

  it("leaves nothing behind when it fails, and refuses a directory that is outside the bundle", () => {
    fs.symlinkSync(outside, path.join(root, "swapped"));
    expect(() => writeFileAtomic(root, path.join(root, "swapped", "a.md"), "x")).toThrow("outside the Memory");
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(() => writeFileAtomic(root, path.join(root, "missing-dir", "a.md"), "x")).toThrow();
  });
});

describe("linkInPath and isRealDirectory", () => {
  it("finds a link along a path, and tells a directory from a link to one", () => {
    fs.mkdirSync(path.join(root, "real"));
    fs.symlinkSync(outside, path.join(root, "link"));
    expect(linkInPath(root, "real/a.md")).toBe(false);
    expect(linkInPath(root, "link/a.md")).toBe(true);
    expect(linkInPath(root, "nothing/yet.md")).toBe(false);
    expect(isRealDirectory(path.join(root, "real"))).toBe(true);
    expect(isRealDirectory(path.join(root, "link"))).toBe(false);
    expect(isRealDirectory(path.join(root, "none"))).toBe(false);
  });
});

describe("insideRoot", () => {
  it("tells a file in the bundle from one that a link leads out of", () => {
    fs.mkdirSync(path.join(root, "real"));
    fs.symlinkSync(outside, path.join(root, "link"));
    expect(insideRoot(root, path.join(root, "real", "a.md"))).toBe(true);
    expect(insideRoot(root, path.join(root, "link", "a.md"))).toBe(false);
    expect(insideRoot(root, path.join(root, "none", "a.md"))).toBe(false);
  });

});
