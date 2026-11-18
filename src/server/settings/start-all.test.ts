import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startAllShips } from "./start-all.js";
import type { ShipRuntime } from "./ship-runtime.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mis-all-"));
  for (const [id, port] of [["alpha", 4000], ["beta", 4001], ["gamma", 4002]] as const) {
    fs.mkdirSync(path.join(dir, "ships", id), { recursive: true });
    fs.writeFileSync(path.join(dir, "ships", id, "ship.yml"), `port: ${port}\ncrew:\n  lead: { member: a }\n`);
  }
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("startAllShips", () => {
  it("starts what is stopped and reports what it could not", async () => {
    const asked: string[] = [];
    const runtime = {
      start: async (id: string) => {
        asked.push(id);
        return id === "beta" ? { ok: false as const, reason: "running" as const } : id === "gamma" ? { ok: false as const, reason: "conflict" as const } : { ok: true as const };
      },
    } as unknown as ShipRuntime;
    expect(await startAllShips(dir, runtime)).toEqual([
      { id: "alpha", outcome: "started", url: "http://127.0.0.1:4000" },
      { id: "beta", outcome: "running", url: "http://127.0.0.1:4001" },
      { id: "gamma", outcome: "conflict", url: "http://127.0.0.1:4002" },
    ]);
    expect(asked).toEqual(["alpha", "beta", "gamma"]);
  });

  it("does nothing for a directory without ships", async () => {
    const runtime = { start: async () => { throw new Error("not called"); } } as unknown as ShipRuntime;
    expect(await startAllShips(path.join(dir, "none"), runtime)).toEqual([]);
  });
});
