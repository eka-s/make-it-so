import { describe, expect, it } from "vitest";
import { LANGUAGE_LABELS, LANGUAGE_OPTIONS } from "./languages";

describe("the languages to choose from", () => {
  it("are all the languages, each named in itself and marked as being in itself", () => {
    expect(LANGUAGE_OPTIONS.map((o) => o.value).sort()).toEqual(Object.keys(LANGUAGE_LABELS).sort());
    for (const option of LANGUAGE_OPTIONS) {
      expect(option.label).toBe(LANGUAGE_LABELS[option.value]);
      expect(option.lang).toBe(option.value);
    }
  });
});
