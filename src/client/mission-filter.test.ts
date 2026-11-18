import { describe, expect, it } from "vitest";
import { matchesFilter } from "./mission-filter";

describe("narrowing missions (matchesFilter)", () => {
  it("empty or whitespace only matches everything", () => {
    expect(matchesFilter("Bridge", "")).toBe(true);
    expect(matchesFilter("Bridge", "   ")).toBe(true);
  });

  it("matches if contained in the name, case-insensitive", () => {
    expect(matchesFilter("Test Alpha", "alpha")).toBe(true);
    expect(matchesFilter("Test Alpha", "ALPHA")).toBe(true);
    expect(matchesFilter("Test Alpha", "beta")).toBe(false);
  });

  it("several space-separated words match only what contains all of them (AND, in any order)", () => {
    expect(matchesFilter("Test A", "te A")).toBe(true);
    expect(matchesFilter("Test A", "A te")).toBe(true);
    expect(matchesFilter("Test B", "te A")).toBe(false);
  });
});
