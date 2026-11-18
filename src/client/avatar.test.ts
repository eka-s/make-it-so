import { describe, expect, it } from "vitest";
import { avatarHue, avatarInitial } from "./avatar";

describe("avatarInitial", () => {
  it("returns the first character of the name in uppercase. Japanese and emoji are counted as one character too", () => {
    expect(avatarInitial("alex")).toBe("A");
    expect(avatarInitial("  sam")).toBe("S");
    expect(avatarInitial("ジョー")).toBe("ジ");
    expect(avatarInitial("😀 smile")).toBe("😀");
  });

  it("? if empty", () => {
    expect(avatarInitial("")).toBe("?");
    expect(avatarInitial("   ")).toBe("?");
  });
});

describe("avatarHue", () => {
  it("the same name gives the same hue. Case and surrounding whitespace are not distinguished", () => {
    expect(avatarHue("Alex")).toBe(avatarHue("alex"));
    expect(avatarHue(" alex ")).toBe(avatarHue("alex"));
  });

  it("falls within 0-359, and different names give (in most cases) different colors", () => {
    for (const name of ["alex", "sam", "jo", "", "ジョー", "a-very-long-name-with-many-characters"]) {
      const hue = avatarHue(name);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
    expect(new Set(["alex", "sam", "jo", "dee"].map(avatarHue)).size).toBeGreaterThan(2);
  });
});
