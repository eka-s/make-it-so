import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore, type MemoryStore } from "../memory-store.js";
import { migrate } from "../migrations.js";
import { startTestServer, type TestServer } from "../testing/http.js";
import { createMemoryRouter } from "./memory.js";

// The viewer's read-only side of the Memory. What is listed and how links are written is decided here, so the client only draws it.
let root: string;
let db: DatabaseSync;
let store: MemoryStore;
let server: TestServer;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-route-"));
  db = new DatabaseSync(":memory:");
  migrate(db);
  store = createMemoryStore({ dir: path.join(root, "knowledge"), db, shipName: "Ship", producer: "make-it-so" });
  server = await startTestServer((app) => app.use(createMemoryRouter({ memory: store })));
  const base = { type: "note", description: "d", message: "m", crew: "Alex" };
  await store.write({ ...base, path: "a/one.md", title: "One", body: "See [two](two.md), [root](/top.md) and [web](https://example.com).\n" });
  await store.write({ ...base, path: "a/draft.md", title: "Draft", status: "draft", body: "x" });
  await store.write({ ...base, path: "a/old.md", title: "Old", body: "y" });
  await store.deprecate({ path: "a/old.md", message: "m", crew: "Alex" });
});
afterEach(async () => {
  await server.close();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("GET /api/memory/history", () => {
  it("returns the changes of the Memory or of one memo, newest first, with the diff only when it is asked for", async () => {
    const all = await server.get("/api/memory/history");
    expect(all.status).toBe(200);
    expect((all.body as { message: string }[])[0].message).toBe("m");
    const one = await server.get("/api/memory/history?path=a/one.md&diff=1&limit=5");
    const entries = one.body as { author: string; diff?: string }[];
    expect(entries).toHaveLength(1);
    expect(entries[0].author).toBe("Alex");
    expect(entries[0].diff).toContain("+");
    expect(((await server.get("/api/memory/history?path=a/one.md")).body as { diff?: string }[])[0].diff).toBeUndefined();
  });

  it("refuses a path that is not a path of the Memory", async () => {
    expect((await server.get("/api/memory/history?path=..%2F..%2Fx.md")).status).toBe(400);
  });
});

describe("GET /api/memory/tree", () => {
  it("lists a directory with its subdirectories counted, and leaves out the drafts and deprecated memos that are switched off", async () => {
    const all = await server.get("/api/memory/tree?dir=a");
    expect((all.body as { docs: unknown[] }).docs).toHaveLength(3);
    const some = await server.get("/api/memory/tree?dir=a&draft=0&deprecated=0");
    expect((some.body as { docs: { path: string }[] }).docs.map((d) => d.path)).toEqual(["a/one.md"]);
    const root = await server.get("/api/memory/tree");
    expect(root.body).toMatchObject({ dir: "", dirs: [{ name: "a", count: 3 }], docs: [] });
  });

  it("refuses a directory that is not a safe name", async () => {
    expect((await server.get("/api/memory/tree?dir=..%2Fx")).status).toBe(400);
  });
});

describe("GET /api/memory/doc", () => {
  it("returns the memo as it is written: the links are read by the viewer, against the memo it shows", async () => {
    const { status, body } = await server.get("/api/memory/doc?path=a/one.md");
    expect(status).toBe(200);
    const doc = body as { body: string; frontmatter: string; version: string };
    expect(doc.body).toContain("[two](two.md)");
    expect(doc.body).toContain("[root](/top.md)");
    expect(doc.frontmatter).toContain("type: note");
    expect(doc.version).toMatch(/^[0-9a-f]{40}$/);
  });

  it("is 404 for a memo that does not exist, and for a path that cannot be one", async () => {
    expect((await server.get("/api/memory/doc?path=a/nope.md")).status).toBe(404);
    expect((await server.get("/api/memory/doc?path=..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
  });
});

describe("GET /api/memory/search", () => {
  it("searches, honoring the switches", async () => {
    const found = await server.get("/api/memory/search?q=One");
    expect(found.body).toMatchObject({ total: 1, items: [{ path: "a/one.md" }] });
    expect((await server.get("/api/memory/search?q=Old&deprecated=0")).body).toMatchObject({ total: 0 });
  });
});

// What a viewer is asked for is whatever its address says: the server checks every path itself and never reads outside the Memory.
describe("paths that try to leave the Memory", () => {
  const attacks = [
    "../x.md", "..%2Fx.md", "%2e%2e/x.md", "%252e%252e/x.md", "a/../../x.md", "a/..%2F..%2Fx.md", "/etc/passwd", "/x.md",
    "..\\x.md", "a%5C..%5Cx.md", "a%00.md", ".git/HEAD", ".git/config", "a/.hidden.md", "C:/x.md", "a.md:stream", "index.md", "con.md",
    "a.md%20", "a%2F%2Fb.md", `${"a/".repeat(200)}x.md`,
  ];

  it("reads nothing, whatever the encoding", async () => {
    fs.writeFileSync(path.join(root, "secret.md"), "---\ntype: note\ndescription: outside\n---\nsecret\n");
    for (const attack of attacks) {
      const res = await server.get(`/api/memory/doc?path=${attack}`);
      expect(res.status, attack).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("secret");
    }
  });

  it("lists nothing outside for a directory it was given, and refuses it", async () => {
    for (const dir of ["..", "../", "..%2F", "%2e%2e", "a/../..", "/", "/etc", ".git", "a/.git", "..\\", "a%00", "C:"]) {
      const res = await server.get(`/api/memory/tree?dir=${dir}`);
      expect(res.status, dir).toBe(400);
    }
  });

  it("takes only the first value of a repeated parameter and treats a missing one as nothing", async () => {
    expect((await server.get("/api/memory/doc?path=a/one.md&path=../x.md")).status).toBe(404);
    expect((await server.get("/api/memory/doc")).status).toBe(404);
    expect((await server.get("/api/memory/tree?dir=a&dir=..")).status).toBe(200);
  });

  it("does not follow a link of the Memory to a file or a directory outside", async () => {
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "leak.md"), "---\ntype: note\ndescription: leak\n---\nleaked\n");
    fs.symlinkSync(path.join(outside, "leak.md"), path.join(root, "knowledge", "a", "file-link.md"));
    fs.symlinkSync(outside, path.join(root, "knowledge", "dir-link"));
    for (const target of ["a/file-link.md", "dir-link/leak.md"]) {
      const res = await server.get(`/api/memory/doc?path=${target}`);
      expect(res.status, target).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain("leaked");
    }
    await store.rebuild();
    expect(JSON.stringify((await server.get("/api/memory/search?q=leaked")).body)).not.toContain("leak");
    expect(JSON.stringify((await server.get("/api/memory/tree?dir=")).body)).not.toContain("dir-link");
  });

  it("reads the search text as text, not as a path or a pattern", async () => {
    for (const q of ["../x", "%", "_", "\\", "' OR 1=1 --", '"', "*", "a*", "NEAR(", "AND", "-x"]) {
      const res = await server.get(`/api/memory/search?q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(200);
    }
  });
});

describe("what the crew wrote as the successor of a memo", () => {
  it("is passed on only when it is a path of the Memory", async () => {
    const file = path.join(root, "knowledge", "a", "one.md");
    const original = fs.readFileSync(file, "utf-8");
    for (const [value, expected] of [["/a/two.md", "/a/two.md"], ["two.md", "/a/two.md"], ["/%5Cevil.com", undefined], ["/.git/config", undefined], ["https://evil.example/x.md", undefined], ["../../x.md", undefined]] as const) {
      fs.writeFileSync(file, original.replace("status: stable", `status: deprecated\nsuperseded_by: ${JSON.stringify(value)}`));
      const body = (await server.get("/api/memory/doc?path=a/one.md")).body as { supersededBy?: string };
      expect(body.supersededBy, value).toBe(expected);
    }
  });
});
