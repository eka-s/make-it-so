import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore, MemoryError, type MemoryWriteInput } from "./memory-store.js";
import { migrate } from "./migrations.js";

let root: string;
let db: DatabaseSync;

function makeStore(extra: { onChange?: () => void } = {}) {
  return createMemoryStore({ dir: path.join(root, "knowledge"), db, shipName: "Test Ship", producer: "make-it-so/0.0.0", ...extra });
}

function input(over: Partial<MemoryWriteInput> = {}): MemoryWriteInput {
  return { path: "procedures/deploy.md", title: "Deploy", description: "Check this before a release", body: "Run the checks.\n", message: "Add the deploy procedure", crew: "Alex", ...over };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-"));
  db = new DatabaseSync(":memory:");
  migrate(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("write", () => {
  it("creates the bundle on the first write, with an index.md that lists the memo", async () => {
    const store = makeStore();
    const result = await store.write(input());
    expect(result).toMatchObject({ path: "procedures/deploy.md", created: true, warnings: [] });
    const rootIndex = fs.readFileSync(path.join(root, "knowledge", "index.md"), "utf-8");
    expect(rootIndex).toContain('okf_version: "0.3"');
    expect(rootIndex).toContain("[procedures/](procedures/index.md): 1 concept");
    const dirIndex = fs.readFileSync(path.join(root, "knowledge", "procedures", "index.md"), "utf-8");
    expect(dirIndex).toContain("## Concepts");
    expect(dirIndex).toContain("[Deploy](deploy.md): Check this before a release");
  });

  it("records every change as one commit with the crew member as its author", async () => {
    const store = makeStore();
    await store.write(input());
    const history = await store.history({});
    expect(history[0]).toMatchObject({ message: "Add the deploy procedure", author: "Alex" });
    expect(history.map((h) => h.message)).toContain("Create the memory bundle");
  });

  it("writes the fixed type for a new memo, and keeps the type of a file written by hand when it is updated", async () => {
    const store = makeStore();
    const file = path.join(root, "knowledge", "a.md");
    await store.write(input({ path: "a.md" }));
    expect(fs.readFileSync(file, "utf-8")).toContain("type: note");
    fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace("type: note", "type: Playbook"));
    await store.write(input({ path: "a.md", body: "new", base: store.read("a.md")!.version }));
    expect(fs.readFileSync(file, "utf-8")).toContain("type: Playbook");
  });

  it("refuses a missing description or message, and a bad path", async () => {
    const store = makeStore();
    await expect(store.write(input({ description: "" }))).rejects.toMatchObject({ code: "invalid" });
    await expect(store.write(input({ message: "" }))).rejects.toMatchObject({ code: "invalid" });
    for (const bad of ["../x.md", "/x.md", "a/.hidden.md", "index.md", "a/log.md", "x.txt", "a//b.md"]) {
      await expect(store.write(input({ path: bad }))).rejects.toBeInstanceOf(MemoryError);
    }
  });

  it("requires the version that was read to update an existing memo, and refuses a stale one with the current text", async () => {
    const store = makeStore();
    const first = await store.write(input());
    await expect(store.write(input({ body: "again" }))).rejects.toMatchObject({ code: "conflict" });
    const second = await store.write(input({ body: "second", base: first.version }));
    expect(second.created).toBe(false);
    await expect(store.write(input({ body: "third", base: first.version }))).rejects.toMatchObject({ code: "conflict", current: { body: "second" } });
  });

  it("keeps the keys it does not know (a hand-written `tags` among them), and the status when they are left out of an update", async () => {
    const store = makeStore();
    const file = path.join(root, "knowledge", "a.md");
    await store.write(input({ path: "a.md", status: "draft" }));
    fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace("---\n", "---\nsources:\n  - https://example.com\ntags:\n  - x\n"));
    const current = store.read("a.md")!;
    await store.write(input({ path: "a.md", body: "new", base: current.version }));
    const after = fs.readFileSync(file, "utf-8");
    expect(after).toContain("sources:");
    expect(after).toContain("status: draft");
    expect(after).toContain("- x");
  });

  it("refuses a path that differs from an existing one only by letter case", async () => {
    const store = makeStore();
    await store.write(input({ path: "Notes.md" }));
    await expect(store.write(input({ path: "notes.md" }))).rejects.toMatchObject({ code: "invalid" });
  });

  it("succeeds with a warning for a body over 1 MB", async () => {
    const store = makeStore();
    const result = await store.write(input({ body: "x".repeat(1024 * 1024 + 10) }));
    expect(result.warnings.join(" ")).toContain("1 MB");
  });

  it("applies writes made at the same time one after the other", async () => {
    const store = makeStore();
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => store.write(input({ path: `n/${i}.md`, title: `Note ${i}` }))));
    expect(results.every((r) => r.created)).toBe(true);
    expect((await store.history({ limit: 50 })).length).toBe(6);
    expect(store.browse("n").docs).toHaveLength(5);
  });

  it("tells the viewer that the bundle changed", async () => {
    const onChange = vi.fn();
    await makeStore({ onChange }).write(input());
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("deprecate and remove", () => {
  it("marks a memo deprecated, keeps it in the index.md with what replaces it, and records it", async () => {
    const store = makeStore();
    await store.write(input());
    await store.write(input({ path: "procedures/deploy-v2.md", title: "Deploy v2" }));
    await store.deprecate({ path: "procedures/deploy.md", supersededBy: "/procedures/deploy-v2.md", message: "Replaced by v2", crew: "Alex" });
    expect(store.read("procedures/deploy.md")).toMatchObject({ status: "deprecated", supersededBy: "/procedures/deploy-v2.md" });
    const dirIndex = fs.readFileSync(path.join(root, "knowledge", "procedures", "index.md"), "utf-8");
    expect(dirIndex).toContain("deprecated; superseded by");
    expect((await store.history({ path: "procedures/deploy.md" }))[0].message).toBe("Replaced by v2");
  });

  it("deletes a memo, removes the index.md of a directory that became empty, and keeps the history", async () => {
    const store = makeStore();
    await store.write(input());
    await store.remove({ path: "procedures/deploy.md", message: "No longer true", crew: "Alex" });
    expect(store.read("procedures/deploy.md")).toBeUndefined();
    expect(fs.existsSync(path.join(root, "knowledge", "procedures"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "knowledge", "index.md"), "utf-8")).not.toContain("procedures/");
    const history = await store.history({ path: "procedures/deploy.md", diff: true });
    expect(history.map((h) => h.message)).toEqual(["No longer true", "Add the deploy procedure"]);
    expect(history[0].diff).toContain("-Run the checks.");
  });

  it("says when there is no such memo", async () => {
    const store = makeStore();
    await store.write(input());
    await expect(store.remove({ path: "nope.md", message: "x", crew: "Alex" })).rejects.toMatchObject({ code: "not_found" });
    await expect(store.deprecate({ path: "nope.md", message: "x", crew: "Alex" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("search and browse", () => {
  async function fill(store: ReturnType<typeof makeStore>) {
    await store.write(input({ path: "ops/deploy.md", title: "Deploy", description: "Release steps", body: "Run the smoke tests before release." }));
    await store.write(input({ path: "ops/日本語.md", title: "デプロイの手順", description: "本番へ出す前の確認", body: "本番環境を確認する", status: "draft" }));
    await store.write(input({ path: "top.md", title: "Use SQLite", description: "Why SQLite", body: "Local first." }));
  }

  it("finds words of three characters or more in the body, and shorter ones too", async () => {
    const store = makeStore();
    await fill(store);
    expect(store.search({ query: "smoke" }).items.map((i) => i.path)).toEqual(["ops/deploy.md"]);
    expect(store.search({ query: "デプロイ" }).items.map((i) => i.path)).toEqual(["ops/日本語.md"]);
    expect(store.search({ query: "本番" }).items.map((i) => i.path)).toEqual(["ops/日本語.md"]);
    expect(store.search({ query: "SQLite local" }).items.map((i) => i.path)).toEqual(["top.md"]);
  });

  it("filters by status and path, and pages", async () => {
    const store = makeStore();
    await fill(store);
    expect(store.search({ statuses: ["draft"] }).items.map((i) => i.path)).toEqual(["ops/日本語.md"]);
    expect(store.search({ pathPrefix: "/ops" }).total).toBe(2);
    expect(store.search({ limit: 1, offset: 1 })).toMatchObject({ total: 3, items: [{ path: "ops/日本語.md" }] });
  });

  it("treats the characters of a query as text, not as search syntax or wildcards", async () => {
    const store = makeStore();
    await fill(store);
    expect(store.search({ query: '"smoke" OR *' }).items).toEqual([]);
    expect(store.search({ query: "%" }).items).toEqual([]);
  });

  it("lists one directory: its subdirectories with counts, and its memos, with the statuses that are asked for", async () => {
    const store = makeStore();
    await fill(store);
    expect(store.browse("")).toMatchObject({ dirs: [{ name: "ops", path: "ops", count: 2 }], docs: [{ path: "top.md" }] });
    expect(store.browse("ops").docs.map((d) => d.path)).toHaveLength(2);
    expect(store.browse("", ["stable"]).dirs).toEqual([{ name: "ops", path: "ops", count: 1 }]);
    expect(() => store.browse("../x")).toThrow(MemoryError);
  });
});

describe("rebuild", () => {
  it("fills the index again from the files, picking up hand edits and deleted files", async () => {
    const store = makeStore();
    await store.write(input({ path: "a.md", title: "Alpha" }));
    await store.write(input({ path: "b.md", title: "Bravo" }));
    const dir = path.join(root, "knowledge");
    fs.rmSync(path.join(dir, "b.md"));
    fs.writeFileSync(path.join(dir, "c.md"), "---\ntype: note\ndescription: By hand\n---\nHand written\n");
    fs.writeFileSync(path.join(dir, "not-a-concept.md"), "no frontmatter\n");
    db.exec("DELETE FROM memory_docs; DELETE FROM memory_fts");
    expect(await store.rebuild()).toEqual({ count: 2 });
    expect(store.browse("").docs.map((d) => d.path).sort()).toEqual(["a.md", "c.md"]);
    expect(store.search({ query: "Hand written" }).total).toBe(1);
    expect(fs.readFileSync(path.join(dir, "index.md"), "utf-8")).toContain("[c.md](c.md): By hand");
  });

  it("does nothing for a ship that has no memory yet", async () => {
    expect(await makeStore().rebuild()).toEqual({ count: 0 });
  });
});

describe("hardening", () => {
  it("refuses a directory that differs only by letter case, and a path with # ? or %", async () => {
    const store = makeStore();
    await store.write(input({ path: "procedures/a.md" }));
    await expect(store.write(input({ path: "Procedures/b.md" }))).rejects.toMatchObject({ code: "invalid" });
    for (const bad of ["a#b.md", "a?b.md", "a%20b.md"]) await expect(store.write(input({ path: bad }))).rejects.toMatchObject({ code: "invalid" });
  });

  it("keeps the history of a memo that was deleted and written again", async () => {
    const store = makeStore();
    const first = await store.write(input({ path: "a.md", message: "one" }));
    await store.remove({ path: "a.md", message: "two", crew: "Alex" });
    await store.write(input({ path: "a.md", message: "three" }));
    expect(first.created).toBe(true);
    expect((await store.history({ path: "a.md" })).map((h) => h.message)).toEqual(["three", "two", "one"]);
  });

  it("does not overwrite a file that is not a memo, nor write over a memo deleted since it was read", async () => {
    const store = makeStore();
    const written = await store.write(input({ path: "a.md" }));
    fs.writeFileSync(path.join(root, "knowledge", "plain.md"), "just text\n");
    await expect(store.write(input({ path: "plain.md" }))).rejects.toMatchObject({ code: "conflict" });
    await store.remove({ path: "a.md", message: "gone", crew: "Alex" });
    await expect(store.write(input({ path: "a.md", base: written.version }))).rejects.toMatchObject({ code: "conflict" });
  });

  it("commits an index.md that a rebuild fixed, with the next change in its directory", async () => {
    const store = makeStore();
    await store.write(input({ path: "x/a.md" }));
    await store.write(input({ path: "x/b.md" }));
    fs.rmSync(path.join(root, "knowledge", "x", "b.md"));
    await store.rebuild();
    expect(fs.readFileSync(path.join(root, "knowledge", "x", "index.md"), "utf-8")).not.toContain("b.md");
    await store.write(input({ path: "x/c.md" }));
    const dirty = (await import("isomorphic-git")).default;
    const matrix = await dirty.statusMatrix({ fs, dir: path.join(root, "knowledge") });
    expect(matrix.filter(([file, head, workdir, stage]) => file.endsWith("index.md") && !(head === 1 && workdir === 1 && stage === 1)).map((r) => r[0])).toEqual([]);
  });
});

describe("names beyond ASCII", () => {
  it("treats a name in another Unicode form as the same memo, and refuses one that differs only in letter case", async () => {
    const store = makeStore();
    const nfc = "café.md";
    const nfd = "café.md";
    await store.write(input({ path: nfd }));
    expect(store.read(nfc)?.path).toBe(nfc);
    await store.deprecate({ path: nfd, message: "x", crew: "Alex" });
    expect(store.browse("").docs).toHaveLength(1);
    await store.write(input({ path: "Ärger.md" }));
    await expect(store.write(input({ path: "ärger.md" }))).rejects.toMatchObject({ code: "invalid" });
    await store.remove({ path: nfd, message: "x", crew: "Alex" });
    expect(store.browse("").docs.map((d) => d.path)).toEqual(["Ärger.md"]);
  });
});

describe("writing never leaves the bundle", () => {
  const bad = [
    "../x.md", "a/../../x.md", "/abs.md", "..\\x.md", ".git/hooks/post-commit.md", ".hidden.md", "a/.b/c.md", "a\u0000.md", "C:/x.md", "a:b.md",
    "con.md", "a/nul.md", "x.md ", "x.md.", "index.md", "a/index.md", "log.md", "a%2e%2e.md", "a#b.md", "a?b.md", "x.txt", "x.md/../../y.md",
  ];

  it("refuses every path that could, for write, deprecate, remove, read and history, and creates nothing outside", async () => {
    const store = makeStore();
    await store.write(input({ path: "ok.md" }));
    const before = fs.readdirSync(root).sort();
    for (const p of bad) {
      await expect(store.write(input({ path: p })), `write ${JSON.stringify(p)}`).rejects.toBeInstanceOf(MemoryError);
      await expect(store.deprecate({ path: p, message: "m", crew: "Alex" }), `deprecate ${JSON.stringify(p)}`).rejects.toBeInstanceOf(MemoryError);
      await expect(store.remove({ path: p, message: "m", crew: "Alex" }), `remove ${JSON.stringify(p)}`).rejects.toBeInstanceOf(MemoryError);
      expect(store.read(p), `read ${JSON.stringify(p)}`).toBeUndefined();
      await expect(store.history({ path: p }), `history ${JSON.stringify(p)}`).rejects.toBeInstanceOf(MemoryError);
    }
    expect(fs.readdirSync(root).sort()).toEqual(before);
    expect(fs.readdirSync(path.join(root, "knowledge")).sort()).toEqual([".git", "index.md", "ok.md"]);
  });

  it("does not write, delete or deprecate through a symbolic link", async () => {
    const store = makeStore();
    await store.write(input({ path: "ok.md" }));
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "victim.md"), "---\ntype: note\ndescription: d\n---\nkeep me\n");
    fs.symlinkSync(outside, path.join(root, "knowledge", "dir-link"));
    fs.symlinkSync(path.join(outside, "victim.md"), path.join(root, "knowledge", "file-link.md"));
    for (const p of ["dir-link/new.md", "dir-link/victim.md", "file-link.md"]) {
      await expect(store.write(input({ path: p })), p).rejects.toMatchObject({ code: "invalid" });
      await expect(store.deprecate({ path: p, message: "m", crew: "Alex" }), p).rejects.toMatchObject({ code: "invalid" });
      await expect(store.remove({ path: p, message: "m", crew: "Alex" }), p).rejects.toMatchObject({ code: "invalid" });
    }
    expect(fs.readdirSync(outside)).toEqual(["victim.md"]);
    expect(fs.readFileSync(path.join(outside, "victim.md"), "utf-8")).toContain("keep me");
    await store.rebuild();
    expect(store.browse("").docs.map((d) => d.path)).toEqual(["ok.md"]);
  });

  it("keeps a hostile frontmatter from doing anything but being data", async () => {
    const store = makeStore();
    fs.mkdirSync(path.join(root, "knowledge"), { recursive: true });
    const bomb = `---\ntype: note\ndescription: d\na: &a [x, x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\nd: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]\ne: &e [*d, *d, *d, *d, *d, *d, *d, *d, *d, *d]\nf: &f [*e, *e, *e, *e, *e, *e, *e, *e, *e, *e]\n---\nbody\n`;
    fs.writeFileSync(path.join(root, "knowledge", "bomb.md"), bomb);
    fs.writeFileSync(path.join(root, "knowledge", "proto.md"), "---\ntype: note\ndescription: d\n__proto__:\n  polluted: yes\nconstructor:\n  prototype:\n    polluted: yes\n---\nbody\n");
    await store.rebuild();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    await store.write(input({ path: "after.md" }));
    expect(store.browse("").docs.map((d) => d.path)).toContain("after.md");
  });
});

describe("a hostile bundle directory", () => {
  const knowledge = () => path.join(root, "knowledge");
  const outsideDir = () => path.join(root, "outside");
  beforeEach(() => fs.mkdirSync(outsideDir()));

  it("does not write through a link planted where a temporary file or an index.md goes", async () => {
    const store = makeStore();
    await store.write(input({ path: "sub/a.md" }));
    fs.writeFileSync(path.join(outsideDir(), "victim1"), "keep1");
    fs.writeFileSync(path.join(outsideDir(), "victim2"), "keep2");
    fs.rmSync(path.join(knowledge(), "sub", "index.md"));
    fs.symlinkSync(path.join(outsideDir(), "victim1"), path.join(knowledge(), "sub", "index.md"));
    fs.rmSync(path.join(knowledge(), "index.md"));
    fs.symlinkSync(path.join(outsideDir(), "victim2"), path.join(knowledge(), "index.md"));
    await store.write(input({ path: "sub/b.md" }));
    await store.write(input({ path: "new.md" }));
    for (const [name, text] of [["victim1", "keep1"], ["victim2", "keep2"]]) expect(fs.readFileSync(path.join(outsideDir(), name), "utf-8"), name).toBe(text);
    expect(fs.lstatSync(path.join(knowledge(), "new.md")).isFile()).toBe(true);
    expect(fs.lstatSync(path.join(knowledge(), "sub", "index.md")).isFile()).toBe(true);
  });

  it("does not delete an index.md outside when an indexed directory is swapped for a link and the index is rebuilt", async () => {
    const store = makeStore();
    await store.write(input({ path: "proc/a.md" }));
    fs.writeFileSync(path.join(outsideDir(), "index.md"), "mine");
    fs.rmSync(path.join(knowledge(), "proc"), { recursive: true });
    fs.symlinkSync(outsideDir(), path.join(knowledge(), "proc"));
    await store.rebuild();
    expect(fs.readFileSync(path.join(outsideDir(), "index.md"), "utf-8")).toBe("mine");
  });

  it("neither reads nor hangs on a pipe where a memo or an index.md should be, and survives a rebuild", async () => {
    const store = makeStore();
    await store.write(input({ path: "ok.md" }));
    execFileSync("mkfifo", [path.join(knowledge(), "pipe.md")]);
    fs.rmSync(path.join(knowledge(), "index.md"));
    execFileSync("mkfifo", [path.join(knowledge(), "index.md")]);
    expect(store.read("pipe.md")).toBeUndefined();
    await expect(store.write(input({ path: "pipe.md" }))).rejects.toMatchObject({ code: "conflict" });
    await store.rebuild();
    expect(store.browse("").docs.map((d) => d.path)).toEqual(["ok.md"]);
    expect(fs.lstatSync(path.join(knowledge(), "index.md")).isFile()).toBe(true);
  });

  it("skips a huge file in a rebuild and still indexes the others", async () => {
    const store = makeStore();
    await store.write(input({ path: "ok.md" }));
    const big = path.join(knowledge(), "big.md");
    fs.writeFileSync(big, "---\ntype: note\ndescription: d\n---\n");
    fs.truncateSync(big, 20 * 1024 * 1024);
    db.exec("DELETE FROM memory_docs; DELETE FROM memory_fts");
    expect(await store.rebuild()).toEqual({ count: 1 });
  });

  it("looks at only the first few words of one or two characters in a search", async () => {
    const store = makeStore();
    await store.write(input({ path: "a.md", body: "a b c d" }));
    expect(store.search({ query: "a b c d" }).total).toBe(1);
    expect(store.search({ query: "a b c d e" }).total).toBe(1);
    expect(store.search({ query: "a b c x" }).total).toBe(0);
  });

  it("looks only at the first words of a search, so a huge query costs no more than a normal one", async () => {
    const store = makeStore();
    const words = Array.from({ length: 40 }, (_, i) => `word${String(i).padStart(2, "0")}`);
    await store.write(input({ path: "a.md", body: words.slice(0, 32).join(" ") }));
    expect(store.search({ query: words.join(" ") }).total).toBe(1);
    expect(store.search({ query: "x".repeat(5000) }).total).toBe(0);
  });

  it("refuses an 8.3 short name and a Windows device name in a path", async () => {
    const store = makeStore();
    for (const p of ["GIT~1/x.md", "a/PROGRA~1.md", "COM1.md", "lpt9.txt.md"]) await expect(store.write(input({ path: p })), p).rejects.toMatchObject({ code: "invalid" });
  });
});
