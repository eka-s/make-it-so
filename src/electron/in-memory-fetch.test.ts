import express from "express";
import { describe, expect, it } from "vitest";
import { createLocalRequestGuard } from "../server/local-guard.js";
import { createInMemoryFetch } from "./in-memory-fetch.js";

function appWithRoutes(onSseClose: () => void = () => {}): express.Express {
  const app = express();
  app.use(createLocalRequestGuard());
  app.use(express.json());
  app.get("/api/config", (_req, res) => res.json({ shipName: "Test Ship" }));
  app.post("/api/echo", (req, res) => res.status(201).json({ echoed: req.body }));
  app.get("/api/events", (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(": connected\n\n");
    let n = 0;
    const timer = setInterval(() => res.write(`event: tick\ndata: ${++n}\n\n`), 10);
    req.on("close", () => { clearInterval(timer); onSseClose(); });
  });
  app.get("/api/cookie", (_req, res) => { res.append("Set-Cookie", "a=1"); res.append("Set-Cookie", "b=2"); res.end(); });
  return app;
}

describe("serving a request without a port", () => {
  it("answers a GET with the JSON of the handler", async () => {
    const serve = createInMemoryFetch(appWithRoutes());
    const res = await serve(new Request("app://ship/api/config"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ shipName: "Test Ship" });
  });

  it("passes the body of a POST and the status of the answer", async () => {
    const serve = createInMemoryFetch(appWithRoutes());
    const res = await serve(new Request("app://ship/api/echo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ a: 1 }) }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ echoed: { a: 1 } });
  });

  it("is not refused by the local-request guard for the origin of the page (those headers only mean something over the network)", async () => {
    const serve = createInMemoryFetch(appWithRoutes());
    const res = await serve(new Request("app://ship/api/config", { headers: { Origin: "app://ship", "Sec-Fetch-Site": "same-origin", Referer: "app://ship/" } }));
    expect(res.status).toBe(200);
  });

  it("streams an event stream and tells the handler when the page closes it", async () => {
    let closed = false;
    const serve = createInMemoryFetch(appWithRoutes(() => { closed = true; }));
    const abort = new AbortController();
    const res = await serve(new Request("app://ship/api/events", { signal: abort.signal }));
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const reader = res.body!.getReader();
    let received = "";
    while ((received.match(/event: tick/g) ?? []).length < 3) {
      const { value, done } = await reader.read();
      if (done) break;
      received += Buffer.from(value).toString();
    }
    expect((received.match(/event: tick/g) ?? []).length).toBeGreaterThanOrEqual(3);

    abort.abort();
    await expect.poll(() => closed).toBe(true);
  });

  it("keeps every Set-Cookie header of the answer", async () => {
    const serve = createInMemoryFetch(appWithRoutes());
    const res = await serve(new Request("app://ship/api/cookie"));
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });

  it("answers 404 for a path the handler does not know", async () => {
    const serve = createInMemoryFetch(appWithRoutes());
    expect((await serve(new Request("app://ship/api/nope"))).status).toBe(404);
  });
});
