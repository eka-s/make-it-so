import { describe, expect, it } from "vitest";
import { clampSplitRatio, DEFAULT_SPLIT_RATIO, MAX_SPLIT_RATIO, MIN_SPLIT_RATIO, splitRatioFromPointer } from "./split-layout";

describe("split ratio", () => {
  it("the default is a quarter of the area", () => {
    expect(DEFAULT_SPLIT_RATIO).toBe(0.25);
  });

  it("keeps a ratio inside the allowed range", () => {
    expect(clampSplitRatio(0.5)).toBe(0.5);
    expect(clampSplitRatio(0)).toBe(MIN_SPLIT_RATIO);
    expect(clampSplitRatio(1)).toBe(MAX_SPLIT_RATIO);
  });

  it("falls back to the default for a broken value", () => {
    expect(clampSplitRatio(Number.NaN)).toBe(DEFAULT_SPLIT_RATIO);
    expect(clampSplitRatio(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SPLIT_RATIO);
  });

  it("turns the pointer position into a ratio of the area", () => {
    expect(splitRatioFromPointer(300, 100, 800)).toBe(0.25);
    expect(splitRatioFromPointer(500, 100, 800)).toBe(0.5);
  });

  it("clamps a pointer dragged outside the area", () => {
    expect(splitRatioFromPointer(0, 100, 800)).toBe(MIN_SPLIT_RATIO);
    expect(splitRatioFromPointer(5000, 100, 800)).toBe(MAX_SPLIT_RATIO);
  });

  it("uses the default for an area without height", () => {
    expect(splitRatioFromPointer(100, 0, 0)).toBe(DEFAULT_SPLIT_RATIO);
  });
});
