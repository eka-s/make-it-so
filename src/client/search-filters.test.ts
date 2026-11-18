import { describe, expect, it } from "vitest";
import { dayStartIso, nextDayStartIso, resolveMissionIds, toggleMission } from "./search-filters";

describe("dayStartIso / nextDayStartIso", () => {
  it("makes it the ISO time of local midnight (interpreted as a local date regardless of the time zone)", () => {
    expect(dayStartIso("2026-11-14")).toBe(new Date(2026, 10, 14).toISOString());
    expect(nextDayStartIso("2026-11-14")).toBe(new Date(2026, 10, 15).toISOString());
  });

  it("the next day across the end of a month or year is also correct", () => {
    expect(nextDayStartIso("2026-11-30")).toBe(new Date(2026, 11, 1).toISOString());
    expect(nextDayStartIso("2026-12-31")).toBe(new Date(2027, 0, 1).toISOString());
  });

  it("an invalid date is undefined (empty, wrong format, nonexistent day)", () => {
    for (const bad of ["", "2026/11/14", "2026-1-4", "abc", "2026-02-30", "2026-13-01"]) {
      expect(dayStartIso(bad)).toBeUndefined();
      expect(nextDayStartIso(bad)).toBeUndefined();
    }
  });
});

describe("resolveMissionIds", () => {
  const existing = ["bridge", "m1", "m2"];

  it("current is the current mission. custom is only the missions that exist", () => {
    expect(resolveMissionIds({ kind: "current" }, "m1", existing)).toEqual(["m1"]);
    expect(resolveMissionIds({ kind: "custom", ids: ["m2", "gone", "bridge"] }, "m1", existing)).toEqual(["m2", "bridge"]);
    expect(resolveMissionIds({ kind: "custom", ids: [] }, "m1", existing)).toEqual([]);
  });
});

describe("toggleMission", () => {
  it("adding another mission from the current-only state gives a custom that includes the current mission too", () => {
    expect(toggleMission({ kind: "current" }, "m1", "m2")).toEqual({ kind: "custom", ids: ["m1", "m2"] });
  });

  it("unchecking the current mission can leave custom empty (nothing is targeted)", () => {
    expect(toggleMission({ kind: "current" }, "m1", "m1")).toEqual({ kind: "custom", ids: [] });
  });

  it("in custom, checkboxes are checked and unchecked", () => {
    const on = toggleMission({ kind: "custom", ids: ["m1"] }, "bridge", "m2");
    expect(on).toEqual({ kind: "custom", ids: ["m1", "m2"] });
    expect(toggleMission(on, "bridge", "m1")).toEqual({ kind: "custom", ids: ["m2"] });
  });
});
