import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS_PORT, parseStartMode } from "./cli-args.js";

describe("parseStartMode", () => {
  it("starts a ship unless --settings is given", () => {
    expect(parseStartMode([])).toEqual({ kind: "ship" });
    expect(parseStartMode(["--ship", "alpha"])).toEqual({ kind: "ship" });
  });

  it("--settings starts the settings server on the default port, or the one given with --port", () => {
    expect(parseStartMode(["--settings"])).toEqual({ kind: "settings", port: DEFAULT_SETTINGS_PORT });
    expect(parseStartMode(["--settings", "--port", "4000"])).toEqual({ kind: "settings", port: 4000 });
    expect(parseStartMode(["--port=4001", "--settings"])).toEqual({ kind: "settings", port: 4001 });
  });

  it("the default settings port is 3938 (next to a ship's 3939)", () => {
    expect(DEFAULT_SETTINGS_PORT).toBe(3938);
  });

  it("--settings and --ship cannot be combined", () => {
    expect(() => parseStartMode(["--settings", "--ship", "alpha"])).toThrow(/cannot be used together/);
    expect(() => parseStartMode(["--ship=alpha", "--settings"])).toThrow(/cannot be used together/);
  });

  it("--all is a mode of its own, and cannot be combined with the others or with --port", () => {
    expect(parseStartMode(["--all"])).toEqual({ kind: "all" });
    expect(() => parseStartMode(["--all", "--settings"])).toThrow(/--settings and --all cannot be used together/);
    expect(() => parseStartMode(["--ship", "a", "--all"])).toThrow(/--ship and --all cannot be used together/);
    expect(() => parseStartMode(["--all", "--port", "4000"])).toThrow(/only for --settings/);
  });

  it("--port is only for --settings", () => {
    expect(() => parseStartMode(["--port", "4000"])).toThrow(/only for --settings/);
  });

  it("an invalid port is an error", () => {
    expect(() => parseStartMode(["--settings", "--port", "abc"])).toThrow(/--port must be an integer/);
    expect(() => parseStartMode(["--settings", "--port", "70000"])).toThrow(/--port must be an integer/);
    expect(() => parseStartMode(["--settings", "--port"])).toThrow(/--port must be an integer/);
  });

  it("ignores the other arguments around it", () => {
    expect(parseStartMode(["--config", "vite.config.ts", "--settings"])).toEqual({ kind: "settings", port: DEFAULT_SETTINGS_PORT });
  });
});
