import { describe, expect, it } from "vitest";
import { en } from "./en";
import { ja } from "./ja";
import { placeholdersOf } from "./translate";

describe("message dictionaries", () => {
  it("en and ja have exactly the same keys", () => {
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
  });

  it("every message uses the same placeholders in both languages", () => {
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect({ key, placeholders: placeholdersOf(ja[key]) }).toEqual({ key, placeholders: placeholdersOf(en[key]) });
    }
  });

  it("no message is empty", () => {
    for (const [key, text] of [...Object.entries(en), ...Object.entries(ja)]) {
      expect({ key, empty: text.trim() === "" }).toEqual({ key, empty: false });
    }
  });
});
