import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./load-config.js";

// load-config.ts receives environment variables, the home directory, and log output as arguments, so
// it can be called as is, without a mock, against config files made in a temporary directory (the fake home).
let tmp: string;
let logs: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mis-config-"));
  logs = [];
  // suppress the console output on the fleet-config.ts side
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const file = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** Creates a minimal fleet (ship alpha: port 4000, one crew member Alex as first_officer) in tmp/.make-it-so. */
function makeFleet(extraShips: Record<string, number> = {}): void {
  write(".make-it-so/roster.yml", "crew:\n  alex: { name: Alex, provider: claude }\n");
  for (const [id, port] of Object.entries({ alpha: 4000, ...extraShips })) {
    write(`.make-it-so/ships/${id}/ship.yml`, `port: ${port}\ncrew:\n  first_officer: { member: alex }\n`);
  }
}

const load = (shipId?: string) => loadConfig({ shipId, homeDir: tmp, log: (m) => logs.push(m) });

describe("configuration problems", () => {
  it("if there is no config.yml, it runs on defaults (and says so); the missing ships are what stops it", () => {
    expect(() => load()).toThrow(/Ships directory not found at .*\.make-it-so.*ships/);
    expect(logs.some((m) => m.startsWith("[Config] No config.yml found at") && m.endsWith("using defaults"))).toBe(true);
  });

  it("an error if there is no ship under ships/", () => {
    fs.mkdirSync(path.join(tmp, ".make-it-so/ships"), { recursive: true });
    expect(() => load()).toThrow(/No ships found/);
  });

  it("if there are several ships and no ship is chosen, an error that shows the candidates", () => {
    makeFleet({ beta: 4001 });
    expect(() => load()).toThrow(/Multiple ships found.*alpha, beta|Multiple ships found.*beta, alpha/);
  });

  it("an error if the chosen ship does not exist, listing the ships there are", () => {
    makeFleet();
    expect(() => load("nope")).toThrow(/Ship "nope" \(--ship\) was not found.*Available ships: alpha/);
  });

  it("an error if there is no roster", () => {
    write(".make-it-so/ships/alpha/ship.yml", "port: 4000\ncrew:\n  first_officer: { member: alex }\n");
    expect(() => load()).toThrow(/Fleet roster not found/);
  });
});

describe("where everything is read from", () => {
  beforeEach(() => makeFleet());

  it("reads the fleet from .make-it-so in the home directory, and config.yml is optional", () => {
    const config = load();
    expect(config.shipId).toBe("alpha");
    expect(config.port).toBe(4000);
    expect(config.fleetRoot).toBe(path.join(tmp, ".make-it-so"));
    expect(config.projectRoot).toBe(path.join(tmp, ".make-it-so/ships/alpha"));
    expect(config.crew.first_officer.name).toBe("Alex");
  });

  it("reads .make-it-so/config.yml when there is one", () => {
    write(".make-it-so/config.yml", "language: ja\n");
    expect(load().language).toBe("ja");
  });

  it("does not look at config.yml anywhere else (a file in the home directory itself is ignored)", () => {
    write("config.yml", "language: ja\n");
    expect(load().language).toBe("en");
  });
});

describe("ship selection and defaults", () => {
  beforeEach(() => {
    makeFleet({ beta: 4001 });
  });

  it("the ship is chosen with the --ship argument", () => {
    const config = load("beta");
    expect(config.shipId).toBe("beta");
    expect(config.port).toBe(4001);
  });

  it("defaults: listen on loopback only, provider claude, logging info and 5MB", () => {
    const config = load("alpha");
    expect(config.host).toBe("127.0.0.1");
    expect(config.acp.provider).toBe("claude");
    expect(config.logging).toEqual({ level: "info", maxFileSizeMb: 5 });
    expect(config.debug).toBe(false);
    expect(config.language).toBe("en");
    expect(config.crewLanguage).toBe("en");
  });

  it("crew_language is the same as language if omitted. If specified, it can differ from the UI language. An unsupported value is an error", () => {
    write(".make-it-so/config.yml", "language: ja\n");
    expect(load("alpha").crewLanguage).toBe("ja");

    write(".make-it-so/config.yml", "language: en\ncrew_language: ja\n");
    const config = load("alpha");
    expect([config.language, config.crewLanguage]).toEqual(["en", "ja"]);

    write(".make-it-so/config.yml", "crew_language: fr\n");
    expect(() => load("alpha")).toThrow(/"crew_language" must be one of en, ja/);
  });

  it("theme defaults to classic and can be set in config.yml. An unsupported value is an error", () => {
    expect(load("alpha").theme).toBe("classic");

    write(".make-it-so/config.yml", "theme: light\n");
    expect(load("alpha").theme).toBe("light");

    write(".make-it-so/config.yml", "theme: neon\n");
    expect(() => load("alpha")).toThrow(/"theme" must be one of classic, light, dark/);
  });

  it("language can be specified in config.yml. An unsupported value is an error", () => {
    write(".make-it-so/config.yml", "language: ja\n");
    expect(load("alpha").language).toBe("ja");

    write(".make-it-so/config.yml", "language: fr\n");
    expect(() => load("alpha")).toThrow(/"language" must be one of en, ja/);
  });

  it("the listening host is config.yml's server.host, or loopback by default", () => {
    write(".make-it-so/config.yml", "server:\n  host: 0.0.0.0\n");
    expect(load("alpha").host).toBe("0.0.0.0");
  });

  it("the ship's working directories are decided under the ship root", () => {
    const config = load("alpha");
    expect(config.turnsDir).toBe(path.join(config.projectRoot, "turns"));
    expect(config.logsDir).toBe(path.join(config.projectRoot, "logs"));
  });
});

describe("when the YAML is broken", () => {
  it("the message includes which file is broken (with line and column)", () => {
    const file = write(".make-it-so/config.yml", "language: [unclosed\n  x: 1\n");
    expect(() => load()).toThrow(new RegExp(`\\[Config\\] ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} could not be read.*line 1, column`, "s"));
  });

  it("the same when the fleet-side file (roster.yml) is broken", () => {
    makeFleet();
    const roster = write(".make-it-so/roster.yml", "crew: [unclosed\n");
    expect(() => load()).toThrow(new RegExp(roster.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

describe("loadConfig: values that are checked up front", () => {
  const withConfig = (yaml: string) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mis-lc-"));
    const dir = path.join(home, ".make-it-so");
    fs.mkdirSync(path.join(dir, "ships/s"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config.yml"), yaml);
    fs.writeFileSync(path.join(dir, "roster.yml"), "crew:\n  alex:\n    name: Alex\n");
    fs.writeFileSync(path.join(dir, "ships/s/ship.yml"), "port: 4000\ncrew:\n  lead:\n    member: alex\n");
    return home;
  };
  const load = (yaml: string) => loadConfig({ homeDir: withConfig(yaml), log: () => {} });

  it("a typo in the provider names the key and the choices, instead of failing later with a TypeError", () => {
    expect(() => load("acp:\n  provider: claud\n")).toThrow(/"acp.provider" in config.yml must be one of kiro, claude \(got "claud"\)/);
  });

  it("refuses a debug that is not a boolean, a bad log level, a bad size, and a bad command or args", () => {
    expect(() => load('debug: "false"\n')).toThrow(/"debug".*true or false/);
    expect(() => load("logging:\n  level: loud\n")).toThrow(/"logging.level"/);
    expect(() => load("logging:\n  maxFileSizeMb: abc\n")).toThrow(/"logging.maxFileSizeMb"/);
    expect(() => load("acp:\n  claude:\n    command: 5\n")).toThrow(/"acp.claude.command"/);
    expect(() => load("acp:\n  kiro:\n    args: not-a-list\n")).toThrow(/"acp.kiro.args"/);
    expect(() => load('server:\n  host: ""\n')).toThrow(/"server.host"/);
  });

  it("accepts a valid config", () => {
    expect(load("acp:\n  provider: kiro\nlogging:\n  level: warn\n  maxFileSizeMb: 2\ndebug: true\n").acp.provider).toBe("kiro");
  });
});
