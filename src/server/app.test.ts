import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppDeps } from "./app.js";
import { broadcast } from "./sse-emitter.js";
import { serveApp, type TestServer } from "./testing/http.js";

// Checks the assembly of the whole app (common middleware, mount positions, MCP, SSE, error handling)
// with stub routers whose contents are fixed. The contents of each router are checked in its own tests.
let server: TestServer;
let handleMcpRequest: ReturnType<typeof vi.fn>;
const controllers: AbortController[] = [];

function stubRouter(path: string, body: unknown): express.Router {
  const router = express.Router();
  router.get(path, (_req, res) => {
    res.json(body);
  });
  router.post(path, (req, res) => {
    res.json({ echoed: req.body });
  });
  return router;
}

async function start(overrides: Partial<AppDeps> = {}): Promise<void> {
  const deps: AppDeps = {
    routers: [stubRouter("/api/stub", { from: "root" })],
    pinsRouter: stubRouter("/", { from: "pins" }),
    handleMcpRequest: async (_req, res) => {
      handleMcpRequest();
      res.json({ ok: true });
    },
    ...overrides,
  };
  server = await serveApp(createApp(deps));
}

/** Connects to an SSE endpoint and collects what is received. */
async function openSse(path: string): Promise<{ text: () => string; waitFor: (needle: string) => Promise<void>; response: Response }> {
  const controller = new AbortController();
  controllers.push(controller);
  const response = await fetch(`${server.baseUrl}${path}`, { signal: controller.signal });
  let received = "";
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        received += decoder.decode(value);
      }
    } catch {
      /* disconnected */
    }
  })();
  return {
    response,
    text: () => received,
    waitFor: (needle) => vi.waitFor(() => expect(received).toContain(needle)),
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  handleMcpRequest = vi.fn();
});
afterEach(async () => {
  for (const c of controllers.splice(0)) c.abort();
  await server.close();
  vi.restoreAllMocks();
});

describe("mounting routers", () => {
  it("routers are mounted at the root, pins at /api/pins", async () => {
    await start();
    expect((await server.get("/api/stub")).body).toEqual({ from: "root" });
    expect((await server.get("/api/pins")).body).toEqual({ from: "pins" });
  });

  it("a nonexistent path is 404", async () => {
    await start();
    // The body is Express's standard HTML, so it is not read as JSON; only the status is looked at
    expect((await fetch(`${server.baseUrl}/api/nothing`)).status).toBe(404);
  });

  it("if several routers are passed, all are mounted", async () => {
    await start({ routers: [stubRouter("/api/a", "A"), stubRouter("/api/b", "B")] });
    expect((await server.get("/api/a")).body).toBe("A");
    expect((await server.get("/api/b")).body).toBe("B");
  });
});

describe("common middleware", () => {
  it("parses a JSON body and passes it to the router", async () => {
    await start();
    expect((await server.send("POST", "/api/stub", { a: 1 })).body).toEqual({ echoed: { a: 1 } });
  });

  it("broken JSON is 400 (Invalid JSON in request body)", async () => {
    await start();
    const response = await fetch(`${server.baseUrl}/api/stub`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ broken",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON in request body" });
  });

  it("a body over 1MB is not accepted", async () => {
    await start();
    const response = await fetch(`${server.baseUrl}/api/stub`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ big: "x".repeat(1024 * 1024 + 10) }),
    });
    expect(response.status).toBe(413);
  });

  it("cors() is not used (no header allowing another origin is attached)", async () => {
    await start();
    const response = await fetch(`${server.baseUrl}/api/stub`, { headers: { Origin: "https://evil.example" } });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("POST /mcp", () => {
  it("hands the processing to the handler", async () => {
    await start();
    const { status, body } = await server.send("POST", "/mcp", {});
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(handleMcpRequest).toHaveBeenCalledTimes(1);
  });

  it("500 if the handler fails (if it has not responded yet)", async () => {
    await start({
      handleMcpRequest: async () => {
        throw new Error("boom");
      },
    });
    const { status, body } = await server.send("POST", "/mcp", {});
    expect(status).toBe(500);
    expect(body).toEqual({ error: "Internal server error" });
  });
});

describe("SSE", () => {
  it("on connecting it starts with text/event-stream, and a connection-confirmation comment arrives", async () => {
    await start();
    const sse = await openSse("/api/events/bridge");
    expect(sse.response.headers.get("content-type")).toContain("text/event-stream");
    await sse.waitFor(": connected");
  });

  it("/api/events/bridge receives chat events and does not receive events addressed to crew members", async () => {
    await start();
    const sse = await openSse("/api/events/bridge");
    await sse.waitFor(": connected");

    broadcast({ type: "task:progress", data: { agent: "ensign", taskId: "ensign_0001", chunk: "x", field: "response" } });
    broadcast({ type: "timeline:remove", data: { id: "x" } });

    await sse.waitFor("event: timeline:remove");
    expect(sse.text()).not.toContain("event: task:progress");
  });

  it("/api/events (all channels) receives both kinds of events", async () => {
    await start();
    const sse = await openSse("/api/events");
    await sse.waitFor(": connected");

    broadcast({ type: "task:progress", data: { agent: "ensign", taskId: "ensign_0001", chunk: "x", field: "response" } });
    broadcast({ type: "timeline:remove", data: { id: "y" } });

    await sse.waitFor("event: task:progress");
    await sse.waitFor("event: timeline:remove");
  });
});

describe("serving the UI (clientDir)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "client-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<html>UI</html>");
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function getText(p: string): Promise<{ status: number; text: string }> {
    const res = await fetch(`${server.baseUrl}${p}`);
    return { status: res.status, text: await res.text() };
  }

  it("with clientDir, serves /, assets, and paths inside the UI (SPA)", async () => {
    await start({ clientDir: dir });
    expect(await getText("/")).toEqual({ status: 200, text: "<html>UI</html>" });
    expect((await getText("/assets/app.js")).text).toBe("console.log(1)");
    expect((await getText("/some/page")).text).toBe("<html>UI</html>");
  });

  it("the API takes priority over the UI, and an undefined /api/... is not swallowed by the UI and stays 404", async () => {
    await start({ clientDir: dir });
    expect(await server.get("/api/stub")).toEqual({ status: 200, body: { from: "root" } });
    expect((await getText("/api/nothing")).text).not.toContain("UI");
    expect((await getText("/api/nothing")).status).toBe(404);
  });

  it("without clientDir, or without index.html, nothing is served (npm run dev)", async () => {
    await start();
    expect((await getText("/")).status).toBe(404);
    await server.close();
    await start({ clientDir: path.join(dir, "nothing") });
    expect((await getText("/")).status).toBe(404);
  });
});
