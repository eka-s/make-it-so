import { describe, expect, it } from "vitest";
import { chooseStartMode } from "./start-mode.js";

const ship = (id: string) => ({ id });

describe("choosing how to start", () => {
  it("runs the ship the person names, whatever else there is", () => {
    expect(chooseStartMode(["--ship", "alpha"], [ship("alpha"), ship("beta")])).toEqual({ kind: "ship" });
    expect(chooseStartMode(["--ship=missing"], [])).toEqual({ kind: "ship" });
  });

  it("runs the only ship without asking", () => {
    expect(chooseStartMode([], [ship("alpha")])).toEqual({ kind: "ship" });
  });

  it("counts a ship whose ship.yml cannot be read: running it reports the problem instead of hiding it", () => {
    expect(chooseStartMode([], [{ id: "alpha", error: "bad yaml" }])).toEqual({ kind: "ship" });
  });

  it("lets the person choose when there are several ships or none", () => {
    expect(chooseStartMode([], [ship("alpha"), ship("beta")])).toEqual({ kind: "launcher" });
    expect(chooseStartMode([], [])).toEqual({ kind: "launcher" });
  });
});
