import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyInitPlan, planInit, type InitOptions } from "./init-plan.js";
import { loadConfig } from "./load-config.js";
import { isOnPath, missingCliMessage, type PathLookup } from "./agent-cli-check.js";

let tmp: string;
let dir: string; // plays ~/.make-it-so

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mis-init-"));
  dir = path.join(tmp, ".make-it-so");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const options = (overrides: Partial<InitOptions> = {}): InitOptions => ({
  provider: "claude",
  shipId: "my-ship",
  port: 3939,
  homeDir: dir,
  ...overrides,
});

describe("planInit", () => {
  it("plans the three files config.yml, roster.yml, and ship.yml at the expected locations", () => {
    const files = planInit(options());
    expect(files.map((f) => f.path)).toEqual([
      path.join(dir, "config.yml"),
      path.join(dir, "roster.yml"),
      path.join(dir, "ships", "my-ship", "ship.yml"),
    ]);
  });

  it("has no side effects, and returns the same output for the same input", () => {
    const before = fs.readdirSync(tmp);
    expect(planInit(options())).toEqual(planInit(options()));
    expect(fs.readdirSync(tmp)).toEqual(before);
  });

  it("the provider choice is reflected in config.yml and roster.yml", () => {
    const [config, roster] = planInit(options({ provider: "kiro" }));
    expect(config.content).toContain('provider: "kiro"');
    expect(roster.content).toContain('provider: "kiro"');
  });

  it("the ship's port and name go into ship.yml", () => {
    const ship = planInit(options({ port: 4100 }))[2];
    expect(ship.content).toContain("port: 4100");
    expect(ship.content).toContain('name: "My Ship"');
  });

  it("the generated files contain no proper names taken from any particular work", () => {
    const text = planInit(options()).map((f) => f.content).join("\n");
    expect(text).not.toMatch(/riker|ライカー|enterprise|enterprize|picard|voyager|star ?trek/i);
  });

  it("invalid input is rejected with a reason", () => {
    expect(() => planInit(options({ provider: "gpt" as never }))).toThrow(/provider must be one of/);
    expect(() => planInit(options({ shipId: "../evil" }))).toThrow(/ship id/);
    expect(() => planInit(options({ shipId: "" }))).toThrow(/ship id/);
    expect(() => planInit(options({ port: 0 }))).toThrow(/port/);
    expect(() => planInit(options({ port: 70000 }))).toThrow(/port/);
    expect(() => planInit(options({ port: 3.5 }))).toThrow(/port/);
    expect(() => planInit(options({ homeDir: "  " }))).toThrow(/home directory/);
  });
});

describe("applyInitPlan", () => {
  it("writing from an empty state lets loadConfig pass and yields the ship and the commander (the generated files can really be started)", () => {
    const result = applyInitPlan(planInit(options({ provider: "kiro", port: 4100 })));
    expect(result.conflicts).toEqual([]);
    expect(result.written).toHaveLength(3);

    const config = loadConfig({ homeDir: tmp, log: () => {} });
    expect(config.port).toBe(4100);
    expect(config.shipId).toBe("my-ship");
    expect(config.shipName).toBe("My Ship");
    expect(config.acp.provider).toBe("kiro");
    expect(config.crew.lead).toMatchObject({ name: "Alex", provider: "kiro", acp_agent: "alex", rank: "commander" });
  });

  it("if even one file already exists, nothing is written and the existing content is not changed either", () => {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "roster.yml"), "mine");

    const result = applyInitPlan(planInit(options()));
    expect(result.written).toEqual([]);
    expect(result.conflicts).toEqual([path.join(dir, "roster.yml")]);
    expect(fs.readFileSync(path.join(dir, "roster.yml"), "utf-8")).toBe("mine");
    expect(fs.existsSync(path.join(dir, "config.yml"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "ships"))).toBe(false);
  });

  it("stops if config.yml already exists. With a different ship ID, only the ship cannot be added (roster.yml would collide), so it stops", () => {
    applyInitPlan(planInit(options()));
    const again = applyInitPlan(planInit(options({ shipId: "other" })));
    expect(again.written).toEqual([]);
    expect(again.conflicts).toEqual([path.join(dir, "config.yml"), path.join(dir, "roster.yml")]);
  });
});

describe("agent-cli-check", () => {
  const lookup = (existing: string[], over: Partial<PathLookup> = {}): PathLookup => ({
    pathEnv: "/usr/bin:/opt/bin",
    platform: "linux",
    isFile: (p) => existing.includes(p),
    ...over,
  });

  it("found if it is anywhere on the PATH. Not found otherwise", () => {
    expect(isOnPath("npx", lookup(["/opt/bin/npx"]))).toBe(true);
    expect(isOnPath("npx", lookup(["/elsewhere/npx"]))).toBe(false);
    expect(isOnPath("npx", lookup([], { pathEnv: undefined }))).toBe(false);
  });

  it("a command containing a path is checked for the existence of that path", () => {
    expect(isOnPath("/custom/kiro-cli", lookup(["/custom/kiro-cli"]))).toBe(true);
    expect(isOnPath("/custom/kiro-cli", lookup([]))).toBe(false);
  });

  it("on Windows, the PATHEXT extensions are supplied and entries are separated by ;", () => {
    const win = lookup([], {
      platform: "win32",
      pathEnv: "C:\\tools;C:\\other",
      pathExt: ".EXE;.CMD",
      isFile: (p) => p.replace(/\//g, "\\") === "C:\\tools\\npx.CMD",
    });
    expect(isOnPath("npx", win)).toBe(true);
  });

  it("only when it is not found, returns guidance matching the provider. It adds that authentication cannot be checked", () => {
    expect(missingCliMessage("claude", "npx", lookup(["/usr/bin/npx"]))).toBeNull();
    expect(missingCliMessage("claude", "npx", lookup([]))).toMatch(/"npx".*not found on PATH.*Node\.js.*logged in/);
    expect(missingCliMessage("kiro", "kiro-cli", lookup([]))).toMatch(/Install kiro-cli/);
    expect(missingCliMessage("kiro", "kiro-cli", lookup([]))).toMatch(/cannot check whether you are logged in/);
  });
});

describe("missingCliMessage: a command that is not the default", () => {
  const empty: PathLookup = { pathEnv: "/nowhere", platform: "linux", isFile: () => false } as unknown as PathLookup;

  it("points at the setting instead of telling the person to install npx", () => {
    const message = missingCliMessage("claude", "my-agent", empty)!;
    expect(message).toContain('"my-agent"');
    expect(message).toContain("acp.claude.command");
    expect(message).not.toContain("npx comes with it");
  });

  it("keeps the install advice for the default command", () => {
    expect(missingCliMessage("claude", "npx", empty)).toContain("npx comes with it");
    expect(missingCliMessage("kiro", "kiro-cli", empty)).toContain("Install kiro-cli");
  });
});
