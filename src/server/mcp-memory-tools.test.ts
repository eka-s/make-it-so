import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerMemoryTools } from "./mcp-memory-tools.js";
import { createMemoryStore } from "./memory-store.js";
import { migrate } from "./migrations.js";

let root: string;
let db: DatabaseSync;
let client: Client;

async function connect(writer: () => string | undefined): Promise<void> {
  const store = createMemoryStore({ dir: path.join(root, "knowledge"), db, shipName: "Ship", producer: "make-it-so" });
  const server = new McpServer({ name: "test", version: "1.0.0" });
  registerMemoryTools(server, store, writer);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text?: string }>; isError?: boolean };
  return { text: result.content[0]?.text ?? "", isError: result.isError === true };
}

const memo = { path: "procedures/deploy.md", type: "procedure", description: "Before a release", body: "Run the checks.", message: "Add it" };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-tools-"));
  db = new DatabaseSync(":memory:");
  migrate(db);
});

afterEach(async () => {
  await client.close();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the memory tools", () => {
  it("write, search, read and update a memo, with the writer as the author in the history", async () => {
    await connect(() => "Alex");
    const created = await call("write_memory", memo);
    expect(created.isError).toBe(false);
    expect(created.text).toMatch(/^Created procedures\/deploy.md\. version: [0-9a-f]{40}/);

    expect(JSON.parse((await call("search_memory", { query: "checks" })).text)).toMatchObject({ total: 1, items: [{ path: "procedures/deploy.md" }] });
    const read = JSON.parse((await call("read_memory", { path: "/procedures/deploy.md" })).text) as { version: string; body: string };
    expect(read.body).toBe("Run the checks.");

    expect((await call("write_memory", { ...memo, body: "x" })).isError).toBe(true);
    expect((await call("write_memory", { ...memo, body: "Run more checks.", message: "Extend", base: read.version })).text).toMatch(/^Updated /);
    expect(JSON.parse((await call("get_memory_history", { path: memo.path, diff: true })).text)).toMatchObject([{ message: "Extend", author: "Alex" }, { message: "Add it" }]);
  });

  it("a stale write is refused with the memo as it is now", async () => {
    await connect(() => "Alex");
    await call("write_memory", memo);
    const refused = await call("write_memory", { ...memo, base: "0".repeat(40) });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Run the checks.");
  });

  it("deprecates and deletes", async () => {
    await connect(() => "Alex");
    await call("write_memory", memo);
    expect((await call("deprecate_memory", { path: memo.path, superseded_by: "/procedures/v2.md", message: "Replaced" })).text).toMatch(/^Deprecated /);
    expect(JSON.parse((await call("read_memory", { path: memo.path })).text)).toMatchObject({ status: "deprecated", supersededBy: "/procedures/v2.md" });
    expect((await call("delete_memory", { path: memo.path, message: "Wrong" })).text).toBe("Deleted procedures/deploy.md.");
    expect((await call("read_memory", { path: memo.path })).isError).toBe(true);
  });

  it("refuses to write when the caller cannot be identified", async () => {
    await connect(() => undefined);
    expect(await call("write_memory", memo)).toMatchObject({ isError: true, text: expect.stringContaining("could not be identified") });
    expect((await call("search_memory", {})).isError).toBe(false);
  });

  it("needs a path for a diff", async () => {
    await connect(() => "Alex");
    expect((await call("get_memory_history", { diff: true })).isError).toBe(true);
  });
});
