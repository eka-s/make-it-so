import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CONFIG_DEFAULTS } from "../config-defaults.js";
import { applyConfigValues, CONFIG_FIELDS, readConfigState } from "./config-fields.js";
import { loadConfig } from "../load-config.js";

let tmp: string;
let dir: string; // plays ~/.make-it-so
let file: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mis-fields-"));
  dir = path.join(tmp, ".make-it-so");
  file = path.join(dir, "config.yml");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function seed(text: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, text);
}
const written = () => parse(fs.readFileSync(file, "utf-8"));
const value = (key: string) => readConfigState(dir).fields.find((f) => f.key === key)?.value;

describe("readConfigState", () => {
  it("without a config.yml, every field is unset (the defaults apply)", () => {
    const state = readConfigState(dir);
    expect(state.exists).toBe(false);
    expect(state.fields.every((f) => f.value === null)).toBe(true);
  });

  it("reports the values in the file, lists included", () => {
    seed("language: ja\nacp:\n  provider: kiro\n  kiro:\n    args: [acp, --x]\n");
    expect(value("language")).toBe("ja");
    expect(value("acp.provider")).toBe("kiro");
    expect(value("acp.kiro.args")).toEqual(["acp", "--x"]);
    expect(value("crew_language")).toBeNull();
  });

  it("a broken config.yml is an error, not an empty state", () => {
    seed("language: [unclosed\n");
    expect(() => readConfigState(dir)).toThrow(/could not be read/);
  });
});

describe("applyConfigValues", () => {
  it("writes a changed value, creating config.yml and the directory when needed", () => {
    const result = applyConfigValues(dir, { language: "ja" });
    expect(result.ok).toBe(true);
    expect(written()).toEqual({ language: "ja" });
  });

  it("a value equal to the default removes the key (and the parents it leaves empty)", () => {
    seed("logging:\n  level: debug\n");
    applyConfigValues(dir, { "logging.level": CONFIG_DEFAULTS.logLevel });
    expect(written()).toEqual({});
  });

  it("clearing a field (null or empty) removes the key", () => {
    seed("crew_language: ja\nserver:\n  host: 0.0.0.0\n");
    applyConfigValues(dir, { crew_language: null, "server.host": "" });
    expect(written()).toEqual({});
  });

  it("an unchanged value is left alone: an explicit value equal to the default stays, and comments are kept", () => {
    seed("# mine\nlanguage: en # explicit\nlogging:\n  level: debug\n");
    applyConfigValues(dir, { language: "en", "logging.level": "warn" });
    const text = fs.readFileSync(file, "utf-8");
    expect(text).toContain("# mine");
    expect(text).toContain("language: en # explicit");
    expect(written()).toEqual({ language: "en", logging: { level: "warn" } });
  });

  it("keys it does not know are kept", () => {
    seed("future_option: 1\nlanguage: en\n");
    applyConfigValues(dir, { language: "ja" });
    expect(written()).toEqual({ future_option: 1, language: "ja" });
  });

  it("nothing is written unless every value is valid, and the errors are given per key", () => {
    seed("language: en\n");
    const before = fs.readFileSync(file, "utf-8");
    const result = applyConfigValues(dir, { language: "fr", "logging.maxFileSizeMb": 0, "acp.kiro.args": "x", debug: "yes", nope: 1 });
    expect(result).toEqual({
      ok: false,
      errors: {
        language: "settings.error.notAnOption",
        "logging.maxFileSizeMb": "settings.error.outOfRange",
        "acp.kiro.args": "settings.error.notAList",
        debug: "settings.error.notABoolean",
        nope: "settings.error.notAnOption",
      },
    });
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
  });

  it("a number must be an integer, and text is trimmed (blank is an error, not a clear)", () => {
    expect(applyConfigValues(dir, { "logging.maxFileSizeMb": 2.5 })).toMatchObject({ ok: false, errors: { "logging.maxFileSizeMb": "settings.error.notANumber" } });
    expect(applyConfigValues(dir, { "acp.claude.command": "   " })).toMatchObject({ ok: false, errors: { "acp.claude.command": "settings.error.empty" } });
    applyConfigValues(dir, { "acp.claude.command": "  claude  " });
    expect(value("acp.claude.command")).toBe("claude");
  });

  it("a list drops blank items, and an empty list is cleared", () => {
    applyConfigValues(dir, { "acp.kiro.args": ["acp", " ", "--verbose"] });
    expect(value("acp.kiro.args")).toEqual(["acp", "--verbose"]);
    applyConfigValues(dir, { "acp.kiro.args": [] });
    expect(written()).toEqual({});
  });

  it("what it writes is read by loadConfig as the same values (every field, end to end)", () => {
    fs.mkdirSync(path.join(dir, "ships", "alpha"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ships", "alpha", "ship.yml"), "port: 4000\ncrew:\n  lead: { member: alex }\n");
    fs.writeFileSync(path.join(dir, "roster.yml"), "crew:\n  alex: { name: Alex, provider: claude }\n");
    applyConfigValues(dir, {
      language: "ja", crew_language: "en", "acp.provider": "kiro", "acp.kiro.command": "k", "acp.kiro.args": ["a"],
      "acp.claude.command": "c", "acp.claude.args": ["b"], "server.host": "0.0.0.0", debug: true,
      "logging.level": "warn", "logging.maxFileSizeMb": 9,
    });
    const config = loadConfig({ homeDir: tmp, log: () => {} });
    expect([config.language, config.crewLanguage, config.acp.provider, config.host, config.debug]).toEqual(["ja", "en", "kiro", "0.0.0.0", true]);
    expect([config.acp.kiro, config.acp.claude]).toEqual([{ command: "k", args: ["a"] }, { command: "c", args: ["b"] }]);
    expect(config.logging).toEqual({ level: "warn", maxFileSizeMb: 9 });
  });

  it("every field of the form is one that load-config.ts reads", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/server/load-config.ts"), "utf-8");
    for (const f of CONFIG_FIELDS) {
      expect({ key: f.key, read: new RegExp(`\\b${f.key.split(".").pop()}\\b`).test(source) }).toEqual({ key: f.key, read: true });
    }
  });
});
