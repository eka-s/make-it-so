import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runningInBrowser, shipHost } from "./running-in-browser.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mis-running-browser-"));
  fs.mkdirSync(path.join(dir, "ships", "alpha"), { recursive: true });
  fs.writeFileSync(path.join(dir, "ships", "alpha", "ship.yml"), "port: 3971\n");
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const answering = (body: unknown, ok = true) => (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as unknown as typeof fetch;

describe("a ship running in the browser version", () => {
  it("gives the port and the process when the ship itself answers there", async () => {
    expect(await runningInBrowser(dir, "alpha", { fetch: answering({ status: "ok", shipId: "alpha", pid: 1234 }) })).toEqual({ port: 3971, pid: 1234, confirmed: true });
  });

  it("gives no process when what answers does not say a usable one (0, negative and 1 would signal a group or init)", async () => {
    for (const pid of [0, -4, 1, "7", 2.5, undefined]) {
      expect(await runningInBrowser(dir, "alpha", { fetch: answering({ shipId: "alpha", pid }) })).toEqual({ port: 3971, pid: null, confirmed: true });
    }
  });

  it("is not running when another ship answers, or when what answers is not a ship", async () => {
    expect(await runningInBrowser(dir, "alpha", { fetch: answering({ shipId: "beta" }) })).toBeNull();
    expect(await runningInBrowser(dir, "alpha", { fetch: answering("not json") })).toBeNull();
    expect(await runningInBrowser(dir, "alpha", { fetch: answering({ shipId: "alpha" }, false) })).toBeNull();
  });

  it("counts a port that is listening but does not answer in time as running (a busy ship), without a process to name", async () => {
    const slow = (async () => { throw new DOMException("The operation timed out", "TimeoutError"); }) as unknown as typeof fetch;
    expect(await runningInBrowser(dir, "alpha", { fetch: slow })).toEqual({ port: 3971, pid: null, confirmed: false });
  });

  it("counts the refusal of a ship's own local-request guard as running (a host name in server.host makes the guard refuse the probe's Host)", async () => {
    for (const error of ["forbidden_host", "forbidden_origin", "forbidden_site"]) {
      expect(await runningInBrowser(dir, "alpha", { fetch: answering({ error, message: "..." }, false) })).toEqual({ port: 3971, pid: null, confirmed: false });
    }
  });

  it("does not count other failures to answer (a refused connection, another program's error page) as running", async () => {
    const refused = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(await runningInBrowser(dir, "alpha", { fetch: refused })).toBeNull();
    expect(await runningInBrowser(dir, "alpha", { fetch: answering({ error: "something else" }, false) })).toBeNull();
  });

  it("asks nobody when the ship has no port or its ID is not one", async () => {
    fs.mkdirSync(path.join(dir, "ships", "beta"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ships", "beta", "ship.yml"), "name: Beta\n");
    const never = (async () => { throw new Error("must not be asked"); }) as unknown as typeof fetch;
    expect(await runningInBrowser(dir, "beta", { fetch: never })).toBeNull();
    expect(await runningInBrowser(dir, "../alpha", { fetch: never })).toBeNull();
  });

  it("asks the host the browser version listens on, with the time it is given", async () => {
    fs.writeFileSync(path.join(dir, "config.yml"), "server:\n  host: 192.168.1.5\n");
    const asked: { url: string; signal: AbortSignal | undefined }[] = [];
    const spy = (async (url: string | URL | Request, init?: RequestInit) => { asked.push({ url: String(url), signal: init?.signal ?? undefined }); return new Response("{}", { status: 500 }); }) as unknown as typeof fetch;
    await runningInBrowser(dir, "alpha", { fetch: spy, timeoutMs: 2500 });
    expect(asked[0].url).toBe("http://192.168.1.5:3971/api/health");
    expect(asked[0].signal).toBeDefined();
  });
});

describe("the host the browser version listens on", () => {
  const write = (text: string) => fs.writeFileSync(path.join(dir, "config.yml"), text);

  it("is the loopback address when config.yml says nothing", () => {
    expect(shipHost(dir)).toBe("127.0.0.1");
    write("language: en\n");
    expect(shipHost(dir)).toBe("127.0.0.1");
  });

  it("is the host config.yml names", () => {
    write("server:\n  host: 192.168.1.5\n");
    expect(shipHost(dir)).toBe("192.168.1.5");
  });

  it("is the loopback address for a wildcard (it cannot be connected to, and covers the loopback)", () => {
    for (const host of ["0.0.0.0", "'::'"]) {
      write(`server:\n  host: ${host}\n`);
      expect(shipHost(dir)).toBe("127.0.0.1");
    }
  });

  it("puts an IPv6 address in brackets, and falls back when config.yml is not usable", () => {
    write("server:\n  host: '::1'\n");
    expect(shipHost(dir)).toBe("[::1]");
    write("server: [unclosed\n");
    expect(shipHost(dir)).toBe("127.0.0.1");
    write("server:\n  host: 42\n");
    expect(shipHost(dir)).toBe("127.0.0.1");
  });
});
