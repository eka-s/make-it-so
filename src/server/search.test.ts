import { describe, expect, it } from "vitest";
import { escapeLike, makeSnippet, MAX_SEARCH_TERMS, MAX_TERM_LENGTH, parseSearchTerms } from "./search.js";

describe("parseSearchTerms", () => {
  it("splits on whitespace (including full-width), and drops empty terms and duplicates (case-insensitive)", () => {
    expect(parseSearchTerms("  ログイン　検証 ログイン  Test test ")).toEqual(["ログイン", "検証", "Test"]);
    expect(parseSearchTerms("")).toEqual([]);
    expect(parseSearchTerms("   ")).toEqual([]);
  });

  it("there is an upper limit on the number of terms and on the length of a term", () => {
    const many = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
    expect(parseSearchTerms(many)).toHaveLength(MAX_SEARCH_TERMS);
    expect(parseSearchTerms("a".repeat(500))[0]).toHaveLength(MAX_TERM_LENGTH);
  });
});

describe("escapeLike", () => {
  it("escapes the LIKE special characters (% _ \\) so that they are treated literally", () => {
    expect(escapeLike("100%_done\\")).toBe("100\\%\\_done\\\\");
    expect(escapeLike("普通の語")).toBe("普通の語");
  });
});

describe("makeSnippet", () => {
  it("returns the positions of the matches as ranges within the excerpt. Case-insensitive", () => {
    const s = makeSnippet("The Login form was fixed", ["login"]);
    expect(s.text).toBe("The Login form was fixed");
    expect(s.ranges).toEqual([[4, 9]]);
    expect(s.cutStart).toBe(false);
    expect(s.cutEnd).toBe(false);
  });

  it("Japanese is also found by partial match, and the matches of all the terms are returned. Overlaps are merged into one", () => {
    const s = makeSnippet("ログインの検証を追加しました。検証は成功です", ["検証", "ログイン"]);
    expect(s.ranges).toEqual([[0, 4], [5, 7], [15, 17]]);
    expect(makeSnippet("abcdef", ["abc", "cde"]).ranges).toEqual([[0, 5]]); // overlapping ranges become one
  });

  it("for a long body, cuts out the area around the first match and shows which side was cut off", () => {
    const long = "あ".repeat(100) + "検証" + "い".repeat(300);
    const s = makeSnippet(long, ["検証"]);
    expect(s.cutStart).toBe(true);
    expect(s.cutEnd).toBe(true);
    expect(s.text.length).toBeLessThan(long.length);
    const [from, to] = s.ranges[0];
    expect(s.text.slice(from, to)).toBe("検証");
  });

  it("newlines and tabs are replaced with spaces (positions do not shift)", () => {
    const s = makeSnippet("1行目\n検証\t2", ["検証"]);
    expect(s.text).toBe("1行目 検証 2");
    expect(s.text.slice(...s.ranges[0])).toBe("検証");
  });

  it("if there is no match, cuts out the beginning and the matched ranges are empty", () => {
    const s = makeSnippet("何も一致しない本文", ["zzz"]);
    expect(s.ranges).toEqual([]);
    expect(s.text).toBe("何も一致しない本文");
  });

  it("does not cut in the middle of an emoji (surrogate pair)", () => {
    const s = makeSnippet("😀".repeat(80) + "検証" + "😀".repeat(100), ["検証"]);
    expect(s.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    expect(s.text.slice(...s.ranges[0])).toBe("検証");
  });
});
