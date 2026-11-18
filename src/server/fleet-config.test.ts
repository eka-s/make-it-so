import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canDispatch,
  defaultCrewRole,
  loadCrew,
  loadHosts,
  resolveAccess,
  resolveCwd,
  resolveFiles,
  resolveShip,
  type RawShipFile,
} from "./fleet-config.js";

// fleet-config.ts has no side effects and receives everything as arguments, so it can be
// called as is, without a mock, against config files made in a temporary directory.
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mis-fleet-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

describe("loadHosts", () => {
  it("empty if there is no hosts.yml (a ship that uses no remote crew needs nothing)", () => {
    expect(loadHosts(root)).toEqual({});
  });

  it("reads destination", () => {
    write("hosts.yml", "hosts:\n  dock:\n    destination: dock\n  dev:\n    destination: me@dev-server\n");
    expect(loadHosts(root)).toEqual({
      dock: { name: "dock", destination: "dock" },
      dev: { name: "dev", destination: "me@dev-server" },
    });
  });

  it("a key other than destination (key path, port, etc.) is an error that points to where to move it", () => {
    write("hosts.yml", "hosts:\n  dock:\n    destination: dock\n    identityFile: /x/key\n    port: 22\n");
    expect(() => loadHosts(root)).toThrow(/unsupported key\(s\): identityFile, port/);
    expect(() => loadHosts(root)).toThrow(/~\/\.ssh\/config/);
  });

  it.each([
    ["starts with - (ssh option injection)", '"-oProxyCommand=evil"'],
    ["contains whitespace", '"a b"'],
    ["empty string", '""'],
  ])("an invalid destination is rejected: %s", (_label, value) => {
    write("hosts.yml", `hosts:\n  dock:\n    destination: ${value}\n`);
    expect(() => loadHosts(root)).toThrow(/destination must be/);
  });

  it("a host without destination is rejected", () => {
    write("hosts.yml", "hosts:\n  dock: {}\n");
    expect(() => loadHosts(root)).toThrow(/destination must be/);
  });
});

describe("resolveShip", () => {
  const ship = (port: number | null) => (port === null ? "name: x\n" : `port: ${port}\n`);

  it("if there is one ship, it is chosen without being specified", () => {
    write("ships/alpha/ship.yml", ship(3939));
    const result = resolveShip(path.join(root, "ships"), undefined);
    expect(result.id).toBe("alpha");
    expect(result.port).toBe(3939);
    expect(result.root).toBe(path.join(root, "ships", "alpha"));
  });

  it("a directory without ship.yml is not treated as a ship", () => {
    write("ships/alpha/ship.yml", ship(3939));
    fs.mkdirSync(path.join(root, "ships", "not-a-ship"));
    expect(resolveShip(path.join(root, "ships"), undefined).id).toBe("alpha");
  });

  it("if there are several ships and none is specified, an error that shows the candidates", () => {
    write("ships/alpha/ship.yml", ship(3939));
    write("ships/beta/ship.yml", ship(3940));
    expect(() => resolveShip(path.join(root, "ships"), undefined)).toThrow(/none was chosen.*alpha, beta/);
  });

  it("chooses the specified ship. A nonexistent ship is an error that shows the candidates", () => {
    write("ships/alpha/ship.yml", ship(3939));
    write("ships/beta/ship.yml", ship(3940));
    expect(resolveShip(path.join(root, "ships"), "beta").id).toBe("beta");
    expect(() => resolveShip(path.join(root, "ships"), "gamma")).toThrow(/"gamma" \(--ship\) was not found.*alpha, beta/);
  });

  it("an error if there is no ship at all. Also an error if the ships directory itself does not exist", () => {
    fs.mkdirSync(path.join(root, "ships"));
    expect(() => resolveShip(path.join(root, "ships"), undefined)).toThrow(/No ships found/);
    expect(() => resolveShip(path.join(root, "nowhere"), undefined)).toThrow(/Ships directory not found/);
  });

  it("a ship without a port, and ships with a duplicated port, are errors (detected ahead of time even when starting just one ship)", () => {
    write("ships/alpha/ship.yml", ship(null));
    expect(() => resolveShip(path.join(root, "ships"), "alpha")).toThrow(/missing "port"/);

    write("ships/alpha/ship.yml", ship(3939));
    write("ships/beta/ship.yml", ship(3939));
    expect(() => resolveShip(path.join(root, "ships"), "alpha")).toThrow(/alpha, beta all declare port 3939/);
  });
});

describe("resolveCwd", () => {
  it("the ship root if cwd is not specified", () => {
    expect(resolveCwd("role", undefined, undefined, undefined, "/ship")).toBe("/ship");
  });

  it("a relative path is resolved against the ship root. A member's setting takes priority over the ship's", () => {
    fs.mkdirSync(path.join(root, "ship", "proj"), { recursive: true });
    fs.mkdirSync(path.join(root, "ship", "other"), { recursive: true });
    const shipRoot = path.join(root, "ship");
    expect(resolveCwd("r", undefined, "proj", undefined, shipRoot)).toBe(path.join(shipRoot, "proj"));
    expect(resolveCwd("r", "other", "proj", undefined, shipRoot)).toBe(path.join(shipRoot, "other"));
  });

  it("a nonexistent cwd (or a cwd that points to a file) is an error, not a silent fallback", () => {
    write("ship/file.txt", "x");
    expect(() => resolveCwd("r", "missing", undefined, undefined, path.join(root, "ship"))).toThrow(/does not exist/);
    expect(() => resolveCwd("r", "file.txt", undefined, undefined, path.join(root, "ship"))).toThrow(/not a directory|does not exist/);
  });

  describe("remote host", () => {
    const host = { name: "dock", destination: "dock" };

    it("an absolute path on the remote side is used as is (no existence check or conversion locally)", () => {
      expect(resolveCwd("r", "/srv/project", undefined, host, "/ship")).toBe("/srv/project");
    });

    it("an error if cwd is missing or a relative path", () => {
      expect(() => resolveCwd("r", undefined, undefined, host, "/ship")).toThrow(/absolute path on the remote host/);
      expect(() => resolveCwd("r", "relative/dir", undefined, host, "/ship")).toThrow(/absolute path on the remote host/);
    });
  });
});

describe("resolveFiles", () => {
  it("turns relative paths into absolute paths based on baseDir. Empty if not specified", () => {
    const file = write("base/rules/common.md", "x");
    expect(resolveFiles("rules", "owner", path.join(root, "base"), ["rules/common.md"])).toEqual([file]);
    expect(resolveFiles("rules", "owner", root, undefined)).toEqual([]);
  });

  it("a nonexistent file is an error that shows the kind and the owner", () => {
    expect(() => resolveFiles("skills", 'ship "x"', root, ["nope.md"])).toThrow(/skills file for ship "x" not found/);
  });
});

describe("resolveAccess", () => {
  const targets = { app: "/work/app", docs: "/work/docs" };

  it("nothing is attached if there are no targets", () => {
    expect(resolveAccess("r", undefined, {}, "/ship", "/ship")).toEqual({ additionalDirectories: [] });
  });

  it("cwd is the ship root: announces the ship root as the working directory, and puts only the targets given in access on the allow list", () => {
    const result = resolveAccess("r", { app: "readwrite", docs: "readonly" }, targets, "/ship", "/ship");
    expect(result.additionalDirectories).toEqual(["/work/app", "/work/docs"]);
    expect(result.accessNote).toContain("/ship : read/write freely (the normal working directory)");
    expect(result.accessNote).toContain("/work/app (app): read/write freely");
    expect(result.accessNote).toContain("/work/docs (docs): read-only");
    expect(result.accessNote).toContain("Do not access any directory that is not listed above.");
  });

  it("a target with no access specified (out of scope) is on neither the allow list nor additionalDirectories", () => {
    const result = resolveAccess("r", { app: "readwrite" }, targets, "/ship", "/ship");
    expect(result.additionalDirectories).toEqual(["/work/app"]);
    expect(result.accessNote).not.toContain("/work/docs");
  });

  it("cwd is other than the ship root: announces cwd as readable, and the text says writing is limited to individual specifications", () => {
    const result = resolveAccess("r", { app: "readwrite" }, targets, "/proj", "/ship");
    expect(result.accessNote).toContain("/ship : read/write freely (the ship's make-it-so directory)");
    expect(result.accessNote).toContain("/proj : working directory (cwd). Readable.");
    expect(result.accessNote).toContain("Do not write to, modify or delete anything");
  });

  it("writing a nonexistent target name in access only warns and carries on", () => {
    const result = resolveAccess("r", { ghost: "readwrite" }, targets, "/ship", "/ship");
    expect(result.additionalDirectories).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('unknown target "ghost"'));
  });
});

describe("loadCrew", () => {
  const shipFile = (yaml: string): { id: string; file: RawShipFile } => ({
    id: "alpha",
    file: { port: 3939, ...(JSON.parse(yaml) as object) } as RawShipFile,
  });

  beforeEach(() => {
    write(
      "roster.yml",
      [
        "crew:",
        "  alex: { name: Alex, provider: claude }",
        "  sam: { name: Sam, provider: kiro, rules: [personnel/sam-rules.md] }",
        "  scout: { name: Jo, provider: claude, model: sonnet }",
      ].join("\n"),
    );
    write("personnel/sam-rules.md", "sam rules");
    fs.mkdirSync(path.join(root, "ship"), { recursive: true });
  });

  const shipRoot = () => path.join(root, "ship");

  it("a role name that ids and directory names cannot hold, and a role without a body, are config errors (not a TypeError)", () => {
    expect(() => loadCrew(root, shipRoot(), shipFile('{"crew":{"機関長":{"member":"alex"}}}'))).toThrow(/role "機関長": a role name may only have/);
    expect(() => loadCrew(root, shipRoot(), shipFile('{"crew":{"chief.eng":{"member":"alex"}}}'))).toThrow(/role name may only have/);
    expect(() => loadCrew(root, shipRoot(), shipFile('{"crew":{"engineer":null}}'))).toThrow(/role "engineer".*must be a map with a "member"/);
    expect(() => loadCrew(root, shipRoot(), shipFile('{"crew":{"engineer":{}}}'))).toThrow(/must be a map with a "member"/);
  });

  it("names of the Object prototype are not crew members (constructor / __proto__ / toString find nothing)", () => {
    const crew = loadCrew(root, shipRoot(), shipFile('{"crew":{"lead":{"member":"alex"}}}'));
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(crew[name], name).toBeUndefined();
      expect(name in crew, name).toBe(false);
    }
    expect(Object.keys(crew)).toEqual(["lead"]);
  });

  it("default crew member: cwd is the ship root and there is no agent (make-it-so injects the persona)", () => {
    const crew = loadCrew(root, shipRoot(), shipFile('{"crew":{"first_officer":{"member":"alex"}}}'));
    expect(crew.first_officer).toMatchObject({
      name: "Alex",
      provider: "claude",
      acp_agent: "alex",
      cwd: shipRoot(),
      agent: undefined,
      rules: [],
      skills: [],
    });
    expect(crew.first_officer.host).toBeUndefined();
  });

  it("model: the ship's post (ship.yml) takes priority over the roster's member setting, and undefined if neither exists", () => {
    const crew = loadCrew(
      root,
      shipRoot(),
      shipFile('{"crew":{"first_officer":{"member":"alex"},"chief_engineer":{"member":"scout"},"science":{"member":"scout","model":"opus"}}}'),
    );
    expect(crew.first_officer.model).toBeUndefined();
    expect(crew.chief_engineer.model).toBe("sonnet"); // the roster's setting
    expect(crew.science.model).toBe("opus"); // the ship's setting takes priority
  });

  it("permission_mode too: the ship's post (ship.yml) takes priority over the roster's member setting, and undefined if neither exists", () => {
    write(
      "roster.yml",
      ["crew:", "  alex: { name: Alex, provider: claude }", "  scout: { name: Jo, provider: claude, permission_mode: plan }"].join("\n"),
    );
    const crew = loadCrew(
      root,
      shipRoot(),
      shipFile('{"crew":{"first_officer":{"member":"alex"},"chief_engineer":{"member":"scout"},"science":{"member":"scout","permission_mode":"default"}}}'),
    );
    expect(crew.first_officer.permissionMode).toBeUndefined();
    expect(crew.chief_engineer.permissionMode).toBe("plan"); // the roster's setting
    expect(crew.science.permissionMode).toBe("default"); // the ship's setting takes priority
  });

  it("cwd and agent are independent: specifying cwd does not attach an agent, and writing an agent leaves cwd at the ship root", () => {
    fs.mkdirSync(path.join(root, "proj"));
    const crew = loadCrew(
      root,
      shipRoot(),
      shipFile(`{"cwd":${JSON.stringify(path.join(root, "proj"))},"crew":{"first_officer":{"member":"alex","agent":"alex_mis"},"chief_engineer":{"member":"sam"}}}`),
    );
    expect(crew.first_officer).toMatchObject({ cwd: path.join(root, "proj"), agent: "alex_mis" });
    expect(crew.chief_engineer.cwd).toBe(path.join(root, "proj"));
    expect(crew.chief_engineer.agent).toBeUndefined();

    const noCwd = loadCrew(root, shipRoot(), shipFile('{"crew":{"first_officer":{"member":"alex","agent":"alex_mis"}}}'));
    expect(noCwd.first_officer).toMatchObject({ cwd: shipRoot(), agent: "alex_mis" });
  });

  it("if the old name profile is written, an error asking for the rename to agent", () => {
    expect(() =>
      loadCrew(root, shipRoot(), shipFile('{"crew":{"first_officer":{"member":"alex","profile":"alex_mis"}}}')),
    ).toThrow(/"profile" was renamed to "agent"/);
  });

  it("rules are concatenated in the order personal (roster, relative to the fleet root) → ship (ship, relative to the ship root)", () => {
    write("ship/rules/ship.md", "ship rules");
    const crew = loadCrew(
      root,
      shipRoot(),
      shipFile('{"rules":["rules/ship.md"],"crew":{"first_officer":{"member":"alex"},"chief_engineer":{"member":"sam"}}}'),
    );
    expect(crew.chief_engineer.rules).toEqual([
      path.join(root, "personnel", "sam-rules.md"),
      path.join(shipRoot(), "rules", "ship.md"),
    ]);
    expect(crew.first_officer.rules).toEqual([path.join(shipRoot(), "rules", "ship.md")]);
  });

  it("remote crew member: looks up the host in hosts.yml, cwd is a remote path, and no targets guidance is attached", () => {
    write("hosts.yml", "hosts:\n  dock:\n    destination: dock\n");
    const crew = loadCrew(
      root,
      shipRoot(),
      shipFile('{"targets":{"app":"/work/app"},"crew":{"first_officer":{"member":"alex"},"science_officer":{"member":"scout","host":"dock","cwd":"/work"}}}'),
    );
    expect(crew.science_officer).toMatchObject({
      host: { name: "dock", destination: "dock" },
      cwd: "/work",
      agent: undefined,
      additionalDirectories: [],
    });
    expect(crew.science_officer.accessNote).toBeUndefined();
  });

  it("referencing an undefined host is an error", () => {
    expect(() =>
      loadCrew(root, shipRoot(), shipFile('{"crew":{"first_officer":{"member":"alex"},"x":{"member":"scout","host":"nope","cwd":"/work"}}}')),
    ).toThrow(/unknown host "nope"/);
  });

  it("specifying access (targets) for a remote crew member is an error", () => {
    write("hosts.yml", "hosts:\n  dock:\n    destination: dock\n");
    expect(() =>
      loadCrew(
        root,
        shipRoot(),
        shipFile('{"targets":{"app":"/work/app"},"crew":{"first_officer":{"member":"alex"},"x":{"member":"scout","host":"dock","cwd":"/work","access":{"app":"readwrite"}}}}'),
      ),
    ).toThrow(/"access" \(targets\) is not supported for remote crew/);
  });

  it("a member not in the roster is an error (a typo must not silently drop a role)", () => {
    expect(() => loadCrew(
      root,
      shipRoot(),
      shipFile('{"crew":{"first_officer":{"member":"alex"},"ghost":{"member":"nobody"}}}'),
    )).toThrow(/role "ghost" references unknown crew member "nobody".*members: /);
  });

  it("no particular role name (first_officer, etc.) is required. An error if there are no crew members at all. Also an error if there is no roster", () => {
    const crew = loadCrew(root, shipRoot(), shipFile('{"crew":{"chief_engineer":{"member":"sam"}}}'));
    expect(Object.keys(crew)).toEqual(["chief_engineer"]);
    expect(() => loadCrew(root, shipRoot(), shipFile('{"crew":{"first_officer":{"member":"nobody"}}}'))).toThrow(
      /unknown crew member "nobody"/,
    );
    fs.rmSync(path.join(root, "roster.yml"));
    expect(() => loadCrew(root, shipRoot(), shipFile('{"crew":{"first_officer":{"member":"alex"}}}'))).toThrow(
      /Fleet roster not found/,
    );
  });

  describe("rank", () => {
    const withRanks = (r1?: string, r2?: string) =>
      shipFile(JSON.stringify({
        crew: {
          first_officer: { member: "alex", ...(r1 ? { rank: r1 } : {}) },
          chief_engineer: { member: "sam", ...(r2 ? { rank: r2 } : {}) },
        },
      }));

    it("crew if omitted. commander, chief, and crew can be specified", () => {
      const none = loadCrew(root, shipRoot(), withRanks());
      expect([none.first_officer.rank, none.chief_engineer.rank]).toEqual(["crew", "crew"]);
      const set = loadCrew(root, shipRoot(), withRanks("commander", "chief"));
      expect([set.first_officer.rank, set.chief_engineer.rank]).toEqual(["commander", "chief"]);
    });

    it("not decided by role name: even one named first_officer is crew if not written", () => {
      expect(loadCrew(root, shipRoot(), withRanks(undefined, "commander")).first_officer.rank).toBe("crew");
    });

    it("an unknown rank is an error", () => {
      expect(() => loadCrew(root, shipRoot(), withRanks("admiral"))).toThrow(/rank must be one of commander, chief, crew/);
    });

    it("at most one commander per ship", () => {
      expect(() => loadCrew(root, shipRoot(), withRanks("commander", "commander"))).toThrow(
        /only one crew member can have rank "commander" \(found: first_officer, chief_engineer\)/,
      );
    });
  });

  describe("defaultCrewRole / canDispatch", () => {
    it("the default partner is the commander if there is one, otherwise the first crew member written. undefined if there are no crew members", () => {
      expect(defaultCrewRole({ a: { rank: "crew" }, b: { rank: "commander" }, c: { rank: "chief" } })).toBe("b");
      expect(defaultCrewRole({ a: { rank: "chief" }, b: { rank: "crew" } })).toBe("a");
      expect(defaultCrewRole({})).toBeUndefined();
    });

    it("only the commander and chiefs can issue tasks", () => {
      expect([canDispatch("commander"), canDispatch("chief"), canDispatch("crew")]).toEqual([true, true, false]);
    });
  });
});

describe("resolveShip: a broken ship does not keep the others from starting", () => {
  const shipYml = (port: number) => `port: ${port}\ncrew:\n  lead: { member: alex }\n`;

  it("a ship.yml that cannot be read is skipped (with a warning) when another ship is asked for", () => {
    write("ships/good/ship.yml", shipYml(4001));
    write("ships/bad/ship.yml", "port: [unclosed");
    const result = resolveShip(path.join(root, "ships"), "good");
    expect(result.id).toBe("good");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Skipping ship "bad"'));
  });

  it("but it is an error for the ship that is asked for, and when no ship is asked for", () => {
    write("ships/good/ship.yml", shipYml(4001));
    write("ships/bad/ship.yml", "port: [unclosed");
    expect(() => resolveShip(path.join(root, "ships"), "bad")).toThrow(/could not be read/);
    expect(() => resolveShip(path.join(root, "ships"), undefined)).toThrow(/could not be read/);
  });

  it("two other ships with the same port are not the asked ship's problem", () => {
    write("ships/good/ship.yml", shipYml(4001));
    write("ships/x/ship.yml", shipYml(4002));
    write("ships/y/ship.yml", shipYml(4002));
    expect(resolveShip(path.join(root, "ships"), "good").port).toBe(4001);
    expect(() => resolveShip(path.join(root, "ships"), "x")).toThrow(/all declare port 4002/);
  });
});

describe("loadCrew: roster and access values that would otherwise only fail later", () => {
  it("a member without a display name, a member ID with odd characters, and an access mode that is not readonly/readwrite are config errors", () => {
    write("roster.yml", ["crew:", "  alex: { provider: claude }", "  'a b': { name: X }", "  sam: { name: Sam }"].join("\n"));
    fs.mkdirSync(path.join(root, "ship"), { recursive: true });
    const ship = (c: string) => ({ id: "alpha", file: { port: 3939, targets: { app: root }, ...(JSON.parse(c) as object) } as RawShipFile });
    expect(() => loadCrew(root, path.join(root, "ship"), ship('{"crew":{"lead":{"member":"alex"}}}'))).toThrow(/Crew member "alex".*needs a "name"/);
    expect(() => loadCrew(root, path.join(root, "ship"), ship('{"crew":{"lead":{"member":"a b"}}}'))).toThrow(/an ID may only have/);
    expect(() => loadCrew(root, path.join(root, "ship"), ship('{"crew":{"lead":{"member":"sam","access":{"app":"write"}}}}'))).toThrow(/access to "app" must be "readonly" or "readwrite"/);
  });
});
