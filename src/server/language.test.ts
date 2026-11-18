import { describe, expect, it } from "vitest";
import { isLanguage, resolveLanguage } from "./language.js";

describe("language", () => {
  it("accepts only supported languages", () => {
    expect(isLanguage("en")).toBe(true);
    expect(isLanguage("ja")).toBe(true);
    expect(isLanguage("fr")).toBe(false);
    expect(isLanguage(undefined)).toBe(false);
    expect(isLanguage(1)).toBe(false);
  });

  it("prefers the saved value over the configured one", () => {
    expect(resolveLanguage("ja", "en")).toBe("ja");
    expect(resolveLanguage(undefined, "ja")).toBe("ja");
  });

  it("ignores an unknown saved value", () => {
    expect(resolveLanguage("fr", "en")).toBe("en");
  });
});
