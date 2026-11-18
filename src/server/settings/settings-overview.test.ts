import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOverview } from "./settings-overview.js";

let tmp: string;
let dir: string; // plays ~/.make-it-so

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mis-overview-"));
  dir = path.join(tmp, ".make-it-so");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(rel: string, content: string): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe("readOverview", () => {
  it("a directory that does not exist is reported as missing, with no files and no ships", () => {
    const overview = readOverview(dir);
    expect(overview).toMatchObject({ dir, exists: false, personnelCount: 0, ships: [] });
    expect(overview.files.every((f) => !f.exists)).toBe(true);
  });

  it("reports which files exist, the personas and the ships (sorted by ID)", () => {
    write("roster.yml", "crew: {}\n");
    write("personnel/alex.md", "x");
    write("personnel/alex.png", "x");
    write("ships/beta/ship.yml", "port: 4001\nname: Beta\n");
    write("ships/alpha/ship.yml", "port: 4000\n");
    const overview = readOverview(dir);
    expect(overview.exists).toBe(true);
    expect(overview.files).toEqual([
      { name: "config.yml", exists: false },
      { name: "roster.yml", exists: true },
      { name: "hosts.yml", exists: false },
    ]);
    expect(overview.personnelCount).toBe(1); // only the .md files count
    expect(overview.ships).toEqual([{ id: "alpha", port: 4000 }, { id: "beta", name: "Beta", port: 4001 }]);
  });

  it("a directory without ship.yml is not a ship", () => {
    write("ships/notes/readme.txt", "x");
    expect(readOverview(dir).ships).toEqual([]);
  });

  it("a ship.yml that cannot be read is reported on its own entry, not as a failure of the whole overview", () => {
    write("ships/broken/ship.yml", "port: [unclosed\n");
    write("ships/ok/ship.yml", "port: 4000\n");
    const { ships } = readOverview(dir);
    expect(ships.map((s) => s.id)).toEqual(["broken", "ok"]);
    expect(ships[0].error).toBeTruthy();
    expect(ships[1]).toEqual({ id: "ok", port: 4000 });
  });
});
