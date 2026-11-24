import { afterEach, describe, expect, it } from "vitest";
import { openMcpListener, type McpListener } from "./mcp-listener.js";

let listener: McpListener;
afterEach(async () => { await listener.close(); });

function post(path = "/mcp", headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${listener.port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: "{}",
  });
}

describe("the MCP listener", () => {
  it("gets its own port from the OS and answers 503 until a handler is given", async () => {
    listener = await openMcpListener();
    expect(listener.port).toBeGreaterThan(0);
    const res = await post();
    expect(res.status).toBe(503);
  });

  it("hands /mcp calls to the handler once it serves", async () => {
    listener = await openMcpListener();
    listener.serve(async (_req, res) => { res.json({ ok: true }); });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("answers 500 when the handler fails before it responds", async () => {
    listener = await openMcpListener();
    listener.serve(async () => { throw new Error("boom"); });
    const res = await post();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
  });

  it("serves nothing but /mcp", async () => {
    listener = await openMcpListener();
    listener.serve(async (_req, res) => { res.json({ ok: true }); });
    expect((await post("/api/config")).status).toBe(404);
  });

  it("refuses a request that is not addressed to a local host or comes from another origin", async () => {
    listener = await openMcpListener();
    listener.serve(async (_req, res) => { res.json({ ok: true }); });
    expect((await post("/mcp", { Origin: "https://evil.example" })).status).toBe(403);
  });
});
