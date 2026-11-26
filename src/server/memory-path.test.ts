import { describe, expect, it } from "vitest";
import { memoryDirsUp, memoryPathProblem, resolveBundleLink } from "./memory-path.js";

describe("memoryPathProblem", () => {
  it("accepts a plain relative .md path, Japanese names included", () => {
    expect(memoryPathProblem("procedures/deploy.md")).toBeNull();
    expect(memoryPathProblem("手順/デプロイ.md")).toBeNull();
  });

  it("refuses what could leave the bundle, hidden entries, reserved names and other file types", () => {
    for (const bad of ["", "/a.md", "../a.md", "a/../b.md", "a/./b.md", ".git/config.md", "a/.x.md", "a\\b.md", "a.txt", "index.md", "x/log.md", "a//b.md", "a\u0000b.md"]) {
      expect(memoryPathProblem(bad), bad).not.toBeNull();
    }
  });
});

describe("memoryDirsUp", () => {
  it("lists a directory and every one above it, ending with the root", () => {
    expect(memoryDirsUp("a/b")).toEqual(["a/b", "a", ""]);
    expect(memoryDirsUp("")).toEqual([""]);
  });
});

describe("resolveBundleLink", () => {
  it("turns relative and root links into bundle paths", () => {
    expect(resolveBundleLink("a/b.md", "c.md")).toBe("/a/c.md");
    expect(resolveBundleLink("a/b.md", "../x/y.md#top")).toBe("/x/y.md");
    expect(resolveBundleLink("a/b.md", "/z.md")).toBe("/z.md");
  });

  it("leaves external links, anchors and links that climb out of the bundle alone", () => {
    expect(resolveBundleLink("a/b.md", "https://example.com/x.md")).toBeNull();
    expect(resolveBundleLink("a/b.md", "mailto:x@y.z")).toBeNull();
    expect(resolveBundleLink("a/b.md", "#section")).toBeNull();
    expect(resolveBundleLink("a.md", "../x.md")).toBeNull();
  });
});
