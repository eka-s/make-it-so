import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIVITY_KEPT, OPERATIONS_KEPT, OUTPUT_KEPT_CHARS, TITLE_KEPT_CHARS, createActivityLog } from "./activity-log.js";

let dir: string;
beforeEach(() => { dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mis-activity-")), "activity"); });
afterEach(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));

describe("recording and reading", () => {
  it("what was recorded comes back as operations with their output (the output arrives in pieces)", () => {
    const log = createActivityLog({ dir });
    log.recordCall("turn-1", "Bash: ls");
    log.recordOutput("turn-1", "total 8\n");
    log.recordOutput("turn-1", "file.txt");
    log.recordCall("turn-1", "Read: README.md");
    const entry = log.read("turn-1")!;
    expect(entry.operations).toEqual([{ title: "Bash: ls", output: "total 8\nfile.txt" }, { title: "Read: README.md", output: "" }]);
    expect(entry.isActive).toBe(false);
    expect(entry.id).toBe("turn-1");
  });

  it("nothing recorded is undefined, and so is an output with no operation before it", () => {
    const log = createActivityLog({ dir });
    expect(log.read("nope")).toBeUndefined();
    log.recordOutput("late", "text");
    expect(log.read("late")).toBeUndefined();
  });

  it("an output beyond the limit is cut and marked, and the titles are all kept", () => {
    const log = createActivityLog({ dir });
    log.recordCall("t", "Bash: big");
    log.recordOutput("t", "x".repeat(OUTPUT_KEPT_CHARS - 10));
    log.recordOutput("t", "y".repeat(500));
    log.recordOutput("t", "z".repeat(500)); // past the limit: not written
    const [op] = log.read("t")!.operations;
    expect(op.output).toBe(`${"x".repeat(OUTPUT_KEPT_CHARS - 10)}${"y".repeat(10)}…`);
  });

  it("the limit is per operation: the next operation gets its own room", () => {
    const log = createActivityLog({ dir });
    log.recordCall("t", "a");
    log.recordOutput("t", "x".repeat(OUTPUT_KEPT_CHARS + 100));
    log.recordCall("t", "b");
    log.recordOutput("t", "second");
    expect(log.read("t")!.operations[1].output).toBe("second");
  });

  it("a half-written last line (the server stopped while writing) is skipped, not an error", () => {
    const log = createActivityLog({ dir });
    log.recordCall("t", "ok");
    fs.appendFileSync(path.join(dir, "t.jsonl"), '{"k":"call","t":"x","tit');
    expect(log.read("t")!.operations.map((o) => o.title)).toEqual(["ok"]);
  });

  it("an id that is not safe as a file name is not recorded and not read", () => {
    const log = createActivityLog({ dir });
    log.recordCall("../escape", "x");
    log.recordCall("a/b", "x");
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
    expect(log.read("../escape")).toBeUndefined();
  });
});

describe("limits and odd input", () => {
  it("an output of exactly the limit is not marked as cut, and one beyond it is", () => {
    const log = createActivityLog({ dir });
    log.recordCall("a", "x");
    log.recordOutput("a", "y".repeat(OUTPUT_KEPT_CHARS));
    expect(log.read("a")!.operations[0].output).toBe("y".repeat(OUTPUT_KEPT_CHARS));
    log.recordCall("b", "x");
    log.recordOutput("b", "y".repeat(OUTPUT_KEPT_CHARS + 1));
    expect(log.read("b")!.operations[0].output).toBe(`${"y".repeat(OUTPUT_KEPT_CHARS)}…`);
  });

  it("a cut never splits a surrogate pair", () => {
    const log = createActivityLog({ dir });
    log.recordCall("a", "x");
    log.recordOutput("a", `${"y".repeat(OUTPUT_KEPT_CHARS - 1)}😀tail`);
    expect(log.read("a")!.operations[0].output).toBe(`${"y".repeat(OUTPUT_KEPT_CHARS - 1)}…`);
  });

  it("a long title is cut, and a title that is not a string is recorded as text (so its output stays with it)", () => {
    const log = createActivityLog({ dir });
    log.recordCall("a", "t".repeat(TITLE_KEPT_CHARS + 50));
    log.recordCall("a", 42 as unknown as string);
    log.recordOutput("a", "out");
    const [first, second] = log.read("a")!.operations;
    expect(first.title).toBe(`${"t".repeat(TITLE_KEPT_CHARS)}…`);
    expect(second).toEqual({ title: "42", output: "out" });
  });

  it("operations beyond the limit are not recorded, and neither is their output", () => {
    const log = createActivityLog({ dir });
    for (let i = 0; i < OPERATIONS_KEPT + 5; i++) {
      log.recordCall("a", `op ${i}`);
      log.recordOutput("a", "o");
    }
    const ops = log.read("a")!.operations;
    expect(ops).toHaveLength(OPERATIONS_KEPT);
    expect(ops.at(-1)).toEqual({ title: `op ${OPERATIONS_KEPT - 1}`, output: "o" });
  });

  it("tells the listener after each change", () => {
    const changed: string[] = [];
    const log = createActivityLog({ dir, onChange: (id) => changed.push(id) });
    log.recordCall("a", "x");
    log.recordOutput("a", "o");
    expect(changed).toEqual(["a", "a"]);
  });
});

describe("keeping only the recent ones", () => {
  it("never removes the file of an item that is still being written, however old it is", () => {
    const log = createActivityLog({ dir, keep: 2 });
    log.recordCall("running", "x"); // not finished
    const old = new Date(Date.UTC(2020, 0, 1));
    fs.utimesSync(path.join(dir, "running.jsonl"), old, old);
    for (const id of ["a", "b", "c"]) { log.recordCall(id, "x"); log.finish(id); }
    expect(fs.existsSync(path.join(dir, "running.jsonl"))).toBe(true);
  });

  it("removes the oldest files beyond the limit when a new one is started", () => {
    let tick = 0;
    const log = createActivityLog({ dir, keep: 3 });
    for (const id of ["a", "b", "c", "d", "e"]) {
      log.recordCall(id, `op ${id}`);
      log.finish(id);
      const t = new Date(Date.UTC(2026, 0, 1, 0, 0, ++tick));
      fs.utimesSync(path.join(dir, `${id}.jsonl`), t, t); // distinct modification times, oldest first
    }
    log.recordCall("f", "op f"); // a new file, still being written: the 3 newest finished ones are kept besides it
    expect(fs.readdirSync(dir).sort()).toEqual(["c.jsonl", "d.jsonl", "e.jsonl", "f.jsonl"]);
  });

  it("the default limit is 50 items", () => {
    expect(ACTIVITY_KEPT).toBe(50);
  });
});

describe("the directory", () => {
  it("is private to the owner", () => {
    if (process.platform === "win32") return;
    const log = createActivityLog({ dir });
    log.recordCall("t", "x");
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("a directory that cannot be written is not an error for the work (nothing is recorded)", () => {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, "a file where the directory should be");
    const log = createActivityLog({ dir });
    expect(() => log.recordCall("t", "x")).not.toThrow();
    expect(log.read("t")).toBeUndefined();
  });
});
