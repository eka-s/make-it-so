import http from "node:http";
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

  it("takes a call whose body is over 1 MB (a large memo is written with a warning, not refused)", async () => {
    listener = await openMcpListener();
    listener.serve(async (req, res) => { res.json({ length: (req.body as { text: string }).text.length }); });
    const res = await fetch(`http://127.0.0.1:${listener.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(await res.json()).toEqual({ length: 2 * 1024 * 1024 });
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

  it("refuses a request from another origin", async () => {
    listener = await openMcpListener();
    listener.serve(async (_req, res) => { res.json({ ok: true }); });
    expect((await post("/mcp", { Origin: "https://evil.example" })).status).toBe(403);
  });

  it("refuses a request addressed to a host name that is not a local one (a name that rebinds to this machine)", async () => {
    listener = await openMcpListener();
    listener.serve(async (_req, res) => { res.json({ ok: true }); });
    // fetch will not let a script set Host, so the request is made with http directly
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: listener.port, path: "/mcp", method: "POST", headers: { Host: "evil.example", "Content-Type": "application/json" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.end("{}");
    });
    expect(status).toBe(403);
  });
});
