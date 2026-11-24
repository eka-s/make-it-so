import express from "express";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createLocalRequestGuard } from "../server/local-guard.js";
import { createInMemoryFetch } from "./in-memory-fetch.js";

function appWithRoutes(onSseClose: () => void = () => {}, ran: () => void = () => {}): express.Express {
  const app = express();
  app.use(createLocalRequestGuard());
  app.use(express.json());
  app.get("/api/config", (_req, res) => res.json({ shipName: "Test Ship" }));
  app.post("/api/echo", (req, res) => res.status(201).json({ echoed: req.body }));
  app.delete("/api/echo", (req, res) => res.json({ echoed: req.body }));
  app.put("/api/bytes", express.raw({ type: "application/octet-stream" }), (req, res) => res.json({ bytes: [...(req.body as Buffer)] }));
  app.get("/api/events", (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(": connected\n\n");
    let n = 0;
    const timer = setInterval(() => res.write(`event: tick\ndata: ${++n}\n\n`), 10);
    req.on("close", () => { clearInterval(timer); onSseClose(); });
  });
  app.delete("/api/gone", (_req, res) => { res.status(204).send(); });
  app.get("/api/not-modified", (_req, res) => { res.status(304).end(); });
  app.get("/api/ran", (_req, res) => { ran(); res.json({}); });
  app.post("/api/ran", (_req, res) => { ran(); res.json({}); });
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

  it("passes the body of a DELETE too (the settings remove a ship with a confirmation in its body)", async () => {
    const serve = createInMemoryFetch(appWithRoutes());
    const res = await serve(new Request("app://ship/api/echo", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: "alpha" }) }));
    expect(await res.json()).toEqual({ echoed: { confirm: "alpha" } });
  });

  it("passes a binary body unchanged (an icon is uploaded as raw bytes)", async () => {
    const serve = createInMemoryFetch(appWithRoutes());
    const res = await serve(new Request("app://ship/api/bytes", { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array([0, 255, 10, 13, 128]) }));
    expect(await res.json()).toEqual({ bytes: [0, 255, 10, 13, 128] });
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

  it("answers a 204 and a 304 with no body (a body on those would make the Response constructor throw)", async () => {
    const serve = createInMemoryFetch(appWithRoutes());
    const gone = await serve(new Request("app://ship/api/gone", { method: "DELETE" }));
    expect(gone.status).toBe(204);
    expect(gone.body).toBeNull();
    const notModified = await serve(new Request("app://ship/api/not-modified"));
    expect(notModified.status).toBe(304);
    expect(notModified.body).toBeNull();
  });

  it("tells the handler when the page drops the response body without any abort (as the protocol layer does when a page closes an event stream)", async () => {
    let closed = false;
    const serve = createInMemoryFetch(appWithRoutes(() => { closed = true; }));
    const res = await serve(new Request("app://ship/api/events"));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await expect.poll(() => closed).toBe(true);
  });

  it("also notices a body that is destroyed rather than cancelled", async () => {
    let closed = false;
    const serve = createInMemoryFetch(appWithRoutes(() => { closed = true; }));
    const res = await serve(new Request("app://ship/api/events"));
    const node = Readable.fromWeb(res.body as never);
    await new Promise((resolve) => node.once("data", resolve));
    node.destroy();
    await expect.poll(() => closed).toBe(true);
  });

  it("does not run the handler for a request that was aborted before it was made", async () => {
    const ran = vi.fn();
    const serve = createInMemoryFetch(appWithRoutes(() => {}, ran));
    const abort = new AbortController();
    abort.abort();
    await expect(serve(new Request("app://ship/api/ran", { signal: abort.signal }))).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ran).not.toHaveBeenCalled();
  });

  it("does not run the handler for a request that was aborted while its body was still being read", async () => {
    const ran = vi.fn();
    const serve = createInMemoryFetch(appWithRoutes(() => {}, ran));
    const abort = new AbortController();
    // A body that finishes only after the page has given up.
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    });
    const request = new Request("app://ship/api/ran", { method: "POST", body, signal: abort.signal, duplex: "half", headers: { "Content-Type": "application/json" } } as RequestInit);
    const served = serve(request);
    setTimeout(() => abort.abort(), 10);
    await expect(served).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ran).not.toHaveBeenCalled();
  });

  it("answers 404 for a path the handler does not know", async () => {
    const serve = createInMemoryFetch(appWithRoutes());
    expect((await serve(new Request("app://ship/api/nope"))).status).toBe(404);
  });
});
