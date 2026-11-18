import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadHosts } from "../fleet-config.js";
import { readHostsState, saveHosts } from "./hosts-settings.js";

let tmp: string;
let dir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mis-hosts-"));
  dir = path.join(tmp, ".make-it-so");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(rel: string, text: string): void {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}
const written = () => parse(fs.readFileSync(path.join(dir, "hosts.yml"), "utf-8"));

describe("readHostsState", () => {
  it("no hosts.yml: an empty list", () => {
    expect(readHostsState(dir)).toMatchObject({ exists: false, hosts: [] });
  });

  it("lists the hosts, and which ships use each", () => {
    write("hosts.yml", "hosts:\n  dev:\n    destination: dev-server\n  spare:\n    destination: me@10.0.0.2\n");
    write("ships/alpha/ship.yml", "port: 4000\ncrew:\n  a: { member: x, host: dev }\n  b: { member: y }\n");
    write("ships/beta/ship.yml", "port: 4001\ncrew:\n  a: { member: x, host: dev }\n");
    expect(readHostsState(dir).hosts).toEqual([
      { name: "dev", destination: "dev-server", usedBy: ["alpha", "beta"] },
      { name: "spare", destination: "me@10.0.0.2", usedBy: [] },
    ]);
  });
});

describe("saveHosts", () => {
  it("adds, changes and removes hosts; what it writes is accepted by loadHosts", () => {
    write("hosts.yml", "# my hosts\nhosts:\n  dev: # the dev box\n    destination: dev-server\n  old:\n    destination: old-box\n");
    const result = saveHosts(dir, [{ name: "dev", destination: "dev2" }, { name: "new", destination: "me@host" }]);
    expect(result.ok).toBe(true);
    expect(written()).toEqual({ hosts: { dev: { destination: "dev2" }, new: { destination: "me@host" } } });
    expect(fs.readFileSync(path.join(dir, "hosts.yml"), "utf-8")).toContain("# my hosts");
    expect(loadHosts(dir)).toEqual({ dev: { name: "dev", destination: "dev2" }, new: { name: "new", destination: "me@host" } });
  });

  it("an unchanged host is not touched", () => {
    write("hosts.yml", "hosts:\n  dev:\n    # keep me\n    destination: dev-server\n");
    saveHosts(dir, [{ name: "dev", destination: "dev-server" }, { name: "b", destination: "bbb" }]);
    expect(fs.readFileSync(path.join(dir, "hosts.yml"), "utf-8")).toContain("# keep me");
  });

  it("removing every host leaves a file loadHosts still reads", () => {
    write("hosts.yml", "hosts:\n  dev:\n    destination: dev-server\n");
    saveHosts(dir, []);
    expect(loadHosts(dir)).toEqual({});
  });

  it("refuses bad names, duplicates and bad destinations, writing nothing", () => {
    write("hosts.yml", "hosts:\n  dev:\n    destination: dev-server\n");
    const before = fs.readFileSync(path.join(dir, "hosts.yml"), "utf-8");
    const result = saveHosts(dir, [
      { name: "bad name", destination: "x" },
      { name: "dup", destination: "a" },
      { name: "dup", destination: "b" },
      { name: "opt", destination: "-oProxyCommand=evil" },
      { name: "spaced", destination: "a b" },
    ]);
    expect(result).toEqual({
      ok: false,
      errors: {
        "bad name": "settings.error.hostName",
        dup: "settings.error.hostDuplicate",
        opt: "settings.error.hostDestination",
        spaced: "settings.error.hostDestination",
      },
    });
    expect(fs.readFileSync(path.join(dir, "hosts.yml"), "utf-8")).toBe(before);
  });

  it("a host that a ship uses cannot be removed (or renamed)", () => {
    write("hosts.yml", "hosts:\n  dev:\n    destination: dev-server\n");
    write("ships/alpha/ship.yml", "port: 4000\ncrew:\n  a: { member: x, host: dev }\n");
    expect(saveHosts(dir, [])).toEqual({ ok: false, errors: { dev: "settings.error.hostInUse" } });
    expect(saveHosts(dir, [{ name: "dev2", destination: "dev-server" }])).toEqual({ ok: false, errors: { dev: "settings.error.hostInUse" } });
    expect(parse(fs.readFileSync(path.join(dir, "hosts.yml"), "utf-8"))).toEqual({ hosts: { dev: { destination: "dev-server" } } });
  });
});

describe("a hosts.yml whose hosts key is empty", () => {
  it("the first host can still be added", () => {
    write("hosts.yml", "# remote machines\nhosts:\n  # dock:\n  #   destination: dock\n");
    expect(saveHosts(dir, [{ name: "dock", destination: "dock" }]).ok).toBe(true);
    expect(written()).toEqual({ hosts: { dock: { destination: "dock" } } });
  });
});
