import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearFileStream, openFileStream, readFileStream } from "./file-stream.js";
import { createTurnStreams } from "./turn-stream.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-stream-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("file-stream", () => {
  it("appended in the order written, and the full text can be read after finish() resolves (a nonexistent parent directory is created too)", async () => {
    const file = path.join(dir, "deep", "a.md");
    const stream = openFileStream(file);
    for (const chunk of ["one", "two", "three"]) stream.write(chunk);
    await stream.finish();
    expect(await readFileStream(file)).toBe("onetwothree");
  });

  it("leaving the `await using` block flushes automatically", async () => {
    const file = path.join(dir, "a.md");
    {
      await using stream = openFileStream(file);
      stream.write("body");
    }
    expect(await readFileStream(file)).toBe("body");
  });

  it("reopening the same path truncates the previous content (for retries)", async () => {
    const file = path.join(dir, "a.md");
    const first = openFileStream(file);
    first.write("previous attempt");
    await first.finish();
    const second = openFileStream(file);
    second.write("next");
    await second.finish();
    expect(await readFileStream(file)).toBe("next");
  });

  it("an empty string if there is no file. Other read errors are not swallowed but thrown", async () => {
    expect(await readFileStream(path.join(dir, "none.md"))).toBe("");
    // Try to read a directory instead of a file (EISDIR)
    await expect(readFileStream(dir)).rejects.toThrow();
  });

  it("clear removes it. Clearing a nonexistent file does not fail", async () => {
    const file = path.join(dir, "a.md");
    const stream = openFileStream(file);
    stream.write("x");
    await stream.finish();
    await clearFileStream(file);
    expect(fs.existsSync(file)).toBe(false);
    await expect(clearFileStream(file)).resolves.toBeUndefined();
  });
});

describe("turn-stream", () => {
  it("writes, reads, and deletes `{turnsDir}/{turnId}.md` per turn id. Turns do not mix", async () => {
    const turns = createTurnStreams(path.join(dir, "turns"));
    const a = turns.open("t1");
    const b = turns.open("t2");
    a.write("A");
    b.write("B");
    await Promise.all([a.finish(), b.finish()]);
    expect(await turns.read("t1")).toBe("A");
    expect(await turns.read("t2")).toBe("B");
    expect(fs.existsSync(path.join(dir, "turns", "t1.md"))).toBe(true);
    await turns.clear("t1");
    expect(await turns.read("t1")).toBe("");
    expect(await turns.read("t2")).toBe("B");
  });
});
