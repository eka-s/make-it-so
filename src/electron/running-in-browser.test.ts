import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runningInBrowser } from "./running-in-browser.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mis-running-browser-"));
  fs.mkdirSync(path.join(dir, "ships", "alpha"), { recursive: true });
  fs.writeFileSync(path.join(dir, "ships", "alpha", "ship.yml"), "port: 3971\n");
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const answering = (body: unknown, ok = true) => (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as unknown as typeof fetch;

describe("a ship running in the browser version", () => {
  it("gives the port when the ship itself answers there", async () => {
    expect(await runningInBrowser(dir, "alpha", answering({ status: "ok", shipId: "alpha", pid: 1234 }))).toBe(3971);
  });

  it("is not running when nothing answers, when another ship answers, or when what answers is not a ship", async () => {
    const refused = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await runningInBrowser(dir, "alpha", refused)).toBeNull();
    expect(await runningInBrowser(dir, "alpha", answering({ shipId: "beta" }))).toBeNull();
    expect(await runningInBrowser(dir, "alpha", answering("not json"))).toBeNull();
    expect(await runningInBrowser(dir, "alpha", answering({ shipId: "alpha" }, false))).toBeNull();
  });

  it("asks nobody when the ship has no port", async () => {
    fs.mkdirSync(path.join(dir, "ships", "beta"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ships", "beta", "ship.yml"), "name: Beta\n");
    const never = (async () => { throw new Error("must not be asked"); }) as unknown as typeof fetch;
    expect(await runningInBrowser(dir, "beta", never)).toBeNull();
  });
});
