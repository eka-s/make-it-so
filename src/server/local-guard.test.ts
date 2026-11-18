import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalRequestGuard, isAcceptedHost, isSameOrigin } from "./local-guard.js";

describe("isAcceptedHost", () => {
  it("accepts IP literals and localhost names, with or without a port", () => {
    for (const host of ["127.0.0.1:3939", "127.0.0.1", "localhost:3939", "LOCALHOST", "app.localhost:1", "[::1]:3939", "192.168.1.20:3939", "[fe80::1]:80"]) {
      expect(isAcceptedHost(host), host).toBe(true);
    }
  });

  it("refuses any other name (a DNS name that rebinds to this machine), and a missing or broken Host", () => {
    for (const host of ["evil.example:3939", "localhost.evil.example", "127.0.0.1.evil.example", "mybox.local", "", "a b", "http://x/", "evil.com@127.0.0.1:3939", "127.0.0.1:3939/evil.com", "127.0.0.1:99999x"]) {
      expect(isAcceptedHost(host), host).toBe(false);
    }
    expect(isAcceptedHost(undefined)).toBe(false);
  });
});

describe("isSameOrigin", () => {
  it("compares the origin's host and port with the Host header", () => {
    expect(isSameOrigin("http://localhost:3939", "localhost:3939")).toBe(true);
    expect(isSameOrigin("http://LOCALHOST:3939", "localhost:3939")).toBe(true);
    expect(isSameOrigin("http://localhost:3940", "localhost:3939")).toBe(false);
    expect(isSameOrigin("http://evil.example", "localhost:3939")).toBe(false);
    expect(isSameOrigin("null", "localhost:3939")).toBe(false);
    expect(isSameOrigin("https://localhost:3939", "localhost:3939")).toBe(false); // this server is plain http
  });
});

describe("createLocalRequestGuard", () => {
  let server: http.Server | undefined;
  afterEach(() => new Promise<void>((resolve) => { if (!server) return resolve(); server.closeAllConnections(); server.close(() => resolve()); server = undefined; }));

  async function call(headers: Record<string, string>, method = "POST"): Promise<number> {
    const app = express();
    app.use(createLocalRequestGuard());
    app.all("/x", (_req, res) => { res.json({ ok: true }); });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    // http.request (not fetch) so that the Host header can be set to anything.
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/x", method, headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.end();
    });
  }

  it("lets a plain local request through (no Origin: curl, agents, the CLI)", async () => {
    expect(await call({})).toBe(200);
  });

  it("lets the page of this very server through, as a browser sends it", async () => {
    expect(await call({ Host: "localhost:5000", Origin: "http://localhost:5000" })).toBe(200);
  });

  it("refuses a rebound host name, even without an Origin", async () => {
    expect(await call({ Host: "rebind.evil.example:3939" })).toBe(403);
    expect(await call({ Host: "rebind.evil.example:3939", Origin: "http://rebind.evil.example:3939" })).toBe(403);
  });

  it("refuses a GET that a page of another origin triggers (an <img> or <script> tag sends no Origin, but Sec-Fetch-Site)", async () => {
    expect(await call({ "Sec-Fetch-Site": "cross-site" }, "GET")).toBe(403);
    expect(await call({ "Sec-Fetch-Site": "same-site" }, "GET")).toBe(403);
    expect(await call({ "Sec-Fetch-Site": "same-origin" }, "GET")).toBe(200);
    expect(await call({ "Sec-Fetch-Site": "none" }, "GET")).toBe(200);
  });

  it("lets the person follow a link to the page (a top-level navigation), which the settings screen's 'open the ship' link is", async () => {
    expect(await call({ "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" }, "GET")).toBe(200);
    expect(await call({ "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" }, "GET")).toBe(200);
    // anything that is not a page load stays refused
    expect(await call({ "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "image" }, "GET")).toBe(403);
    expect(await call({ "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" }, "GET")).toBe(403);
    expect(await call({ "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" }, "POST")).toBe(403);
    expect(await call({ "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe" }, "GET")).toBe(403);
  });

  it("refuses a cross-site request, including a simple POST that needs no preflight", async () => {
    expect(await call({ Origin: "https://evil.example", "Content-Type": "text/plain" })).toBe(403);
    expect(await call({ Origin: "null" })).toBe(403);
    expect(await call({ Origin: "https://evil.example" }, "GET")).toBe(403);
  });
});
