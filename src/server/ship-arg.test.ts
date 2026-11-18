import { describe, expect, it } from "vitest";
import { parseShipArg } from "./ship-arg.js";

describe("parseShipArg", () => {
  it("reads --ship <id> and --ship=<id>", () => {
    expect(parseShipArg(["--ship", "alpha"])).toBe("alpha");
    expect(parseShipArg(["--ship=beta"])).toBe("beta");
  });

  it("is undefined when --ship is not given", () => {
    expect(parseShipArg([])).toBeUndefined();
    expect(parseShipArg(["--config", "vite.config.ts"])).toBeUndefined();
  });

  it("ignores the other arguments around it (the dev tooling shares the argument list)", () => {
    expect(parseShipArg(["--config", "vite.config.ts", "--ship", "alpha", "--host"])).toBe("alpha");
  });

  it("an error when the ship ID is missing", () => {
    expect(() => parseShipArg(["--ship"])).toThrow(/--ship needs a ship ID/);
    expect(() => parseShipArg(["--ship", "--other"])).toThrow(/--ship needs a ship ID/);
    expect(() => parseShipArg(["--ship="])).toThrow(/--ship needs a ship ID/);
  });
});
