import { describe, expect, it } from "vitest";
import { isShipId } from "./ship-id.js";

describe("a ship ID", () => {
  it("is a name of letters, digits, _ and -, beginning with a letter or digit", () => {
    for (const ok of ["alpha", "Ship_2", "a", "0day", "my-ship"]) expect(isShipId(ok)).toBe(true);
  });

  it("is never a path, nor a name that would be read as an option", () => {
    for (const bad of ["", "../x", "a/b", "a\\b", "..", "-x", "--inspect=127.0.0.1:9229", "_x", "a b", "a\n", "é"]) expect(isShipId(bad)).toBe(false);
  });
});
