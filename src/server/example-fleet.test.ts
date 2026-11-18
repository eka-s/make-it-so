import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./load-config.js";

// Pins that examples/fleet/ (the sample fleet that is published) remains a configuration that can actually be loaded.
// This prevents the state where the format was changed but only the sample is stale.

const exampleFleet = path.resolve(__dirname, "../../examples/fleet");
let home: string; // a fake home directory holding a copy of the example as ~/.make-it-so

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mis-example-"));
  fs.cpSync(exampleFleet, path.join(home, ".make-it-so"), { recursive: true });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("examples/fleet", () => {
  it("can be read with loadConfig, and yields the ship, 3 crew members, and the rules", () => {
    const config = loadConfig({ homeDir: home, log: () => {} });
    expect(config.shipId).toBe("example");
    expect(config.shipName).toBe("Example Ship");
    expect(Object.keys(config.crew)).toEqual(["first_officer", "chief_engineer", "ensign"]);
    expect(config.crew.first_officer).toMatchObject({ name: "Alex", agent: undefined });
    expect(config.crew.ensign.permissionMode).toBe("default");
    expect(config.crew.chief_engineer.rules).toEqual([
      path.join(home, ".make-it-so", "ships", "example", "rules", "working-agreement.md"),
    ]);
  });

  it("each crew member's persona (personnel/{id}.md) exists and contains no proper names taken from any particular work", () => {
    const names = fs.readdirSync(path.join(exampleFleet, "personnel"));
    expect(names.sort()).toEqual(["alex.md", "jo.md", "sam.md"]);
    const all = [
      ...names.map((n) => fs.readFileSync(path.join(exampleFleet, "personnel", n), "utf-8")),
      fs.readFileSync(path.join(exampleFleet, "roster.yml"), "utf-8"),
      fs.readFileSync(path.join(exampleFleet, "ships", "example", "ship.yml"), "utf-8"),
    ].join("\n");
    expect(all).not.toMatch(/riker|ライカー|enterprise|enterprize|picard|voyager|star ?trek|geordi|data\b/i);
  });
});
